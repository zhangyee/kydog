import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage, type LaunchedApp, newThread } from './helpers';
import type { FixtureEvent, FixtureFile } from './fixtures/fixture.types';

/**
 * 一轮 agent 回合从主进程流到渲染层：文本 + 工具卡、thinking 折叠、两个 thread 并发不串、
 * write 落盘后的文件卡、Stop。串行共用一次启动：fixture 用 `scripts` 形状，按每条发的原文
 * 挑剧本（剧本内容照搬原来那几份单剧本 fixture）。Stop 那条放最后。
 */
test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let projectPath = '';
let reportPath = '';
const THREAD_A = '00000000-0000-0000-0000-00000000000a';
const THREAD_B = '00000000-0000-0000-0000-00000000000b';
const THREAD_W = 'thr-write';

const eventsOf = async (name: string): Promise<FixtureEvent[]> =>
  (JSON.parse(await fs.readFile(path.resolve('e2e/fixtures', name), 'utf8')) as { events: FixtureEvent[] }).events;

test.beforeAll(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  // fixture 不会真的写盘：markdown tab 打开时要能读到内容，先放一份。
  reportPath = path.join(projectPath, 'report.md');
  await fs.writeFile(reportPath, '# report\n\n正文\n');
  // write-markdown 的占位符在 JSON 里，按 JSON 转义嵌进去（Windows 路径的 `\U` / `\a` 直接替换是非法转义）。
  const writeMd = JSON.parse((await fs.readFile(path.resolve('e2e/fixtures/write-markdown.json'), 'utf8'))
    .replace('__REPORT_PATH__', () => JSON.stringify(reportPath).slice(1, -1))) as { events: FixtureEvent[] };
  const text = await eventsOf('happy-path-text.json');
  const scripts: FixtureFile = {
    scripts: {
      'list files': await eventsOf('happy-path-bash.json'),
      'summarize your reasoning': await eventsOf('happy-path-thinking.json'),
      'hello A': text,
      'hello B': text,
      '生成报告': writeMd.events,
      'think long': await eventsOf('abort.json'),
    },
  };
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-fx-'));
  const fixture = path.join(fixtureDir, 'turns.json');
  await fs.writeFile(fixture, JSON.stringify(scripts));
  launched = await launchKydog({
    fixture,
    seed: async (home) => {
      await seedSettings(home);
      await seedProject(home, projectPath, [
        { id: THREAD_A, title: 'Thread A' },
        { id: THREAD_B, title: 'Thread B' },
        { id: THREAD_W, title: 'WriteTest' },
      ]);
    },
  });
});

test.afterAll(async () => {
  await teardown(launched);
  await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
});

async function send(text: string): Promise<void> {
  const { page } = launched;
  const input = page.getByTestId('composer-input');
  // 切对话 / 新建之后输入框会换一个实例，字可能填进正要卸载的那个（发送键就一直禁用，CI 上见过）。
  // fill 是整体替换、重复无副作用：填到字真的在当前这个输入框里为止，再发。
  await expect.poll(async () => { await input.fill(text); return input.textContent(); }).toBe(text);
  await page.getByTestId('send-button').click();
}

test('04-send: fixture LLM streams text + bash tool card', async () => {
  const { page } = launched;
  const list = page.getByTestId('message-list');
  await newThread(page);
  await send('list files');
  await expect(list).toContainText('list files');
  await expect(list).toContainText('我来 ls 看看');

  // 本轮跑完后 ProcessGroup 自己收起（open = manual ?? isRunning），工具卡随之离开 DOM。
  // 直接断言 tool-t1 等于在「还在跑」的一小段窗口里抢时间（fixture 整条才 165ms），
  // 所以先等它落定（aria-expanded=false），再手动展开断言稳定态。
  const processToggle = page.getByTestId('process-toggle');
  await expect(processToggle).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
  await processToggle.click();
  await expect(page.getByTestId('process-content')).toBeVisible();

  // ToolCard 用 groupToolLabel：bash 调用收起时只显示命令头 "ls"，展开才有 "$ ls" 与输出。
  const card = page.locator('[data-testid^="tool-t1"]');
  await expect(card).toContainText('ls');
  await expect(card).toContainText('完成');
  await expect(card).not.toContainText('$ ls');
  await expect(page.getByTestId('tool-toggle-t1')).toContainText('展开');
  await expect(card).not.toContainText('README.md');
  await page.getByTestId('tool-toggle-t1').click();
  await expect(card).toContainText('$ ls');
  await expect(card).toContainText('README.md');
  await expect(list).toContainText('目录里有 README 和 src');
});

test('28-process-group: thinking 跑完后外层 ProcessGroup 收起，点击展开后内层 ThinkingBlock 仍可独立折叠', async () => {
  const { page } = launched;
  await newThread(page);
  await send('summarize your reasoning');
  await expect(page.getByTestId('message-list')).toContainText('我先看了下目录');

  // 外层默认收起：「已处理」+「展开」，内层 ThinkingBlock 不在 DOM 里（正向证明在展开之后）。
  const pgToggle = page.getByTestId('process-toggle');
  await expect(pgToggle).toContainText('已处理');
  await expect(pgToggle).toContainText('展开');
  await expect(page.getByTestId('thinking-toggle')).toHaveCount(0);

  await pgToggle.click();
  await expect(pgToggle).toContainText('收起');
  // 内层出现，自己仍收着；「1s」这类时长由 processWallClock.test 守。
  const thToggle = page.getByTestId('thinking-toggle');
  await expect(thToggle).toContainText('已思考');
  await expect(thToggle).toContainText('展开');
  await expect(page.getByTestId('thinking-content')).toHaveCount(0);
  await thToggle.click();
  await expect(page.getByTestId('thinking-content')).toContainText('我先梳理一下文件结构');
});

test('06-concurrent: two threads streaming with same fixture do not cross-contaminate', async () => {
  const { page } = launched;
  const list = page.getByTestId('message-list');
  await page.getByTestId(`thread-${THREAD_A}`).click();
  await send('hello A');
  // 立刻切到 B 再发：两轮同时在跑。
  await page.getByTestId(`thread-${THREAD_B}`).click();
  await send('hello B');
  await expect(list).toContainText('hello B');
  await expect(list).toContainText('我是 KyDog');
  // 切回 A：只有 A 自己的（正向：A 的消息在）。
  await page.getByTestId(`thread-${THREAD_A}`).click();
  await expect(list).toContainText('hello A');
  await expect(list).not.toContainText('hello B');
});

test('33-write-file-card: write 工具落盘 .md → 文件卡出现 → 单击打开 markdown tab', async () => {
  const { page } = launched;
  await page.getByTestId(`thread-${THREAD_W}`).click();
  await send('生成报告');
  const card = page.getByTestId(`file-card-${reportPath}`);

  // ① 本轮还没结束时不出卡片（agent 落盘时正文可能还在一章章填、交付前自检也还没跑）。
  // fixture 在 tool_end 与 agent_end 之间留了 1500ms：先等 write 的工具卡真的落地、本轮仍在跑，
  // 再断卡片不在 —— 缺了前两步，toBeHidden 会在 tool_end 到达之前平凡通过。
  await expect(page.getByTestId('tool-tc1')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('streaming-indicator')).toBeVisible();
  await expect(card).toBeHidden();

  // ② 本轮结束（消息落进 history）之后才出现；单击打开 markdown tab。
  await expect(page.getByTestId('streaming-indicator')).toBeHidden({ timeout: 10_000 });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId(`tab-${reportPath}`)).toBeVisible();
  await expect(page.locator('.kydog-md-editor .ProseMirror')).toContainText('report');
});

test('05-abort: Stop button transitions run state to idle and stops events', async () => {
  const { page } = launched;
  const list = page.getByTestId('message-list');
  await newThread(page);
  await send('think long');
  // 正向：这一轮真的在流（第一句 215ms 到；第二句要再等 2s）。
  await expect(list).toContainText('我正在思考很久');
  await page.getByTestId('stop-button').click();
  await expect(page.getByTestId('send-button')).toBeVisible();
  // 「停下之后不再送事件」的协议语义由 fixtureProvider.test（中止短路在途等待）守；
  // 这里守的是 Stop → RPC → idle 这条链路，以及第二句没有挤进来。
  await expect(list).not.toContainText('应该已经被中断');
});
