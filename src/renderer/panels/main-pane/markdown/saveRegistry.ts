/** tabId → 保存函数（返回 true 表示保存成功）。供关闭确认框跨组件触发保存。 */
type Saver = () => Promise<boolean>;

const savers = new Map<string, Saver>();

export function registerSaver(id: string, fn: Saver): void {
  savers.set(id, fn);
}

export function unregisterSaver(id: string): void {
  savers.delete(id);
}

export function getSaver(id: string): Saver | undefined {
  return savers.get(id);
}

export function _clearSaversForTesting(): void {
  savers.clear();
}
