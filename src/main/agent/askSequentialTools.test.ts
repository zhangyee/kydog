import { describe, it, expect } from 'vitest';
import { isParallelBatch, toolCallsOf, SEQUENTIAL_TOOL_NAMES } from './askSequentialTools';
import { createAskUserQuestionTool } from './askUserQuestionTool';
import { ASK_TOOL_NAME } from '../../shared/askQuestion';

const call = (name: string, id = name) => ({ type: 'toolCall', id, name });

describe('toolCallsOf', () => {
  it('只取 toolCall，忽略 text / thinking', () => {
    expect(toolCallsOf([{ type: 'text', text: 'hi' }, call('bash'), { type: 'thinking' }]))
      .toEqual([{ id: 'bash', name: 'bash' }]);
  });

  it('没有 id 的 toolCall 被丢掉', () => {
    expect(toolCallsOf([{ type: 'toolCall', name: 'bash' }])).toEqual([]);
  });

  it('不是数组时返回空', () => {
    expect(toolCallsOf(undefined)).toEqual([]);
    expect(toolCallsOf('nope')).toEqual([]);
  });
});

describe('isParallelBatch', () => {
  it('两个普通工具是并行', () => {
    expect(isParallelBatch([call('bash'), call('read')])).toBe(true);
  });

  it('单个工具不是并行', () => {
    expect(isParallelBatch([call('bash')])).toBe(false);
  });

  it('空批次不是并行', () => {
    expect(isParallelBatch([])).toBe(false);
  });

  it('批次里有 sequential 工具时不是并行——pi 会把整批拖成串行', () => {
    expect(isParallelBatch([call('bash'), call(ASK_TOOL_NAME)])).toBe(false);
  });

  it('sequential 工具在前也一样', () => {
    expect(isParallelBatch([call(ASK_TOOL_NAME), call('bash'), call('read')])).toBe(false);
  });

  it('非 toolCall 的 content 不计入', () => {
    expect(isParallelBatch([{ type: 'text', text: 'hi' }, call('bash')])).toBe(false);
  });

  it('ask 在 SEQUENTIAL_TOOL_NAMES 里', () => {
    expect(SEQUENTIAL_TOOL_NAMES.has(ASK_TOOL_NAME)).toBe(true);
  });

  it('名单与工具定义的 executionMode 保持一致', () => {
    const tool = createAskUserQuestionTool('t', { onOpened: () => {}, onClosed: () => {} });
    expect(SEQUENTIAL_TOOL_NAMES.has(tool.name)).toBe(tool.executionMode === 'sequential');
  });
});
