import { describe, it, expect, beforeEach } from 'vitest';
import { useUpdateStore, shouldShowBanner } from './updateStore';
import type { UpdateStatus } from '../../shared/types';

const base: UpdateStatus = {
  check: { phase: 'never' }, update: { kind: 'none' },
  bannerDismissed: false, autoCheck: true, currentVersion: '0.1.0',
};

describe('updateStore', () => {
  beforeEach(() => useUpdateStore.setState({ status: null }));

  it('setStatus 写入状态', () => {
    useUpdateStore.getState().setStatus(base);
    expect(useUpdateStore.getState().status).toEqual(base);
  });

  it('横幅条件：有更新且未忽略才显示', () => {
    expect(shouldShowBanner(null)).toBe(false);
    expect(shouldShowBanner(base)).toBe(false);
    const avail: UpdateStatus = { ...base, update: { kind: 'available', candidateId: 'c1', label: 'v2' } };
    expect(shouldShowBanner(avail)).toBe(true);
    expect(shouldShowBanner({ ...avail, bannerDismissed: true })).toBe(false);
    expect(shouldShowBanner({ ...base, update: { kind: 'downloaded', label: 'v2' } })).toBe(true);
  });

  it('检查失败不出横幅', () => {
    expect(shouldShowBanner({ ...base, check: { phase: 'failed', message: 'x', retry: 'allowed' } })).toBe(false);
  });
});
