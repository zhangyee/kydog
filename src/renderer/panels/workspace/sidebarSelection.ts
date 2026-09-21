import { create } from 'zustand';
import type { ProjectsView } from './projectsView';

/**
 * 左栏的多选（spec 2026-09-21-thread-archive-design §2.2）。只在内存里。
 *
 * 点选语义照 Finder：高亮着的当前对话本身就算「被选中的那一个」。selectedIds 可以只有 0 / 1 个
 * —— 那不叫多选；多选态是 effectiveSelection() 非空（≥ 2 个**可见**行被选中）。
 * 批量动作、菜单上的数量、勾与底色都只认 effectiveSelection()，不另存一份「可见的选中」。
 */
export type SelectionState = { selectedIds: string[]; anchorId: string | null };
export type ClickInput = { id: string; shift: boolean; toggle: boolean };
export type ClickCtx = { order: readonly string[]; currentId: string | null };

export const EMPTY_SELECTION: SelectionState = { selectedIds: [], anchorId: null };

/** 左栏渲染的顺序：分组时按组、只含展开项目的行；平铺时就是那一列。 */
export function visibleThreadOrder(view: ProjectsView, collapsed: ReadonlySet<string>): string[] {
  if (view.kind === 'flat') return view.threads.map((t) => t.id);
  return view.groups.flatMap((g) => (collapsed.has(g.project.path) ? [] : g.threads.map((t) => t.id)));
}

export function applyClick(s: SelectionState, input: ClickInput, ctx: ClickCtx): SelectionState {
  const { id, shift, toggle } = input;
  if (shift) {
    const anchor = s.anchorId ?? ctx.currentId;
    const to = ctx.order.indexOf(id);
    if (to === -1) return s;
    const from = anchor === null ? -1 : ctx.order.indexOf(anchor);
    // 锚点不可见（项目收起了 / 行已不在）：退化成只选这一行。
    if (from === -1) return { selectedIds: [id], anchorId: id };
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    return { selectedIds: ctx.order.slice(lo, hi + 1), anchorId: anchor };
  }
  if (toggle) {
    const seed = s.selectedIds.length > 0
      ? s.selectedIds
      : (ctx.currentId !== null && ctx.order.includes(ctx.currentId) ? [ctx.currentId] : []);
    const next = seed.includes(id) ? seed.filter((x) => x !== id) : [...seed, id];
    return { selectedIds: next, anchorId: id };
  }
  return { selectedIds: [], anchorId: id };
}

/** 当前可见且被选中的行，按可见顺序；不足 2 个返回空（= 没有多选）。 */
export function effectiveSelection(selectedIds: readonly string[], order: readonly string[]): string[] {
  const chosen = new Set(selectedIds);
  const visible = order.filter((id) => chosen.has(id));
  return visible.length >= 2 ? visible : [];
}

type SelectionStore = SelectionState & {
  click: (input: ClickInput, ctx: ClickCtx) => void;
  clear: () => void;
};

export const useSidebarSelection = create<SelectionStore>((set, get) => ({
  ...EMPTY_SELECTION,
  click: (input, ctx) => set(applyClick({ selectedIds: get().selectedIds, anchorId: get().anchorId }, input, ctx)),
  clear: () => set({ selectedIds: [] }),
}));
