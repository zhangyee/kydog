import { describe, it, expect } from 'vitest';
import { applyClick, effectiveSelection, visibleThreadOrder, EMPTY_SELECTION } from './sidebarSelection';
import { applyProjectsView } from './projectsView';
import type { Project, Thread } from '../../../shared/types';

/**
 * 点选语义照 Finder（spec 2026-09-21-thread-archive-design §2.2）：高亮着的当前对话本身就算
 * 「被选中的那一个」；⇧ 从锚点（缺省是当前对话）选到这一行；⌘ 在多选为空时先放进当前对话再切换。
 *
 * 可见顺序两组：a 组三条、b 组两条。区间用例都断言中间那一行在里面 —— 只断两端的话，
 * 「只选两端」的实现也会绿。
 */
const ORDER = ['a1', 'a2', 'a3', 'b1', 'b2'];
const ctx = (currentId: string | null = 'a1', order: readonly string[] = ORDER) => ({ order, currentId });
const sel = (selectedIds: string[], anchorId: string | null) => ({ selectedIds, anchorId });

describe('applyClick：⇧', () => {
  it('锚点缺省是当前对话：a1 当前，⇧ a3 → a1 a2 a3，锚点仍是 a1', () => {
    expect(applyClick(EMPTY_SELECTION, { id: 'a3', shift: true, toggle: false }, ctx('a1')))
      .toEqual(sel(['a1', 'a2', 'a3'], 'a1'));
  });

  it('跨项目：锚点 a2，⇧ b1 → a2 a3 b1', () => {
    expect(applyClick(sel([], 'a2'), { id: 'b1', shift: true, toggle: false }, ctx('a1')))
      .toEqual(sel(['a2', 'a3', 'b1'], 'a2'));
  });

  it('反方向：锚点 b2，⇧ a3 → 按可见顺序 a3 b1 b2', () => {
    expect(applyClick(sel([], 'b2'), { id: 'a3', shift: true, toggle: false }, ctx('a1')))
      .toEqual(sel(['a3', 'b1', 'b2'], 'b2'));
  });

  it('⇧ 不移动锚点：锚点 a1，先 ⇧ a3 再 ⇧ a2 → a1 a2', () => {
    const s1 = applyClick(sel([], 'a1'), { id: 'a3', shift: true, toggle: false }, ctx('a1'));
    expect(applyClick(s1, { id: 'a2', shift: true, toggle: false }, ctx('a1'))).toEqual(sel(['a1', 'a2'], 'a1'));
  });

  it('锚点不可见（它的项目收起了）→ 退化成只选这一行、锚点换成它', () => {
    expect(applyClick(sel([], 'a1'), { id: 'b2', shift: true, toggle: false }, ctx('a1', ['b1', 'b2'])))
      .toEqual(sel(['b2'], 'b2'));
  });
});

describe('applyClick：⌘ / Ctrl', () => {
  it('多选为空时先放进当前对话：a1 当前，⌘ b1 → a1 b1，锚点 b1', () => {
    expect(applyClick(EMPTY_SELECTION, { id: 'b1', shift: false, toggle: true }, ctx('a1')))
      .toEqual(sel(['a1', 'b1'], 'b1'));
  });

  it('当前对话不可见时不放它：⌘ b1 → 只有 b1', () => {
    expect(applyClick(EMPTY_SELECTION, { id: 'b1', shift: false, toggle: true }, ctx('a1', ['b1', 'b2'])))
      .toEqual(sel(['b1'], 'b1'));
  });

  it('⌘ 已选中的行 → 移除；减到 1 个时 effectiveSelection 为空（退出多选）', () => {
    const s = applyClick(sel(['a1', 'b1'], 'b1'), { id: 'a1', shift: false, toggle: true }, ctx('a1'));
    expect(s).toEqual(sel(['b1'], 'a1'));
    expect(effectiveSelection(s.selectedIds, ORDER)).toEqual([]);
    // 正向：再 ⌘ 一行回到 2 个，effectiveSelection 又有了
    const s2 = applyClick(s, { id: 'b2', shift: false, toggle: true }, ctx('a1'));
    expect(effectiveSelection(s2.selectedIds, ORDER)).toEqual(['b1', 'b2']);
  });
});

describe('applyClick：单击', () => {
  it('清空选中、锚点换成这一行', () => {
    expect(applyClick(sel(['a1', 'a2'], 'a1'), { id: 'b1', shift: false, toggle: false }, ctx('a1')))
      .toEqual(sel([], 'b1'));
  });
});

describe('effectiveSelection', () => {
  it('按可见顺序返回，不按点选先后', () => {
    expect(effectiveSelection(['b2', 'a1'], ORDER)).toEqual(['a1', 'b2']);
  });

  it('收起项目下的行不算：a 组收起时 a2 不在里面；a 组展开时同一个选中集把它算回来', () => {
    const chosen = ['a2', 'b1', 'b2'];
    expect(effectiveSelection(chosen, ['b1', 'b2'])).toEqual(['b1', 'b2']);
    expect(effectiveSelection(chosen, ORDER)).toEqual(['a2', 'b1', 'b2']);
  });
});

describe('visibleThreadOrder', () => {
  const proj = (path: string): Project => ({ path, addedAt: '2026-09-01T00:00:00.000Z' });
  const thd = (id: string, projectPath: string, lastActiveAt: string): Thread => ({
    id, projectPath, title: id, createdAt: '2026-09-01T00:00:00.000Z', lastActiveAt,
  });
  const projects = [proj('/a'), proj('/b')];
  const threadsByProject = {
    '/a': [thd('a1', '/a', '2026-09-03'), thd('a2', '/a', '2026-09-02')],
    '/b': [thd('b1', '/b', '2026-09-04')],
  };

  it('按项目分组：只含展开项目的行，按组顺序', () => {
    const view = applyProjectsView({ projects, threadsByProject, groupBy: 'project', sortBy: 'updated' });
    expect(visibleThreadOrder(view, new Set())).toEqual(['a1', 'a2', 'b1']);
    expect(visibleThreadOrder(view, new Set(['/a']))).toEqual(['b1']);
  });

  it('按时间平铺：就是那一列，收起集合不起作用', () => {
    const view = applyProjectsView({ projects, threadsByProject, groupBy: 'time', sortBy: 'updated' });
    expect(visibleThreadOrder(view, new Set(['/a']))).toEqual(['b1', 'a1', 'a2']);
  });
});
