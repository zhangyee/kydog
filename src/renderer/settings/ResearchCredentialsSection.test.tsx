import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findAllWhere } from '../../test-support/miniReact';

/**
 * 「机构账号」那一块跟着 `INSTITUTION_LOGIN_OPEN` 走：关着就不挂 `InstitutionBlock`。
 *
 * 开关是编译期常量，这里换成取值函数，同一条用例里先证明开着时它在、再翻面断它不在 ——
 * 只断「不在」的话，哪天组件改了名或者换了挂法，这条照样绿。
 */

const F = vi.hoisted(() => ({ institutionOpen: true }));
vi.mock('../../shared/features', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/features')>()),
  get INSTITUTION_LOGIN_OPEN() { return F.institutionOpen; },
}));

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { mount } = await import('../../test-support/miniReact');
const { ResearchCredentialsSection } = await import('./ResearchCredentialsSection');
const { InstitutionBlock } = await import('./InstitutionBlock');

beforeEach(() => {
  F.institutionOpen = true;
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string) => method === 'research.get'
        ? Promise.resolve({ presets: {}, custom: [] })
        : Promise.reject(new Error(`没接这条 RPC：${method}`)),
    },
  };
});

afterEach(() => { delete (globalThis as unknown as Record<string, unknown>).window; });

const institutionBlocks = (tree: unknown) => findAllWhere(tree, (el) => el.type === InstitutionBlock);

describe('文献检索密钥页的「机构账号」', () => {
  it('开着时挂在最前；关着时不挂，下面的预设与保存按钮照旧', async () => {
    const m = mount(ResearchCredentialsSection, {});
    await m.settle();   // research.get 那次 async effect，落地前页面只有「装载中…」
    expect(m.query('research-save')).not.toBeNull();
    expect(institutionBlocks(m.tree)).toHaveLength(1);

    F.institutionOpen = false;
    m.rerender({});
    expect(institutionBlocks(m.tree)).toHaveLength(0);
    expect(m.query('research-save')).not.toBeNull();
  });
});
