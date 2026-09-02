import { readFileSync } from 'node:fs';
import type { UpdaterPort, UpdaterEvent } from './updaterPort';

/** 一次检查的结果。engine 只负责得出它，状态迁移与不变量归 UpdateService 管。 */
export type CheckOutcome =
  | { kind: 'none' }
  | { kind: 'available'; candidateId: string; label: string }
  /** 仅 Windows：下载已开始。是本次检查的终态，真正的终局由迟到通道给出。 */
  | { kind: 'downloading' }
  | { kind: 'downloaded'; label: string }
  | { kind: 'failed'; message: string; retry: 'allowed' | 'restart-required' };

export interface CheckEngine {
  /** 发起一次检查。必须自行吞掉所有异常，返回 failed 而不是 reject。 */
  run(signal: AbortSignal): Promise<CheckOutcome>;
  /** 仅 Windows 有意义：deadline 之后才到达的终态事件。 */
  onLateOutcome(cb: (o: CheckOutcome) => void): void;
  quitAndInstall(): void;
}

const fail = (message: string): CheckOutcome => ({ kind: 'failed', message, retry: 'allowed' });

/** 开发态与 e2e 的默认引擎：永不联网，永远「已是最新」。 */
export function createNoopEngine(): CheckEngine {
  return {
    async run() { return { kind: 'none' }; },
    onLateOutcome() {},
    quitAndInstall() { throw new Error('no-op 更新服务不支持安装'); },
  };
}

/** e2e 专用：从文件读一个 outcome。每次 run 都重读，
 *  用例才能中途改写 fixture 驱动状态迁移。 */
export function createFixtureEngine(file: string): CheckEngine {
  return {
    async run() {
      // 与真实引擎同契约：读不到或形状不对都返回 failed，不能 reject 出去
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as CheckOutcome;
      } catch (err) {
        return fail(`更新 fixture 无法读取：${String((err as Error)?.message ?? err)}`);
      }
    },
    onLateOutcome() {},
    quitAndInstall() {},
  };
}

export function createDarwinEngine(deps: {
  feedUrl: string;
  userAgent: string;
  fetchFn?: typeof fetch;
}): CheckEngine {
  const doFetch = deps.fetchFn ?? fetch;
  return {
    async run(signal) {
      let res: Response;
      try {
        res = await doFetch(deps.feedUrl, { headers: { 'User-Agent': deps.userAgent }, signal });
      } catch (err) {
        return fail(`无法连接更新服务：${String((err as Error)?.message ?? err)}`);
      }
      // 服务端用 semver.lte 自行比较，204 就是权威的「已是最新」，客户端不做版本比较。
      if (res.status === 204) return { kind: 'none' };
      // 404 意为「找不到匹配平台的资产」—— 是发布配置问题，绝不能说成已是最新。
      if (res.status === 404) return fail('更新服务未找到本平台的发布资产，可能是发布配置有误');
      if (res.status !== 200) return fail(`更新服务返回 ${res.status}`);
      try {
        const j = await res.json() as { name?: unknown; url?: unknown };
        // name 是可编辑的 Release 标题，只作展示；url 只作不透明身份，从不解析、从不跳转。
        if (typeof j.name !== 'string' || typeof j.url !== 'string') return fail('更新服务返回的数据格式无法识别');
        return { kind: 'available', label: j.name, candidateId: j.url };
      } catch {
        return fail('更新服务返回的数据格式无法识别');
      }
    },
    onLateOutcome() { /* macOS 的 fetch 可被 abort 真正取消，没有迟到结果 */ },
    quitAndInstall() { throw new Error('macOS 不支持应用内安装更新'); },
  };
}

export function createWin32Engine(deps: {
  port: UpdaterPort;
  feedUrl: string;
  userAgent: string;
  deadlineMs: number;
}): CheckEngine {
  let settle: ((o: CheckOutcome) => void) | null = null;
  let lateCb: ((o: CheckOutcome) => void) | null = null;
  let feedSet = false;

  // autoUpdater 的事件不带检查标识，无法把一个事件归给某一轮检查。
  // 因此这里只区分「本轮还没结束」和「本轮已结束」：前者兑现 promise，
  // 后者作为迟到结果交给 UpdateService 按规则处理。
  const toOutcome = (e: UpdaterEvent): CheckOutcome | null => {
    if (e.type === 'update-not-available') return { kind: 'none' };
    if (e.type === 'update-downloaded') return { kind: 'downloaded', label: e.releaseName };
    if (e.type === 'error') return { kind: 'failed', message: e.message, retry: 'allowed' };
    // update-available：整包下载就此开始（182MB 起，分钟级），必然越过 deadline。
    // 它是本次检查的终态 —— 把它当非终态，deadline 就会把一次正常的下载判成
    // 「超时，请重启应用」，而两分钟后迟到的 downloaded 又把横幅弹出来，自相矛盾。
    return { kind: 'downloading' };
  };

  deps.port.on((e) => {
    const o = toOutcome(e);
    if (!o) return;
    if (settle) { const s = settle; settle = null; s(o); }
    else lateCb?.(o);
  });

  return {
    run(_signal) {
      return new Promise<CheckOutcome>((resolve) => {
        if (!feedSet) {
          deps.port.setFeedURL(deps.feedUrl, { 'User-Agent': deps.userAgent });
          feedSet = true;
        }
        const timer = setTimeout(() => {
          if (!settle) return;
          settle = null;
          resolve({
            kind: 'failed',
            message: '检查更新超时；本次运行期间已停止检查，请重启应用',
            retry: 'restart-required',
          });
        }, deps.deadlineMs);
        settle = (o) => { clearTimeout(timer); resolve(o); };
        deps.port.checkForUpdates();
      });
    },
    onLateOutcome(cb) { lateCb = cb; },
    quitAndInstall() { deps.port.quitAndInstall(); },
  };
}
