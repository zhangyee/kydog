import type { UpdaterPort, UpdaterEvent } from './updaterPort';

/** 一次检查的结果。engine 只负责得出它，状态迁移与不变量归 UpdateService 管。 */
export type CheckOutcome =
  | { kind: 'none' }
  | { kind: 'available'; candidateId: string; label: string }
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
