import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '../../../test-support/miniReact';

/**
 * 选单显示的是**模型名**，不是 id —— `deepseek-v4-flash` 与 `deepseek-flash` 只差一代，
 * 光看 id 认不出谁是谁（这条用例就是从那次认错来的）。名字与 id 不同时两个都要在。
 * 照 `Composer.attachments.test.tsx` 的模式：`vi.mock('react')` 换 miniReact 的 hooks，
 * 用到的 store 换成直读 getState 的替身。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

function directRead<M extends Record<string, unknown>>(mod: M, key: keyof M & string): M {
  const real = mod[key] as unknown as { getState: () => unknown };
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as M[typeof key];
  Object.assign(hook as object, real);
  return { ...mod, [key]: hook };
}

vi.mock('../../stores/uiStore', async (orig) => directRead(await orig<typeof import('../../stores/uiStore')>(), 'useUiStore'));
vi.mock('../../stores/threadsStore', async (orig) => directRead(await orig<typeof import('../../stores/threadsStore')>(), 'useThreadsStore'));
vi.mock('../../stores/llmStore', async (orig) => directRead(await orig<typeof import('../../stores/llmStore')>(), 'useLlmStore'));

const { ComposerModelMenu } = await import('./ComposerModelMenu');
const { useLlmStore } = await import('../../stores/llmStore');
const { useThreadsStore } = await import('../../stores/threadsStore');

const PROJ = '/proj';
const THREAD = { id: 't1', projectPath: PROJ, title: 'x', createdAt: 'x', lastActiveAt: 'x' };
const RECT = { left: 0, top: 100, width: 10, height: 10 } as DOMRect;

/** 渲染树上所有的文字节点。 */
function texts(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out; }
  if (node && typeof node === 'object') {
    const props = (node as { props?: { children?: unknown } }).props;
    if (props && 'children' in props) texts(props.children, out);
  }
  return out;
}

function setModels(models: Array<{ id: string; name: string; image: boolean }>, override?: { providerId: string; modelId: string }) {
  useLlmStore.setState({
    configured: [{
      providerId: 'deepseek', displayName: 'DeepSeek', kind: 'apiKey',
      authStatus: { configured: true }, models, defaultModel: models[0]?.id ?? null,
    }] as never,
    defaultProvider: 'deepseek' as never,
    defaultModel: models[0]?.id ?? null,
  });
  useThreadsStore.setState({ threadsByProject: { [PROJ]: [{ ...THREAD, ...(override ? { modelOverride: override } : {}) }] } } as never);
}

describe('ComposerModelMenu', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = {
      kydog: { invoke: vi.fn().mockResolvedValue([]) },
      innerHeight: 800,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    useLlmStore.setState({ configured: [], defaultProvider: null, defaultModel: null } as never);
  });

  it('每个模型显示名字；名字与 id 不同时 id 也在', () => {
    setModels([
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', image: true },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', image: false },
    ]);
    const all = texts(mount(ComposerModelMenu, { threadId: 't1', anchorRect: RECT, onClose: () => {} }).tree);
    expect(all).toContain('DeepSeek V4.1 Flash');
    expect(all).toContain('deepseek-flash');
    expect(all).toContain('DeepSeek V4 Pro');
  });

  it('名字就是 id 时不重复显示两遍（自定义 provider 不填 name 的情形）', () => {
    setModels([{ id: 'my-model', name: 'my-model', image: false }]);
    const all = texts(mount(ComposerModelMenu, { threadId: 't1', anchorRect: RECT, onClose: () => {} }).tree);
    // 顶部「当前默认」一次 + 列表一次 = 2；名字与 id 各排一遍的话就是 4。
    expect(all.filter((t) => t === 'my-model')).toHaveLength(2);
  });

  it('会话钉着清单里没有的模型（已退役）：列表里不出现它，顶部按 id 显示', () => {
    setModels(
      [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', image: true }],
      { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
    );
    const all = texts(mount(ComposerModelMenu, { threadId: 't1', anchorRect: RECT, onClose: () => {} }).tree);
    // 顶部那一处是回落显示（钉着什么显示什么），所以正好一次 —— 列表里没有第二次。
    expect(all.filter((t) => t === 'deepseek-v4-flash')).toHaveLength(1);
    // 正向对照：在售的那个照常既有名字又有 id，证明上面那条不是因为整棵树没渲染出来。
    expect(all).toContain('DeepSeek V4.1 Flash');
    expect(all).toContain('deepseek-flash');
  });
});
