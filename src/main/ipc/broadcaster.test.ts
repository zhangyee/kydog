import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const { broadcaster } = await import('./broadcaster');

describe('broadcaster.emitTo', () => {
  it('只把事件发给指定且仍存活的 webContents', () => {
    const first = { isDestroyed: () => false, send: vi.fn() };
    const second = { isDestroyed: () => false, send: vi.fn() };

    broadcaster.emitTo(first as never, 'ui.closeActiveTab', undefined);

    expect(first.send).toHaveBeenCalledWith('kydog:event', {
      topic: 'ui.closeActiveTab', payload: undefined,
    });
    expect(second.send).not.toHaveBeenCalled();
  });

  it('已销毁的目标不发送；同一个目标恢复为存活时会发送', () => {
    let destroyed = true;
    const sender = { isDestroyed: () => destroyed, send: vi.fn() };

    broadcaster.emitTo(sender as never, 'ui.closeActiveTab', undefined);
    expect(sender.send).not.toHaveBeenCalled();

    destroyed = false;
    broadcaster.emitTo(sender as never, 'ui.closeActiveTab', undefined);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });
});
