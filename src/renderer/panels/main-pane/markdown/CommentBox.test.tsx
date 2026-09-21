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
  const key = (k: string, meta = false, isComposing = false) => ({
    key: k, metaKey: meta, ctrlKey: false, nativeEvent: { isComposing }, preventDefault: vi.fn(), stopPropagation: vi.fn(),
  });

  it('⌘↵ 交出写好的批注；单按 ↵ 不交（交给文本框换行）', () => {
    const { input, onSubmit } = setup();
    input().props.onChange({ target: { value: '补一组对照' } });
    input().props.onKeyDown(key('Enter'));
    expect(onSubmit).not.toHaveBeenCalled();
    input().props.onKeyDown(key('Enter', true));
    expect(onSubmit).toHaveBeenCalledWith('补一组对照');
  });

  it('输入法组字中的 Esc / ⌘↵ 交给输入法：不取消、不添加（CommentBox 真把 nativeEvent.isComposing 传下去了）', () => {
    const { input, onSubmit, onCancel } = setup();
    input().props.onChange({ target: { value: '补一组' } });
    // 正向：不在组字时，同样的 Esc / ⌘↵ 确实会取消 / 添加。
    input().props.onKeyDown(key('Escape'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    input().props.onKeyDown(key('Enter', true));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    input().props.onKeyDown(key('Escape', false, true));
    input().props.onKeyDown(key('Enter', true, true));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Esc 取消；说明行写明进哪个对话、用哪个键', () => {
    const { m, input, onCancel } = setup();
    input().props.onKeyDown(key('Escape'));
    expect(onCancel).toHaveBeenCalled();
    expect(JSON.stringify(m.tree)).toContain('进「综述」的输入框 · ⌘↵');
  });
});

describe('CommentBox —— 定位与对焦（修复：visibility:hidden 挡住 autoFocus）', () => {
  beforeEach(() => {
    (globalThis as any).window = { kydog: { platform: 'darwin' }, innerWidth: 1000, innerHeight: 800 };
    (globalThis as any).document = { body: {} };
  });

  it('定位算出来后用 opacity 而不是 visibility 藏；pos 一变就重新显式抢一次焦点（不止挂载那一刻）', () => {
    const onSubmit = vi.fn(); const onCancel = vi.fn();
    const m = mount(CommentBox, { quote: 'q', targetTitle: '综述', anchor: { left: 0, top: 0, bottom: 10 }, onSubmit, onCancel });
    const box = () => findAllWhere(m.tree as never, (el) => el.props['data-testid'] === 'comment-box')[0];
    const input = () => findAllWhere(m.tree as never, (el) => el.props['data-testid'] === 'comment-box-input')[0];

    // 正向：定位落地后（miniReact 的假 rect 永远非 undefined，pos 在挂载时就已经算出来了）
    // 用的是 opacity（可对焦），不是 visibility:hidden（Chromium 不给隐藏元素对焦，
    // autoFocus 会落空，这正是发现 1 的根因）。
    expect(box().props.style).toMatchObject({ opacity: 1, pointerEvents: 'auto' });
    expect(box().props.style).not.toHaveProperty('visibility');

    // 挂载时那次 focus() 已经调过了，这里再拿到同一个假元素装个 spy，换一个不同的锚点
    // 逼 pos 重新算一遍（对象引用必换，见 placeCommentBox 每次都返回新对象），验证
    // 「重新定位后再抢一次焦点」这条效果确实接在 [pos] 上，不是只在首次挂载那一刻抢过一次。
    const fakeTextarea = input().props.ref.current;
    const spy = vi.spyOn(fakeTextarea, 'focus');
    m.rerender({ quote: 'q', targetTitle: '综述', anchor: { left: 400, top: 400, bottom: 420 }, onSubmit, onCancel });
    expect(spy).toHaveBeenCalled();
  });
});

describe('CommentBox —— 写了一半的批注（F5：md 标签切走时框不渲染，切回来接着写）', () => {
  beforeEach(() => {
    (globalThis as any).window = { kydog: { platform: 'darwin' }, innerWidth: 1000, innerHeight: 800 };
    (globalThis as any).document = { body: {} };
  });
  const base = { quote: 'q', targetTitle: '综述', anchor: { left: 0, top: 0, bottom: 10 }, onCancel: vi.fn() };
  const input = (m: { tree: unknown }) => findAllWhere(m.tree as never, (el) => el.props['data-testid'] === 'comment-box-input')[0];

  it('initialNote 是输入框的初值；每次改字都报给 onNoteChange；添加交出的是改过的字', () => {
    // 对照：不给 initialNote 就是空的 —— 下面的「写了一半」确实来自这个 prop，不是别处的默认值。
    const plain = mount(CommentBox, { ...base, onSubmit: vi.fn() });
    expect(input(plain).props.value).toBe('');

    const onNoteChange = vi.fn(); const onSubmit = vi.fn();
    const m = mount(CommentBox, { ...base, onSubmit, initialNote: '写了一半', onNoteChange });
    expect(input(m).props.value).toBe('写了一半');
    input(m).props.onChange({ target: { value: '写了一半，补完' } });
    expect(onNoteChange).toHaveBeenLastCalledWith('写了一半，补完');
    expect(input(m).props.value).toBe('写了一半，补完');
    input(m).props.onKeyDown({ key: 'Enter', metaKey: true, ctrlKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onSubmit).toHaveBeenCalledWith('写了一半，补完');
  });
});

