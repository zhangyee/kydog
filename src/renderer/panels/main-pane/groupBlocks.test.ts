import { describe, it, expect } from 'vitest';
import { groupBlocks } from './groupBlocks';
import type { AssistantBlock } from '../../../shared/types';

const thinking = (text: string): AssistantBlock => ({ kind: 'thinking', text, status: 'done' });
const tool = (id: string): AssistantBlock => ({
  kind: 'tool_call', id, name: 'bash', chunks: [], status: 'ok',
});
const text = (t: string): AssistantBlock => ({ kind: 'text', text: t });

describe('groupBlocks', () => {
  it('空数组返回空', () => {
    expect(groupBlocks([])).toEqual([]);
  });

  it('全 text 返回 text groups', () => {
    const out = groupBlocks([text('a'), text('b')]);
    expect(out).toEqual([
      { kind: 'text', block: { kind: 'text', text: 'a' } },
      { kind: 'text', block: { kind: 'text', text: 'b' } },
    ]);
  });

  it('单 thinking 包成 process group（一律包）', () => {
    const out = groupBlocks([thinking('t')]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('process');
    if (out[0].kind === 'process') expect(out[0].blocks).toHaveLength(1);
  });

  it('单 tool_call 包成 process group（一律包）', () => {
    const out = groupBlocks([tool('tc-1')]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('process');
    if (out[0].kind === 'process') expect(out[0].blocks).toHaveLength(1);
  });

  it('thinking + tool 合并到一个 process group', () => {
    const out = groupBlocks([thinking('t'), tool('tc-1')]);
    expect(out).toHaveLength(1);
    if (out[0].kind === 'process') expect(out[0].blocks).toHaveLength(2);
  });

  it('text 是边界：thinking → tool → text → tool 分成 process / text / process', () => {
    const out = groupBlocks([thinking('t'), tool('tc-1'), text('mid'), tool('tc-2')]);
    expect(out.map(g => g.kind)).toEqual(['process', 'text', 'process']);
    if (out[0].kind === 'process') expect(out[0].blocks).toHaveLength(2);
    if (out[2].kind === 'process') expect(out[2].blocks).toHaveLength(1);
  });

  it('交错完整序列：thinking → tool → text → tool → text', () => {
    const out = groupBlocks([thinking('t'), tool('tc-1'), text('mid'), tool('tc-2'), text('final')]);
    expect(out.map(g => g.kind)).toEqual(['process', 'text', 'process', 'text']);
  });

  it('tool 紧跟 text 后再跟 text：分成 text / process / text', () => {
    const out = groupBlocks([text('pre'), tool('tc-x'), text('post')]);
    expect(out.map(g => g.kind)).toEqual(['text', 'process', 'text']);
    if (out[1].kind === 'process') expect(out[1].blocks).toHaveLength(1);
  });

  it('thinking → tool → thinking 全部进同一个 process group', () => {
    const out = groupBlocks([thinking('a'), tool('tc-1'), thinking('b')]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('process');
    if (out[0].kind === 'process') expect(out[0].blocks).toHaveLength(3);
  });
});
