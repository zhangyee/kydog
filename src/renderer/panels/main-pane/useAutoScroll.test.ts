import { describe, it, expect } from 'vitest';
import { isNearBottom, STICKY_THRESHOLD_PX } from './useAutoScroll';

describe('isNearBottom', () => {
  it('距底部恰好 0（贴底）→ true', () => {
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })).toBe(true);
  });

  it('距底部 < THRESHOLD → true', () => {
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 - (STICKY_THRESHOLD_PX - 1) })).toBe(true);
  });

  it('距底部 = THRESHOLD → false（严格小于）', () => {
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 - STICKY_THRESHOLD_PX })).toBe(false);
  });

  it('距底部 > THRESHOLD → false', () => {
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 })).toBe(false);
  });

  it('内容未撑满容器（scrollHeight == clientHeight, scrollTop=0）→ true', () => {
    expect(isNearBottom({ scrollHeight: 200, clientHeight: 200, scrollTop: 0 })).toBe(true);
  });

  it('THRESHOLD 是 64', () => {
    expect(STICKY_THRESHOLD_PX).toBe(64);
  });
});
