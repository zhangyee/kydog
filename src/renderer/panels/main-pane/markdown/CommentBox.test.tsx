import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, findAllWhere } from '../../../../test-support/miniReact';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});
// 让 portal 里的批注框落在树上，接线用例才找得到它（照 Tooltip.test.tsx）。
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: unknown) => node,
}));

const { CommentBox, placeCommentBox } = await import('./CommentBox');

describe('placeCommentBox', () => {
  const vp = { width: 1000, height: 800 };
  it('下面放得下就放选区下方；放不下翻到选区上方；横向钳进视口', () => {
    expect(placeCommentBox({ left: 100, top: 200, bottom: 220 }, { width: 320, height: 150 }, vp)).toEqual({ left: 100, top: 228 });
    expect(placeCommentBox({ left: 100, top: 600, bottom: 700 }, { width: 320, height: 150 }, vp)).toEqual({ left: 100, top: 442 });
    expect(placeCommentBox({ left: 900, top: 200, bottom: 220 }, { width: 320, height: 150 }, vp).left).toBe(672);
  });
});

describe('CommentBox —— 按键', () => {
  beforeEach(() => {
    (globalThis as any).window = { kydog: { platform: 'darwin' }, innerWidth: 1000, innerHeight: 800 };
    (globalThis as any).document = { body: {} };
  });
  function setup() {
    const onSubmit = vi.fn(); const onCancel = vi.fn();
    const m = mount(CommentBox, { quote: 'q', targetTitle: '综述', anchor: { left: 0, top: 0, bottom: 10 }, onSubmit, onCancel });
    const input = () => findAllWhere(m.tree as never, (el) => el.props['data-testid'] === 'comment-box-input')[0];
    return { m, input, onSubmit, onCancel };
  }
  const key = (k: string, meta = false) => ({ key: k, metaKey: meta, ctrlKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });

  it('⌘↵ 交出写好的批注；单按 ↵ 不交（交给文本框换行）', () => {
    const { input, onSubmit } = setup();
    input().props.onChange({ target: { value: '补一组对照' } });
    input().props.onKeyDown(key('Enter'));
    expect(onSubmit).not.toHaveBeenCalled();
    input().props.onKeyDown(key('Enter', true));
    expect(onSubmit).toHaveBeenCalledWith('补一组对照');
  });

  it('Esc 取消；说明行写明进哪个对话、用哪个键', () => {
    const { m, input, onCancel } = setup();
    input().props.onKeyDown(key('Escape'));
    expect(onCancel).toHaveBeenCalled();
    expect(JSON.stringify(m.tree)).toContain('进「综述」的输入框 · ⌘↵');
  });
});
