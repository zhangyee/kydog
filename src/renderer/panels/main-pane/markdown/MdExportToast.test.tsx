import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findAllWhere, mount } from '../../../../test-support/miniReact';
import type { ExportToast } from './MdExportToast';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { MdExportToast, MdExportToastBody, revealLabel } = await import('./MdExportToast');
const { TOAST_MS } = await import('../../workspace/SidebarToast');

const DONE = { id: 1, kind: 'done' as const, pdfPath: '/p/ch3.pdf', fileName: 'ch3.pdf' };
const FAILED = { id: 2, kind: 'failed' as const, message: '导出超时（60 秒）' };
// 泛型而不是 `toast: unknown`：DONE / FAILED 是判别联合的具体成员，传 unknown 会在
// mount(MdExportToastBody, …) 那几处把 toast 精确类型抹掉——tsc 就会在 'toast' 字段上报错
// （unknown 不能赋给 ExportToast）。泛型让每次调用按实参字面量类型推断，null / DONE / FAILED 各自成立。
const props = <T extends ExportToast | null>(toast: T, over: Record<string, unknown> = {}) => ({
  toast, platform: 'darwin', onOpen: vi.fn(), onReveal: vi.fn(), onDismiss: vi.fn(), ...over,
});
const texts = (tree: unknown) => findAllWhere(tree as never, (el) => typeof el.props.children === 'string').map((el) => el.props.children);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('revealLabel', () => {
  it('按平台', () => {
    expect(revealLabel('darwin')).toBe('在访达中显示');
    expect(revealLabel('win32')).toBe('在资源管理器中显示');
    expect(revealLabel('linux')).toBe('在文件夹中显示');
  });
});

describe('MdExportToast', () => {
  it('没有 toast 不渲染；有就交给按 id 换 key 的 Body', () => {
    expect(mount(MdExportToast, props(null)).tree).toBeNull();
    const m = mount(MdExportToast, props(DONE));
    const body = findAllWhere(m.tree as never, (el) => el.type === MdExportToastBody)[0];
    expect(body.key).toBe('1');
  });
});

describe('MdExportToastBody', () => {
  it('成功：「已导出 <文件名>」+ 打开 + 在访达中显示；两个动作带上 pdfPath', () => {
    const p = props(DONE);
    const m = mount(MdExportToastBody, p);
    expect(texts(m.tree)).toEqual(expect.arrayContaining(['已导出 ch3.pdf', '打开', '在访达中显示']));
    m.find('md-export-open').props.onClick();
    expect(p.onOpen).toHaveBeenCalledWith('/p/ch3.pdf');
    m.find('md-export-reveal').props.onClick();
    expect(p.onReveal).toHaveBeenCalledWith('/p/ch3.pdf');
  });

  it('失败：「导出失败：<原因>」，没有两个动作', () => {
    const ok = mount(MdExportToastBody, props(DONE));
    expect(ok.query('md-export-open')).not.toBeNull();   // 正向：成功时找得到
    const m = mount(MdExportToastBody, props(FAILED));
    expect(texts(m.tree)).toContain('导出失败：导出超时（60 秒）');
    expect(m.query('md-export-open')).toBeNull();
    expect(m.query('md-export-reveal')).toBeNull();
  });

  it('TOAST_MS 后自动消失；悬停期间不计时', () => {
    const p = props(DONE);
    const m = mount(MdExportToastBody, p);
    m.find('md-export-toast').props.onMouseEnter();
    vi.advanceTimersByTime(TOAST_MS + 1);
    expect(p.onDismiss).not.toHaveBeenCalled();
    m.find('md-export-toast').props.onMouseLeave();
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(p.onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(p.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('文字过长时省略、整句在 title 里（成功与失败都是）；两个动作键不被压缩', () => {
    const long = { ...DONE, fileName: `${'很长的文件名'.repeat(20)}.pdf` };
    const m = mount(MdExportToastBody, props(long));
    const text = m.find('md-export-toast-text');
    expect(text.props.children).toBe(`已导出 ${long.fileName}`);
    expect(text.props.title).toBe(`已导出 ${long.fileName}`);
    expect(text.props.style).toMatchObject({ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' });
    for (const id of ['md-export-open', 'md-export-reveal']) expect(m.find(id).props.style, id).toMatchObject({ flexShrink: 0 });
    // 盒子本身不超出这个标签：宽度随内容、封顶在标签宽（不是 left: 50% 剩下的半宽）
    expect(m.find('md-export-toast').props.style).toMatchObject({ width: 'max-content', maxWidth: 'calc(100% - 32px)' });
    expect(mount(MdExportToastBody, props(FAILED)).find('md-export-toast-text').props.title).toBe('导出失败：导出超时（60 秒）');
  });

  it('Windows 文案', () => {
    expect(texts(mount(MdExportToastBody, props(DONE, { platform: 'win32' })).tree)).toContain('在资源管理器中显示');
  });
});
