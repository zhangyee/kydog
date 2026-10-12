import { describe, expect, it, vi } from 'vitest';
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
            genuine = retainPointerFailure(error, { tabId: 'research-tab', snapshotId: mode === 'wrong-binding' ? 'other-snapshot' : snap.snapshotId,
              generation: snap.generation, nodeId: node.nodeId }, 'measure', { ok: false, reason: 'intercepted', x: 73, y: 89, by: 'private-class' });
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
              stage: 'measure', reason: 'intercepted', nativeFrameObserved: false, point: { x: 73, y: 89 }, rejection: null },
          });
        }
        expect(warn).toHaveBeenCalledTimes(mode === 'genuine-A' ? 1 : 2);
      }
    } finally { warn.mockRestore(); }
  });
});
