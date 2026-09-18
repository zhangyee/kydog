import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findAllWhere, findOneWhere, type MiniElement } from '../../test-support/miniReact';
import type { SettingsFile } from '../../shared/types';

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

type Research = SettingsFile['research'];

/** research.get 的回复。默认空；需要已有自定义变量的用例自己换掉。 */
let stored: Research = { presets: {}, custom: [] };
/** research.save 收到的每一份负载。 */
let saves: Research[] = [];

beforeEach(() => {
  F.institutionOpen = true;
  stored = { presets: {}, custom: [] };
  saves = [];
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string, args?: unknown) => {
        if (method === 'research.get') return Promise.resolve(stored);
        // 主进程的 normalizeResearch 不丢条目、不改顺序：这里原样回显，够用
        if (method === 'research.save') { saves.push(args as Research); return Promise.resolve(args); }
        return Promise.reject(new Error(`没接这条 RPC：${method}`));
      },
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

const click = (el: MiniElement) => { (el.props.onClick as () => void)(); };
/** 自定义区的变量行：只有它们带 `onRemove`（预设行没有删除按钮）。VarRow 不导出，按 props 认。 */
const customRows = (tree: unknown) => findAllWhere(tree, (el) => typeof el.props.onRemove === 'function' && 'kind' in el.props);
/** 正在添加的那张小表单。AddVarForm 不导出，按它独有的 `onAdd` 认。 */
const addForm = (tree: unknown) => findOneWhere(tree, (el) => typeof el.props.onAdd === 'function');

describe('新加的自定义变量没确认之前，保存被拦住', () => {
  /**
   * 填了新变量但没点「确定」就点保存，那一行根本还不在 `custom` 里 —— 保存出去的负载里
   * 没有它，内容静默丢失。所以添加表单开着时保存必须是禁用的，并说明为什么。
   */
  it('添加表单开着：保存禁用并给出提示；确认之后恢复可用，新变量进了自定义列表', async () => {
    const m = mount(ResearchCredentialsSection, {});
    await m.settle();
    // 正向起点：没在添加时保存可用、提示不在
    expect(m.find('research-save').props.disabled).toBe(false);
    expect(m.query('research-save-blocked')).toBeNull();

    click(m.find('research-add-var'));
    expect(m.find('research-save').props.disabled).toBe(true);
    expect(m.query('research-save-blocked')).not.toBeNull();

    (addForm(m.tree).props.onAdd as (e: { name: string; kind: 'key'; value: string }) => void)(
      { name: 'AAA_VAR', kind: 'key', value: 'secret-aaa' },
    );
    expect(m.find('research-save').props.disabled).toBe(false);
    expect(m.query('research-save-blocked')).toBeNull();
    expect(customRows(m.tree).map((el) => [el.props.name, el.props.value])).toEqual([['AAA_VAR', 'secret-aaa']]);
  });

  it('取消添加同样放开保存', async () => {
    const m = mount(ResearchCredentialsSection, {});
    await m.settle();
    click(m.find('research-add-var'));
    expect(m.find('research-save').props.disabled).toBe(true);

    (addForm(m.tree).props.onCancel as () => void)();
    expect(m.find('research-save').props.disabled).toBe(false);
  });
});

describe('保存前后自定义行的身份不变', () => {
  /**
   * 每一行的「显示 / 隐藏」是 VarRow 自己的局部 state，跟着 React key 走。保存后要是给每行
   * 重新发 uid，key 一换 React 就卸载重建整行，点开的「显示」每保存一次就被收回去。
   * miniReact 不做协调、VarRow 也不展开，所以这里断的是那个前提本身：**同一行保存前后 key 相同**。
   */
  it('已有的一行与刚加的一行，保存后 key 都与保存前一致，值原样留着', async () => {
    // 两行而不是一行：按位置复用 uid，一行时「位置错一格」看不出来
    stored = { presets: {}, custom: [{ name: 'OLD_KEY', kind: 'key', value: 'old-secret' }] };
    const m = mount(ResearchCredentialsSection, {});
    await m.settle();
    click(m.find('research-add-var'));
    (addForm(m.tree).props.onAdd as (e: { name: string; kind: 'key'; value: string }) => void)(
      { name: 'AAA_VAR', kind: 'key', value: 'secret-aaa' },
    );

    const before = customRows(m.tree).map((el) => el.key);
    expect(before).toHaveLength(2);
    expect(new Set(before).size).toBe(2);

    click(m.find('research-save'));
    await m.settle();
    // 保存确实走完了：负载里有这两行，「已保存」出现
    expect(saves).toHaveLength(1);
    expect(saves[0].custom.map((c) => c.name)).toEqual(['OLD_KEY', 'AAA_VAR']);
    expect(m.query('research-saved')).not.toBeNull();

    const after = customRows(m.tree);
    expect(after.map((el) => el.key)).toEqual(before);
    expect(after.map((el) => [el.props.name, el.props.value])).toEqual([['OLD_KEY', 'old-secret'], ['AAA_VAR', 'secret-aaa']]);
  });
});
