import { describe, it, expect } from 'vitest';
import { statusText } from './UpdateBlock';
import type { UpdateStatus } from '../../shared/types';

const base: UpdateStatus = {
  check: { phase: 'ok' }, update: { kind: 'none' },
  bannerDismissed: false, autoCheck: true, currentVersion: '0.1.0',
};

describe('statusText', () => {
  it('ok + none → 已是最新', () => {
    expect(statusText(base).main).toBe('已是最新');
  });

  it('ok + available 绝不能说成已是最新', () => {
    const s: UpdateStatus = { ...base, update: { kind: 'available', candidateId: 'c', label: 'v2' } };
    expect(statusText(s).main).toBe('发现新版 v2');
  });

  it('ok + downloaded → 重启后生效', () => {
    const s: UpdateStatus = { ...base, update: { kind: 'downloaded', label: 'v2' } };
    expect(statusText(s).main).toBe('新版 v2 已下载，重启后生效');
  });

  it('downloading → 正在下载新版，既不是失败也不是已是最新', () => {
    expect(statusText({ ...base, check: { phase: 'downloading' } }).main).toBe('正在下载新版…');
  });

  it('never → 尚未检查', () => {
    expect(statusText({ ...base, check: { phase: 'never' } }).main).toBe('尚未检查');
  });

  it('failed + none：主行如实说失败，不能显示「尚未检查」', () => {
    const s: UpdateStatus = { ...base, check: { phase: 'failed', message: '无法连接更新服务', retry: 'allowed' } };
    expect(statusText(s).main).toBe('上次检查失败：无法连接更新服务');
  });

  it('checking 时不管有没有已知更新，主行都是「检查中…」', () => {
    const s: UpdateStatus = {
      ...base,
      check: { phase: 'checking' },
      update: { kind: 'available', candidateId: 'c', label: 'v2' },
    };
    expect(statusText(s).main).toBe('检查中…');
  });

  it('failed + downloaded：更新信息与失败提示并列，失败不得掩盖更新', () => {
    const s: UpdateStatus = {
      ...base,
      check: { phase: 'failed', message: '超时', retry: 'restart-required' },
      update: { kind: 'downloaded', label: 'v2' },
    };
    const r = statusText(s);
    expect(r.main).toBe('新版 v2 已下载，重启后生效');
    expect(r.failure).toBe('上次检查失败：超时');
  });
});
