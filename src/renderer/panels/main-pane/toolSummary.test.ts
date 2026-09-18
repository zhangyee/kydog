import { describe, it, expect } from 'vitest';
import {
  toolExpandable, toolStatusLabel, groupToolLabel, groupToolLabelSummary, groupStatusSummary,
} from './toolSummary';
import type { AssistantBlock } from '../../../shared/types';

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;

const tool = (patch: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: 'tool_call', id: 't1', name: 'bash', command: 'fastpaper search arxiv x',
  chunks: [], status: 'ok', ...patch,
});

const OUT = [{ stream: 'stdout' as const, data: 'hit\n' }];

/**
 * 能不能展开：有输出，**或者有命令**（`e2e/63-running-tool-command` 挪下来的那条判据）。
 *
 * 命令随 `run.tool_call_start` 一开始就到了，输出要等工具结束才一次性发过来。只看输出的话，
 * 跑着的工具点不开 —— 一批并行调用全显示成同一个命令头，哪条卡住了看不出来。
 */
describe('toolExpandable', () => {
  it('还在跑、一个字的输出都没有，但有命令 → 能展开；命令也没有 → 不能展开', () => {
    expect(toolExpandable(tool({ status: 'running', chunks: [] }))).toBe(true);
    // 只翻「有没有命令」这一个字段：
    expect(toolExpandable(tool({ status: 'running', chunks: [], command: undefined }))).toBe(false);
    expect(toolExpandable(tool({ status: 'running', chunks: [], command: '' }))).toBe(false);
  });

  it('没有命令、但有输出 → 能展开（ask 回退路径那种工具卡）', () => {
    expect(toolExpandable(tool({ command: undefined, chunks: OUT }))).toBe(true);
  });

  it('判据与状态无关：跑完 / 失败 / 还在跑，同一份命令与输出给出同一个结论', () => {
    for (const status of ['running', 'ok', 'failed'] as const) {
      expect(toolExpandable(tool({ status }))).toBe(true);
      expect(toolExpandable(tool({ status, command: undefined }))).toBe(false);
    }
  });
});

describe('toolStatusLabel', () => {
  it('三个状态三句话', () => {
    expect(toolStatusLabel('running')).toBe('运行中');
    expect(toolStatusLabel('ok')).toBe('完成');
    expect(toolStatusLabel('failed')).toBe('失败');
  });
});

describe('groupToolLabel / groupToolLabelSummary', () => {
  it('bash 取命令的第一个词；没有命令退回工具名；别的工具就是工具名', () => {
    expect(groupToolLabel(tool({ command: '  fastpaper search pubmed x' }))).toBe('fastpaper');
    expect(groupToolLabel(tool({ command: undefined }))).toBe('bash');
    expect(groupToolLabel(tool({ name: 'browser_act', command: 'fastpaper x' }))).toBe('browser_act');
  });

  it('三路 fastpaper 聚成「fastpaper ×3」；只有一条的不带 ×1', () => {
    const three = ['arxiv', 's2', 'pubmed'].map((src, i) => tool({ id: `t${i}`, command: `fastpaper search ${src} x` }));
    expect(groupToolLabelSummary(three)).toBe('fastpaper ×3');
    expect(groupToolLabelSummary([...three, tool({ id: 't9', command: 'slowpaper get x' })])).toBe('fastpaper ×3 · slowpaper');
  });

  it('标签种类超过上限：前 N 种照列，余下的记成「+M」', () => {
    const tools = ['a', 'b', 'c', 'd', 'e'].map((c, i) => tool({ id: `t${i}`, command: `${c} run` }));
    expect(groupToolLabelSummary(tools)).toBe('a · b · c +2');
    expect(groupToolLabelSummary(tools, 5)).toBe('a · b · c · d · e');
  });
});

/** 并行组表头右侧那一格。`e2e/63` 第二条的前提「一条跑完、一条还在跑」读的就是它。 */
describe('groupStatusSummary', () => {
  it('一条在跑、一条跑完 →「运行中 1 · 完成 1」', () => {
    expect(groupStatusSummary([tool({ id: 'a', status: 'ok' }), tool({ id: 'b', status: 'running' })])).toBe('运行中 1 · 完成 1');
  });

  it('全是同一个状态时说「全部…」', () => {
    expect(groupStatusSummary([tool({ status: 'ok' }), tool({ status: 'ok' }), tool({ status: 'ok' })])).toBe('全部完成');
    expect(groupStatusSummary([tool({ status: 'failed' }), tool({ status: 'failed' })])).toBe('全部失败');
    expect(groupStatusSummary([tool({ status: 'running' }), tool({ status: 'running' })])).toBe('全部运行中');
  });

  it('混合时按「运行中 → 完成 → 失败」的次序列，数为 0 的那一项不出现', () => {
    expect(groupStatusSummary([
      tool({ status: 'failed' }), tool({ status: 'ok' }), tool({ status: 'running' }), tool({ status: 'ok' }),
    ])).toBe('运行中 1 · 完成 2 · 失败 1');
    expect(groupStatusSummary([tool({ status: 'failed' }), tool({ status: 'ok' })])).toBe('完成 1 · 失败 1');
  });
});
