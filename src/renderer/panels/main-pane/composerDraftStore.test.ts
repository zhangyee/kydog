import { describe, it, expect, beforeEach } from 'vitest';
import { useComposerDraftStore, EMPTY_DRAFT } from './composerDraftStore';
import type { SkillEntry } from '../../../shared/types';

const SKILL = { name: 'fastpaper', description: 'x', enabled: true } as unknown as SkillEntry;

describe('composerDraftStore', () => {
  beforeEach(() => { useComposerDraftStore.setState({ byThread: {} }); });

  it('没写过草稿的 thread 读出来是 undefined —— 调用方落到 EMPTY_DRAFT', () => {
    expect(useComposerDraftStore.getState().byThread['t1']).toBeUndefined();
    expect(EMPTY_DRAFT).toEqual({ skill: null, body: '' });
  });

  // 这条就是「输入几个字 → 切到 md 编辑器 → 切回来，字没了」的那个 bug：
  // Composer 会被卸载，草稿必须活在组件之外才回得来。
  it('草稿按 thread 存活，组件卸载重挂后原样读回', () => {
    useComposerDraftStore.getState().setDraft('t1', { skill: null, body: '写了一半' });
    expect(useComposerDraftStore.getState().byThread['t1']).toEqual({ skill: null, body: '写了一半' });
  });

  it('两个 thread 的草稿互不干扰', () => {
    useComposerDraftStore.getState().setDraft('t1', { skill: null, body: 'A' });
    useComposerDraftStore.getState().setDraft('t2', { skill: SKILL, body: 'B' });
    expect(useComposerDraftStore.getState().byThread['t1']).toEqual({ skill: null, body: 'A' });
    expect(useComposerDraftStore.getState().byThread['t2']).toEqual({ skill: SKILL, body: 'B' });
  });

  it('setDraft 覆盖同一 thread 的旧草稿', () => {
    useComposerDraftStore.getState().setDraft('t1', { skill: SKILL, body: 'A' });
    useComposerDraftStore.getState().setDraft('t1', { skill: null, body: 'B' });
    expect(useComposerDraftStore.getState().byThread['t1']).toEqual({ skill: null, body: 'B' });
  });

  it('clearDraft 只清掉指定 thread（发送后 / 删除 thread 时走这条）', () => {
    useComposerDraftStore.getState().setDraft('t1', { skill: null, body: 'A' });
    useComposerDraftStore.getState().setDraft('t2', { skill: null, body: 'B' });
    useComposerDraftStore.getState().clearDraft('t1');
    expect(useComposerDraftStore.getState().byThread['t1']).toBeUndefined();
    expect(useComposerDraftStore.getState().byThread['t2']).toEqual({ skill: null, body: 'B' });
  });

  it('clearDraft 对没有草稿的 thread 是 noop，不换 byThread 引用', () => {
    const before = useComposerDraftStore.getState().byThread;
    useComposerDraftStore.getState().clearDraft('missing');
    expect(useComposerDraftStore.getState().byThread).toBe(before);
  });
});
