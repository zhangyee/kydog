import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * session 文件头里的 `cwd` 记的是不是这条对话的项目目录？
 *
 * `SessionManager.open(file)` 不带第三个参数时，新文件的头取 `process.cwd()` —— 从 Finder
 * 启动的打包版是 `/`，2026-09-21 之前所有 session 的头都是这个值。KyDog 眼下不调 pi 里读它的
 * 那几处（executeBash / export），所以行为上看不出来，只是盘上的事实错了；那天排查
 * 「transcript 落在别的项目目录」时，本该一眼对出来的东西只能靠目录哈希反推。
 *
 * 这里只替身掉 `createAgentSession`（截下交给它的参数），`SessionManager` 用 pi 真的：
 * 头是 pi 在第一条 assistant 消息出现时才写盘的，得真的走到那一步再从盘上读。
 */
const H = vi.hoisted(() => ({ captured: null as Record<string, unknown> | null }));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createAgentSession: async (opts: Record<string, unknown>) => {
    H.captured = opts;
    return { session: { prompt: async () => {}, abort: () => {}, subscribe: () => () => {} } };
  },
}));
vi.mock('../skills/skillResourceLoader', () => ({
  createKydogResourceLoader: async () => ({ reload: async () => {} }),
}));
vi.mock('../llm/providerRegistry', () => ({
  getProviderRegistry: () => ({ modelRuntime: { getModel: () => ({ id: 'm' }) } }),
}));
vi.mock('../settings/settingsService', () => ({
  settingsService: { get: async () => ({ ui: { locale: 'zh' }, institution: null }) },
  toInstitutionPublic: () => null,
}));
vi.mock('../browser/browserService', () => ({ browserService: {} }));
vi.mock('../browser/loginFlow', () => ({ loginFlow: { noteFor: () => null } }));

const { createSession } = await import('./sessionFactory');

type SM = {
  getCwd: () => string;
  appendMessage: (m: unknown) => string;
};

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function headerOnDisk(file: string): { type: string; cwd: string } {
  return JSON.parse(readFileSync(file, 'utf8').split('\n')[0]);
}

describe('session 文件头的 cwd', () => {
  let dir: string;
  let project: string;
  let sessionsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-sf-cwd-'));
    project = path.join(dir, 'LLM');
    sessionsDir = path.join(dir, 'sessions');
    mkdirSync(project);
    mkdirSync(sessionsDir);
    H.captured = null;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  async function build(threadId: string): Promise<SM> {
    await createSession({
      cwd: project, sessionId: threadId, sessionsDir,
      providerId: 'anthropic', modelId: 'm',
      askShared: { onOpened: () => {}, onClosed: () => {} },
    });
    return H.captured!.sessionManager as SM;
  }

  it('新对话：落盘后的头记的是项目目录，不是进程的 cwd', async () => {
    // 前提：进程的 cwd 与项目目录不同，否则两种写法写出来一样，这条测不出区别。
    expect(process.cwd()).not.toBe(project);
    const sm = await build('t-new');
    expect(sm.getCwd()).toBe(project);

    // pi 在第一条 assistant 消息出现时才把头连同之前的条目一起写盘。
    sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() });
    sm.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: 'hello' }],
      api: 'anthropic-messages', provider: 'anthropic', model: 'm',
      usage: ZERO_USAGE, stopReason: 'stop', timestamp: Date.now(),
    });
    const header = headerOnDisk(path.join(sessionsDir, 't-new.jsonl'));
    expect(header.type).toBe('session');
    expect(header.cwd).toBe(project);
  });

  it('旧对话（头里是 "/"）：运行时以项目目录为准，盘上的头不改写', async () => {
    const file = path.join(sessionsDir, 't-old.jsonl');
    const legacy = '{"type":"session","version":3,"id":"01a0c453-098b-7dbb-9185-2e8334501ab9","timestamp":"2026-09-21T14:16:11.403Z","cwd":"/"}\n';
    writeFileSync(file, legacy);
    const sm = await build('t-old');
    expect(sm.getCwd()).toBe(project);
    expect(readFileSync(file, 'utf8')).toBe(legacy);
  });
});
