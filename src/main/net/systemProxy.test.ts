import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getGlobalDispatcher, setGlobalDispatcher, request, EnvHttpProxyAgent } from 'undici';
import { parseProxyRule, SystemProxyDispatcher, installProxyDispatcher, PROXY_ENV_VARS } from './systemProxy';

/**
 * 假代理：只记账不转发，CONNECT 一律用 502 当场回绝。
 *
 * 三种收尾方式试过两种坏的：直接 `socket.destroy()` 会被 undici 当成连接失败并疯狂重连
 * （实测一次跑出 4 万多次 CONNECT）；应答 200 再把 socket 挂着的话，客户端卡在 TLS 握手上，
 * 而 `AbortSignal` 在隧道建成前不生效，用例只能等到 vitest 超时。502 是协议层的拒绝，
 * undici 当场把错误交回来，既快又不重试。
 */
function startFakeProxy() {
  const connects: string[] = [];
  const plain: string[] = [];
  const srv = http.createServer((req, res) => { plain.push(`${req.method} ${req.url}`); res.end('ok'); });
  srv.on('connect', (req, socket) => {
    connects.push(req.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  return {
    connects,
    plain,
    async listen() {
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      return (srv.address() as AddressInfo).port;
    },
    async close() {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
}

/** 发一次注定完不成的请求，只为把路由决策逼出来；返回失败原因的 code，用来区分走没走代理。 */
async function probe(dispatcher: SystemProxyDispatcher, url: string): Promise<string> {
  try {
    await request(url, { dispatcher });
    return 'ok';
  } catch (err) {
    const e = err as { code?: string; name?: string; message?: string };
    return e.code ?? e.name ?? String(e.message);
  }
}

describe('systemProxy.parseProxyRule', () => {
  it('DIRECT 与空串是直连；无法识别的串也直连，但标记 fellBack', () => {
    for (const s of ['DIRECT', '', '   ']) {
      expect(parseProxyRule(s), s).toEqual({ kind: 'direct', fellBack: false });
    }
    // fellBack 的语义是「Chromium 给了非 DIRECT 的东西，我们一条都没用上」。
    // 这和「本来就该直连」必须分得开：前者说明我们漏了一种代理，值得告警。
    for (const s of ['GARBAGE', 'PROXY', 'QUIC h3.example:443']) {
      expect(parseProxyRule(s), s).toEqual({ kind: 'direct', fellBack: true });
    }
  });

  it('PROXY 与 HTTPS 分别映射到 http:// 和 https:// 的代理 URI', () => {
    expect(parseProxyRule('PROXY 127.0.0.1:7892')).toEqual({ kind: 'http', uri: 'http://127.0.0.1:7892' });
    expect(parseProxyRule('HTTPS proxy.example.com:443')).toEqual({ kind: 'http', uri: 'https://proxy.example.com:443' });
  });

  it('SOCKS5 映射到 socks5://；SOCKS4 undici 不支持，降级直连并标记 fellBack', () => {
    expect(parseProxyRule('SOCKS5 127.0.0.1:7891')).toEqual({ kind: 'socks5', uri: 'socks5://127.0.0.1:7891' });
    // 对照：同样是 SOCKS 家族，5 认、4 不认——降级这件事必须能和「本来就 DIRECT」区分开，
    // 否则 Chromium 明明给了代理、我们却直连出网，表现和没装过这套东西一模一样。
    expect(parseProxyRule('SOCKS 1.2.3.4:1080')).toEqual({ kind: 'direct', fellBack: true });
    expect(parseProxyRule('SOCKS4 1.2.3.4:1080')).toEqual({ kind: 'direct', fellBack: true });
  });

  it('多段规则取第一个能用的，不是第一个', () => {
    expect(parseProxyRule('PROXY a.example:1; PROXY b.example:2')).toEqual({ kind: 'http', uri: 'http://a.example:1' });
    // 头一段不支持时要跳过它继续找，而不是就地降级
    expect(parseProxyRule('SOCKS4 s:1; PROXY p:2; DIRECT')).toEqual({ kind: 'http', uri: 'http://p:2' });
    // DIRECT 排在前面就是直连，后面的代理不算数
    expect(parseProxyRule('DIRECT; PROXY p:2')).toEqual({ kind: 'direct', fellBack: false });
  });
});

describe('systemProxy.SystemProxyDispatcher', () => {
  // 每条用例一份全新的假代理：connects 是累加的，共用一份会让隔壁用例的记账漏过来。
  let proxy: ReturnType<typeof startFakeProxy>;
  let port = 0;
  let dispatcher: SystemProxyDispatcher | undefined;

  beforeEach(async () => { proxy = startFakeProxy(); port = await proxy.listen(); });
  afterEach(async () => {
    await dispatcher?.destroy();
    dispatcher = undefined;
    await proxy.close();
  });

  it('按 resolveProxy 的答案路由：给 PROXY 就走代理，给 DIRECT 就不走', async () => {
    let rule = `PROXY 127.0.0.1:${port}`;
    dispatcher = new SystemProxyDispatcher({ resolveProxy: async () => rule });

    await probe(dispatcher, 'https://example.invalid/a');
    expect(proxy.connects).toEqual(['example.invalid:443']);

    // 同一个 dispatcher、同一个假代理，只把答案换成 DIRECT——否定断言要先有正面那一半，
    // 不然哪天路由整个坏掉（connects 永远是空的），这条照样绿。
    rule = 'DIRECT';
    const code = await probe(dispatcher, 'http://127.0.0.1:1/b');
    expect(proxy.connects).toEqual(['example.invalid:443']);   // 没有新增
    expect(code).toBe('ECONNREFUSED');                          // 真的直连出去了
  });

  it('每个请求都重新问一次 —— 不缓存，用户中途开关代理立刻生效', async () => {
    const asked: string[] = [];
    let rule = 'DIRECT';
    dispatcher = new SystemProxyDispatcher({
      resolveProxy: async (url) => { asked.push(url); return rule; },
    });

    await probe(dispatcher, 'http://127.0.0.1:1/x');
    expect(proxy.connects).toHaveLength(0);

    rule = `PROXY 127.0.0.1:${port}`;
    await probe(dispatcher, 'https://example.invalid/y');
    expect(proxy.connects).toEqual(['example.invalid:443']);

    // 问的是 origin，不是整条 URL（PAC 只按 scheme+host+port 决策）
    expect(asked).toEqual(['http://127.0.0.1:1', 'https://example.invalid']);
  });

  it('resolveProxy 抛错时降级直连，不把请求带走', async () => {
    dispatcher = new SystemProxyDispatcher({
      resolveProxy: async () => { throw new Error('session not ready'); },
    });
    const code = await probe(dispatcher, 'http://127.0.0.1:1/x');
    expect(code).toBe('ECONNREFUSED');
    expect(proxy.connects).toHaveLength(0);
  });
});

describe('systemProxy.installProxyDispatcher', () => {
  const saved = new Map<string, string | undefined>();
  let restoreGlobal: (() => void) | undefined;
  const original = getGlobalDispatcher();

  beforeEach(() => {
    for (const k of PROXY_ENV_VARS) { saved.set(k, process.env[k]); delete process.env[k]; }
  });
  afterEach(async () => {
    restoreGlobal?.();
    restoreGlobal = undefined;
    setGlobalDispatcher(original);
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('没有代理环境变量时问系统；有 HTTPS_PROXY 时用环境变量、不问系统', async () => {
    let asked = 0;
    const resolveProxy = async () => { asked++; return 'DIRECT'; };

    // 正面那一半：先证明「不设环境变量时它真的会去问」
    restoreGlobal = installProxyDispatcher({ resolveProxy });
    expect(getGlobalDispatcher()).toBeInstanceOf(SystemProxyDispatcher);
    await probe(getGlobalDispatcher() as SystemProxyDispatcher, 'http://127.0.0.1:1/x');
    expect(asked).toBe(1);
    restoreGlobal();

    // 再证明设了之后它不问了——显式意图优先，环境变量赢
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    restoreGlobal = installProxyDispatcher({ resolveProxy });
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
    expect(asked).toBe(1);   // 还是 1，没有新增
  });

  it('小写的 https_proxy 一样算数', () => {
    process.env.https_proxy = 'http://127.0.0.1:9';
    restoreGlobal = installProxyDispatcher({ resolveProxy: async () => 'DIRECT' });
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it('只设 NO_PROXY 不算「用户指定了代理」，仍然问系统', () => {
    process.env.NO_PROXY = 'example.com';
    restoreGlobal = installProxyDispatcher({ resolveProxy: async () => 'DIRECT' });
    expect(getGlobalDispatcher()).toBeInstanceOf(SystemProxyDispatcher);
  });

  it('还原函数把全局 dispatcher 放回原样', () => {
    const before = getGlobalDispatcher();
    const restore = installProxyDispatcher({ resolveProxy: async () => 'DIRECT' });
    expect(getGlobalDispatcher()).not.toBe(before);
    restore();
    expect(getGlobalDispatcher()).toBe(before);
  });
});
