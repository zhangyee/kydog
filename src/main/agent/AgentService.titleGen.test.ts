import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { saveIndex } from '../persist/indexFile';
import { threadService } from '../thread/threadService';
import { agentService } from './AgentService';

// Mock electron so broadcaster.emit doesn't crash outside Electron.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

// Stub titleService so we can assert it was (not) called without running an LLM.
vi.mock('../thread/titleService', () => ({
  titleService: { generateForThread: vi.fn() },
}));
import { titleService } from '../thread/titleService';

// Force the fixture provider path so AgentService never reaches pi-coding-agent.
function makeFixture(dir: string, events: any[]): string {
  const file = path.join(dir, 'fixture.json');
  writeFileSync(file, JSON.stringify({ events }));
  return file;
}

// Minimal event sequences — only agent_start + agent_end matter for the trigger.
const COMPLETED_FIRST_TURN = [
  { type: 'agent_start', after_ms: 0 },
  { type: 'agent_end', after_ms: 0, reason: 'completed' },
];

const ABORTED_FIRST_TURN = [
  { type: 'agent_start', after_ms: 0 },
  { type: 'agent_end', after_ms: 0, reason: 'aborted' },
];

describe('AgentService — title generation trigger', () => {
  let dir: string;
  let projectPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-agt-'));
    projectPath = path.join(dir, 'proj');
    mkdirSync(projectPath, { recursive: true });
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    await saveIndex({
      schemaVersion: 1,
      projects: [{ path: projectPath, addedAt: new Date().toISOString() }],
      threads: [],
    });
    // Reset agent singleton state — same pattern as AgentService.invalidation.test.ts
    (agentService as any).sessions.clear();
    (agentService as any).runs.clear();
    (titleService.generateForThread as any).mockClear();
  });

  afterEach(async () => {
    delete process.env.KYDOG_AGENT_FIXTURE;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('fires titleService once on first completed turn', async () => {
    process.env.KYDOG_AGENT_FIXTURE = makeFixture(dir, COMPLETED_FIRST_TURN);
    const t = await threadService.create({ projectPath });
    const { runId } = await agentService.send(t.id, projectPath, 'Hi');
    // Wait until the fixture provider drains its event queue.
    await new Promise((r) => setTimeout(r, 50));
    expect(titleService.generateForThread).toHaveBeenCalledTimes(1);
    expect(titleService.generateForThread).toHaveBeenCalledWith(t.id, '');
    void runId;
  });

  it('does not fire on aborted first turn', async () => {
    process.env.KYDOG_AGENT_FIXTURE = makeFixture(dir, ABORTED_FIRST_TURN);
    const t = await threadService.create({ projectPath });
    await agentService.send(t.id, projectPath, 'Hi');
    await new Promise((r) => setTimeout(r, 50));
    expect(titleService.generateForThread).not.toHaveBeenCalled();
  });

  it('does not fire when thread already has a non-placeholder title', async () => {
    process.env.KYDOG_AGENT_FIXTURE = makeFixture(dir, COMPLETED_FIRST_TURN);
    const t = await threadService.create({ projectPath, title: 'Pre-named' });
    await agentService.send(t.id, projectPath, 'Hi');
    await new Promise((r) => setTimeout(r, 50));
    expect(titleService.generateForThread).not.toHaveBeenCalled();
  });
});
