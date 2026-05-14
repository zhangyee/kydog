import { describe, it, expect } from 'vitest';
import { processWallClock } from './processWallClock';
import type { ProcessBlock } from './groupBlocks';

const thinkingBlock = (startedAt?: number, endedAt?: number): ProcessBlock => ({
  kind: 'thinking', text: 't', status: 'done', startedAt, endedAt,
});
const toolBlock = (startedAt?: number, endedAt?: number): ProcessBlock => ({
  kind: 'tool_call', id: 'x', name: 'bash', chunks: [], status: 'ok', startedAt, endedAt,
});

describe('processWallClock', () => {
  it('单 block：返回 endedAt - startedAt', () => {
    expect(processWallClock([thinkingBlock(1000, 4000)])).toBe(3000);
  });

  it('多 block：max(end) - min(start)', () => {
    const blocks = [
      thinkingBlock(1000, 1500),
      toolBlock(1500, 4500),
      thinkingBlock(4500, 5000),
    ];
    expect(processWallClock(blocks)).toBe(4000); // 5000 - 1000
  });

  it('全无时间戳：返回 null', () => {
    expect(processWallClock([thinkingBlock()])).toBeNull();
  });

  it('有 startedAt 但全部 endedAt 缺失：返回 null', () => {
    expect(processWallClock([thinkingBlock(1000), toolBlock(2000)])).toBeNull();
  });

  it('部分缺 endedAt：仍能从已完成的算', () => {
    const blocks = [
      thinkingBlock(1000, 2000),
      toolBlock(2000),
    ];
    expect(processWallClock(blocks)).toBe(1000); // 2000 - 1000
  });
});
