/** 启动后首次检查的延迟：避开启动高峰。 */
export const FIRST_CHECK_DELAY_MS = 30_000;
/** 检查间隔。跨 UTC 日后至多 6 小时补上，长期运行的实例不会漏掉任何一天。 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 单次请求的 deadline，防止永久悬挂。 */
export const REQUEST_TIMEOUT_MS = 15_000;
