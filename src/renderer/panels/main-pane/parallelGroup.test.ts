import { describe, it, expect } from 'vitest';
import { isParallelGroup } from './parallelGroup';
import type { AssistantBlock } from '../../../shared/types';

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;

const bash = (id: string, command: string, parallelGroupId?: string): ToolBlock => ({
  kind: 'tool_call', id, name: 'bash', command, chunks: [], status: 'ok', parallelGroupId,
});

describe('isParallelGroup', () => {
  it('单个 tool：不是并行', () => {
    expect(isParallelGroup([bash('a', 'fastpaper search foo', 'g1')])).toBe(false);
  });

  it('两个 fastpaper bash + 共享 groupId：并行', () => {
    expect(isParallelGroup([
      bash('a', 'fastpaper search foo', 'g1'),
      bash('b', 'fastpaper search bar', 'g1'),
    ])).toBe(true);
  });

  it('groupId 不同：非并行（跨 pi message，严格 reject）', () => {
    expect(isParallelGroup([
      bash('a', 'fastpaper search foo', 'g1'),
      bash('b', 'fastpaper search bar', 'g2'),
    ])).toBe(false);
  });

  it('全部 groupId 缺失（旧数据 / 普通顺序调用）：非并行', () => {
    expect(isParallelGroup([
      bash('a', 'fastpaper search foo'),
      bash('b', 'fastpaper search bar'),
    ])).toBe(false);
  });

  it('部分 groupId 缺失：非并行（必须全部共享）', () => {
    expect(isParallelGroup([
      bash('a', 'fastpaper search foo', 'g1'),
      bash('b', 'fastpaper search bar'),
    ])).toBe(false);
  });

  it('fastpaper + ls 共享 groupId：非并行（ls 不是内置 CLI）', () => {
    expect(isParallelGroup([
      bash('a', 'fastpaper search foo', 'g1'),
      bash('b', 'ls -la', 'g1'),
    ])).toBe(false);
  });

  it('两个 ls 共享 groupId：非并行（都不是内置 CLI）', () => {
    expect(isParallelGroup([
      bash('a', 'ls', 'g1'),
      bash('b', 'ls /tmp', 'g1'),
    ])).toBe(false);
  });

  it('非 bash 工具：非并行', () => {
    const t: ToolBlock = { kind: 'tool_call', id: 'x', name: 'read', chunks: [], status: 'ok', parallelGroupId: 'g1' };
    expect(isParallelGroup([t, { ...t, id: 'y' }])).toBe(false);
  });

  it('三个 fastpaper 共享 groupId：并行（覆盖 fixture 场景）', () => {
    expect(isParallelGroup([
      bash('a', "fastpaper search 'flow matching' --source arxiv", 'g1'),
      bash('b', "fastpaper search 'rectified flow' --source s2", 'g1'),
      bash('c', "fastpaper search 'diffusion biomedical' --source pubmed", 'g1'),
    ])).toBe(true);
  });
});
