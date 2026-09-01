import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));

import { broadcaster } from '../ipc/broadcaster';
import { agentService } from './AgentService';
import { ASK_TOOL_NAME } from '../../shared/askQuestion';

type Listener = (evt: { type: string; [k: string]: unknown }) => void;

/**
 * 造一个假 session 并挂上 AgentService 的订阅，返回可以直接灌 pi 事件的 listener。
 * 手法照 AgentService.invalidation.test.ts：直接往私有 map 里塞 bound。
 */
function attach(threadId: string) {
  let listener: Listener = () => undefined;
  const bound = {
    threadId, providerId: 'anthropic', modelId: 'm', cwd: '/x',
    activeMessageId: `${threadId}:msg`,
    askOpened: new Set<string>(),
    askArgs: new Map<string, { toolName: string; args: unknown }>(),
    // 这两个字段生产上由 ensureSession 初始化；这里绕过它直接塞 bound，得自己补齐。
    runJournal: [],
    runStartIndex: null,
    session: {
      prompt: vi.fn(), abort: vi.fn(), dispose: vi.fn(),
      subscribe: (l: Listener) => { listener = l; return () => undefined; },
    },
  };
  (agentService as any).sessions.set(threadId, bound);
  (agentService as any).runs.set(threadId, { status: 'running', runId: 'r1', abortRequested: false });
  (agentService as any).subscribe(bound);
  return { bound, fire: (evt: { type: string; [k: string]: unknown }) => listener(evt) };
}

const call = (name: string, id = name) => ({ type: 'toolCall', id, name });

const messageEnd = (content: unknown[]) => ({
  type: 'message_end',
  message: { role: 'assistant', content },
});

function emitted(topic: string) {
  return (broadcaster.emit as any).mock.calls.filter((c: unknown[]) => c[0] === topic);
}

describe('AgentService message_end → run.parallel_group', () => {
  beforeEach(() => {
    (agentService as any).sessions.clear();
    (agentService as any).runs.clear();
    (broadcaster.emit as any).mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('两个普通工具的批次发出 run.parallel_group', () => {
    const { fire } = attach('t1');
    fire(messageEnd([call('bash'), call('read')]));
    const groups = emitted('run.parallel_group');
    expect(groups).toHaveLength(1);
    expect(groups[0][1]).toMatchObject({
      threadId: 't1', runId: 'r1', messageId: 't1:msg',
      toolCallIds: ['bash', 'read'],
    });
  });

  it('批次里有 ask_user_question 时不发——pi 会把整批拖成串行', () => {
    const { fire } = attach('t1');
    fire(messageEnd([call('bash'), call(ASK_TOOL_NAME)]));
    expect(emitted('run.parallel_group')).toHaveLength(0);
  });

  it('单个工具的批次不发', () => {
    const { fire } = attach('t1');
    fire(messageEnd([call('bash')]));
    expect(emitted('run.parallel_group')).toHaveLength(0);
  });
});
