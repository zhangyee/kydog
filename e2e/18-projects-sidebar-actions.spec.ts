import { test, expect, type Locator, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchKydog, teardown, seedSettings, seedSamplePackage, type LaunchedApp } from './helpers';

/**
 * 左栏的 project / thread 操作与它们的落盘，最后一条重启一次验持久化。
 *
 * 串行共用一次启动（外加末尾那一次重启）：每一步都在前一步留下的状态上走 ——
 * A 被改名、B 被置顶、B 被「全部收起」后留着收起、t-x 被删 —— 最后一条重启后逐项核对。
 * t-arc1..3 被归档（1 先归档再撤销，随后三条一起批量归档）。
 * 顺序不能打乱。
 */
test.describe.configure({ mode: 'serial' });

const LONG_TITLE = '会议纪要：关于下一阶段科研数据管线与多智能体协作流程的详细讨论与后续待办梳理';
const RENAMED_PROJECT = '我的研究';

let launched: LaunchedApp;
let home = '';
let dirA = '';
let dirB = '';
let nameB = '';
/** A 的显示名：改名那一步之后换成 RENAMED_PROJECT（ProjectRow 的 testid 跟着显示名走）。 */
let nameA = '';

test.beforeAll(async () => {
  dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-A-'));
  dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-B-'));
  nameA = path.basename(dirA);
  nameB = path.basename(dirB);
  launched = await launchKydog({
    seed: async (h) => {
      home = h;
      await seedSettings(h);
      await seedSamplePackage(dirA);
      await seedSamplePackage(dirB);
      const t = (id: string, projectPath: string, title: string, lastActiveAt: string) =>
        ({ id, projectPath, title, createdAt: '2026-01-01', lastActiveAt });
      await fs.writeFile(path.join(h, '.kydog', 'index.json'), JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: dirA, addedAt: '2026-01-01T00:00:00Z' },
          { path: dirB, addedAt: '2026-01-02T00:00:00Z' },
        ],
        threads: [
          t('t-a', dirA, 'thread-A', '2026-04-04'),
          t('t-long', dirA, LONG_TITLE, '2026-04-03'),
          t('t-short', dirA, '短', '2026-04-02'),
          t('t-x', dirA, 'doomed', '2026-04-01'),
          t('t-arc1', dirA, 'arc-1', '2026-03-30'),
          t('t-arc2', dirA, 'arc-2', '2026-03-29'),
          t('t-arc3', dirA, 'arc-3', '2026-03-28'),
          t('t-b', dirB, 'thread-B', '2026-04-10'),
        ],
      }, null, 2));
    },
  });
});

test.afterAll(async () => {
  await teardown(launched);
  for (const d of [home, dirA, dirB]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const readIndex = async () => JSON.parse(await fs.readFile(path.join(home, '.kydog', 'index.json'), 'utf8'));
const readSettings = async () => JSON.parse(await fs.readFile(path.join(home, '.kydog', 'kydog.json'), 'utf8'));

/**
 * 让行的 hover 态真的翻过来。`hover()` 是单发 mousemove、没有到达回执（CI 高负载下实测丢过），
 * 所以把刺激放进 poll 每轮重新施加，锚定在协议层事实：操作按钮自身生效的 computed
 * pointer-events（hover 态外层 wrapper 从 none 翻成 auto，按钮继承它）。
 */
async function reveal(row: Locator, action: Locator): Promise<void> {
  await expect.poll(async () => {
    await row.hover();
    return action.evaluate((el) => getComputedStyle(el).pointerEvents);
  }).toBe('auto');
}

/** 打开某一行的「…」菜单（删除从行上的 × 挪进了这里）。 */
async function openRowMenu(page: Page, id: string): Promise<void> {
  const trigger = page.getByTestId(`thread-menu-trigger-${id}`);
  await reveal(page.getByTestId(`thread-${id}`), trigger);
  await trigger.click();
}

test('15-titlebar: defaults to KyDog and reflects selected thread title', async () => {
  const { page } = launched;
  const titleBar = page.getByTestId('title-bar');
  await expect(titleBar).toContainText('KyDog');
  await page.getByTestId('thread-t-a').click();
  await expect(titleBar).toContainText('thread-A');
});

test('13-tab-strip: thread tab renders, breadcrumb stats visible, close deselects to Welcome', async () => {
  const { page } = launched;
  await expect(page.getByTestId('tab-t-a')).toBeVisible();
  await expect(page.getByTestId('thread-stats')).toBeVisible();
  await page.getByTestId('tab-close-t-a').click();
  await expect(page.getByTestId('tab-t-a')).toHaveCount(0);
  await expect(page.getByTestId('welcome-slogan')).toBeVisible();
});

test('17-project-tree-collapse: selected thread project still toggles closed', async () => {
  const { page } = launched;
  const threadRow = page.getByTestId('thread-t-a');
  const toggle = page.getByTestId(`project-toggle-${nameA}`);
  await threadRow.click();
  await toggle.click();
  await expect(threadRow).toHaveCount(0);
  await toggle.click();
  await expect(threadRow).toBeVisible();
});

test('35-marquee: 长标题 hover 滚动，短标题不滚，离开复位', async () => {
  const { page } = launched;
  const longRow = page.getByTestId('thread-t-long');
  const longScroll = page.getByTestId('thread-title-scroll-t-long');
  const shortRow = page.getByTestId('thread-t-short');
  const shortScroll = page.getByTestId('thread-title-scroll-t-short');

  // hover 长标题 → 内层滚动节点出现、过了起始延迟后位移成负值。失败时把页面态 JSON 落进
  // Received（hover 链是否成立、媒体层有没有残留 reduce）。
  await expect.poll(async () => {
    await longRow.hover();
    if (await longScroll.count() === 0) {
      return longRow.evaluate((el) => JSON.stringify({
        hoverChain: el.matches(':hover'),
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
      }));
    }
    return longScroll.evaluate((el) => (el as HTMLElement).style.transform);
  }).toMatch(/translateX\(-\d/);

  // 移到短标题行：先确认它的 hover 态真的生效了（与上面长标题同一个 hover 驱动），
  // 此刻长标题已复位、短标题没有滚动节点。MarqueeText 在 hover 生效的同一次渲染里量溢出，
  // 要滚就当场渲染出滚动节点（起始延迟只推迟位移），所以不必再等一个时间窗。
  await reveal(shortRow, page.getByTestId('thread-menu-trigger-t-short'));
  await expect(longScroll).toHaveCount(0);
  await expect(shortScroll).toHaveCount(0);
});

test('34-thread-rename: 菜单重命名写回 index', async () => {
  const { page } = launched;
  const row = page.getByTestId('thread-t-a');
  const trigger = page.getByTestId('thread-menu-trigger-t-a');
  await reveal(row, trigger);
  await trigger.click();
  await page.getByTestId('thread-rename-t-a').click();
  const input = page.getByTestId('thread-rename-input-t-a');
  await expect(input).toBeFocused();
  await input.fill('新名字');
  await input.press('Enter');
  await expect(row).toContainText('新名字');
  await expect.poll(async () => (await readIndex()).threads.find((t: { id: string }) => t.id === 't-a')?.title)
    .toBe('新名字');
});

test('18-projects-sidebar: inline rename project', async () => {
  const { page } = launched;
  const trigger = page.getByTestId(`project-menu-trigger-${nameA}`);
  await reveal(page.getByTestId(`project-toggle-${nameA}`), trigger);
  await trigger.click();
  await page.getByTestId(`project-rename-${nameA}`).click();
  const input = page.getByTestId(`project-rename-input-${nameA}`);
  await expect(input).toBeFocused();
  await input.fill(RENAMED_PROJECT);
  await input.press('Enter');
  await expect(page.getByTestId(`project-toggle-${RENAMED_PROJECT}`)).toBeVisible();
  await expect.poll(async () => (await readIndex()).projects.find((p: { path: string }) => p.path === dirA)?.label)
    .toBe(RENAMED_PROJECT);
  nameA = RENAMED_PROJECT;
});

test('18-projects-sidebar: collapse-all + filter sort', async () => {
  const { page } = launched;
  await expect(page.getByTestId('thread-t-a')).toBeVisible();
  await expect(page.getByTestId('thread-t-b')).toBeVisible();

  await page.getByTestId('projects-collapse-all').click();
  await expect(page.getByTestId('thread-t-a')).toBeHidden();
  await expect(page.getByTestId('thread-t-b')).toBeHidden();

  // 只展开 A；B 留着收起，最后那条重启后要看它还收着。
  await page.getByTestId(`project-toggle-${nameA}`).click();
  await expect(page.getByTestId('thread-t-a')).toBeVisible();

  await page.getByTestId('projects-filter-trigger').click();
  await expect(page.getByTestId('projects-filter-menu')).toBeVisible();
  await page.getByTestId('filter-sort-created').click();
  await expect(page.getByTestId('projects-filter-menu')).toBeHidden();
});

test('18-projects-sidebar: pin project', async () => {
  const { page } = launched;
  const trigger = page.getByTestId(`project-menu-trigger-${nameB}`);
  await reveal(page.getByTestId(`project-toggle-${nameB}`), trigger);
  await trigger.click();
  await page.getByTestId(`project-pin-${nameB}`).click();
  // 等的是落盘（RPC → loadIndex → 原子写），不是 UI 响应，给基础设施余量；「点没点到」由上面
  // click 的 actionability 保证。
  await expect.poll(async () => (await readIndex()).projects.find((p: { path: string }) => p.path === dirB)?.pinned,
    { timeout: 15_000 }).toBe(true);
});

test('34-thread-rename: 删除点取消则会话保留', async () => {
  const { page } = launched;
  const row = page.getByTestId('thread-t-x');
  await openRowMenu(page, 't-x');
  await page.getByTestId('thread-delete-t-x').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-dialog-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toBeHidden();
  await expect(row).toBeVisible();
  expect((await readIndex()).threads.map((t: { id: string }) => t.id)).toContain('t-x');
});

test('10-delete: removes thread from index', async () => {
  const { page } = launched;
  const row = page.getByTestId('thread-t-x');
  await openRowMenu(page, 't-x');
  await page.getByTestId('thread-delete-t-x').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(row).toBeHidden();
  await expect.poll(async () => (await readIndex()).threads.map((t: { id: string }) => t.id))
    .toEqual(expect.not.arrayContaining(['t-x']));
  // 正向：删的只是那一条。
  expect((await readIndex()).threads.map((t: { id: string }) => t.id)).toContain('t-long');
});

test('归档：行上一键归档 → 落盘带 archivedAt → 撤销回来', async () => {
  const { page } = launched;
  const row = page.getByTestId('thread-t-arc1');
  const btn = page.getByTestId('archive-thread-t-arc1');
  await expect(row).toBeVisible();
  await reveal(row, btn);
  await btn.click();

  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await readIndex()).threads.find((t: { id: string }) => t.id === 't-arc1')?.archivedAt,
    { timeout: 15_000 }).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await expect(page.getByTestId('sidebar-toast')).toContainText('已归档「arc-1」');

  await page.getByTestId('sidebar-toast-action').click();
  await expect(row).toBeVisible();
  // 对话还在 index 里、只是没有 archivedAt 了；找不到它返回 'missing'，免得「没了」被当成「没有 archivedAt」。
  await expect.poll(async () => {
    const t = (await readIndex()).threads.find((x: { id: string }) => x.id === 't-arc1');
    return t ? 'archivedAt' in t : 'missing';
  }, { timeout: 15_000 }).toBe(false);
});

test('右键归档：不打开被右键的那一行，当前对话不变（portal 里的点击不许冒泡到行上）', async () => {
  const { page } = launched;
  // 先让 t-a 成为当前对话（它的 tab 可见），再右键另一行 t-arc1 → 归档。
  await page.getByTestId('thread-t-a').click();
  await expect(page.getByTestId('tab-t-a')).toBeVisible();
  const row = page.getByTestId('thread-t-arc1');
  await row.click({ button: 'right' });
  await page.getByTestId('thread-ctx-archive-t-arc1').click();
  await expect(row).toHaveCount(0);
  // 正向：归档确实发生了；当前对话仍是 t-a（右键那一行没被打开，主区没掉回欢迎页）。
  await expect.poll(async () => Boolean((await readIndex()).threads.find((t: { id: string }) => t.id === 't-arc1')?.archivedAt),
    { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId('tab-t-a')).toBeVisible();
  await expect(page.getByTestId('tab-t-arc1')).toHaveCount(0);
  // 撤销回来，下一条还要用 t-arc1。
  await page.getByTestId('sidebar-toast-action').click();
  await expect(row).toBeVisible();
});

test('多选：单击 + ⇧ 单击连选三条，右键批量归档', async () => {
  const { page } = launched;
  const rows = ['t-arc1', 't-arc2', 't-arc3'].map((id) => page.getByTestId(`thread-${id}`));
  await rows[0].click();
  await rows[2].click({ modifiers: ['Shift'] });
  // 中间那条被选中：证明是区间，不只是两端。
  await expect(rows[1]).toHaveAttribute('data-selected', 'true');

  await rows[1].click({ button: 'right' });
  const item = page.getByTestId('thread-ctx-batch-archive');
  await expect(item).toContainText('归档 3 个对话');
  await item.click();

  for (const r of rows) await expect(r).toHaveCount(0);
  await expect.poll(async () => {
    const idx = await readIndex();
    return ['t-arc1', 't-arc2', 't-arc3', 't-a'].map((id) => Boolean(idx.threads.find((t: { id: string }) => t.id === id)?.archivedAt));
  }, { timeout: 15_000 }).toEqual([true, true, true, false]);
  await expect(page.getByTestId('thread-t-a')).toBeVisible();
});

test('07/50/53c/18-pin: 重启之后主题、置顶、收起、改名都在；视图不恢复', async () => {
  const { page } = launched;
  // 重启前：开着一个 thread tab（53c：冷启动不恢复视图快照）、切到 midnight（07）。
  await page.getByTestId('thread-t-a').click();
  await expect(page.getByTestId('tab-t-a')).toBeVisible();
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('theme-midnight').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  // 落盘的是路径本身，不是「第几个 project」这种随排序漂移的东西（50）。
  await expect.poll(async () => {
    const s = await readSettings();
    return { theme: s.ui.theme, collapsed: s.ui.collapsedProjects };
  }).toEqual({ theme: 'midnight', collapsed: [dirB] });

  await teardown(launched);
  launched = await launchKydog({ kydogHome: home });
  const p2 = launched.page;

  await expect(p2.locator('html')).toHaveAttribute('data-theme', 'midnight');
  // 置顶的 B 排第一，改过名的 A 在它后面。
  await expect(p2.getByTestId(`project-toggle-${nameB}`)).toBeVisible();
  const order = await p2.locator('[data-testid^="project-toggle-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(order).toEqual([`project-toggle-${nameB}`, `project-toggle-${RENAMED_PROJECT}`]);
  // A 展开、改过名的 thread 在；B 仍收着，点开就回来。
  await expect(p2.getByTestId('thread-t-a')).toContainText('新名字');
  // 归档的三条：重启后仍不在左栏（上一行证明了 A 展开着、列表确实渲染了）；
  // 同时还在 index 里、带 archivedAt —— 没被删，只是藏起来。
  for (const id of ['t-arc1', 't-arc2', 't-arc3']) await expect(p2.getByTestId(`thread-${id}`)).toHaveCount(0);
  const idxAfter = await readIndex();
  expect(['t-arc1', 't-arc2', 't-arc3'].map((id) => idxAfter.threads.find((t: { id: string }) => t.id === id)?.archivedAt))
    .toEqual([expect.any(String), expect.any(String), expect.any(String)]);
  await expect(p2.getByTestId('thread-t-b')).toHaveCount(0);
  await p2.getByTestId(`project-toggle-${nameB}`).click();
  await expect(p2.getByTestId('thread-t-b')).toBeVisible();
  // 视图快照只活在主进程内存里：冷启动回欢迎页，不恢复重启前开着的 tab。
  await expect(p2.getByTestId('welcome-slogan')).toBeVisible();
  await expect(p2.getByTestId('tab-t-a')).toHaveCount(0);
});
