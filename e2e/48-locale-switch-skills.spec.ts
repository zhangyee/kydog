import { test, expect, type ElectronApplication } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

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

test('48-locale: 切到 en 落到磁盘，投影树逐字节就是英文源', async () => {
  const app = await launchKydog({
    seed: async (home) => { await seedSettings(home, { locale: 'zh' }); },
  });
  try {
    const { page, kydogHome } = app;
    const skillsDir = path.join(kydogHome, '.kydog', 'skills');
    await expect.poll(
      async () => fs.access(path.join(skillsDir, 'paper-summary', 'SKILL.md')).then(() => true).catch(() => false),
      { timeout: 10_000 },
    ).toBe(true);

    await page.locator('[data-testid="user-menu-trigger"]').click();
    await expect(page.locator('[data-testid="locale-zh"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-testid="locale-en"]').click();

    // 选中态读的是 settings store，而 store 只由 locale.set 的返回值覆盖 ——
    // 它翻过去就说明主进程真的提交了，不是本地乐观更新。
    await expect(page.locator('[data-testid="locale-en"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
    await expect(page.locator('[data-testid="locale-switch-error"]')).toHaveCount(0);

    await expect.poll(() => readLocaleOnDisk(kydogHome), { timeout: 10_000 }).toBe('en');

    // 语言变体是源侧的维度，落盘树里只该有投影后的单语言文件。
    const tree = await listTree(path.join(skillsDir, 'paper-summary'));
    expect(tree).toContain('SKILL.md');
    expect(tree.filter((f) => /\.(zh|en)\.[^./]+$/.test(f))).toEqual([]);

    const srcRoot = await builtinSkillsRoot(app.app);

    // 整棵树是异步重写的：locale 落盘不等于内容已经换过来，先等它真的翻成英文再逐字节比。
    const summaryEn = await fs.readFile(path.join(srcRoot, 'paper-summary', 'SKILL.en.md'), 'utf8');
    await expect.poll(
      () => fs.readFile(path.join(skillsDir, 'paper-summary', 'SKILL.md'), 'utf8').catch(() => ''),
      { timeout: 10_000 },
    ).toBe(summaryEn);

    // 内容层：每个落盘文件都该逐字节等于「en 这一格命中的那个源」——有 `.en` 变体就是变体，
    // 没有才回落到默认语言文件。只看文件名换没换，投影选错源是查不出来的。
    const fellBack: string[] = [];
    for (const entry of await fs.readdir(srcRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const srcSkill = path.join(srcRoot, entry.name);
      if (!await fileExists(path.join(srcSkill, 'SKILL.md'))) continue;   // 不是 skill 目录
      const landedSkill = path.join(skillsDir, entry.name);
      for (const rel of await listTree(landedSkill)) {
        const variant = variantOf(rel, 'en');
        const picked = await fileExists(path.join(srcSkill, variant)) ? variant : rel;
        if (picked === rel) fellBack.push(`${entry.name}/${rel}`);
        expect(
          (await fs.readFile(path.join(landedSkill, rel))).equals(await fs.readFile(path.join(srcSkill, picked))),
          `${entry.name}/${rel} 落盘内容应逐字节等于源侧的 ${picked}`,
        ).toBe(true);
      }
    }
    // 负向对照：上面那圈在「一个 `.en` 变体都没有」的世界里同样全绿（处处回落到默认文件），
    // 所以必须钉住回落清单。fastpaper 归上游，暂时只有中文；上游发出双语 tag 之后这里跟着清空
    // ——和 `builtinSkillsI18n.test.ts` 的 `EXEMPT` 是同一条有期限的例外。
    expect(fellBack).toEqual(['fastpaper/SKILL.md']);

    // 具体锚点。④-ANCHOR 那行是 `SKILL.en.md` / `references/layout.en.md` 拿去当 `edit` oldText 的串，
    // 对不上模型的 edit 会直接报错，所以它必须逐字落在 en 树里。
    // ⚠️ **不要**在这里加「英文树里没有汉字」：`⟨待填⟩` / `⟨待填: …⟩` 是刻意保留的哨兵串，
    // en 模板里 21 行带汉字全是它，加了会假红（见 `.claude/skills/sync-skill-docs/SKILL.md`）。
    const deckTpl = await fs.readFile(path.join(skillsDir, 'learning-deck', 'assets', 'report-template.html'), 'utf8');
    expect(deckTpl).toContain('<!-- ④-ANCHOR insert concept chapters before this line ⟨待填⟩ -->');
    expect(deckTpl).not.toContain('知识点章节插在这一行之前');
    expect(deckTpl).toContain('<html lang="en">');

    const summaryOnDisk = await fs.readFile(path.join(skillsDir, 'paper-summary', 'SKILL.md'), 'utf8');
    expect(summaryOnDisk).toContain('# Close Reading and Writing Material');
    expect(summaryOnDisk).not.toContain('# 论文精读与写作素材');
  } finally {
    await teardown(app);
  }
});

test('48-locale: 切换成功后 skill 列表用返回值覆盖，不必手动刷新', async () => {
  const app = await launchKydog({
    seed: async (home) => { await seedSettings(home, { locale: 'zh' }); },
  });
  try {
    const { page, kydogHome } = app;
    const skillsDir = path.join(kydogHome, '.kydog', 'skills');

    // 先把 Settings 的技能页打开，让 skillsStore 进入 ready —— 之后它不会再自己拉一次，
    // 列表里出现新东西就只可能来自 locale.set 的返回值。
    await page.locator('[data-testid="nav-skills"]').click();
    await expect(page.locator('[data-testid="skill-row"]').first()).toBeVisible({ timeout: 10_000 });

    // 应用起来之后才出现的一个用户 skill：bootstrap 那次 skill.list 看不到它。
    const lateSkill = path.join(skillsDir, 'e2e-late-skill');
    await fs.mkdir(lateSkill, { recursive: true });
    await fs.writeFile(
      path.join(lateSkill, 'SKILL.md'),
      '---\nname: e2e-late-skill\ndescription: 装在 bootstrap 之后的用户 skill\n---\n\n正文\n',
    );
    const lateRow = page.locator('[data-testid="skill-row"][data-skill-name="e2e-late-skill"]');
    await expect(lateRow).toHaveCount(0);   // 负向对照：此刻 store 里确实没有它

    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="locale-en"]').click();

    await expect(lateRow).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => readLocaleOnDisk(kydogHome), { timeout: 10_000 }).toBe('en');
  } finally {
    await teardown(app);
  }
});

test('48-locale: 有任务在跑时切换被拒，界面停在旧语言并说明原因', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);

  const app = await launchKydog({
    fixture: path.resolve('e2e/fixtures/long-run.json'),
    seed: async (home) => { await seedSettings(home, { locale: 'zh' }); await seedProject(home, projectPath); },
  });
  try {
    const { page, kydogHome } = app;
    await page.locator('[data-testid="new-thread"]').click();
    await page.locator('[data-testid="composer-input"]').fill('跑一会儿');
    await page.locator('[data-testid="send-button"]').click();
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="locale-en"]').click();

    // 被拒是一次正常返回：message 是给用户看的中文，不走异常路径。
    await expect(page.locator('[data-testid="locale-switch-error"]')).toContainText('有任务正在运行', { timeout: 10_000 });
    // 被拒时 locale.set 带回的是原封不动的现状，直接 set 就把界面钉在旧语言上。
    await expect(page.locator('[data-testid="locale-zh"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="locale-en"]')).toHaveAttribute('aria-pressed', 'false');
    expect(await readLocaleOnDisk(kydogHome)).toBe('zh');

    // 被拒不是同步失败：skill 树根本没被碰过，Settings 不该冒出「skill 同步失败」。
    // 切到 Settings 后中间栏不再是对话，stop 按钮随之消失；run 由 teardown 关进程收掉。
    await page.locator('[data-testid="nav-skills"]').click();
    await expect(page.locator('[data-testid="skill-row"]').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="skill-sync-error"]')).toHaveCount(0);

    // 陈旧提示不许留：popover 只是 return null、组件不卸载，不主动清就会在下次打开时
    // 原样再出现一次 —— 而那时 run 可能早就结束、切换明明已经能成了。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="user-menu"]')).toHaveCount(0);
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await expect(page.locator('[data-testid="user-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="locale-switch-error"]')).toHaveCount(0);
  } finally {
    await teardown(app);
  }
});
