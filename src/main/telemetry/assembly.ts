import {
  ARCHES, PLATFORMS, MAX_VERSION_LEN, SEMVER_RE, type Arch, type Platform,
} from '../../shared/telemetryContract';

/** 开发态与 e2e 的唯一闸门。此判断优先于用户设置 —— 用户在 npm start 下把开关
 *  打开也不发。闸只此一处，schedule 与任何手动触发同受其管。
 *
 *  与 update/pickAssembly.ts 是同一个意图的两份实现：统计与更新已刻意解耦，
 *  不共用那道闸，因此这里必须自建，不能假设更新那边挡住了。 */
export function telemetryAllowed(env: { isPackaged: boolean; e2e?: string }): boolean {
  if (env.e2e === '1') return false;
  return env.isPackaged;
}

/** 契约只认 darwin/win32 与 x64/arm64。不认识的一律返回 null 让上报停掉 ——
 *  绝不能把 linux 映射成 darwin、把 ia32 映射成 x64：那是拿一个编造的值
 *  顶替事实，会让服务端的平台分布悄悄失真，且没有任何信号能发现。
 *  取 process.platform 作参数而不是就地读全局，与 telemetryAllowed 同一约定。 */
export function exactPlatform(raw: string): Platform | null {
  return (PLATFORMS as readonly string[]).includes(raw) ? (raw as Platform) : null;
}

export function exactArch(raw: string): Arch | null {
  return (ARCHES as readonly string[]).includes(raw) ? (raw as Arch) : null;
}

/** version 是 payload 里唯一没有结构性保证的字段：id 来自 randomUUID()、
 *  platform/arch 由上面两个函数严格判定，只有它来自 app.getVersion()。而服务端对
 *  校验失败的 payload 是「丢弃不记录但仍返回 204」—— 客户端会稳定收到 sent 却从未
 *  被记录，协议层没有任何信号能让它发现自己在空发。成本极低，这里拦住。 */
export function versionOk(raw: string): boolean {
  return raw.length <= MAX_VERSION_LEN && SEMVER_RE.test(raw);
}
