import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSkillsOverride, loadHarnessAgentsFiles, buildAgentsFilesOverride, HARNESS_MAX_CHARS } from './skillResourceLoader';

describe('buildSkillsOverride', () => {
  it('filters disabled names from skills, preserves diagnostics', () => {
    const override = buildSkillsOverride(['fastpaper']);
    const base = {
      skills: [{ name: 'fastpaper' }, { name: 'agent-browser' }],
      diagnostics: [{ kind: 'noop' as const }],
    };
    const out = override(base);
    expect(out.skills.map((s) => s.name)).toEqual(['agent-browser']);
    expect(out.diagnostics).toBe(base.diagnostics);
  });

  it('passes through unchanged when disabled list is empty', () => {
    const override = buildSkillsOverride([]);
    const base = {
      skills: [{ name: 'a' }, { name: 'b' }],
      diagnostics: [],
    };
    const out = override(base);
    expect(out.skills.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('captures disabled list at builder time (snapshot semantics)', () => {
    const list = ['x'];
    const override = buildSkillsOverride([...list]); // copy
    list.push('y'); // mutate after
    const out = override({ skills: [{ name: 'x' }, { name: 'y' }], diagnostics: [] });
    expect(out.skills.map((s) => s.name)).toEqual(['y']); // 'x' filtered, 'y' survived (not in snapshot)
  });
});

describe('harness 注入', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-inject-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('顺序 SOUL → USER → AGENTS，缺失跳过', async () => {
    writeFileSync(path.join(dir, 'SOUL.md'), 'S');
    writeFileSync(path.join(dir, 'AGENTS.md'), 'A'); // USER.md 缺失
    const files = await loadHarnessAgentsFiles(dir);
    expect(files.map((f) => path.basename(f.path))).toEqual(['SOUL.md', 'AGENTS.md']);
  });

  it('超长截断 + [已截断] 标记', async () => {
    writeFileSync(path.join(dir, 'SOUL.md'), 'x'.repeat(HARNESS_MAX_CHARS + 100));
    const [f] = await loadHarnessAgentsFiles(dir);
    expect(f.content.length).toBe(HARNESS_MAX_CHARS + '\n[已截断]'.length);
    expect(f.content.endsWith('[已截断]')).toBe(true);
  });

  it('override 前置于既有 agentsFiles', () => {
    const override = buildAgentsFilesOverride([{ path: '/h/SOUL.md', content: 'S' }]);
    const out = override({ agentsFiles: [{ path: '/proj/AGENTS.md', content: 'P' }] });
    expect(out.agentsFiles.map((f) => f.path)).toEqual(['/h/SOUL.md', '/proj/AGENTS.md']);
  });
});
