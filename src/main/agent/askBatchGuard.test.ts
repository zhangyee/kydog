import { describe, it, expect } from 'vitest';
import { createAskBatchGuard } from './askBatchGuard';
import { ASK_TOOL_NAME } from '../../shared/askQuestion';

const call = (id: string, name: string) => ({ type: 'toolCall', id, name });
const ask = (id: string) => call(id, ASK_TOOL_NAME);

describe('createAskBatchGuard', () => {
  it('只有一个 ask 的批次合法', () => {
    const g = createAskBatchGuard();
    g.onAssistantMessageEnd([ask('a1')]);
    expect(g.shouldBlock('a1')).toBe(false);
  });

  it('ask 与其他工具混批时整批被拦', () => {
    const g = createAskBatchGuard();
    g.onAssistantMessageEnd([call('w1', 'write'), ask('a1')]);
    expect(g.shouldBlock('w1')).toBe(true);
    expect(g.shouldBlock('a1')).toBe(true);
  });

  it('ask 在前、其他工具在后也一样整批被拦', () => {
    const g = createAskBatchGuard();
    g.onAssistantMessageEnd([ask('a1'), call('w1', 'write')]);
    expect(g.shouldBlock('a1')).toBe(true);
    expect(g.shouldBlock('w1')).toBe(true);
  });

  it('两个 ask 同批也非法', () => {
    const g = createAskBatchGuard();
    g.onAssistantMessageEnd([ask('a1'), ask('a2')]);
    expect(g.shouldBlock('a1')).toBe(true);
    expect(g.shouldBlock('a2')).toBe(true);
  });

  it('不含 ask 的批次一律放行，哪怕有多个工具', () => {
    const g = createAskBatchGuard();
    g.onAssistantMessageEnd([call('w1', 'write'), call('b1', 'bash')]);
    expect(g.shouldBlock('w1')).toBe(false);
    expect(g.shouldBlock('b1')).toBe(false);
  });

  it('集合是整批替换而非累加：上一批的非法 id 不污染下一批', () => {
    const g = createAskBatchGuard();
    g.onAssistantMessageEnd([call('w1', 'write'), ask('a1')]);
    expect(g.shouldBlock('w1')).toBe(true);
    g.onAssistantMessageEnd([ask('a2')]);
    expect(g.shouldBlock('w1')).toBe(false);
    expect(g.shouldBlock('a2')).toBe(false);
  });

  it('合法批次之后跟非法批次，同样整批替换', () => {
    const g = createAskBatchGuard();
    g.onAssistantMessageEnd([ask('a1')]);
    g.onAssistantMessageEnd([call('w1', 'write'), ask('a2')]);
    expect(g.shouldBlock('a2')).toBe(true);
  });

  it('reset 清空集合', () => {
    const g = createAskBatchGuard();
    g.onAssistantMessageEnd([call('w1', 'write'), ask('a1')]);
    g.reset();
    expect(g.shouldBlock('w1')).toBe(false);
  });

  it('content 不是数组时不炸', () => {
    const g = createAskBatchGuard();
    expect(() => g.onAssistantMessageEnd(undefined)).not.toThrow();
    expect(g.shouldBlock('anything')).toBe(false);
  });

  it('非 toolCall 的 content 项不参与计数', () => {
    const g = createAskBatchGuard();
    // 一条 text + 一个 ask，仍然是「只有一个 toolCall」，合法
    g.onAssistantMessageEnd([{ type: 'text', text: '我先问一下' }, ask('a1')]);
    expect(g.shouldBlock('a1')).toBe(false);
  });

  it('没有 id 的 toolCall 不会污染集合', () => {
    const g = createAskBatchGuard();
    g.onAssistantMessageEnd([{ type: 'toolCall', name: 'write' }, ask('a1')]);
    expect(g.shouldBlock('a1')).toBe(true);
    expect(g.shouldBlock('undefined')).toBe(false);
  });

  it('两个 guard 实例互不干扰', () => {
    const g1 = createAskBatchGuard();
    const g2 = createAskBatchGuard();
    g1.onAssistantMessageEnd([call('w1', 'write'), ask('a1')]);
    expect(g2.shouldBlock('w1')).toBe(false);
  });
});
