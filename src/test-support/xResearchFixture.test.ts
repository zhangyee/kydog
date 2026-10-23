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
