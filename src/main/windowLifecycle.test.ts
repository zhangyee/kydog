import { describe, expect, it } from 'vitest';
import { shouldQuitAfterAllWindowsClosed } from './windowLifecycle';

describe('shouldQuitAfterAllWindowsClosed', () => {
  it('macOS 关闭最后一个窗口仍驻留；Windows/Linux 关闭最后一个窗口退出', () => {
    expect(shouldQuitAfterAllWindowsClosed('darwin')).toBe(false);
    expect(shouldQuitAfterAllWindowsClosed('win32')).toBe(true);
    expect(shouldQuitAfterAllWindowsClosed('linux')).toBe(true);
  });
});
