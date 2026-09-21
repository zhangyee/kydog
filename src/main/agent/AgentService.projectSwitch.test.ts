/**
 * 复现 2026-09-21 的真实缺陷：「新对话」缺省落在 projects[0]，用户在输入框的项目下拉里
 * 换到别的项目再发消息 —— 工具却在旧项目里跑、transcript 写进旧项目的 sessions 目录，
 * 而 index 里这条对话记的是新项目（重启后按 index 找 transcript 找不到，对话变空）。
 *
 * 链路：打开对话那一刻 ensureSession 按旧项目建好 session、按 threadId 缓存；
 * thread.update 只改了 index（它为判断「是不是空对话」调的 loadHistory 本身也会按旧项目
 * 建 session）；send 命中缓存，调用方传进来的新 projectPath 被静默丢掉。
 *
 * 走真的 threadService + AgentService，只替换 createSession，记下每个 session 是按
 * 哪个 cwd / sessionsDir 建的。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));
vi.mock('./resolveActive', () => ({ resolveActive: vi.fn() }));
vi.mock('./sessionFactory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionFactory')>();
  return { ...actual, createSession: vi.fn() };
});
vi.mock('../thread/titleService', () => ({ titleService: { generateForThread: vi.fn() } }));

import * as paths from '../persist/paths';
import { saveIndex } from '../persist/indexFile';
import { createSession } from './sessionFactory';
import { resolveActive } from './resolveActive';
import { agentService } from './AgentService';
import { threadService } from '../thread/threadService';

type FakeSession = {
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  subscribe: () => () => void;
  dispose: ReturnType<typeof vi.fn>;
  state: { messages: unknown[] };
};

/** 每个造出来的 session → 它被造时收到的 cwd / sessionsDir。 */
let built: Array<{ session: FakeSession; cwd: string; sessionsDir: string }>;

function stubCreateSession(): void {
  vi.mocked(createSession).mockImplementation(async (opts) => {
    const session: FakeSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      subscribe: () => () => undefined,
      dispose: vi.fn(),
      state: { messages: [] },
    };
    built.push({ session, cwd: opts.cwd, sessionsDir: opts.sessionsDir });
    return session as never;
  });
}

describe('换项目之后 session 跟着换', () => {
  let dir: string;
  let projA: string;
  let projB: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-proj-switch-'));
    projA = path.join(dir, 'kydog-demo');
    projB = path.join(dir, 'LLM');
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    await saveIndex({
      schemaVersion: 1,
      projects: [
        { path: projA, addedAt: new Date().toISOString() },
        { path: projB, addedAt: new Date().toISOString() },
      ],
      threads: [],
    });
    (agentService as any).sessions.clear();
    (agentService as any).runs.clear();
    built = [];
    stubCreateSession();
    // 放在 beforeEach 里设：afterEach 的 restoreAllMocks 会把 vi.fn 的实现一并清掉。
    vi.mocked(resolveActive).mockResolvedValue({ providerId: 'anthropic', modelId: 'placeholder' });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('新对话打开后换项目再发消息：prompt 落在按新项目建的 session 上', async () => {
    const t = await threadService.create({ projectPath: projA });
    // 渲染层选中新对话就会拉历史 —— 这一步按旧项目建好 session 并缓存。
    await threadService.loadHistory({ threadId: t.id });
    // 前提：缓存里确实有一份按旧项目建的 session，否则下面的断言测不到这个缺陷。
    expect(built.map((b) => b.cwd)).toEqual([projA]);

    await threadService.update({ threadId: t.id, projectPath: projB });
    await threadService.send({ threadId: t.id, content: 'hi' });

    const prompted = built.filter((b) => b.session.prompt.mock.calls.length > 0);
    expect(prompted).toHaveLength(1);
    expect(prompted[0].cwd).toBe(projB);
    expect(prompted[0].sessionsDir).toBe(paths.sessionsDirFor(projB));
    expect(prompted[0].session.prompt).toHaveBeenCalledWith('hi');
    // 旧项目那份被拆掉，且没被 prompt 过（上面已证明 prompt 能被观测到）。
    const stale = built.find((b) => b.cwd === projA)!;
    expect(stale.session.dispose).toHaveBeenCalled();
    expect(stale.session.prompt).not.toHaveBeenCalled();
  });

  it('ensureSession 收到与缓存不同的 projectPath：空闲时重建，有一轮在飞时拒绝', async () => {
    // 空闲：拆掉旧的、按新 projectPath 重建。
    await agentService.ensureSession('idle', projA);
    const rebuilt = await agentService.ensureSession('idle', projB);
    expect(built.map((b) => b.cwd)).toEqual([projA, projB]);
    expect(built[0].session.dispose).toHaveBeenCalled();
    expect(rebuilt.cwd).toBe(projB);
    expect(rebuilt.session).toBe(built[1].session);

    // 在飞：拆了就把这一轮打断了，只能拒绝；缓存里那份原样留着。
    const running = await agentService.ensureSession('running', projA);
    running.runId = 'r1';
    await expect(agentService.ensureSession('running', projB)).rejects.toMatchObject({ code: 'thread.busy' });
    expect((agentService as any).sessions.get('running')).toBe(running);
    expect(built.map((b) => b.cwd)).toEqual([projA, projB, projA]);
    expect(built[2].session.dispose).not.toHaveBeenCalled();
  });
});
