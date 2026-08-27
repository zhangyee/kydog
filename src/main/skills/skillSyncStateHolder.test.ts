import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SkillSyncHealth } from '../../shared/types';

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.0.0-test' } }));
vi.mock('./skillResourceLoader', () => ({ KYDOG_SKILLS_DIR: '/tmp/kydog-test/skills' }));
vi.mock('../persist/paths', () => ({ STAGING_DIR: '/tmp/kydog-test/staging' }));
vi.mock('./skillTreeLock', () => ({ withSkillTree: <T>(fn: () => Promise<T>) => fn() }));

const runSkillSync = vi.fn<(i: unknown) => Promise<SkillSyncHealth>>();
const builtinSkillsRoot = vi.fn<() => string>();
vi.mock('./skillSync', () => ({ runSkillSync: (i: unknown) => runSkillSync(i) }));
vi.mock('./builtinSkills', () => ({ builtinSkillsRoot: () => builtinSkillsRoot() }));

// cached 是模块级变量，每个用例都得拿一份新的模块实例。
async function fresh() {
  vi.resetModules();
  return (await import('./skillSyncStateHolder')).skillSyncStateHolder;
}

describe('skillSyncStateHolder', () => {
  beforeEach(() => {
    runSkillSync.mockReset();
    builtinSkillsRoot.mockReset().mockReturnValue('/src/skills');
  });

  it('没跑过时报 skipped/onboarding-pending', async () => {
    const holder = await fresh();
    expect(holder.getHealth()).toEqual({ state: 'skipped', reason: 'onboarding-pending' });
  });

  it('跑成功后缓存这一轮的结果', async () => {
    const ok: SkillSyncHealth = { state: 'ok', installedOrUpgraded: ['a'], userSkills: [] };
    runSkillSync.mockResolvedValue(ok);
    const holder = await fresh();
    expect(await holder.runForUnlocked('zh', 'startup')).toEqual(ok);
    expect(holder.getHealth()).toEqual(ok);
  });

  it('周边调用在进入 runSkillSync 之前就抛，也记成 failed 而不是留在 skipped', async () => {
    // 关键回归：onboarding 已完成、同步却根本没跑起来时，「尚未播种」与「播种失败」
    // 在界面上是相反的两句话，不能因为 cached 没赋值就退回前者。
    builtinSkillsRoot.mockImplementation(() => { throw new Error('resources missing'); });
    const holder = await fresh();
    const h = await holder.runForUnlocked('en', 'onboarding');
    expect(h).toEqual({ state: 'failed', phase: 'onboarding', message: 'Error: resources missing' });
    expect(holder.getHealth()).toEqual(h);
    expect(runSkillSync).not.toHaveBeenCalled();
  });

  it('runForUnlocked 不再把异常抛给调用方（启动流程不会因此中止）', async () => {
    builtinSkillsRoot.mockImplementation(() => { throw new Error('boom'); });
    const holder = await fresh();
    await expect(holder.runFor('zh', 'startup')).resolves.toBeUndefined();
    expect(holder.getHealth()).toMatchObject({ state: 'failed', phase: 'startup' });
  });
});
