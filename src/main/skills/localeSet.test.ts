import { describe, it, expect, vi } from 'vitest';
import { createLocaleSet } from './localeSet';
import type { SkillSyncHealth } from '../../shared/types';

const OK: SkillSyncHealth = { state: 'ok', installedOrUpgraded: [], userSkills: [] };
const FAIL: SkillSyncHealth = { state: 'failed', phase: 'locale-switch', message: 'boom' };

function deps(over: Partial<Parameters<typeof createLocaleSet>[0]> = {}) {
  return {
    currentLocale: async () => 'zh' as const,
    hasActiveRun: () => false,
    disposeAllSessions: vi.fn(async () => {}),
    sync: vi.fn(async () => OK),
    commitLocale: vi.fn(async () => ({ ui: { locale: 'en' } }) as never),
    readSettings: async () => ({ ui: { locale: 'zh' } }) as never,
    listSkills: async () => [],
    ...over,
  };
}

describe('locale.set', () => {
  it('有 run 在跑 → 拒绝，不 dispose 也不同步', async () => {
    const d = deps({ hasActiveRun: () => true });
    const r = await createLocaleSet(d)('en');
    expect(r.sync).toMatchObject({ state: 'failed', phase: 'locale-switch' });
    expect(d.disposeAllSessions).not.toHaveBeenCalled();
    expect(d.sync).not.toHaveBeenCalled();
    expect(d.commitLocale).not.toHaveBeenCalled();
  });

  it('成功路径：先 dispose 再同步，最后才提交 locale', async () => {
    const order: string[] = [];
    const d = deps({
      disposeAllSessions: vi.fn(async () => { order.push('dispose'); }),
      sync: vi.fn(async () => { order.push('sync'); return OK; }),
      commitLocale: vi.fn(async () => { order.push('commit'); return {} as never; }),
    });
    const r = await createLocaleSet(d)('en');
    expect(order).toEqual(['dispose', 'sync', 'commit']);
    expect(r.sync).toEqual(OK);
  });

  it('同步失败 → 按旧 locale 重投影一次，locale 不提交', async () => {
    const seen: string[] = [];
    const d = deps({
      sync: vi.fn(async (loc: 'zh' | 'en') => { seen.push(loc); return loc === 'en' ? FAIL : OK; }),
    });
    const r = await createLocaleSet(d)('en');
    expect(seen).toEqual(['en', 'zh']);            // 第二次是向前重投影回旧语言
    expect(d.commitLocale).not.toHaveBeenCalled();
    expect(r.sync.state).toBe('failed');
  });

  it('提交 settings 失败 → 同样重投影回旧语言', async () => {
    const seen: string[] = [];
    const d = deps({
      sync: vi.fn(async (loc: 'zh' | 'en') => { seen.push(loc); return OK; }),
      commitLocale: vi.fn(async () => { throw new Error('write failed'); }),
    });
    const r = await createLocaleSet(d)('en');
    expect(seen).toEqual(['en', 'zh']);
    expect(r.sync.state).toBe('failed');
  });

  it('重投影也失败 → 返回 failed 而不是抛', async () => {
    const d = deps({ sync: vi.fn(async () => FAIL) });
    const r = await createLocaleSet(d)('en');
    expect(r.sync.state).toBe('failed');
  });

  it('切到当前已是的语言 → 直接返回 ok，不动任何东西', async () => {
    const d = deps();
    const r = await createLocaleSet(d)('zh');
    expect(r.sync.state).toBe('ok');
    expect(d.disposeAllSessions).not.toHaveBeenCalled();
  });
});
