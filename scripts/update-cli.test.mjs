import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import readline from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitBlobSha } from './cli/skill-sync.mjs';

// github.mjs 是这条流程里唯一的网络出口，整个 mock 掉；
// skill-sync.mjs 里的 `import { fetchRepoFile } from './github.mjs'` 解析到同一个模块，一并被替换
vi.mock('./cli/github.mjs', () => ({
  latestStableTag: vi.fn(),
  fetchShaForAsset: vi.fn(async () => { throw new Error('fetchShaForAsset 不该被调用'); }),
  fetchDistManifest: vi.fn(async () => { throw new Error('fetchDistManifest 不该被调用'); }),
  fetchRepoTree: vi.fn(),
  fetchRepoFile: vi.fn(async () => Buffer.from('upstream\n')),
  releaseTagExists: vi.fn(),
  listStableTags: vi.fn(),
}));

const { fetchRepoTree, fetchRepoFile, latestStableTag, fetchShaForAsset, fetchDistManifest, releaseTagExists, listStableTags } = await import('./cli/github.mjs');
const { checkAndSyncSkill, parseToolArg, selectTools, checkAndPlan } = await import('./update-cli.mjs');

// checkAndSyncSkill 内部按 REPO_ROOT 解析 cfg.skill.dest，与 update-cli.mjs 里算法一致
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

describe('checkAndSyncSkill', () => {
  let dest, createInterface;

  beforeEach(() => {
    dest = mkdtempSync(path.join(tmpdir(), 'cli-update-dest-'));
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // 任何提问都要先建 readline；没建过就等于一次都没问过用户。
    // 这里故意让假接口一律答 "y"：守卫一旦失效，流程就会真的走到 applySkill 把 dest 删空，
    // 下面那几条 existsSync 断言才是真在兜底，而不是靠 stub 抛错提前拦住
    createInterface = vi.spyOn(readline, 'createInterface').mockImplementation(() => ({
      on() {},
      setPrompt() {},
      prompt() {},
      close() {},
      [Symbol.asyncIterator]: () => ({ next: async () => ({ value: 'y', done: false }) }),
    }));
  });

  afterEach(() => {
    rmSync(dest, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** dest 必须写成相对 REPO_ROOT 的路径，才能被 path.join(REPO_ROOT, dest) 还原回临时目录 */
  const cfgFor = (repoPath) => ({
    repo: 'zhangyee/fastpaper-cli',
    version: '0.2.0',
    releaseTagTemplate: 'v{version}',
    skill: { repoPath, dest: path.relative(REPO_ROOT, dest) },
  });

  it('没有 skill 字段的 tool 直接返回 null，一次网络都不发', async () => {
    const cfg = { repo: 'zhangyee/fastpaper-cli', version: '0.2.0', releaseTagTemplate: 'v{version}' };
    await expect(checkAndSyncSkill('fastpaper', cfg)).resolves.toBeNull();
    expect(fetchRepoTree).not.toHaveBeenCalled();
    expect(fetchRepoFile).not.toHaveBeenCalled();
  });

  it('上游一个文件都没有时硬报错，且不碰 dest 里的任何东西', async () => {
    // 本地有内容；repoPath 打错了字（fastpapre），上游 tree 里没有任何东西落在它下面
    writeFileSync(path.join(dest, 'SKILL.md'), 'hello\n');
    mkdirSync(path.join(dest, 'references'));
    writeFileSync(path.join(dest, 'references', 'x.md'), 'refs\n');

    fetchRepoTree.mockResolvedValue([
      { path: 'skills', type: 'tree', sha: 'tttt' },
      { path: 'skills/fastpaper/SKILL.md', type: 'blob', sha: 'aaaa' },
      { path: 'README.md', type: 'blob', sha: 'eeee' },
    ]);

    await expect(checkAndSyncSkill('fastpaper', cfgFor('skills/fastpapre')))
      .rejects.toThrow(/no files under "skills\/fastpapre"/);

    // 这条守卫的全部意义：没有它，upstream={} 会把下面每个文件都判成 removed 然后删光
    expect(existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(dest, 'references', 'x.md'))).toBe(true);
    expect(readdirSync(dest).sort()).toEqual(['SKILL.md', 'references']);
    // 连下载都没开始，更没走到 applySkill
    expect(fetchRepoFile).not.toHaveBeenCalled();
    expect(createInterface).not.toHaveBeenCalled();
  });

  it('报错信息里带上 repo@tag，好让人知道该去哪儿核对', async () => {
    fetchRepoTree.mockResolvedValue([{ path: 'README.md', type: 'blob', sha: 'eeee' }]);
    await expect(checkAndSyncSkill('fastpaper', cfgFor('skills/nope')))
      .rejects.toThrow(/zhangyee\/fastpaper-cli@v0\.2\.0/);
  });

  it('已同步时返回 null，不下载也不提问', async () => {
    writeFileSync(path.join(dest, 'SKILL.md'), 'hello\n');
    fetchRepoTree.mockResolvedValue([
      { path: 'skills/fastpaper/SKILL.md', type: 'blob', sha: gitBlobSha(Buffer.from('hello\n')) },
    ]);

    await expect(checkAndSyncSkill('fastpaper', cfgFor('skills/fastpaper'))).resolves.toBeNull();
    expect(fetchRepoFile).not.toHaveBeenCalled();
    expect(createInterface).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/in sync/));
  });

  it('tag 跟着 manifest 里的版本走（升级被跳过时按旧 tag 比对）', async () => {
    writeFileSync(path.join(dest, 'SKILL.md'), 'hello\n');
    fetchRepoTree.mockResolvedValue([
      { path: 'skills/fastpaper/SKILL.md', type: 'blob', sha: gitBlobSha(Buffer.from('hello\n')) },
    ]);
    const cfg = cfgFor('skills/fastpaper');
    cfg.version = '0.1.0';

    await checkAndSyncSkill('fastpaper', cfg);
    expect(fetchRepoTree).toHaveBeenCalledWith('zhangyee/fastpaper-cli', 'v0.1.0');
  });
});

describe('parseToolArg', () => {
  it('没有参数时返回 null（保持"所有 tool 对最新版"的现状）', () => {
    expect(parseToolArg([])).toBeNull();
  });

  it('只给 tool 名，版本为 null', () => {
    expect(parseToolArg(['fastpaper'])).toEqual({ name: 'fastpaper', version: null });
  });

  it('name@version 形式', () => {
    expect(parseToolArg(['fastpaper@0.2.1'])).toEqual({ name: 'fastpaper', version: '0.2.1' });
  });

  // npm 在带 -- 时会把 --tool 原样透传，不带 -- 时会自己吞掉它只留下值；
  // 两种形态都要能落到同一个结果，否则用户按哪种敲法都得看运气
  it('--tool <值> 与位置参数等价', () => {
    expect(parseToolArg(['--tool', 'fastpaper@0.2.1'])).toEqual({ name: 'fastpaper', version: '0.2.1' });
  });

  it('--tool=<值> 与位置参数等价', () => {
    expect(parseToolArg(['--tool=fastpaper@0.2.1'])).toEqual({ name: 'fastpaper', version: '0.2.1' });
  });

  it('--tool 后面没值时报错', () => {
    expect(() => parseToolArg(['--tool'])).toThrow(/--tool needs a value/);
  });

  it('缺 tool 名时报错', () => {
    expect(() => parseToolArg(['@0.2.1'])).toThrow(/missing tool name/);
  });

  it('@ 后面没版本时报错', () => {
    expect(() => parseToolArg(['fastpaper@'])).toThrow(/missing version/);
  });

  it('多个 @ 时报错', () => {
    expect(() => parseToolArg(['a@b@c'])).toThrow(/more than one/);
  });

  it('点名多个 tool 时报错', () => {
    expect(() => parseToolArg(['a', 'b'])).toThrow(/only one tool/);
  });

  // 手滑打错的 flag 若被当成"没给参数"，脚本会转头去升最新版——与本意正相反，必须拦
  it('无法识别的 flag 报错而不是被忽略', () => {
    expect(() => parseToolArg(['--verison', '0.2.1'])).toThrow(/unknown option/);
  });
});

describe('selectTools', () => {
  const manifest = { tools: { fastpaper: { version: '0.2.0' }, other: { version: '1.0.0' } } };

  it('没点名时返回全部 tool', () => {
    expect(selectTools(manifest, null).map(([n]) => n)).toEqual(['fastpaper', 'other']);
  });

  it('点名时只返回那一个', () => {
    const got = selectTools(manifest, { name: 'other', version: null });
    expect(got.map(([n]) => n)).toEqual(['other']);
    expect(got[0][1]).toBe(manifest.tools.other);
  });

  // 名字打错不该先花几秒去拉 GitHub 才告诉你，所以这一步在任何网络请求之前
  it('未知 tool 名报错并列出已知的名字', () => {
    expect(() => selectTools(manifest, { name: 'nope', version: null }))
      .toThrow(/unknown tool "nope".*fastpaper, other/);
  });
});

describe('checkAndPlan', () => {
  const cfg = () => ({
    repo: 'zhangyee/fastpaper-cli',
    version: '0.2.0',
    releaseTagTemplate: 'v{version}',
    binaryName: 'fastpaper',
    assets: { 'darwin-arm64': 'a', 'darwin-x64': 'b', 'win32-x64': 'c' },
    sha256: { 'darwin-arm64': 'aa', 'darwin-x64': 'bb', 'win32-x64': 'cc' },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    latestStableTag.mockResolvedValue('v0.3.0');
  });

  it('不指定版本时目标就是 latest，不去查 tag 是否存在', async () => {
    // 没钉版本 = 从 0.2.0 升到 latest，走的是 update 那条路，dist-manifest 与 sha 照常要抓；
    // 工厂里给这两个的默认实现是"不该被调用"的哨兵，此处必须打桩，否则测的就不是 tag 选择了
    fetchDistManifest.mockResolvedValue(null);
    fetchShaForAsset.mockResolvedValue('dd');
    const plan = await checkAndPlan('fastpaper', cfg(), null);
    expect(plan.targetTag).toBe('v0.3.0');
    expect(plan.latestTag).toBe('v0.3.0');
    expect(plan.requested).toBe(false);
    expect(releaseTagExists).not.toHaveBeenCalled();
  });

  // 钉住的版本正好是当前版本：不是 no-op，要照常返回让上层落到 skill 检查
  it('指定的版本正好是当前版本时报 up-to-date，但仍带上 latest 供显示', async () => {
    releaseTagExists.mockResolvedValue(true);
    const plan = await checkAndPlan('fastpaper', cfg(), '0.2.0');
    expect(releaseTagExists).toHaveBeenCalledWith('zhangyee/fastpaper-cli', 'v0.2.0');
    expect(plan.status).toBe('up-to-date');
    expect(plan.targetTag).toBe('v0.2.0');
    expect(plan.latestTag).toBe('v0.3.0');
    expect(plan.requested).toBe(true);
  });

  it('指定的版本上游没有时抛错并列出候选，且不去抓 dist-manifest', async () => {
    releaseTagExists.mockResolvedValue(false);
    listStableTags.mockResolvedValue(['v0.3.0', 'v0.2.1', 'v0.2.0']);
    await expect(checkAndPlan('fastpaper', cfg(), '9.9.9'))
      .rejects.toThrow(/v9\.9\.9.*v0\.3\.0, v0\.2\.1, v0\.2\.0/s);
    expect(fetchDistManifest).not.toHaveBeenCalled();
  });
});
