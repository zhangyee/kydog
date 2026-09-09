import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, findOneWhere, type MiniElement } from '../../test-support/miniReact';

/**
 * **`InstitutionBlock` 的「组件那一半」。**
 *
 * `institutionForm.ts` 里那三个判断有用例守着，但**调用点没有**：评审实测把
 * `:93` 的 `buildSaveArgs({…})` 换回一个内联对象 `{ name, entityID, username, password }`，
 * 三条 gate 全绿 —— 而后果是**每一次保存都带上 `password` 键**，没碰过密码框时那是空串，
 * 协议上等于「清除」。用户改个用户名点保存，**存好的校园密码就没了**，
 * 界面只显示「已保存」。这是本批唯一一条会丢用户数据的缝。
 *
 * 所以这份用例**真的把组件挂载一遍、真的点那个保存按钮**，断言的是
 * `institution.save` 这一次 RPC **到底带了哪些键**（不是「buildSaveArgs 被调用过」）。
 * 对照组（真碰过密码框）证明那条断言不是空绿。
 *
 * 顺带把「显示密码失败之后按码分支」的调用点也钉住：两个错误码要用户做的事正相反，
 * 而组件读不读 `storedPasswordLost` 今天同样没人守。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { InstitutionBlock } = await import('./InstitutionBlock');

type Call = { method: string; args: unknown };

const calls: Call[] = [];
/** 方法 → 这一次要回什么（函数则调用它，可以抛）。 */
let replies: Record<string, (args: unknown) => unknown> = {};

const STORED = {
  name: '清华大学',
  entityID: 'https://idp.tsinghua.edu.cn/idp/shibboleth',
  username: '2020210001',
  hasPassword: true,
};

/** 哨兵：只要它出现在保存请求里，就是密码被顺手带出去了。 */
const SENTINEL = 'S3NT1NEL-pw-do-not-leak';

beforeEach(() => {
  calls.length = 0;
  replies = {
    'institution.get': () => STORED,
    'institution.save': (args) => ({ ...STORED, ...(args as object), hasPassword: true }),
    'institution.revealPassword': () => ({ password: SENTINEL }),
  };
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string, args: unknown) => {
        calls.push({ method, args });
        const r = replies[method];
        if (r === undefined) return Promise.reject(new Error(`没接这条 RPC：${method}`));
        try { return Promise.resolve(r(args)); } catch (e) { return Promise.reject(e); }
      },
    },
  };
});

afterEach(() => { delete (globalThis as unknown as Record<string, unknown>).window; });

function lastSave(): Record<string, unknown> {
  const hits = calls.filter((c) => c.method === 'institution.save');
  expect(hits.length).toBeGreaterThan(0);
  return hits[hits.length - 1].args as Record<string, unknown>;
}

/** 一行的 `hint`（「已设置。留空不动它」那句）。 */
function hintOf(tree: unknown, name: string): unknown {
  return findOneWhere(tree, (el: MiniElement) => el.props.name === name).props.hint;
}

async function mounted() {
  const m = mount(InstitutionBlock, {});
  await m.settle();   // institution.get 那次 async effect
  return m;
}

function type(m: { find: (id: string) => MiniElement }, testId: string, value: string): void {
  (m.find(testId).props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}

describe('InstitutionBlock：保存请求里 password 这个键出不出现', () => {
  it('只改了用户名 → 请求里根本没有 password 这个键', async () => {
    const m = await mounted();
    type(m, 'institution-username', '2020999');
    (m.find('institution-save').props.onClick as () => void)();
    await m.settle();

    const args = lastSave();
    expect(Object.keys(args).sort()).toEqual(['entityID', 'name', 'username']);
    expect('password' in args).toBe(false);
    expect(args.username).toBe('2020999');
  });

  it('**对照组**：真碰过密码框就要带上（证明上面那条不是空绿）', async () => {
    const m = await mounted();
    type(m, 'institution-password', 'new-secret');
    (m.find('institution-save').props.onClick as () => void)();
    await m.settle();

    expect(lastSave().password).toBe('new-secret');
  });

  it('清空密码框 = 清除，带一个空串过去（三档里的第二档）', async () => {
    const m = await mounted();
    type(m, 'institution-password', 'x');
    type(m, 'institution-password', '');
    (m.find('institution-save').props.onClick as () => void)();
    await m.settle();

    const args = lastSave();
    expect('password' in args).toBe(true);
    expect(args.password).toBe('');
  });

  it('**刚点过「显示」、没碰密码框**就保存 → 明文一个字都不许上路', async () => {
    const m = await mounted();
    (m.find('institution-reveal').props.onClick as () => void)();
    await m.settle();
    // 明文这时确实在输入框里（组件局部 state），这是最危险的那一格。
    expect(m.find('institution-password').props.value).toBe(SENTINEL);

    type(m, 'institution-username', '2020999');
    (m.find('institution-save').props.onClick as () => void)();
    await m.settle();

    const args = lastSave();
    expect('password' in args).toBe(false);
    expect(JSON.stringify(args)).not.toContain(SENTINEL);
  });
});

describe('InstitutionBlock：显示密码失败之后按码分支', () => {
  it('密文永久解不开 → 「已设置」换成「要重新填」', async () => {
    replies['institution.revealPassword'] = () => {
      throw Object.assign(new Error('存下来的密码解不开了'), { code: 'settings.stored_password_unreadable' });
    };
    const m = await mounted();
    expect(hintOf(m.tree, 'institution-password')).toBe('已设置。留空不动它');

    (m.find('institution-reveal').props.onClick as () => void)();
    await m.settle();

    expect(hintOf(m.tree, 'institution-password')).toBe('已保存的那份解不开了，只能重新填一次');
  });

  it('**对照组**：钥匙串这一刻不可用 → 密码还在，不许说成失效', async () => {
    replies['institution.revealPassword'] = () => {
      throw Object.assign(new Error('系统钥匙串暂时用不了'), { code: 'settings.secure_storage_unavailable' });
    };
    const m = await mounted();
    (m.find('institution-reveal').props.onClick as () => void)();
    await m.settle();

    expect(hintOf(m.tree, 'institution-password')).toBe('已设置。留空不动它');
    // 主进程那句「下一步」原样显示，渲染层不抄第二份措辞。
    expect(m.find('institution-error').props.children).toBe('系统钥匙串暂时用不了');
  });
});
