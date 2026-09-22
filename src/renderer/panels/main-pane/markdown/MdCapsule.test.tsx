import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { findAllWhere, mount } from '../../../../test-support/miniReact';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { MdCapsule } = await import('./MdCapsule');
const { IconButton, Tooltip } = await import('../../../shared');

describe('MdCapsule', () => {
  const btn = (tree: unknown) => findAllWhere(tree as never, (el) => el.type === IconButton && el.props.testId === 'md-comment-mode')[0];
  // 评论键那一颗的 Tooltip：分享键导出中时外面也会包一层 Tooltip（正在导出…），
  // 只数「包着评论键」那颗才是这条用例守的东西——数全部 Tooltip 在分享键忙的场景下会被带偏。
  const commentTips = (tree: unknown) => findAllWhere(tree as never, (el) => el.type === Tooltip && el.props.children === btn(tree))
    .filter((el) => el.props.content === '先打开一个对话');

  const base = { exportOpen: false, exporting: false, onToggleExport: () => {} };

  it('有对话：可点、tooltip「评论」、active 跟着模式、开着时走 accent 强调态；没对话：禁用，IconButton 自己因为 disabled 不会渲染 tooltip（见 IconButton.tsx），外面手动包一层 Tooltip 补上「先打开一个对话」', () => {
    // 没对话这条先来：正向证明「树上找得到 Tooltip、content 对」——下面「有对话时不额外包
    // Tooltip」那句 toHaveLength(0) 靠的就是这同一个 tips() 查找，得先证明它真的找得到东西，
    // 不是查找本身坏了才导致「找不到」（CLAUDE.md 否定断言的要求）。
    const none = mount(MdCapsule, { commentMode: false, canComment: false, onToggleComment: () => {}, ...base });
    expect(btn(none.tree).props).toMatchObject({ disabled: true, tooltip: '先打开一个对话' });
    const noneTips = commentTips(none.tree);
    expect(noneTips).toHaveLength(1);
    expect(noneTips[0].props.content).toBe('先打开一个对话');

    // 正向：开着时 active 为 true、activeVariant 走 accent（Issue 3：比默认的淡背景更显眼）。
    const on = mount(MdCapsule, { commentMode: true, canComment: true, onToggleComment: () => {}, ...base });
    expect(btn(on.tree).props).toMatchObject({ disabled: false, tooltip: '评论', active: true, activeVariant: 'accent' });
    expect(on.find('md-capsule').props['data-comment-mode']).toBe('on');
    // 有对话：按钮没 disabled，IconButton 自己那套 tooltip 已经够用，不用再手动包一层。
    expect(commentTips(on.tree)).toHaveLength(0);

    // 反向：关着时 active 回 false——activeVariant 这颗 prop 本身没变（IconButton 内部
    // 靠 active && activeVariant==='accent' 一起判定，才不会在关着时也显强调色，见
    // IconButton.test.tsx），上面已经先证明 active:true 那条能被这条查找抓到。
    const off = mount(MdCapsule, { commentMode: false, canComment: true, onToggleComment: () => {}, ...base });
    expect(btn(off.tree).props).toMatchObject({ active: false, activeVariant: 'accent' });
  });

  it('分享键：tooltip「导出 PDF」、卡片开着时 accent 开关态；导出中禁用 + 转圈 + 外包「正在导出…」，且不显示卡片', () => {
    const share = (tree: unknown) => findAllWhere(tree as never, (el) => el.type === IconButton && el.props.testId === 'md-export')[0];
    const card = vi.fn(() => createElement('div', { 'data-testid': 'fake-card' }));
    const props = { commentMode: false, canComment: true, onToggleComment: () => {}, onToggleExport: () => {}, renderExportCard: card };

    const open = mount(MdCapsule, { ...props, exportOpen: true, exporting: false });
    expect(share(open.tree).props).toMatchObject({ tooltip: '导出 PDF', active: true, activeVariant: 'accent', disabled: false });
    expect(open.query('fake-card')).not.toBeNull();   // 正向：开着且不在导出 → 卡片在
    expect(card).toHaveBeenCalledWith(expect.objectContaining({ current: expect.anything() }));

    const closed = mount(MdCapsule, { ...props, exportOpen: false, exporting: false });
    expect(share(closed.tree).props.active).toBe(false);
    expect(closed.query('fake-card')).toBeNull();

    const busy = mount(MdCapsule, { ...props, exportOpen: true, exporting: true });
    expect(share(busy.tree).props).toMatchObject({ disabled: true, tooltip: '正在导出…' });
    expect(busy.query('md-export-spinner')).not.toBeNull();
    expect(findAllWhere(busy.tree as never, (el) => el.type === Tooltip && el.props.content === '正在导出…')).toHaveLength(1);
    expect(busy.query('fake-card')).toBeNull();

    // 翻面：canComment 不影响分享键（spec「分享键不依赖是否有对话」）——上面 open/closed/busy
    // 三条用的都是 canComment: true，这里把它翻成 false 再核一遍非导出中的状态，分享键该是
    // 什么样还是什么样，不会被评论那边「没对话就禁用」的规则带偏。
    const noThread = mount(MdCapsule, { ...props, canComment: false, exportOpen: false, exporting: false });
    expect(share(noThread.tree).props).toMatchObject({ disabled: false, tooltip: '导出 PDF' });
  });
});
