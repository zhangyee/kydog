import { describe, expect, it } from 'vitest';
import { DEFAULT_RESEARCH_BUDGET, ResearchBudgetMeter } from './budget';

const limits = { ...DEFAULT_RESEARCH_BUDGET, maxCandidates: 2, maxFetches: 1, maxTotalBytes: 7,
  maxBytesPerSource: 5, maxModelCalls: 1 };

describe('ResearchBudgetMeter', () => {
  it('去重候选只占一次名额，边界之外显式拒绝', () => {
    const meter = new ResearchBudgetMeter(limits);
    expect(meter.reserveCandidate('https://a.example/')).toEqual({ ok: true, newCandidate: true });
    expect(meter.reserveCandidate('https://a.example/')).toEqual({ ok: true, newCandidate: false });
    expect(meter.reserveCandidate('https://b.example/')).toEqual({ ok: true, newCandidate: true });
    expect(meter.reserveCandidate('https://c.example/')).toEqual({ ok: false, reason: 'candidate_limit' });
    expect(meter.usage.candidates).toBe(2);
  });

  it('派发即占用抓取/模型预算；失败不会退回名额', () => {
    const meter = new ResearchBudgetMeter(limits);
    expect(meter.reserveFetch()).toEqual({ ok: true });
    expect(meter.reserveFetch()).toEqual({ ok: false, reason: 'fetch_limit' });
    expect(meter.reserveModelCall()).toEqual({ ok: true });
    expect(meter.reserveModelCall()).toEqual({ ok: false, reason: 'model_call_limit' });
    expect(meter.usage.fetchesDispatched).toBe(1);
    expect(meter.usage.modelCalls).toBe(1);
  });

  it('流式收字节时同时守来源和全局上限', () => {
    const meter = new ResearchBudgetMeter(limits);
    expect(meter.reserveBytes('s1', 5)).toEqual({ ok: true });
    expect(meter.reserveBytes('s2', 2)).toEqual({ ok: true });
    expect(meter.reserveBytes('s1', 1)).toEqual({ ok: false, reason: 'source_byte_limit' });
    expect(meter.reserveBytes('s2', 1)).toEqual({ ok: false, reason: 'total_byte_limit' });
    expect(meter.usage.receivedBytes).toBe(7);
  });

  it('取消后不再预占任何新任务', () => {
    const meter = new ResearchBudgetMeter(limits);
    expect(meter.reserveFetch()).toEqual({ ok: true });
    meter.cancel();
    expect(meter.reserveCandidate('https://a.example/')).toEqual({ ok: false, reason: 'cancelled' });
    expect(meter.reserveModelCall()).toEqual({ ok: false, reason: 'cancelled' });
    expect(meter.reserveBytes('s1', 1)).toEqual({ ok: false, reason: 'cancelled' });
  });
});
