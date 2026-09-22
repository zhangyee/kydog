import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findAllWhere, mount } from '../../../../test-support/miniReact';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { MdExportCard } = await import('./MdExportCard');

type Listener = { type: string; fn: (e: unknown) => void; capture: boolean };
let listeners: Listener[] = [];
beforeEach(() => {
  listeners = [];
  (globalThis as any).window = {
    addEventListener: (type: string, fn: (e: unknown) => void, opt?: boolean | { capture?: boolean }) =>
      listeners.push({ type, fn, capture: opt === true || (typeof opt === 'object' && !!opt?.capture) }),
    removeEventListener: (type: string, fn: unknown) => { listeners = listeners.filter((l) => !(l.type === type && l.fn === fn)); },
  };
});

const OPTS = { paper: 'letter' as const, margin: 'narrow' as const, pageNumbers: false };
const props = (over: Record<string, unknown> = {}) => ({
  fileName: 'ch3.md', options: OPTS, onChange: vi.fn(), onExport: vi.fn(), onClose: vi.fn(),
  boundary: { current: { contains: (n: Node) => n === (INSIDE as unknown as Node) } }, ...over,
});
const INSIDE = { inside: true };

describe('MdExportCard', () => {
  it('标题与文件名；选中态跟着 options（夹具取非默认值：Letter / 窄 / 页码关）', () => {
    const m = mount(MdExportCard, props());
    expect(m.find('md-export-card')).toBeTruthy();
    expect(m.find('md-export-paper-letter').props['aria-pressed']).toBe(true);
    expect(m.find('md-export-paper-a4').props['aria-pressed']).toBe(false);
    expect(m.find('md-export-margin-narrow').props['aria-pressed']).toBe(true);
    expect(m.find('md-export-margin-standard').props['aria-pressed']).toBe(false);
    expect(m.find('md-export-page-numbers').props['aria-checked']).toBe(false);
    const texts = findAllWhere(m.tree as never, (el) => typeof el.props.children === 'string').map((el) => el.props.children);
    expect(texts).toEqual(expect.arrayContaining(['导出 PDF', 'ch3.md', '纸张', '边距', '页码', '导出…']));
  });

  it('点选项 → onChange 只带那一项；点「导出…」→ onExport', () => {
    const p = props();
    const m = mount(MdExportCard, p);
    m.find('md-export-paper-a4').props.onClick();
    expect(p.onChange).toHaveBeenLastCalledWith({ paper: 'a4' });
    m.find('md-export-margin-standard').props.onClick();
    expect(p.onChange).toHaveBeenLastCalledWith({ margin: 'standard' });
    m.find('md-export-page-numbers').props.onClick();
    expect(p.onChange).toHaveBeenLastCalledWith({ pageNumbers: true });
    m.find('md-export-go').props.onClick();
    expect(p.onExport).toHaveBeenCalledTimes(1);
  });

  it('Esc（捕获阶段、并 preventDefault，免得评论模式的 Esc 也跟着退出）与点卡片外 → onClose；点里面不关', () => {
    const p = props();
    mount(MdExportCard, p);
    const key = listeners.find((l) => l.type === 'keydown')!;
    expect(key.capture).toBe(true);
    const e = { key: 'Escape', preventDefault: vi.fn(), defaultPrevented: false };
    key.fn(e);
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
    key.fn({ key: 'a', preventDefault: vi.fn() });
    expect(p.onClose).toHaveBeenCalledTimes(1);

    const down = listeners.find((l) => l.type === 'mousedown')!;
    down.fn({ target: INSIDE });          // 正向对照：点里面（含分享键所在的那一格）不关
    expect(p.onClose).toHaveBeenCalledTimes(1);
    down.fn({ target: { outside: true } });
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });

  it('卸载时摘掉监听', () => {
    const m = mount(MdExportCard, props());
    expect(listeners.length).toBe(2);
    m.unmount();
    expect(listeners.length).toBe(0);
  });
});
