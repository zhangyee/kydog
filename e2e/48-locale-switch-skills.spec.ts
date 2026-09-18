import { test, expect, type ElectronApplication } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage, type LaunchedApp } from './helpers';

/** 递归列出 skill 树里的全部文件相对路径。 */
async function listTree(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await listTree(root, child));
    else out.push(child);
  }
  return out;
}

async function readLocaleOnDisk(kydogHome: string): Promise<string> {
  const raw = await fs.readFile(path.join(kydogHome, '.kydog', 'kydog.json'), 'utf8');
  return JSON.parse(raw).ui.locale;
}

/** 内置 skill 源树的位置，跟 `builtinSkillsRoot()` 同一套判据（打包与否两条路都要走对）。 */
async function builtinSkillsRoot(electronApp: ElectronApplication): Promise<string> {
  const main = await electronApp.evaluate(({ app }) => ({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  }));
  return main.isPackaged
    ? path.join(main.resourcesPath, 'skills')
    : path.resolve(process.cwd(), 'src', 'skills');
}

/** `references/writing.md` + `en` → `references/writing.en.md`。 */
function variantOf(rel: string, locale: string): string {
  const dot = rel.lastIndexOf('.');
  return dot === -1 ? `${rel}.${locale}` : `${rel.slice(0, dot)}.${locale}${rel.slice(dot)}`;
}

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

/**
 * 落盘树的内容层 oracle：每个落盘文件都该逐字节等于「该 locale 这一格命中的那个源」——
 * 有 `.<locale>` 变体就是变体，没有才回落到默认语言文件。
 * 只看文件名换没换，投影选错源是查不出来的。
 *
 * 返回**回落清单**，由调用方钉死。这不是可选的：在「一个 `.en` 变体都没有」的世界里
 * 下面这圈比对同样全绿（处处回落到默认文件），不钉回落清单就没有负向对照。
 */
async function projectionMismatches(srcRoot: string, skillsDir: string, locale: string): Promise<string[]> {
  const fellBack: string[] = [];
  for (const entry of await fs.readdir(srcRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcSkill = path.join(srcRoot, entry.name);
    if (!await fileExists(path.join(srcSkill, 'SKILL.md'))) continue;   // 不是 skill 目录
    const landedSkill = path.join(skillsDir, entry.name);
    for (const rel of await listTree(landedSkill)) {
      const variant = variantOf(rel, locale);
      const picked = await fileExists(path.join(srcSkill, variant)) ? variant : rel;
      if (picked === rel) fellBack.push(`${entry.name}/${rel}`);
      expect(
        (await fs.readFile(path.join(landedSkill, rel))).equals(await fs.readFile(path.join(srcSkill, picked))),
        `${entry.name}/${rel} 落盘内容应逐字节等于源侧的 ${picked}`,
      ).toBe(true);
    }
  }
  return fellBack;
}

/**
 * 切界面语言连带换掉 skill 投影树。串行共用一次启动（中文起步）：先在有任务跑着时切、被拒；
 * 停掉任务后再切、成功，列表用返回值覆盖，磁盘上整棵树逐字节换成英文源。
 * 以 en 启动的那一次投影（不经过切换）由 54-packaged-smoke 在成品上守。
 */
test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let projectPath = '';

test.beforeAll(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  launched = await launchKydog({
    fixture: path.resolve('e2e/fixtures/long-run.json'),
    seed: async (home) => { await seedSettings(home, { locale: 'zh' }); await seedProject(home, projectPath); },
  });
});

test.afterAll(async () => {
  await teardown(launched);
  await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
});

test('48-locale: 有任务在跑时切换被拒，界面停在旧语言并说明原因', async () => {
  const { page, kydogHome } = launched;
  await page.getByTestId('new-thread').click();
  // 新建之后输入框会换一个实例，字可能填进正要卸载的那个（发送键就一直禁用）：填到字真的在
  // 当前这个输入框里为止（fill 是整体替换，重复无副作用）。
  const composer = page.getByTestId('composer-input');
  await expect.poll(async () => { await composer.fill('跑一会儿'); return composer.textContent(); }).toBe('跑一会儿');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('locale-en').click();
  // 被拒是一次正常返回：message 是给用户看的中文，不走异常路径。
  await expect(page.getByTestId('locale-switch-error')).toContainText('有任务正在运行', { timeout: 10_000 });
  // 被拒时 locale.set 带回的是原封不动的现状，界面钉在旧语言上。
  await expect(page.getByTestId('locale-zh')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('locale-en')).toHaveAttribute('aria-pressed', 'false');
  expect(await readLocaleOnDisk(kydogHome)).toBe('zh');

  // 陈旧提示不许留：popover 只是 return null、组件不卸载，不主动清就会在下次打开时原样再出现。
  // （正向：上面刚看到它在。）
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('user-menu')).toHaveCount(0);
  await page.getByTestId('user-menu-trigger').click();
  await expect(page.getByTestId('user-menu')).toBeVisible();
  await expect(page.getByTestId('locale-switch-error')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // 停掉那一轮，给下一条腾出「没有任务在跑」的前提。
  await page.getByTestId('stop-button').click();
  await expect(page.getByTestId('send-button')).toBeVisible();
});

test('48-locale: 切到 en 成功：skill 列表用返回值覆盖，投影树逐字节换成英文源', async () => {
  const { page, app, kydogHome } = launched;
  const skillsDir = path.join(kydogHome, '.kydog', 'skills');

  // 先把技能页打开，让 skillsStore 进入 ready —— 之后它不会再自己拉一次，列表里出现新东西就只
  // 可能来自 locale.set 的返回值。被拒那一次没碰 skill 树，所以这里也不该冒出「同步失败」。
  await page.getByTestId('nav-skills').click();
  await expect(page.getByTestId('skill-row').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('skill-sync-error')).toHaveCount(0);

  // 应用起来之后才出现的一个用户 skill：bootstrap 那次 skill.list 看不到它。
  const lateSkill = path.join(skillsDir, 'e2e-late-skill');
  await fs.mkdir(lateSkill, { recursive: true });
  await fs.writeFile(
    path.join(lateSkill, 'SKILL.md'),
    '---\nname: e2e-late-skill\ndescription: 装在 bootstrap 之后的用户 skill\n---\n\n正文\n',
  );
  const lateRow = page.locator('[data-testid="skill-row"][data-skill-name="e2e-late-skill"]');
  await expect(lateRow).toHaveCount(0);   // 此刻 store 里确实没有它（正向在切换之后）
  // 「覆盖进来的是英文那份」另钉一个内置 skill 的 description：它从落盘 SKILL.md 的 frontmatter 现读。
  const summaryRow = page.locator('[data-testid="skill-row"][data-skill-name="paper-summary"]');
  await expect(summaryRow).toContainText('精读用户指定的一篇或多篇论文');

  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('locale-en').click();
  // 选中态读的是 settings store，只由 locale.set 的返回值覆盖 —— 翻过去就说明主进程真的提交了。
  await expect(page.getByTestId('locale-en')).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  await expect(lateRow).toBeVisible({ timeout: 10_000 });
  await expect(summaryRow).toContainText('Read one or more user-specified papers closely', { timeout: 10_000 });
  await expect(summaryRow).not.toContainText('精读用户指定的一篇或多篇论文');
  await expect.poll(() => readLocaleOnDisk(kydogHome), { timeout: 10_000 }).toBe('en');

  // 磁盘：整棵树是异步重写的，先等 paper-summary 真的翻成英文，再整树逐字节比。
  const srcRoot = await builtinSkillsRoot(app);
  const summaryEn = await fs.readFile(path.join(srcRoot, 'paper-summary', 'SKILL.en.md'), 'utf8');
  await expect.poll(
    () => fs.readFile(path.join(skillsDir, 'paper-summary', 'SKILL.md'), 'utf8').catch(() => ''),
    { timeout: 10_000 },
  ).toBe(summaryEn);
  // 语言变体是源侧的维度，落盘树里只该有投影后的单语言文件。
  const tree = await listTree(path.join(skillsDir, 'paper-summary'));
  expect(tree).toContain('SKILL.md');
  expect(tree.filter((f) => /\.(zh|en)\.[^./]+$/.test(f))).toEqual([]);
  // 内容层：整棵树逐字节对上 en 这一格的源。回落清单是这圈比对的负向对照（见 projectionMismatches）：
  // 内置 skill 与上游 fastpaper 现在都有 .en 变体，一份都不该回落。④-ANCHOR 那几行由 builtinSkillsI18n.test 守。
  expect(await projectionMismatches(srcRoot, skillsDir, 'en')).toEqual([]);
});
