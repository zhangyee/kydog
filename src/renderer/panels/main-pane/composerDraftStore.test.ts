import { describe, it, expect, beforeEach } from 'vitest';
import { useComposerDraftStore, EMPTY_DRAFT, isDraftEmpty } from './composerDraftStore';
import type { SkillEntry } from '../../../shared/types';

const SKILL = { name: 'fastpaper', description: 'x', enabled: true } as unknown as SkillEntry;

describe('composerDraftStore', () => {
  beforeEach(() => { useComposerDraftStore.setState({ byThread: {} }); });

  it('没写过草稿的 thread 读出来是 undefined —— 调用方落到 EMPTY_DRAFT', () => {
    expect(useComposerDraftStore.getState().byThread['t1']).toBeUndefined();
    expect(EMPTY_DRAFT).toEqual({ skill: null, body: '', attachments: [], comments: [], screenshotSeq: 0, notice: null });
  });

  // 这条就是「输入几个字 → 切到 md 编辑器 → 切回来，字没了」的那个 bug：
  // Composer 会被卸载，草稿必须活在组件之外才回得来。
  it('草稿按 thread 存活，组件卸载重挂后原样读回', () => {
    useComposerDraftStore.getState().setDraft('t1', { skill: null, body: '写了一半' });
    expect(useComposerDraftStore.getState().byThread['t1']).toEqual({ ...EMPTY_DRAFT, skill: null, body: '写了一半' });
  });

  it('两个 thread 的草稿互不干扰', () => {
    useComposerDraftStore.getState().setDraft('t1', { skill: null, body: 'A' });
    useComposerDraftStore.getState().setDraft('t2', { skill: SKILL, body: 'B' });
    expect(useComposerDraftStore.getState().byThread['t1']).toEqual({ ...EMPTY_DRAFT, skill: null, body: 'A' });
    expect(useComposerDraftStore.getState().byThread['t2']).toEqual({ ...EMPTY_DRAFT, skill: SKILL, body: 'B' });
  });

  it('setDraft 覆盖同一 thread 的旧草稿', () => {
    useComposerDraftStore.getState().setDraft('t1', { skill: SKILL, body: 'A' });
    useComposerDraftStore.getState().setDraft('t1', { skill: null, body: 'B' });
    expect(useComposerDraftStore.getState().byThread['t1']).toEqual({ ...EMPTY_DRAFT, skill: null, body: 'B' });
  });

  it('clearDraft 只清掉指定 thread（发送后 / 删除 thread 时走这条）', () => {
    useComposerDraftStore.getState().setDraft('t1', { skill: null, body: 'A' });
    useComposerDraftStore.getState().setDraft('t2', { skill: null, body: 'B' });
    useComposerDraftStore.getState().clearDraft('t1');
    expect(useComposerDraftStore.getState().byThread['t1']).toBeUndefined();
    expect(useComposerDraftStore.getState().byThread['t2']).toEqual({ ...EMPTY_DRAFT, skill: null, body: 'B' });
  });

  it('clearDraft 对没有草稿的 thread 是 noop，不换 byThread 引用', () => {
    const before = useComposerDraftStore.getState().byThread;
    useComposerDraftStore.getState().clearDraft('missing');
    expect(useComposerDraftStore.getState().byThread).toBe(before);
  });
});

describe('composerDraftStore —— 附件与批注', () => {
  beforeEach(() => { useComposerDraftStore.setState({ byThread: {} }); });
  const S = () => useComposerDraftStore.getState();

  it('setDraft 只换正文部分：附件与批注留着', () => {
    S().addAttachments('t1', [{ kind: 'file', name: 'a.pdf', absPath: '/p/a.pdf' }]);
    S().addComment('t1', { absPath: '/p/n.md', quote: 'q', note: '', sourceTabId: '/p/n.md' });
    S().setDraft('t1', { skill: null, body: '新正文' });
    const d = S().byThread['t1']!;
    expect(d.body).toBe('新正文');
    expect(d.attachments).toHaveLength(1);
    expect(d.comments).toHaveLength(1);
  });

  it('同一路径不重复添加；粘贴的截图没有路径，两张都留着', () => {
    S().addAttachments('t1', [{ kind: 'file', name: 'a.pdf', absPath: '/p/a.pdf' }]);
    S().addAttachments('t1', [{ kind: 'file', name: 'a.pdf', absPath: '/p/a.pdf' }, { kind: 'file', name: 'b.pdf', absPath: '/p/b.pdf' }]);
    S().addAttachments('t1', [{ kind: 'image', name: '截图 1', absPath: null, data: 'A', mimeType: 'image/png' }]);
    S().addAttachments('t1', [{ kind: 'image', name: '截图 2', absPath: null, data: 'A', mimeType: 'image/png' }]);
    expect(S().byThread['t1']!.attachments.map((a) => a.name)).toEqual(['a.pdf', 'b.pdf', '截图 1', '截图 2']);
  });

  it('截图序号只增不减：删了不复用', () => {
    expect(S().takeScreenshotName('t1')).toBe('截图 1');
    S().addAttachments('t1', [{ kind: 'image', name: '截图 1', absPath: null, data: 'A', mimeType: 'image/png' }]);
    S().removeAttachment('t1', S().byThread['t1']!.attachments[0].id);
    expect(S().takeScreenshotName('t1')).toBe('截图 2');
  });

  it('提示行：setNotice 写上，下一次改动草稿就清掉', () => {
    S().setNotice('t1', '这张图读不出来');
    expect(S().byThread['t1']!.notice).toBe('这张图读不出来');
    S().setDraft('t1', { skill: null, body: 'x' });
    expect(S().byThread['t1']!.notice).toBeNull();
  });

  it('clearComments 也清掉 notice', () => {
    S().setNotice('t1', '批注清空');
    expect(S().byThread['t1']!.notice).toBe('批注清空');
    S().clearComments('t1');
    expect(S().byThread['t1']!.notice).toBeNull();
  });

  it('批注：addComment 返回 id，按 id 删；clearComments 只清批注', () => {
    const id = S().addComment('t1', { absPath: '/p/n.md', quote: 'q1', note: '', sourceTabId: '/p/n.md' });
    S().addComment('t1', { absPath: '/p/n.md', quote: 'q2', note: '', sourceTabId: '/p/n.md' });
    S().addAttachments('t1', [{ kind: 'file', name: 'a.pdf', absPath: '/p/a.pdf' }]);
    S().removeComment('t1', id);
    expect(S().byThread['t1']!.comments.map((c) => c.quote)).toEqual(['q2']);
    S().clearComments('t1');
    expect(S().byThread['t1']!.comments).toEqual([]);
    expect(S().byThread['t1']!.attachments).toHaveLength(1);
  });

  it('restoreDraft：当前草稿是空的就放回；当前已经写了东西就不覆盖', () => {
    const snap = { ...EMPTY_DRAFT, body: '旧的', comments: [{ id: 'c', absPath: '/p/n.md', quote: 'q', note: '', sourceTabId: 't' }] };
    S().restoreDraft('t1', snap);
    expect(S().byThread['t1']).toEqual(snap);
    S().setDraft('t2', { skill: null, body: '新写的' });
    S().restoreDraft('t2', snap);
    expect(S().byThread['t2']!.body).toBe('新写的');
  });

  it('isDraftEmpty：正文、技能、附件、批注任一非空都不算空', () => {
    expect(isDraftEmpty(EMPTY_DRAFT)).toBe(true);
    expect(isDraftEmpty({ ...EMPTY_DRAFT, body: '  ' })).toBe(true);
    expect(isDraftEmpty({ ...EMPTY_DRAFT, body: 'x' })).toBe(false);
    expect(isDraftEmpty({ ...EMPTY_DRAFT, skill: SKILL })).toBe(false);
    expect(isDraftEmpty({ ...EMPTY_DRAFT, attachments: [{ id: 'a', kind: 'file', name: 'a', absPath: '/a' }] })).toBe(false);
    expect(isDraftEmpty({ ...EMPTY_DRAFT, comments: [{ id: 'c', absPath: '/a', quote: 'q', note: '', sourceTabId: 't' }] })).toBe(false);
  });
});
