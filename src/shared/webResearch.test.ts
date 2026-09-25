import { describe, expect, it } from 'vitest';
import { validateCollectInput } from './webResearch';

const valid = {
  originalQuestion: 'What changed in TypeScript 6?',
  angles: [{ id: 'changes', label: 'Breaking changes', query: 'TypeScript 6 breaking changes', rationale: 'Upgrade risk' }],
  enabledEngines: ['bing', 'duckduckgo'],
  attempts: [{ attemptId: 'a1', angleIds: ['changes'], engineId: 'bing', query: 'TypeScript 6 breaking changes',
    searchPageUrl: 'https://www.bing.com/search?q=TypeScript', status: 'results' }],
  discoveries: [{ attemptId: 'a1', angleId: 'changes', engineId: 'bing', query: 'TypeScript 6 breaking changes',
    resultUrl: 'https://example.com/?v=6', searchPageUrl: 'https://www.bing.com/search?q=TypeScript',
    title: 'Notes', snippet: 'A search observation' }],
};

describe('validateCollectInput', () => {
  it('保留原始问题与逐次搜索记录', () => {
    const result = validateCollectInput(valid);
    expect(result.originalQuestion).toBe(valid.originalQuestion);
    expect(result.discoveries[0]).toEqual(valid.discoveries[0]);
  });

  it('拒绝 discovery 对错 engine、query 或 angle 的伪造归属', () => {
    expect(validateCollectInput(valid).discoveries).toHaveLength(1);
    for (const change of [
      { engineId: 'duckduckgo' }, { query: 'different' }, { angleId: 'missing' }, { attemptId: 'missing' },
    ]) {
      expect(() => validateCollectInput({ ...valid, discoveries: [{ ...valid.discoveries[0], ...change }] })).toThrow();
    }
  });

  it('未知引擎和未启用引擎都不能提交 attempt', () => {
    expect(validateCollectInput(valid).attempts).toHaveLength(1);
    expect(() => validateCollectInput({ ...valid, attempts: [{ ...valid.attempts[0], engineId: 'other' }] })).toThrow();
    expect(() => validateCollectInput({ ...valid, attempts: [{ ...valid.attempts[0], engineId: 'google' }] })).toThrow();
  });

  it('高于默认抓取数必须显式同步提高字节与模型调用预算', () => {
    expect(validateCollectInput(valid).budget.maxFetches).toBe(24);
    expect(() => validateCollectInput({ ...valid, budget: { maxFetches: 100 } })).toThrow();
    expect(validateCollectInput({ ...valid, budget: { maxFetches: 100, maxTotalBytes: 192 * 1024 * 1024,
      maxModelCalls: 200 } }).budget.maxFetches).toBe(100);
  });
});
