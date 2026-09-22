// src/main/agent/messageNormalizer.test.ts
import { describe, it, expect } from 'vitest';
import { normalizePiMessages, type PiMessage } from './messageNormalizer';
import { ASK_TOOL_NAME } from '../../shared/askQuestion';

describe('normalizePiMessages', () => {
  it('user message → KyDog user', () => {
    const input: PiMessage[] = [{ role: 'user', content: 'hi' }];
    expect(normalizePiMessages(input)).toEqual([
      { id: expect.any(String), role: 'user', createdAt: expect.any(String), content: 'hi' },
    ]);
  });

  it('assistant text + toolCall + toolResult merges into blocks', () => {
    const input: PiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } },
        ],
        stopReason: 'toolUse',
        api: 'anthropic' as never,
        provider: 'anthropic' as never,
        model: 'claude-3-5-sonnet',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      },
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'README\n' }],
        isError: false,
        timestamp: Date.now(),
      },
    ];
    const out = normalizePiMessages(input);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    if (out[0].role === 'assistant') {
      expect(out[0].blocks).toEqual([
        { kind: 'text', text: 'let me check' },
        {
          kind: 'tool_call', id: 't1', name: 'bash', command: 'ls',
          chunks: [{ stream: 'stdout', data: 'README\n' }],
          status: 'ok',
        },
      ]);
    }
  });

  it('thinking content → thinking block', () => {
    const input: PiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should think about this...' },
          { type: 'text', text: 'Here is my answer.' },
        ],
        stopReason: 'stop',
        api: 'anthropic' as never,
        provider: 'anthropic' as never,
        model: 'claude-3-7-sonnet',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      },
    ];
    const out = normalizePiMessages(input);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    if (out[0].role === 'assistant') {
      expect(out[0].blocks).toEqual([
        { kind: 'thinking', text: 'I should think about this...', status: 'done' },
        { kind: 'text', text: 'Here is my answer.' },
      ]);
    }
  });

  // ── 聚合：一个 turn 内 pi 把内容切成多条 assistant message，应合并为一条 KyDog Message ──

  it('一个 turn 内 assistant→toolResult→assistant→toolResult→assistant 合并为单条 KyDog Message', () => {
    const input: PiMessage[] = [
      { role: 'user', content: '搜一下 ECG 重建论文' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '我先想想' },
          { type: 'toolCall', id: 't1', name: 'search_papers', arguments: { q: 'ECG' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 't1', toolName: 'search_papers',
        content: [{ type: 'text', text: '找到 10 篇' }],
        isError: false,
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '再换个方向' },
          { type: 'toolCall', id: 't2', name: 'search_arxiv', arguments: { q: 'reconstruct' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 't2', toolName: 'search_arxiv',
        content: [{ type: 'text', text: '找到 5 篇' }],
        isError: false,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '结合两次搜索结果...' }],
      },
    ];
    const out = normalizePiMessages(input);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('user');
    expect(out[1].role).toBe('assistant');
    if (out[1].role === 'assistant') {
      expect(out[1].blocks.map(b => b.kind)).toEqual([
        'thinking', 'tool_call', 'thinking', 'tool_call', 'text',
      ]);
      // tool_call 仍正确填入 chunks（toolResult 不出现在 top-level）
      const tools = out[1].blocks.filter(b => b.kind === 'tool_call');
      expect(tools).toHaveLength(2);
      if (tools[0].kind === 'tool_call') expect(tools[0].chunks).toEqual([{ stream: 'stdout', data: '找到 10 篇' }]);
      if (tools[1].kind === 'tool_call') expect(tools[1].chunks).toEqual([{ stream: 'stdout', data: '找到 5 篇' }]);
    }
  });

  it('两个 turn（user 分隔）：每个 turn 各自聚合，独立成条', () => {
    const input: PiMessage[] = [
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: [{ type: 'text', text: '回答 A1' }] },
      { role: 'assistant', content: [{ type: 'text', text: '回答 A2' }] },
      { role: 'user', content: '第二轮' },
      { role: 'assistant', content: [{ type: 'text', text: '回答 B' }] },
    ];
    const out = normalizePiMessages(input);
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    if (out[1].role === 'assistant') {
      expect(out[1].blocks).toEqual([
        { kind: 'text', text: '回答 A1' },
        { kind: 'text', text: '回答 A2' },
      ]);
    }
    if (out[3].role === 'assistant') {
      expect(out[3].blocks).toEqual([{ kind: 'text', text: '回答 B' }]);
    }
  });

  it('末尾连续 assistant 在循环结束时被 flush，不丢失', () => {
    const input: PiMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    ];
    const out = normalizePiMessages(input);
    expect(out).toHaveLength(1);
    if (out[0].role === 'assistant') {
      expect(out[0].blocks).toEqual([
        { kind: 'text', text: 'a' },
        { kind: 'text', text: 'b' },
      ]);
    }
  });

  it('空数组返回空', () => {
    expect(normalizePiMessages([])).toEqual([]);
  });

  it('仅 user，无 assistant：照常返回', () => {
    const out = normalizePiMessages([
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every(m => m.role === 'user')).toBe(true);
  });

  // ── 并行 groupId 注入：协议层信号 ──

  it('一条 pi assistant message 里 ≥2 个 toolCall：共享同一个 parallelGroupId', () => {
    const input: PiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'fastpaper search a' } },
          { type: 'toolCall', id: 't2', name: 'bash', arguments: { command: 'fastpaper search b' } },
          { type: 'toolCall', id: 't3', name: 'bash', arguments: { command: 'fastpaper search c' } },
        ],
      },
    ];
    const out = normalizePiMessages(input);
    expect(out).toHaveLength(1);
    if (out[0].role !== 'assistant') return;
    const tools = out[0].blocks.filter(b => b.kind === 'tool_call');
    expect(tools).toHaveLength(3);
    const groupIds = tools.map(t => t.kind === 'tool_call' ? t.parallelGroupId : undefined);
    expect(groupIds[0]).toBeTruthy();
    expect(groupIds[0]).toBe(groupIds[1]);
    expect(groupIds[1]).toBe(groupIds[2]);
  });

  it('一条 pi assistant message 里只有 1 个 toolCall：不带 parallelGroupId', () => {
    const input: PiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'fastpaper search a' } },
        ],
      },
    ];
    const out = normalizePiMessages(input);
    if (out[0].role !== 'assistant') return;
    const tool = out[0].blocks[0];
    if (tool.kind === 'tool_call') expect(tool.parallelGroupId).toBeUndefined();
  });

  it('两条 pi assistant message 各 1 个 toolCall（串行）：都不带 groupId，即使被聚合到同一条 KyDog Message', () => {
    const input: PiMessage[] = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'fastpaper search a' } }] },
      {
        role: 'toolResult', toolCallId: 't1', toolName: 'bash',
        content: [{ type: 'text', text: 'r1' }], isError: false,
      },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't2', name: 'bash', arguments: { command: 'fastpaper search b' } }] },
      {
        role: 'toolResult', toolCallId: 't2', toolName: 'bash',
        content: [{ type: 'text', text: 'r2' }], isError: false,
      },
    ];
    const out = normalizePiMessages(input);
    expect(out).toHaveLength(1);
    if (out[0].role !== 'assistant') return;
    const tools = out[0].blocks.filter(b => b.kind === 'tool_call');
    expect(tools).toHaveLength(2);
    for (const t of tools) {
      if (t.kind === 'tool_call') expect(t.parallelGroupId).toBeUndefined();
    }
  });

  it('两条 pi assistant message 都各自有 ≥2 个 toolCall（两次独立并行）：两个 groupId 互不相同', () => {
    const input: PiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'fastpaper a' } },
          { type: 'toolCall', id: 't2', name: 'bash', arguments: { command: 'fastpaper b' } },
        ],
      },
      { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: '' }], isError: false },
      { role: 'toolResult', toolCallId: 't2', toolName: 'bash', content: [{ type: 'text', text: '' }], isError: false },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 't3', name: 'bash', arguments: { command: 'fastpaper c' } },
          { type: 'toolCall', id: 't4', name: 'bash', arguments: { command: 'fastpaper d' } },
        ],
      },
    ];
    const out = normalizePiMessages(input);
    if (out[0].role !== 'assistant') return;
    const tools = out[0].blocks.filter(b => b.kind === 'tool_call');
    expect(tools).toHaveLength(4);
    const ids = tools.map(t => t.kind === 'tool_call' ? t.parallelGroupId : undefined);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBeTruthy();
    expect(ids[2]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[2]);
  });

  it('write tool: 历史回放时 arguments 序列化为 command 字符串（与 realtime 对齐）', () => {
    const input: PiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tw1', name: 'write', arguments: { file_path: '/p/a.md', content: '# hi' } },
        ],
        stopReason: 'toolUse',
        api: 'anthropic' as never,
        provider: 'anthropic' as never,
        model: 'claude-3-5-sonnet',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      },
      {
        role: 'toolResult',
        toolCallId: 'tw1',
        toolName: 'write',
        content: [{ type: 'text', text: 'wrote' }],
        isError: false,
        timestamp: Date.now(),
      },
    ];
    const out = normalizePiMessages(input);
    expect(out).toHaveLength(1);
    if (out[0].role !== 'assistant') throw new Error('not assistant');
    const tool = out[0].blocks.find((b) => b.kind === 'tool_call');
    if (!tool || tool.kind !== 'tool_call') throw new Error('no tool block');
    expect(tool.command).toBe(JSON.stringify({ file_path: '/p/a.md', content: '# hi' }));
  });
});

describe('normalizePiMessages — 含 sequential 工具的批次不判为并行', () => {
  it('两个普通工具仍然共享 parallelGroupId', () => {
    const out = normalizePiMessages([
      { role: 'assistant', content: [
        { type: 'toolCall', id: 't1', name: 'bash', arguments: {} },
        { type: 'toolCall', id: 't2', name: 'read', arguments: {} },
      ] },
    ] as never);
    const blocks = (out[0] as { blocks: Array<{ parallelGroupId?: string }> }).blocks;
    expect(blocks[0].parallelGroupId).toBeDefined();
    expect(blocks[0].parallelGroupId).toBe(blocks[1].parallelGroupId);
  });

  it('批次里有 ask 时所有 toolCall 都没有 parallelGroupId', () => {
    const out = normalizePiMessages([
      { role: 'assistant', content: [
        { type: 'toolCall', id: 't1', name: 'bash', arguments: {} },
        { type: 'toolCall', id: 't2', name: ASK_TOOL_NAME, arguments: {} },
      ] },
    ] as never);
    const blocks = (out[0] as { blocks: Array<{ parallelGroupId?: string }> }).blocks;
    expect(blocks[0].parallelGroupId).toBeUndefined();
    expect(blocks[1].parallelGroupId).toBeUndefined();
  });
});

describe('normalizePiMessages — ask_user_question', () => {
  const questions = [{
    id: 'q0', question: '选哪个？', header: '选择',
    options: [{ id: 'q0o0', label: 'A', description: 'a' }, { id: 'q0o1', label: 'B', description: 'b' }],
  }];
  const askCall = { type: 'toolCall' as const, id: 'tc1', name: ASK_TOOL_NAME, arguments: {} };

  it('有合法 AskOutcome 的 toolResult 还原成 answered 的 ask block', () => {
    const answers = [{ questionId: 'q0', kind: 'answered' as const, optionIds: ['q0o0'] }];
    const out = normalizePiMessages([
      { role: 'assistant', content: [askCall] },
      {
        role: 'toolResult', toolCallId: 'tc1', toolName: ASK_TOOL_NAME, isError: false,
        content: [{ type: 'text', text: '用户回答：' }],
        details: { kind: 'answered', answers, questions },
      },
    ] as never);
    const block = (out[0] as { blocks: Array<Record<string, unknown>> }).blocks[0];
    expect(block).toEqual({ kind: 'ask', toolCallId: 'tc1', questions, status: 'answered', answers });
  });

  it('cancelled 的 toolResult 还原成 cancelled，不带 answers', () => {
    const out = normalizePiMessages([
      { role: 'assistant', content: [askCall] },
      {
        role: 'toolResult', toolCallId: 'tc1', toolName: ASK_TOOL_NAME, isError: false,
        content: [{ type: 'text', text: '用户关闭了提问，未作回答。' }],
        details: { kind: 'cancelled', questions },
      },
    ] as never);
    const block = (out[0] as { blocks: Array<Record<string, unknown>> }).blocks[0];
    expect(block).toEqual({ kind: 'ask', toolCallId: 'tc1', questions, status: 'cancelled' });
  });

  it('aborted 同样还原，且与 cancelled 区分', () => {
    const out = normalizePiMessages([
      { role: 'assistant', content: [askCall] },
      {
        role: 'toolResult', toolCallId: 'tc1', toolName: ASK_TOOL_NAME, isError: false,
        content: [{ type: 'text', text: '提问被中止，用户未作回答。' }],
        details: { kind: 'aborted', questions },
      },
    ] as never);
    const block = (out[0] as { blocks: Array<Record<string, unknown>> }).blocks[0];
    expect(block).toMatchObject({ kind: 'ask', status: 'aborted' });
    expect(block).not.toHaveProperty('answers');
  });

  it('没有 toolResult 还原成 unanswered，问题文本取自 arguments', () => {
    const out = normalizePiMessages([
      { role: 'assistant', content: [{
        type: 'toolCall', id: 'tc1', name: ASK_TOOL_NAME,
        arguments: { questions: [{ question: '选哪个？', header: '选择', options: [
          { label: 'A', description: 'a' }, { label: 'B', description: 'b' },
        ] }] },
      }] },
    ] as never);
    const block = (out[0] as { blocks: Array<Record<string, unknown>> }).blocks[0];
    expect(block).toMatchObject({ kind: 'ask', toolCallId: 'tc1', status: 'unanswered' });
    const qs = (block as { questions: Array<{ id: string; question: string }> }).questions;
    expect(qs[0].id).toBe('q0');
    expect(qs[0].question).toBe('选哪个？');
  });

  it('fallback 的 id 按下标分配，多问题时不会全挤在 q0', () => {
    const opts = [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }];
    const out = normalizePiMessages([
      { role: 'assistant', content: [{
        type: 'toolCall', id: 'tc1', name: ASK_TOOL_NAME,
        arguments: { questions: [
          { question: '第一题？', header: '一', options: opts },
          { question: '第二题？', header: '二', options: opts },
        ] },
      }] },
    ] as never);
    const qs = (out[0] as { blocks: Array<{ questions: Array<{ id: string; options: Array<{ id: string }> }> }> })
      .blocks[0].questions;
    expect(qs.map((q) => q.id)).toEqual(['q0', 'q1']);
    expect(qs[1].options.map((o) => o.id)).toEqual(['q1o0', 'q1o1']);
  });

  it('details 是空对象（校验失败留下的 error toolResult）还原成普通失败工具卡片', () => {
    const out = normalizePiMessages([
      { role: 'assistant', content: [askCall] },
      {
        role: 'toolResult', toolCallId: 'tc1', toolName: ASK_TOOL_NAME, isError: true,
        content: [{ type: 'text', text: 'questions 只能有 1–4 条' }],
        details: {},
      },
    ] as never);
    const block = (out[0] as { blocks: Array<Record<string, unknown>> }).blocks[0];
    expect(block.kind).toBe('tool_call');
    expect(block.status).toBe('failed');
    expect(block.chunks).toEqual([{ stream: 'stdout', data: 'questions 只能有 1–4 条' }]);
  });

  // 「有没有 toolResult」是协议事实，不能用 details 在不在去反推：details 缺失的
  // toolResult 依然是一个已经结束的调用，不是「进程挂在提问上退出」。
  it('有 toolResult 但没有 details 时还原成普通失败工具卡片，不是 unanswered', () => {
    const out = normalizePiMessages([
      { role: 'assistant', content: [askCall] },
      {
        role: 'toolResult', toolCallId: 'tc1', toolName: ASK_TOOL_NAME, isError: true,
        content: [{ type: 'text', text: 'questions 只能有 1–4 条' }],
      },
    ] as never);
    const block = (out[0] as { blocks: Array<Record<string, unknown>> }).blocks[0];
    expect(block.kind).toBe('tool_call');
    expect(block.status).toBe('failed');
  });

  it('普通工具不受影响', () => {
    const out = normalizePiMessages([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'ls' } }] },
      { role: 'toolResult', toolCallId: 'b1', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'ok' }] },
    ] as never);
    const block = (out[0] as { blocks: Array<Record<string, unknown>> }).blocks[0];
    expect(block.kind).toBe('tool_call');
    expect(block.status).toBe('ok');
  });
});

/**
 * 以错误结束的一轮（2026-09-14 修的 bug）。
 *
 * provider 在模型说出第一个字之前就拒了请求（实测：DeepSeek 回 402 余额不足），pi 在
 * transcript 里记下一条 content 为空、stopReason 为 'error'、带 errorMessage 的 assistant。
 * 以前这里只看 content：空 content 让 flushAssistant 当成「没东西」直接丢掉 —— 重启之后
 * 这一轮在界面上什么都不剩，连出过错的迹象都没有。「出错」是这一轮回复自己的事实，
 * pi 已经记在这条消息上，归一化必须把它带出来。
 */
describe('normalizePiMessages — 以错误结束的一轮', () => {
  it('一个字都没输出就失败：仍然产出一条回复，只含一个带错误原文的 error 块', () => {
    const input: PiMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant', content: [], stopReason: 'error',
        errorMessage: '402: {"message":"Insufficient Balance"}', timestamp: 1,
      },
    ];
    const out = normalizePiMessages(input);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      role: 'assistant',
      blocks: [{ kind: 'error', text: '402: {"message":"Insufficient Balance"}' }],
    });
  });

  it('输出了一段之后才失败：error 块排在已经输出的内容之后', () => {
    const input: PiMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant', content: [{ type: 'text', text: '我先看看' }], stopReason: 'error',
        errorMessage: 'socket hang up', timestamp: 1,
      },
    ];
    const out = normalizePiMessages(input);
    expect(out[1]).toMatchObject({
      role: 'assistant',
      blocks: [{ kind: 'text', text: '我先看看' }, { kind: 'error', text: 'socket hang up' }],
    });
  });
});

describe('normalizePiMessages —— 用户消息保留图片', () => {
  it('图片块按原顺序进 images，文字块照旧拼成 content；纯文字消息不带 images 键', () => {
    const out = normalizePiMessages([
      { role: 'user', content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'X', mimeType: 'image/png' },
        { type: 'text', text: 'b' },
        { type: 'image', data: 'Y', mimeType: 'image/jpeg' },
      ] },
      { role: 'user', content: 'plain' },
    ] as PiMessage[], 't');
    expect(out[0]).toMatchObject({ role: 'user', content: 'ab', images: [
      { data: 'X', mimeType: 'image/png' }, { data: 'Y', mimeType: 'image/jpeg' },
    ] });
    expect(out[1]).toMatchObject({ role: 'user', content: 'plain' });
    expect(out[1]).not.toHaveProperty('images');
  });
});
