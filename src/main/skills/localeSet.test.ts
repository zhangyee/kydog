import { describe, it, expect, vi } from 'vitest';
import { createLocaleSet } from './localeSet';
import type { SettingsFile, SkillEntry, SkillSyncHealth } from '../../shared/types';

const OK: SkillSyncHealth = { state: 'ok', installedOrUpgraded: [], userSkills: [] };
const FAIL: SkillSyncHealth = { state: 'failed', phase: 'locale-switch', skill: 'demo', message: 'boom' };

/**
 * fake 的 settings 与 skill 列表跟着 `commitLocale` 走，不是常量。
 *
 * 这是「失败时 settings 带回**旧** locale，渲染层直接 set 就自动回滚 UI」那条契约的建模面：
 * fake 若恒返回同一份，`result.settings` 断言什么都证明不了 —— 提交与否根本没被观测。
 */
function deps(over: Partial<Parameters<typeof createLocaleSet>[0]> = {}) {
  let committed: 'zh' | 'en' = 'zh';
  const base = {
    currentLocale: async () => committed,
    hasActiveRun: () => false,
    disposeAllSessions: vi.fn(async () => {}),
    sync: vi.fn(async (_l: 'zh' | 'en', _p: 'startup' | 'onboarding' | 'locale-switch') => OK),
    commitLocale: vi.fn(async (l: 'zh' | 'en') => {
      committed = l;
      return { ui: { locale: l } } as unknown as SettingsFile;
    }),
    // 磁盘现状：locale 只有提交过才变；skill 的 description 跟着当前 locale 走。
    readSettings: async () => ({ ui: { locale: committed } }) as unknown as SettingsFile,
    listSkills: async (): Promise<SkillEntry[]> => [
      { name: 'demo', description: committed === 'zh' ? '中文描述' : 'english description',
        origin: 'builtin', enabled: true, dirPath: '/skills/demo' },
    ],
  };
  return { ...base, ...over };
}

describe('locale.set', () => {
  it('有 run 在跑 → 是业务拒绝（rejected），不是同步失败', async () => {
    const d = deps({ hasActiveRun: () => true });
    const r = await createLocaleSet(d)('en');
    // 关键区分：拒绝时 skill 树根本没被碰过，编成 SkillSyncHealth.failed 会让渲染层
    // 把「同步失败」写进 health store，与主进程记的 ok 直接矛盾。
    expect(r.outcome).toEqual({ kind: 'rejected', message: '有任务正在运行，请等它结束后再切换语言' });
    expect(d.disposeAllSessions).not.toHaveBeenCalled();
    expect(d.sync).not.toHaveBeenCalled();
    expect(d.commitLocale).not.toHaveBeenCalled();
    // 被拒后带回的是原封不动的现状，渲染层照单全收就停在旧语言。
    expect(r.settings.ui.locale).toBe('zh');
    expect(r.skills[0].description).toBe('中文描述');
  });

  it('成功路径：先 dispose 再同步，最后才提交 locale', async () => {
    const order: string[] = [];
    const d = deps({
      disposeAllSessions: vi.fn(async () => { order.push('dispose'); }),
    });
    d.sync = vi.fn(async (_l, p) => { order.push(`sync:${p}`); return OK; });
    const inner = d.commitLocale;
    d.commitLocale = vi.fn(async (l: 'zh' | 'en') => { order.push('commit'); return inner(l); });
    const r = await createLocaleSet(d)('en');
    expect(order).toEqual(['dispose', 'sync:locale-switch', 'commit']);
    expect(r.outcome).toEqual({ kind: 'applied', sync: OK });
    // 成功时三样一起翻到新语言 —— 渲染层不必再补一次 skill.list。
    expect(r.settings.ui.locale).toBe('en');
    expect(r.skills[0].description).toBe('english description');
  });

  it('同步失败 → 按旧 locale 重投影一次，locale 不提交，带回的仍是旧语言', async () => {
    const seen: string[] = [];
    const d = deps();
    d.sync = vi.fn(async (loc, _p) => { seen.push(loc); return loc === 'en' ? FAIL : OK; });
    const r = await createLocaleSet(d)('en');
    expect(seen).toEqual(['en', 'zh']);            // 第二次是向前重投影回旧语言
    expect(d.commitLocale).not.toHaveBeenCalled();
    // health 是**重投影之后**那棵树（ok），sync 才是这次没切成的原因 —— 两者分开。
    expect(r.outcome).toEqual({ kind: 'failed', sync: FAIL, health: OK });
    // 契约核心：settings 带回旧 locale，渲染层一次 setSettings 就把 UI 钉回原样。
    expect(r.settings.ui.locale).toBe('zh');
    expect(r.skills[0].description).toBe('中文描述');
  });

  it('重投影成功 → health 描述的是重投影之后那棵树，与主进程 getHealth() 是同一个答案', async () => {
    // 回归：曾经只带回 failure，渲染层照写 health store，于是 Settings 说「skill 同步失败」，
    // 而此刻磁盘上是完好的旧语言树、主进程 cached 已被重投影覆盖成 ok —— 两边相反。
    // 这里用两份**可区分**的 ok，钉住返回的是重投影那一次的结果，不是随便一个 ok。
    const RESTORED_OK: SkillSyncHealth = { state: 'ok', installedOrUpgraded: ['demo'], userSkills: ['mine'] };
    const cached: SkillSyncHealth[] = [];
    const d = deps();
    d.sync = vi.fn(async (loc, _p) => {
      const h = loc === 'en' ? FAIL : RESTORED_OK;
      cached.push(h);   // 主进程 skillSyncStateHolder.cached 的建模：每次同步都覆盖它
      return h;
    });
    const r = await createLocaleSet(d)('en');
    expect(r.outcome).toEqual({ kind: 'failed', sync: FAIL, health: RESTORED_OK });
    // getHealth() 读的就是最后一次同步的结果 —— 渲染层拿到的 health 必须与它逐字相同。
    expect(r.outcome.kind === 'failed' && r.outcome.health).toEqual(cached[cached.length - 1]);
  });

  it('提交 settings 失败 → 同样重投影回旧语言', async () => {
    const seen: string[] = [];
    const d = deps({ commitLocale: vi.fn(async () => { throw new Error('write failed'); }) });
    d.sync = vi.fn(async (loc, _p) => { seen.push(loc); return OK; });
    const r = await createLocaleSet(d)('en');
    expect(seen).toEqual(['en', 'zh']);
    expect(r.outcome).toMatchObject({
      kind: 'failed',
      sync: { message: 'Error: write failed' },
      health: OK,                                  // 重投影成功，树是健康的旧语言树
    });
    expect(r.settings.ui.locale).toBe('zh');       // commitLocale 抛了，磁盘没变
  });

  it('重投影也失败 → failed 且保留原始诊断（skill 名不丢），不抛', async () => {
    const d = deps();
    d.sync = vi.fn(async (_l, _p) => FAIL);
    const r = await createLocaleSet(d)('en');
    expect(d.sync).toHaveBeenCalledTimes(2);       // 换树一次 + 重投影一次
    expect(r.outcome).toEqual({
      kind: 'failed',
      sync: { state: 'failed', phase: 'locale-switch', skill: 'demo', message: 'boom；skill 树可能不一致，重启将自动修复' },
      // health 是重投影那一次的**原始**返回值，不带上面那句后缀 —— 它要和主进程
      // cached 逐字相同；给用户看的话术只加在 sync 上。
      health: FAIL,
    });
  });

  it('切到当前已是的语言 → unchanged，不动任何东西也不编一个 health 出来', async () => {
    const d = deps();
    const r = await createLocaleSet(d)('zh');
    expect(r.outcome).toEqual({ kind: 'unchanged' });
    expect(d.disposeAllSessions).not.toHaveBeenCalled();
    expect(d.sync).not.toHaveBeenCalled();
    expect(d.commitLocale).not.toHaveBeenCalled();
  });
});
