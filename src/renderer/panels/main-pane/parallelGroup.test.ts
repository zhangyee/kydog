import { describe, it, expect } from 'vitest';
import { isParallelGroup } from './parallelGroup';
import type { AssistantBlock } from '../../../shared/types';

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;

const bash = (id: string, command: string, startedAt?: number): ToolBlock => ({
  kind: 'tool_call', id, name: 'bash', command, chunks: [], status: 'ok', startedAt,
});

describe('isParallelGroup', () => {
  it('单个 tool：不是并行', () => {
    expect(isParallelGroup([bash('a', 'fastpaper search foo', 1000)])).toBe(false);
  });

  it('两个 fastpaper bash + startedAt 簇内：并行', () => {
    expect(isParallelGroup([
      bash('a', 'fastpaper search foo', 1000),
      bash('b', 'fastpaper search bar', 1050),
    ])).toBe(true);
  });

  it('两个 fastpaper bash + startedAt 拉开 1s：非并行', () => {
    expect(isParallelGroup([
      bash('a', 'fastpaper search foo', 1000),
      bash('b', 'fastpaper search bar', 2500),
    ])).toBe(false);
  });

  it('fastpaper + ls：非并行（ls 不是内置 CLI）', () => {
    expect(isParallelGroup([
      bash('a', 'fastpaper search foo', 1000),
      bash('b', 'ls -la', 1050),
    ])).toBe(false);
  });

  it('两个 ls：非并行（都不是内置 CLI）', () => {
    expect(isParallelGroup([
      bash('a', 'ls', 1000),
      bash('b', 'ls /tmp', 1050),
    ])).toBe(false);
  });

  it('非 bash 工具：非并行', () => {
    const t: ToolBlock = { kind: 'tool_call', id: 'x', name: 'read', chunks: [], status: 'ok' };
    expect(isParallelGroup([t, t])).toBe(false);
  });

  it('startedAt 全缺（历史）：仅看内置 CLI 即视为并行', () => {
    expect(isParallelGroup([
      bash('a', 'fastpaper search foo'),
      bash('b', 'fastpaper search bar'),
    ])).toBe(true);
  });

  it('部分缺 startedAt：按全缺降级（仅看内置 CLI）', () => {
    // 跑到一半的状态：第一个有时间戳第二个没有 —— 当前实现里 starts.length !== tools.length，
    // 跳过 spread 检查，仅靠内置 CLI 判定 → 并行
    expect(isParallelGroup([
      bash('a', 'fastpaper search foo', 1000),
      bash('b', 'fastpaper search bar'),
    ])).toBe(true);
  });

  it('三个 fastpaper 紧密 startedAt：并行（覆盖 fixture 场景）', () => {
    expect(isParallelGroup([
      bash('a', "fastpaper search 'flow matching' --source arxiv", 1000),
      bash('b', "fastpaper search 'rectified flow' --source s2", 1005),
      bash('c', "fastpaper search 'diffusion biomedical' --source pubmed", 1010),
    ])).toBe(true);
  });
});
