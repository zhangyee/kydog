import { describe, expect, it } from 'vitest';
import { BrowserDomBudget } from './browserDomBudget';
import { DEFAULT_WEB_RESEARCH_TASK_BUDGET } from '../../shared/webResearchTask';

describe('BrowserDomBudget', () => {
  it('restores the greater persisted aggregate and sums sources after a partial write', () => {
    const limits = { ...DEFAULT_WEB_RESEARCH_TASK_BUDGET, maxBytesPerSource: 100, maxTotalBytes: 150 };
    const fromSources = new BrowserDomBudget(limits, 20, new Map([['a', 50], ['b', 60]]));
    expect(fromSources.remaining('a')).toBe(40);
    fromSources.record('a', 30);
    expect(fromSources.remaining('b')).toBe(10);
    const fromTask = new BrowserDomBudget(limits, 140, new Map([['a', 50]]));
    expect(fromTask.remaining('a')).toBe(10);
    limits.maxTotalBytes = 200; limits.maxBytesPerSource = 160;
    expect(fromTask.remaining('a')).toBe(60);
  });
  it('rejects invalid persisted usage and preserves source and task limit classification', () => {
    const limits = { ...DEFAULT_WEB_RESEARCH_TASK_BUDGET, maxBytesPerSource: 100, maxTotalBytes: 150 };
    const source = new BrowserDomBudget(limits, 0, new Map());
    source.record('a', 100);
    expect(source.remaining('a')).toBe(0);
    expect(() => source.record('a', 1)).toThrow('browser_source_dom_limit');
    source.record('b', 50);
    expect(() => source.record('b', 1)).toThrow('browser_total_dom_limit');
    expect(() => new BrowserDomBudget(limits, -1, new Map())).toThrow('invalid');
    expect(() => new BrowserDomBudget(limits, 0, new Map([['a', NaN]]))).toThrow('invalid');
  });
});
