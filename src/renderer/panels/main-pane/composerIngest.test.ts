import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ingestFiles, NOTICE_NOT_ON_DISK, NOTICE_UNREADABLE, NOTICE_TOO_LARGE } from './composerIngest';
import { useComposerDraftStore } from './composerDraftStore';

const f = (name: string, type: string) => ({ name, type, size: 10 }) as File;

describe('ingestFiles', () => {
  beforeEach(() => useComposerDraftStore.setState({ byThread: {} }));
  const draft = () => useComposerDraftStore.getState().byThread['t1']!;

  it('四类各就各位：盘上的文件按路径、盘上的图带路径与文件名、粘贴的图叫「截图 N」、不在盘上的非图片不收并提示', async () => {
    const paths = new Map<File, string>();
    const pdf = f('a.pdf', 'application/pdf'); paths.set(pdf, '/p/a.pdf');
    const fig = f('fig.png', 'image/png'); paths.set(fig, '/p/fig.png');
    const shot1 = f('image.png', 'image/png');
    const shot2 = f('image.png', 'image/png');
    const blob = f('x.bin', 'application/octet-stream');
    const prepare = vi.fn().mockResolvedValue({ ok: true, data: 'D', mimeType: 'image/png' });
    await ingestFiles('t1', [pdf, fig, shot1, shot2, blob], { pathForFile: (x) => paths.get(x) ?? '', prepare });
    expect(draft().attachments.map(({ id: _id, ...a }) => a)).toEqual([
      { kind: 'file', name: 'a.pdf', absPath: '/p/a.pdf' },
      { kind: 'image', name: 'fig.png', absPath: '/p/fig.png', data: 'D', mimeType: 'image/png' },
      { kind: 'image', name: '截图 1', absPath: null, data: 'D', mimeType: 'image/png' },
      { kind: 'image', name: '截图 2', absPath: null, data: 'D', mimeType: 'image/png' },
    ]);
    expect(draft().notice).toBe(NOTICE_NOT_ON_DISK);
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it('图片读不出 / 压不下：不收，两种原因都说出来；同一批里正常的照收', async () => {
    const bad = f('bad.png', 'image/png');
    const huge = f('huge.png', 'image/png');
    const ok = f('ok.png', 'image/png');
    const prepare = vi.fn(async (x: Blob) => (x === bad ? { ok: false, reason: 'unreadable' } : x === huge ? { ok: false, reason: 'too-large' } : { ok: true, data: 'D', mimeType: 'image/png' }));
    await ingestFiles('t1', [bad, huge, ok], { pathForFile: () => '', prepare: prepare as never });
    expect(draft().attachments.map((a) => a.name)).toEqual(['截图 1']);
    expect(draft().notice).toBe(`${NOTICE_UNREADABLE}；${NOTICE_TOO_LARGE}`);
  });

  it('全部正常时不留提示（先证明有问题时会留）', async () => {
    await ingestFiles('t1', [f('x.bin', '')], { pathForFile: () => '', prepare: vi.fn() });
    expect(draft().notice).toBe(NOTICE_NOT_ON_DISK);
    await ingestFiles('t1', [f('a.pdf', 'application/pdf')], { pathForFile: () => '/p/a.pdf', prepare: vi.fn() });
    expect(draft().notice).toBeNull();
  });
});
