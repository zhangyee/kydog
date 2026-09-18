import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, findAllWhere } from '../../test-support/miniReact';
import type { HarnessFileName, HarnessFileStatus, HarnessTemplateState } from '../../shared/types';

/**
 * **启动时只问「有新模板」的那几份，文件不存在的不问**（`e2e/64-harness-template-update`
 * 的 64c 挪下来的那一半）。
 *
 * 判据是 `harness.status` 回来的 `template === 'available'`。文件不存在（`'missing'`）
 * 是另一件事：没有旧文件可备份、也没有「更新会不会丢东西」可说，去长期记忆页里「创建」就行，
 * 启动时弹框问它只会让一个从没写过这份文件的用户莫名其妙。主进程那一侧（文件没了 →
 * `'missing'`）钉在 `harnessAssess.test.ts` / `harnessService.test.ts`。
 *
 * 渲染用 miniReact（见 `src/test-support/miniReact.ts` 顶部）：挂载 → effect 里真的调
 * `window.kydog.invoke('harness.status')` → 等它落地 → 读重渲染出来的树。
 * `createPortal` 换成原样返回子树：真的 portal 对象不是元素（没有 `type` / `props`），
 * miniReact 的 `walk` 走不进去；挂到哪个 DOM 节点上这一层本来也看不见。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

vi.mock('react-dom', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-dom')>();
  return { ...real, createPortal: (node: unknown) => node };
});

const { HarnessUpdateDialog } = await import('./HarnessUpdateDialog');

const calls: Array<{ method: string; args: unknown }> = [];
let statusFiles: HarnessFileStatus[] = [];

beforeEach(() => {
  calls.length = 0;
  statusFiles = [];
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string, args: unknown) => {
        calls.push({ method, args });
        if (method === 'harness.status') return Promise.resolve({ files: statusFiles });
        return Promise.reject(new Error(`这份用例没料到会调 ${method}`));
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as { document: unknown }).document = { body: {} };
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).window;
  delete (globalThis as unknown as Record<string, unknown>).document;
});

const file = (name: HarnessFileName, template: HarnessTemplateState): HarnessFileStatus => ({
  name, template,
  edit: template === 'available' || template === 'kept' ? 'unchanged' : null,
  templateLocale: 'zh', localeDiffers: false,
});

/** 对话框里列出来问的那几份，按出现次序。 */
const askedRows = (tree: unknown): string[] =>
  findAllWhere(tree, (el) => typeof el.props['data-testid'] === 'string' && el.props['data-testid'].startsWith('harness-update-row-'))
    .map((el) => (el.props['data-testid'] as string).slice('harness-update-row-'.length));

describe('HarnessUpdateDialog：启动时只问 template === available 的那几份', () => {
  /** 64c 原样：同一份 AGENTS.md，只翻 template 这一个字段。另两份一份最新、一份选过保持。 */
  it('AGENTS.md 有新模板时问它；只把它翻成「文件不存在」，对话框就不弹（查询照样算落定成功）', async () => {
    statusFiles = [file('SOUL.md', 'latest'), file('USER.md', 'kept'), file('AGENTS.md', 'available')];
    const onAvailable = vi.fn();
    const asked = mount(HarnessUpdateDialog, { onSettled: onAvailable });
    await asked.settle();
    expect(calls.map((c) => c.method)).toEqual(['harness.status']);
    expect(asked.query('harness-update-dialog')).not.toBeNull();
    expect(askedRows(asked.tree)).toEqual(['AGENTS.md']);
    expect(onAvailable).toHaveBeenCalledWith(true);
    asked.unmount();

    calls.length = 0;
    statusFiles = [file('SOUL.md', 'latest'), file('USER.md', 'kept'), file('AGENTS.md', 'missing')];
    const onMissing = vi.fn();
    const quiet = mount(HarnessUpdateDialog, { onSettled: onMissing });
    await quiet.settle();
    // 前提：查询确实发出去、也确实落定了 —— 不是「还没回来所以没弹」
    expect(calls.map((c) => c.method)).toEqual(['harness.status']);
    expect(onMissing).toHaveBeenCalledWith(true);
    expect(quiet.query('harness-update-dialog')).toBeNull();
    expect(askedRows(quiet.tree)).toEqual([]);
    quiet.unmount();
  });

  it('一份文件不存在、另两份有新模板：只列那两份，次序照原样', async () => {
    statusFiles = [file('SOUL.md', 'available'), file('USER.md', 'missing'), file('AGENTS.md', 'available')];
    const m = mount(HarnessUpdateDialog, { onSettled: vi.fn() });
    await m.settle();
    expect(askedRows(m.tree)).toEqual(['SOUL.md', 'AGENTS.md']);
    expect(m.query('harness-update-row-USER.md')).toBeNull();
    m.unmount();
  });
});
