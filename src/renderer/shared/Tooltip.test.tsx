import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, findAllWhere, type MiniElement } from '../../test-support/miniReact';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});
// 让 portal 里的提示框落在树上，接线用例才找得到它。
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: unknown) => node,
}));

const { Tooltip, tooltipPosition, TOOLTIP_GAP } = await import('./Tooltip');
type Placement = Parameters<typeof tooltipPosition>[0];

/**
 * 提示框要贴在锚点**外面**，不许盖住锚点本身。以前 top / left 只把提示框推了 -50% / 0，
 * 定位点在锚点那条边外 6px，提示框却从那里往回伸 —— PDF 胶囊上每个按钮的提示都压在按钮上。
 *
 * 没有 jsdom：按 transform 的百分比自己算出提示框的盒子（百分比相对提示框自身尺寸），
 * 再和锚点比。
 */
const ANCHOR = { left: 100, top: 200, width: 40, height: 20, right: 140, bottom: 220 };
const TIP = { width: 80, height: 24 };

type Box = { left: number; top: number; right: number; bottom: number };

function boxOf(pos: { x: number; y: number; transform: string }, size = TIP): Box {
  const m = /^translate\((-?\d+)%?, (-?\d+)%?\)$/.exec(pos.transform);
  if (!m) throw new Error(`认不出的 transform：${pos.transform}`);
  const left = pos.x + (Number(m[1]) / 100) * size.width;
  const top = pos.y + (Number(m[2]) / 100) * size.height;
  return { left, top, right: left + size.width, bottom: top + size.height };
}

function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** 提示框与锚点在放置那一侧的缝，以及另一个方向上的居中偏差。 */
function gapAndCentering(p: Placement, box: Box): { gap: number; offCenter: number } {
  const cx = (box.left + box.right) / 2 - (ANCHOR.left + ANCHOR.right) / 2;
  const cy = (box.top + box.bottom) / 2 - (ANCHOR.top + ANCHOR.bottom) / 2;
  if (p === 'top') return { gap: ANCHOR.top - box.bottom, offCenter: cx };
  if (p === 'bottom') return { gap: box.top - ANCHOR.bottom, offCenter: cx };
  if (p === 'left') return { gap: ANCHOR.left - box.right, offCenter: cy };
  return { gap: box.left - ANCHOR.right, offCenter: cy };
}

describe('tooltipPosition：提示框贴在锚点外、不盖住锚点', () => {
  it.each<Placement>(['top', 'bottom', 'left', 'right'])('%s：与锚点不相交；贴着那一侧、恰好隔 GAP、另一方向居中', (p) => {
    const box = boxOf(tooltipPosition(p, ANCHOR));
    expect(intersects(box, ANCHOR)).toBe(false);
    // 正向：不相交不是因为被算到了老远的地方 —— 它就在那一侧、缝恰好是 GAP、另一方向居中。
    expect(gapAndCentering(p, box)).toEqual({ gap: TOOLTIP_GAP, offCenter: 0 });
  });

  it('相交判据本身灵：把 top / left 换回改前的 transform，就判出盖住了锚点', () => {
    const top = tooltipPosition('top', ANCHOR);
    expect(intersects(boxOf(top), ANCHOR)).toBe(false);
    expect(intersects(boxOf({ ...top, transform: 'translate(-50%, 0)' }), ANCHOR)).toBe(true);
    const left = tooltipPosition('left', ANCHOR);
    expect(intersects(boxOf(left), ANCHOR)).toBe(false);
    expect(intersects(boxOf({ ...left, transform: 'translate(0, -50%)' }), ANCHOR)).toBe(true);
  });
});

describe('Tooltip 接线：提示框用的是 tooltipPosition 算出来的 transform', () => {
  beforeEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    // 悬停延时立刻到点，免得等 200ms。
    g.window = { setTimeout: (fn: () => void) => { fn(); return 1; }, clearTimeout: () => {} };
    g.document = { body: {} };
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
  });

  function hoverAndRead(placement: Placement): string | null {
    const m = mount(Tooltip, { content: '提示', placement, children: '按钮' });
    const [wrap] = findAllWhere(m.tree, (el) => el.type === 'span' && typeof el.props.onMouseEnter === 'function');
    expect(findAllWhere(m.tree, (el) => el.props.role === 'tooltip')).toHaveLength(0);
    (wrap.props.onMouseEnter as () => void)();
    const [tip] = findAllWhere(m.tree, (el) => el.props.role === 'tooltip') as MiniElement[];
    return tip ? (tip.props.style.transform as string) : null;
  }

  it('悬停后出现提示框，四个方向的 transform 各自对得上', () => {
    expect(hoverAndRead('top')).toBe('translate(-50%, -100%)');
    expect(hoverAndRead('left')).toBe('translate(-100%, -50%)');
    expect(hoverAndRead('bottom')).toBe('translate(-50%, 0)');
    expect(hoverAndRead('right')).toBe('translate(0, -50%)');
  });
});
