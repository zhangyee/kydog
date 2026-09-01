import type { CenterViewState } from '../../shared/types';

/**
 * 渲染进程「中央区在看什么」的最后一次快照。
 *
 * **故意只放在内存里**，不进 settings.json：它要活过渲染进程重载（Ctrl+R，那时主进程
 * 根本没重启），但不该活过 app 退出 —— 冷启动仍然落在干净的欢迎页。落盘就变成
 * 「下次开 app 直接回到上次那个会话」，那是另一个产品决定，不是「刷新别跳页」。
 *
 * 单例而不是按窗口存：KyDog 是单窗口应用（pdfRaster 借的那个隐藏窗口不跑渲染层，
 * 也就不会来存）。真要开第二个窗口，这里得改成按 webContents.id 索引。
 */
let snapshot: CenterViewState | null = null;

export const viewStateStore = {
  get(): CenterViewState | null {
    return snapshot;
  },
  set(next: CenterViewState | null): void {
    snapshot = next;
  },
};
