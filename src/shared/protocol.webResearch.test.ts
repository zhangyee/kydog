import { describe, expect, expectTypeOf, it } from 'vitest';
import { RPC_METHODS, type RpcArgs, type RpcResult } from './protocol';
import type { WebResearchTaskSnapshot } from './webResearchTask';

describe('web research recovery protocol', () => {
  it('whitelists the three narrow methods', () => {
    for (const method of ['webResearch.taskOpenSource', 'webResearch.taskRetrySource', 'webResearch.taskControl']) {
      expect(RPC_METHODS).toContain(method);
    }
  });
  it('keeps the exact source/action args and snapshot results', () => {
    type Key = { threadId: string; researchRunId: string; sourceId: string };
    expectTypeOf<RpcArgs<'webResearch.taskOpenSource'>>().toEqualTypeOf<Key>();
    expectTypeOf<RpcArgs<'webResearch.taskRetrySource'>>().toEqualTypeOf<Key & { expectedAttemptId: string | null }>();
    expectTypeOf<RpcArgs<'webResearch.taskControl'>>().toEqualTypeOf<{
      threadId: string; researchRunId: string; action: 'pause' | 'resume' | 'cancel';
    }>();
    expectTypeOf<RpcResult<'webResearch.taskOpenSource'>>().toEqualTypeOf<{
      tabId: string; expectedAttemptId: string | null; snapshot: WebResearchTaskSnapshot;
    }>();
    expectTypeOf<RpcResult<'webResearch.taskRetrySource'>>().toEqualTypeOf<WebResearchTaskSnapshot>();
    expectTypeOf<RpcResult<'webResearch.taskControl'>>().toEqualTypeOf<WebResearchTaskSnapshot>();
  });
});
