// src/main/net/systemProxy.ts
//
// 让主进程的 HTTP 流量跟浏览器走同一条路。
//
// 为什么需要这个模块：主进程里 pi / pi-ai / institutionService / update 全都用全局 `fetch`，
// 而 Node 的 fetch（undici）**既不认系统代理、也不认 HTTP_PROXY 环境变量**——Node 24 的
// `NODE_USE_ENV_PROXY` 只在进程 bootstrap 时读一次，`main.ts` 里再设已经太晚（实测：同一个
// Electron 运行时，启动前设 → 走代理；代码里设 → 与完全不设的对照组一模一样，直连出网）。
// 结果就是国内用户只开 Clash 的「系统代理」时，浏览器里的登录页一切正常，回到主进程换 token
// 那一步直连被挡（OpenAI 的 403 unsupported_country_region_territory），只能靠 Tun 模式兜。
//
// 判据从哪来：`session.resolveProxy(url)` —— Chromium 自己那套解析器（系统代理设置 + PAC 脚本
// + bypass 列表），按 URL 给答案。不去读环境变量、不去猜平台、不去 ping 常见端口：那些都是
// proxy，而这里有协议层的权威来源可问。localhost 的例外也不用我们维护，Chromium 自带
// （实测 `resolveProxy('http://127.0.0.1:9999/x')` → `"DIRECT"`）。
//
// 实测记录（Electron 41.2.1 / Node 24.14.1，真主进程，非 ELECTRON_RUN_AS_NODE）：
//  - `setGlobalDispatcher` 用的是 `Symbol.for('undici.globalDispatcher.v1')` 这个跨 realm 注册
//    符号，所以**内置 fetch 认这个从 npm undici 来的外来 dispatcher**：装上之后 `globalThis.fetch`
//    一动没动（`fetch !== builtinFetch` 为 false），请求却确实走进了代理。**不需要 `undici.install()`**
//    ——那会连 Headers / Response / WebSocket / MessageEvent 一起换掉，blast radius 没必要。
//  - `resolveProxy` 在 `app.whenReady()` 之前调会抛 `Session can only be received when app is ready`，
//    所以装配点必须排在 ready 之后、第一笔 fetch 之前（`initProviderRegistry` 会飞后台目录刷新，
//    那是最早的一批）。
import { Agent, Dispatcher, EnvHttpProxyAgent, ProxyAgent, Socks5ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { logger } from '../log';

/** 测试用来存档还原的那一组；不是「这些都表示用户指定了代理」（NO_PROXY 不算）。 */
export const PROXY_ENV_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;

/** 只有这几个才算「用户显式指定了代理」。NO_PROXY 单独出现不构成指定。 */
const EXPLICIT_PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

export type ProxyRule =
  /** fellBack：Chromium 给了非 DIRECT 的规则，但一条都没能用上——和「本来就该直连」不是一回事。 */
  | { kind: 'direct'; fellBack: boolean }
  | { kind: 'http'; uri: string }
  | { kind: 'socks5'; uri: string };

export type ProxyResolver = (url: string) => Promise<string>;

export type SystemProxyDeps = { resolveProxy: ProxyResolver };

/**
 * 解析 Chromium 的 PAC 结果串，例如 `"PROXY 127.0.0.1:7892"` / `"SOCKS5 h:1; DIRECT"`。
 * 分号分隔、按优先级排列，取第一个我们能变成 dispatcher 的；`DIRECT` 出现即直连。
 */
export function parseProxyRule(rule: string): ProxyRule {
  let sawUnusable = false;
  for (const entry of rule.split(';')) {
    const [scheme, target] = entry.trim().split(/\s+/);
    if (!scheme) continue;
    if (scheme.toUpperCase() === 'DIRECT') return { kind: 'direct', fellBack: false };
    if (!target) { sawUnusable = true; continue; }
    switch (scheme.toUpperCase()) {
      case 'PROXY': return { kind: 'http', uri: `http://${target}` };
      case 'HTTPS': return { kind: 'http', uri: `https://${target}` };
      case 'SOCKS5': return { kind: 'socks5', uri: `socks5://${target}` };
      // SOCKS / SOCKS4 是 SOCKS4 的两种写法，undici 只有 Socks5ProxyAgent。
      // 其余（QUIC 等）同理：认得出是代理，但接不上。
      default: sawUnusable = true; continue;
    }
  }
  return { kind: 'direct', fellBack: sawUnusable };
}

/** 代理 URI 里可能带 user:pass，日志只留 scheme+host+port。 */
function redactUri(uri: string): string {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.username ? '***@' : ''}${u.host}`;
  } catch {
    return '(无法解析)';
  }
}

function failHandler(handler: unknown, err: unknown): void {
  // undici 8 的错误出口是 onResponseError(controller, err)，controller 允许为 null
  // （见 dispatcher-base.js 的 dispatch catch 分支）。旧形状留个回落，别让请求静默挂死。
  const h = handler as {
    onResponseError?: (controller: null, err: unknown) => void;
    onError?: (err: unknown) => void;
  };
  if (typeof h.onResponseError === 'function') h.onResponseError(null, err);
  else if (typeof h.onError === 'function') h.onError(err);
}

/**
 * 按 origin 路由的 dispatcher：每个请求都重新问一次 `resolveProxy`。
 *
 * **不缓存解析结果**是有意的。`resolveProxy` 是进程内调用不是网络往返，每请求问一次付得起；
 * 换来的是用户中途开关 Clash 立刻生效，而不需要任何 TTL 或「隔多久重查一次」——那种时间窗
 * 就是这个仓库禁的启发式 proxy。缓存的是**按代理 URI 复用的 dispatcher 实例**，不是判定结果，
 * 所以不会每请求新建一个 ProxyAgent。
 */
export class SystemProxyDispatcher extends Dispatcher {
  readonly #resolveProxy: ProxyResolver;
  readonly #direct = new Agent();
  readonly #byUri = new Map<string, Dispatcher>();

  constructor(deps: SystemProxyDeps) {
    super();
    this.#resolveProxy = deps.resolveProxy;
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = typeof opts.origin === 'string' ? opts.origin : (opts.origin?.origin ?? '');
    this.#pick(origin).then(
      (d) => { d.dispatch(opts, handler); },
      (err) => { failHandler(handler, err); },
    );
    // 真正的背压由下游 dispatcher 决定，但此刻还没选出来。返回 true 表示「收下了」；
    // 选错方向会让上游少一次 drain 等待，不会丢请求。
    return true;
  }

  async #pick(origin: string): Promise<Dispatcher> {
    let raw: string;
    try {
      raw = await this.#resolveProxy(origin);
    } catch (err) {
      // 解析不出来就直连：这一步失败不该把请求也带走（比如 app 还没 ready）。
      logger.warn('net', 'resolveProxy 失败，本次直连', { origin, err: String(err) });
      return this.#direct;
    }
    const rule = parseProxyRule(raw);
    if (rule.kind === 'direct') {
      if (rule.fellBack) logger.warn('net', '系统给了无法使用的代理规则，本次直连', { origin, rule: raw });
      return this.#direct;
    }
    return this.#agentFor(rule);
  }

  #agentFor(rule: Extract<ProxyRule, { uri: string }>): Dispatcher {
    const existing = this.#byUri.get(rule.uri);
    if (existing) return existing;
    // 两个 agent 的构造形状不一样：ProxyAgent 收 { uri }，Socks5ProxyAgent 收裸 URL 字符串。
    const created = rule.kind === 'socks5'
      ? new Socks5ProxyAgent(rule.uri)
      : new ProxyAgent({ uri: rule.uri });
    this.#byUri.set(rule.uri, created);
    logger.info('net', '经系统代理出网', { proxy: redactUri(rule.uri) });
    return created;
  }

  #all(): Dispatcher[] {
    return [this.#direct, ...this.#byUri.values()];
  }

  // close / destroy 要逐字照抄基类那四组重载，否则 setGlobalDispatcher 这种按 Dispatcher
  // 收参数的地方会当场类型不兼容（回调形态、以及 err 是 `Error | null` 而不是 `Error | undefined`）。
  close(callback: () => void): void;
  close(): Promise<void>;
  close(callback?: () => void): Promise<void> | void {
    const done = Promise.all(this.#all().map((d) => d.close())).then(() => undefined);
    if (callback) { void done.then(callback); return; }
    return done;
  }

  destroy(err: Error | null, callback: () => void): void;
  destroy(callback: () => void): void;
  destroy(err: Error | null): Promise<void>;
  destroy(): Promise<void>;
  destroy(errOrCallback?: Error | null | (() => void), maybeCallback?: () => void): Promise<void> | void {
    const err = typeof errOrCallback === 'function' ? null : (errOrCallback ?? null);
    const callback = typeof errOrCallback === 'function' ? errOrCallback : maybeCallback;
    const done = Promise.all(this.#all().map((d) => d.destroy(err))).then(() => undefined);
    if (callback) { void done.then(callback); return; }
    return done;
  }
}

/**
 * 把全局 dispatcher 换成「跟浏览器一致」的那一个。返回还原函数（测试用；生产不还原）。
 *
 * 环境变量优先于系统设置：`HTTPS_PROXY` / `HTTP_PROXY` 是用户的显式意图，多见于从终端启动
 * 或 CI。注意 macOS 上从 Finder / Dock 启动的 GUI 应用继承的是 launchd 的环境，拿不到用户在
 * shell 里 export 的那份——所以环境变量这条只对终端启动有效，**普通用户靠的是系统设置那条**。
 */
export function installProxyDispatcher(deps: SystemProxyDeps): () => void {
  const previous = getGlobalDispatcher();
  const explicit = EXPLICIT_PROXY_VARS.find((k) => (process.env[k] ?? '').trim() !== '');
  const next = explicit
    ? new EnvHttpProxyAgent()
    : new SystemProxyDispatcher(deps);
  setGlobalDispatcher(next);
  if (explicit) logger.info('net', '按环境变量出网', { via: explicit, proxy: redactUri(process.env[explicit] ?? '') });
  else logger.info('net', '跟随系统代理设置');
  return () => {
    setGlobalDispatcher(previous);
    void next.destroy();
  };
}
