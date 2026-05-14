import { describe, it, expect } from 'vitest';
import { pickSlot } from './pickThreadStatus';

const base = {
  hovered: false,
  pinned: false,
  isCurrent: false,
  runStatus: 'idle' as const,
  hasUnread: false,
};

describe('pickSlot', () => {
  it('idle, no flags → empty', () => {
    expect(pickSlot(base)).toBe('empty');
  });

  it('running thread → spinner（即使是当前 thread）', () => {
    expect(pickSlot({ ...base, runStatus: 'running' })).toBe('spinner');
    expect(pickSlot({ ...base, runStatus: 'running', isCurrent: true })).toBe('spinner');
  });

  it('unread + 非当前 thread → unreadDot', () => {
    expect(pickSlot({ ...base, hasUnread: true })).toBe('unreadDot');
  });

  it('unread + 当前 thread → 空白（兜底）', () => {
    expect(pickSlot({ ...base, hasUnread: true, isCurrent: true })).toBe('empty');
  });

  it('pinned 且无动态信号 → pinIcon', () => {
    expect(pickSlot({ ...base, pinned: true })).toBe('pinIcon');
  });

  it('pinned + unread → unreadDot 优先', () => {
    expect(pickSlot({ ...base, pinned: true, hasUnread: true })).toBe('unreadDot');
  });

  it('pinned + running → spinner 优先', () => {
    expect(pickSlot({ ...base, pinned: true, runStatus: 'running' })).toBe('spinner');
  });

  it('hover → 永远 pinButton（即使 running / unread）', () => {
    expect(pickSlot({ ...base, hovered: true })).toBe('pinButton');
    expect(pickSlot({ ...base, hovered: true, runStatus: 'running' })).toBe('pinButton');
    expect(pickSlot({ ...base, hovered: true, hasUnread: true })).toBe('pinButton');
  });

  it("runStatus 'error' 在 sidebar 上视觉同 idle（不显示 spinner）", () => {
    expect(pickSlot({ ...base, runStatus: 'error' })).toBe('empty');
    expect(pickSlot({ ...base, runStatus: 'error', hasUnread: true })).toBe('unreadDot');
  });
});
