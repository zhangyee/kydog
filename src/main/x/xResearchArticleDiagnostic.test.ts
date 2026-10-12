import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { guardedInteractExpression } from '../browser/measuredPointerSource';
import { KydogError } from '../../shared/errors';
import { fixture, post, readHtml } from '../../test-support/xResearchFixture';
import { logger } from '../log';
import { retainPointerFailure, pointerFailureDiagnostic } from '../browser/pointerDiagnostic';
import { readX } from './xResearchRead';

describe('Article private failure diagnostics', () => {
  it('logs exact producer call identities and bound source receipts at warn, but never authenticates lookalikes', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      let genuine: KydogError | undefined;
      for (const mode of ['genuine-A', 'genuine-B', 'property', 'prototype', 'message', 'wrong-binding']) {
        const f = fixture([readHtml(post().replace('</article>', '<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/bob">@bob</a></div><div data-testid="article-cover-image">private preview</div></div></article>'))]);
        Object.assign(f.context, { runId: `producer-run-${mode}`, callId: `producer-call-${mode}`, batchId: `producer-batch-${mode}` });
        f.act.mockImplementation(async (_action, snapshot) => {
          const snap = snapshot as import('../browser/snapshot').AxSnapshot;
          const node = snap.nodes.find(n => n.collectedPermission?.purpose === 'article_entry')!;
          const error = new KydogError('browser.click_intercepted', 'private-class private-label https://private.example/');
          if (mode.startsWith('genuine') || mode === 'wrong-binding') {
            const dom = new JSDOM('<button>private label</button><aside class="private-class"></aside>', { runScripts: 'outside-only' });
            let raw: unknown;
            try {
              const { window } = dom;
              const target = window.document.querySelector('button')!, cover = window.document.querySelector('aside')!;
              let hit: Element = target;
              Object.assign(window, { __kydogWorld: { gen: snap.generation, ids: new WeakMap([[target, node.nodeId]]), pw: new WeakSet() } });
              Object.assign(window.document, { elementFromPoint: () => hit });
              target.getBoundingClientRect = () => ({ x: 23, y: 39, left: 23, top: 39, width: 100, height: 100 } as DOMRect);
              cover.getBoundingClientRect = () => ({ x: 1, y: 2, width: 900, height: 700 } as DOMRect);
              const measure = () => window.eval(guardedInteractExpression({ op: 'measure', target: { nodeId: node.nodeId } }, Date.now() + 3000));
              expect(measure()).toMatchObject({ ok: true, x: 73, y: 89 });
              hit = cover;
              raw = measure();
              expect(raw).toMatchObject({ ok: false, reason: 'intercepted' });
            } finally { dom.window.close(); }
            genuine = retainPointerFailure(error, { tabId: 'research-tab', snapshotId: mode === 'wrong-binding' ? 'other-snapshot' : snap.snapshotId,
              generation: snap.generation, nodeId: node.nodeId }, 'measure', raw);
            throw genuine;
          }
          if (mode === 'prototype') throw Object.assign(Object.create(Object.getPrototypeOf(genuine!)), error, { diagnostic: pointerFailureDiagnostic(genuine) });
          if (mode === 'property') Object.assign(error, { diagnostic: pointerFailureDiagnostic(genuine) });
          throw error;
        });
        const result = await readX({ tabId: 'research-tab', read: { objective: 'read', targets: [{ url: 'https://x.com/alice/status/123' }],
          includeArticle: true, includeReplies: false, maxRepliesPerPost: 0, maxScrollsPerPost: 0, maxExpandActionsPerPost: 1 } }, f.context);
        expect(result.targets[0]).toMatchObject({ root: { text: 'original' }, article: { actionAttempted: true, bodyObserved: false,
          barrier: { reason: 'article_action_failed:browser.click_intercepted' } }, budgetUsage: { expandActions: 0 } });
        if (mode.startsWith('genuine')) {
          const binding = result.targets[0].article.entry!.binding;
          expect(warn).toHaveBeenLastCalledWith('xResearch', 'Article pointer interception', {
            runId: `producer-run-${mode}`, callId: `producer-call-${mode}`, batchId: `producer-batch-${mode}`,
            diagnostic: { tabId: 'research-tab', snapshotId: binding.snapshotId, generation: binding.generation, nodeId: binding.nodeId,
              stage: 'measure', reason: 'intercepted', nativeFrameObserved: false, point: { x: 73, y: 89 }, rejection: {
                point: { x: 73, y: 89 }, targetTag: 'BUTTON', hitTag: 'ASIDE', targetConnected: true,
                targetContainsHit: false, hitSameAsCaptured: null, rejectGeometry: {
                  targetRect: { x: 23, y: 39, width: 100, height: 100 }, hitRect: { x: 1, y: 2, width: 900, height: 700 },
                  scroll: { x: 0, y: 0 }, viewport: { width: 1024, height: 768 },
                },
              } },
          });
        }
        expect(warn).toHaveBeenCalledTimes(mode === 'genuine-A' ? 1 : 2);
      }
    } finally { warn.mockRestore(); }
  });
});
