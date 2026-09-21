import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, findAllByProp, queryByTestId } from '../../../test-support/miniReact';

/**
 * **文件树读目录失败时要说出来**。以前 FileTree 与 Row 调 `project.readDir` 只有 `.then`：
 * 读失败是一条 unhandled rejection，界面永远停在「加载中…」—— 用户报「新会话一直加载中」
 * 那次，检视栏的文件树也停在这里，从截图上分不出是还在读、还是已经失败了。
 *
 * miniReact 只渲染最外层组件，`DirError` 是它树里的一个元素，按 props 找。store 变了
 * miniReact 不会自己重渲染（useUiStore 换成了直读），所以每次落地后手动 rerender。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

vi.mock('../../stores/uiStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/uiStore')>();
  const real = mod.useUiStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useUiStore: hook };
});

const { FileTree } = await import('./FileTree');
const { useUiStore } = await import('../../stores/uiStore');

const ROOT = 'C:\\Users\\u\\Desktop\\article';
/** 下一次 readDir 的结局：一个 Error 就拒，否则就给这份列表。 */
let next: Error | Array<{ name: string; path: string; kind: 'file' | 'dir' }> = [];
let reads = 0;

beforeEach(() => {
  reads = 0;
  useUiStore.setState(useUiStore.getInitialState());
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string) => {
        if (method !== 'project.readDir') return Promise.resolve(undefined);
        reads += 1;
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).window;
});

type Props = { projectPath: string };
const errorOf = (tree: unknown) => findAllByProp(tree, 'testId', 'file-tree-error');

describe('FileTree：根目录读失败', () => {
  it('显示错误原文与重试，不停在「加载中」；重试成功后出列表', async () => {
    next = new Error(`cannot read ${ROOT} (EPERM)`);
    const m = mount(FileTree, { projectPath: ROOT } as Props);
    await m.settle();
    m.rerender({ projectPath: ROOT });

    const [err] = errorOf(m.tree);
    expect(err.props.message).toBe(`cannot read ${ROOT} (EPERM)`);
    expect(queryByTestId(m.tree, 'file-tree')).toBeNull();
    // 失败后不自动重试：重渲染几次都只读过那一次。
    m.rerender({ projectPath: ROOT });
    await m.settle();
    expect(reads).toBe(1);

    next = [{ name: 'draft.md', path: `${ROOT}\\draft.md`, kind: 'file' }];
    (err.props.onRetry as () => void)();
    m.rerender({ projectPath: ROOT });
    await m.settle();
    m.rerender({ projectPath: ROOT });
    expect(reads).toBe(2);
    expect(errorOf(m.tree)).toHaveLength(0);
    expect(queryByTestId(m.tree, 'file-tree')).not.toBeNull();
  });
});
