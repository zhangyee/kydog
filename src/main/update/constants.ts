/** 唯一的仓库标识来源：Windows feed 与 macOS feed 都从这里拼，不在两处各写一遍。 */
export const GITHUB_SLUG = 'zhangyee/kydog';

/** 手动下载的固定落点。永远指向当前正式版，不从 label 或 feed 的 url 拼装 ——
 *  feed 返回的 url 指向 darwin zip，而 macOS 手动安装要给的是 dmg。 */
export const RELEASES_LATEST_URL = `https://github.com/${GITHUB_SLUG}/releases/latest`;

export function buildFeedUrl(platform: string, arch: string, version: string): string {
  return `https://update.electronjs.org/${GITHUB_SLUG}/${platform}-${arch}/${version}`;
}

/** 启动后首检延迟：避开启动高峰。 */
export const FIRST_CHECK_DELAY_MS = 30_000;
/** 周期检查间隔。 */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 单次检查的 deadline，防止永久悬挂。 */
export const CHECK_DEADLINE_MS = 30_000;
