/**
 * 复现今天撞上的真实缺陷：某条对话是用一个后来被上游从目录里撤掉的模型建的
 * （deepseek/deepseek-v4-flash-vision-exp 那次）。ensureSession 因为
 * ModelUnavailableError 建不起 session 时：
 *   - loadHistory 必须照常把盘上的 transcript 读出来（内容还在，只是模型没了）；
 *   - 读出来的结果要与「模型还在、走活 session（piMessagesOf）那条路」等价；
 *   - 别的失败（这里用一个不相干的 Error 模拟磁盘/权限问题）不能被这条回退吞掉；
 *   - send() 仍然要 ensureSession，但抛出的错误要说得清楚下一步。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));
vi.mock('./resolveActive', () => ({
  resolveActive: vi.fn().mockResolvedValue({ providerId: 'anthropic', modelId: 'placeholder' }),
}));

// AgentService.loadHistoryWithoutSession 只靠 sessionFileFor 找到盘上的 transcript——
// 把它钉到临时目录，绕开真实 ~/.kydog（sessionsDirFor/sessionFileFor 是 paths.ts 里
// 算好的 const，vi.spyOn 只能换外部看到的 getter，换不了模块内部对同一个 const 的
// 引用，实测验证过；模块级 vi.mock 才管用）。
const pathsState = vi.hoisted(() => ({ sessionFile: '' }));
vi.mock('../persist/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persist/paths')>();
  return { ...actual, sessionFileFor: () => pathsState.sessionFile };
});

vi.mock('./sessionFactory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionFactory')>();
  return { ...actual, createSession: vi.fn() };
});

import { createSession, ModelUnavailableError } from './sessionFactory';
import { resolveActive } from './resolveActive';
import { agentService } from './AgentService';
import { normalizePiMessages, type PiMessage } from './messageNormalizer';
import type { Message } from '../../shared/types';

/**
 * normalizePiMessages 给每条消息盖 `new Date().toISOString()`，两次独立调用
 * （一次算 expected，一次是 loadHistory 内部真跑的那次）之间可能跨过一毫秒——
 * AgentService.resync.test.ts 里「归一化的 message id 是确定性的」那条也是靠
 * 只比 id、不比 createdAt 绕开这一点。这里两条路要比的是内容（role/blocks/content），
 * 不是「两次调用发生在同一毫秒」，所以把 createdAt 统一抹平再比。
 */
function stripCreatedAt(messages: Message[]): unknown[] {
  return messages.map((m) => ({ ...m, createdAt: '<ts>' }));
}

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMsg(text: string) {
  return { role: 'user' as const, content: [{ type: 'text', text }], timestamp: Date.now() };
}
function assistantMsg(content: Array<Record<string, unknown>>) {
  const hasToolCall = content.some((c) => c.type === 'toolCall');
  return {
    role: 'assistant' as const, content,
    api: 'anthropic-messages', provider: 'anthropic', model: 'claude-x',
    usage: ZERO_USAGE, stopReason: hasToolCall ? 'toolUse' : 'stop', timestamp: Date.now(),
  };
}
function toolResultMsg(toolCallId: string, toolName: string, text: string, isError = false) {
  return {
    role: 'toolResult' as const, toolCallId, toolName,
    content: [{ type: 'text', text }], isError, timestamp: Date.now(),
  };
}

describe('AgentService — 模型从 registry 里消失后的历史回退', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-model-gone-'));
    (agentService as any).sessions.clear();
    (agentService as any).runs.clear();
    (createSession as any).mockReset();
    // vi.mock 工厂里的 mockResolvedValue 只设一次；如果哪个用例（或以前跑过的用例）
    // 调用过 vi.restoreAllMocks()/mockReset()，这个 mock 会被清空成"什么都不返回"。
    // 每个用例开工前都重新钉一遍，别依赖它"一直是那个值"。
    (resolveActive as any).mockReset().mockResolvedValue({ providerId: 'anthropic', modelId: 'placeholder' });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 用 pi 真实的 SessionManager 写一份 jsonl（不是手写 JSON，理由见 CLAUDE.md
   * 「别凭记忆猜 API」），返回「假如 session 还活着，piMessagesOf 会读到的那份数组」
   * ——pi 的 agent-session.js 建 session 时就是拿 buildSessionContext().messages
   * 直接赋给 state.messages，两者是同一份数据的来源。
   */
  async function seedRealSession(threadId: string): Promise<PiMessage[]> {
    const pi = await import('@earendil-works/pi-coding-agent');
    const file = path.join(dir, `${threadId}.jsonl`);
    pathsState.sessionFile = file;
    const manager = (pi as any).SessionManager.open(file);
    manager.appendMessage(userMsg('查一下这篇论文被引用了多少次'));
    manager.appendMessage(assistantMsg([
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'fastpaper cite 123' } },
    ]));
    manager.appendMessage(toolResultMsg('call-1', 'bash', '引用了 12 次', false));
    manager.appendMessage(assistantMsg([{ type: 'text', text: '一共被引用 12 次。' }]));
    return manager.buildSessionContext().messages as PiMessage[];
  }

  it('ensureSession 因为模型不在了而失败：loadHistory 回退读盘，结果与「活 session」那条路等价', async () => {
    const threadId = 't-gone';
    const liveEquivalent = await seedRealSession(threadId);
    const expected = normalizePiMessages(liveEquivalent, threadId);
    // 正向前置：换成有真实内容的 transcript，等价断言才不是拿两个 [] 比对。
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.some((m) => m.role === 'assistant' && m.blocks.some((b) => b.kind === 'tool_call'))).toBe(true);

    (createSession as any).mockRejectedValue(new ModelUnavailableError('deepseek', 'deepseek-v4-flash-vision-exp'));

    const actual = await agentService.loadHistory(threadId, '/proj');
    expect(stripCreatedAt(actual)).toEqual(stripCreatedAt(expected));
  });

  it('别的失败（不是模型不在了）照旧抛出去，不会被静默吞成空历史', async () => {
    const threadId = 't-other-fail';
    await seedRealSession(threadId); // 盘上确实有内容——如果这条回退被错误地扩大到所有异常，
    // 底下这次调用会"成功"返回内容而不是 reject，从结果上就骗过了测试。
    (createSession as any).mockRejectedValue(new Error('EACCES: permission denied'));

    await expect(agentService.loadHistory(threadId, '/proj')).rejects.toThrow('EACCES: permission denied');
  });

  it('没有 session 文件（全新 thread）时回退返回空历史，不抛错', async () => {
    const threadId = 't-brand-new';
    pathsState.sessionFile = path.join(dir, `${threadId}.jsonl`); // 从未写过
    (createSession as any).mockRejectedValue(new ModelUnavailableError('deepseek', 'gone-model'));

    await expect(agentService.loadHistory(threadId, '/proj')).resolves.toEqual([]);
  });
});

describe('AgentService.send — 模型不在了时的提示文案', () => {
  beforeEach(() => {
    (agentService as any).sessions.clear();
    (agentService as any).runs.clear();
    (createSession as any).mockReset();
    (resolveActive as any).mockReset().mockResolvedValue({ providerId: 'anthropic', modelId: 'placeholder' });
  });

  it('说清楚原来用的模型，并提示去哪切换，而不是甩一句技术性的 "model not found"', async () => {
    (createSession as any).mockRejectedValue(
      new ModelUnavailableError('deepseek', 'deepseek-v4-flash-vision-exp'),
    );

    await expect(agentService.send('t1', '/proj', '你好')).rejects.toMatchObject({ code: 'llm.invalid' });

    try {
      await agentService.send('t1', '/proj', '你好');
      expect.unreachable('应该抛错');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('deepseek/deepseek-v4-flash-vision-exp');
      expect(message).toContain('切换模型');
    }
  });
});
