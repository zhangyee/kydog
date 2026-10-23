import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { fixture, post, readHtml } from './xResearchFixture';

it('transfers page evaluation data out of the disposable VM realm before retaining observations', async () => {
  const f = fixture([readHtml(post())]);
  await f.context.browser.open('https://x.com/alice/status/123', undefined);
  const observation = await f.collect({ stage: 'post', postId: '123', expectedUrl: 'https://x.com/alice/status/123' });
  expect(observation.root).toMatchObject({ postId: '123', text: 'original' });
  // These are retained by collected observations/mock results. Foreign prototypes
  // keep the whole JSDOM VM alive even after its window is closed.
  expect(Object.getPrototypeOf(observation.truncation)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(observation.snapshot!.nodes)).toBe(Array.prototype);
});

it('closes its disposable page even when the evaluation request is invalid', async () => {
  const getWindow = Object.getOwnPropertyDescriptor(JSDOM.prototype, 'window')!.get!;
  let captured: JSDOM['window'] | undefined;
  const spy = vi.spyOn(JSDOM.prototype, 'window', 'get').mockImplementation(function (this: JSDOM) {
    const window = getWindow.call(this) as JSDOM['window'];
    if (!captured) {
      captured = window;
      expect(captured.document.documentElement.tagName).toBe('HTML');
    }
    return window;
  });
  try {
    const f = fixture([readHtml(post())]);
    await expect(f.collect({ stage: 'post', postId: '', expectedUrl: 'https://x.com/alice/status/123' })).rejects.toThrow();
    expect(captured).toBeDefined();
    expect(captured!.document).toBeUndefined();
  } finally { spy.mockRestore(); }
});

it('reuses one page VM across collection frames while replacing the observed document', async () => {
  const getWindow = Object.getOwnPropertyDescriptor(JSDOM.prototype, 'window')!.get!;
  const windows = new Set<JSDOM['window']>();
  const spy = vi.spyOn(JSDOM.prototype, 'window', 'get').mockImplementation(function (this: JSDOM) {
    const window = getWindow.call(this) as JSDOM['window'];
    windows.add(window);
    return window;
  });
  try {
    const f = fixture([readHtml(post()+post('456','bob','first frame')),readHtml(post()+post('789','bob','second frame'))]);
    await f.context.browser.open('https://x.com/alice/status/123', undefined);
    const request = { stage: 'post' as const, postId: '123', expectedUrl: 'https://x.com/alice/status/123' };
    const first = await f.collect(request);
    await f.act({ kind: 'scroll' });
    const second = await f.collect(request);
    expect(first.replies.map(p=>p.text)).toEqual(['first frame']);
    expect(second.replies.map(p=>p.text)).toEqual(['second frame']);
    expect(windows.size).toBe(1);
  } finally { spy.mockRestore(); }
});
