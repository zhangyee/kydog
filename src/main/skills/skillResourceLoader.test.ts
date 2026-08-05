import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { buildSkillsOverride, loadHarnessAgentsFiles, buildAgentsFilesOverride, HARNESS_MAX_CHARS, kydogAgentDir, createKydogResourceLoader } from './skillResourceLoader';

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

describe('createKydogResourceLoader', () => {
  let home: string;   // 假的 ~/.kydog
  let proj: string;   // 假的项目 cwd

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'kydog-loader-home-'));
    proj = mkdtempSync(path.join(os.tmpdir(), 'kydog-loader-proj-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(home);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(home, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(home, '.kydog.json.lock'));
    ensureSettingsFile();
    writeFileSync(path.join(home, 'SOUL.md'), 'S');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // agentDir 若退回 pi.getAgentDir() 就会变成 ~/.pi/agent —— 用户 pi CLI 的家目录。
  // 那里的 settings.json / SYSTEM.md / extensions 会被静默吃进来，装了 pi 的机器和没装的
  // 行为不一致且无从察觉。用 agentDir/SYSTEM.md 的发现结果反证 agentDir 指到了哪。
  it('agentDir 指向 <ROOT>/agent，不是 pi 的 ~/.pi/agent', async () => {
    expect(kydogAgentDir()).toBe(path.join(home, 'agent'));

    const agentDir = path.join(home, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, 'SYSTEM.md'), 'kydog system prompt');

    const loader = await createKydogResourceLoader(proj);
    await loader.reload();
    expect(loader.getSystemPrompt()).toBe('kydog system prompt');
  });

  // noExtensions 关的是「从磁盘发现的扩展」，走的是 extensionPaths 那条路；
  // extensionFactories 走 loadExtensionFactories()，是另一条。两者不能混。
  // 这条在升 pi 时会重新验证一遍该假设 —— 它塌了，提问工具的批次守卫会静默失效。
  it('noExtensions 不影响 extensionFactories：askBatch 仍然挂上', async () => {
    const loader = await createKydogResourceLoader(proj);
    await loader.reload();
    const inline = loader.getExtensions().extensions.filter((e) => e.path.startsWith('<inline:'));
    expect(inline).toHaveLength(1);
  });

  // 扩展不靠目录扫描发现，而是靠 .pi/settings.json 里的 `extensions` 声明
  // （package-manager.js:690 起，项目条目相对 <cwd>/.pi 解析）。所以这里必须连
  // settings.json 一起造，只丢个 .js 进去是测不出东西的。
  it('项目 .pi/settings.json 声明的扩展不会被加载', async () => {
    const piDir = path.join(proj, '.pi');
    mkdirSync(path.join(piDir, 'extensions'), { recursive: true });
    writeFileSync(
      path.join(piDir, 'extensions', 'evil.js'),
      'export default function (pi) { pi.on("agent_end", () => {}); }\n',
    );
    writeFileSync(path.join(piDir, 'settings.json'), JSON.stringify({ extensions: ['extensions/evil.js'] }));

    const loader = await createKydogResourceLoader(proj);
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();

    // 加载成功会进 extensions，加载失败会进 errors —— 两边都不能出现它。
    expect(extensions.filter((e) => !e.path.startsWith('<inline:'))).toEqual([]);
    expect(errors.filter((e) => e.path.includes('evil.js'))).toEqual([]);
  });

  // sessionFactory 调 reload({ resolveProjectTrust: async () => false })。DefaultResourceLoader
  // 只在传了这个选项时才去问信任（resource-loader.js `if (options?.resolveProjectTrust)`），
  // SettingsManager.projectTrusted 默认是 true —— 也就是说不传等于「信任用户随手打开的任意
  // 目录」，那里的 .pi/settings.json 会被整份吃进来，.pi/SYSTEM.md 会顶掉 KyDog 自己的系统提示。
  // 双向断言：不传时项目 SYSTEM.md 确实生效，传了才不生效。只断言后一半的话，选项被删掉测试照绿。
  it('resolveProjectTrust=false 挡掉项目本地 .pi/SYSTEM.md，不传则会被吃进来', async () => {
    const agentDir = path.join(home, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, 'SYSTEM.md'), 'kydog own prompt');
    mkdirSync(path.join(proj, '.pi'), { recursive: true });
    writeFileSync(path.join(proj, '.pi', 'SYSTEM.md'), 'project injected prompt');
    writeFileSync(path.join(proj, 'AGENTS.md'), 'P');

    // 默认信任：项目的 SYSTEM.md 赢过 agentDir 的。这半边证明发现路径本身是通的，
    // 下半边的「没吃到」才不会是因为文件根本没被看见。
    const trusting = await createKydogResourceLoader(proj);
    await trusting.reload();
    expect(trusting.getSystemPrompt()).toBe('project injected prompt');

    const loader = await createKydogResourceLoader(proj);
    await loader.reload({ resolveProjectTrust: async () => false });
    expect(loader.getSystemPrompt()).toBe('kydog own prompt');

    // 项目 AGENTS.md 不受 trust 门禁管（loadProjectContextFiles() 无条件走 cwd 及祖先），
    // 钉在这里免得以后有人把它当回归。
    const files = loader.getAgentsFiles().agentsFiles;
    expect(files.some((f) => f.path === path.join(proj, 'AGENTS.md'))).toBe(true);
  });

  it('harness 文件前置于项目 agents files', async () => {
    writeFileSync(path.join(proj, 'AGENTS.md'), 'P');
    const loader = await createKydogResourceLoader(proj);
    await loader.reload();
    const files = loader.getAgentsFiles().agentsFiles;
    expect(path.basename(files[0].path)).toBe('SOUL.md');
    expect(files.some((f) => f.path === path.join(proj, 'AGENTS.md'))).toBe(true);
  });
});
