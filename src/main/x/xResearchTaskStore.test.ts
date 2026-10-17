import { afterEach, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { XResearchSubmission, XResearchTaskRecord, XResearchWorkItem } from '../../shared/xResearchTask';
import { XResearchTaskStore } from './xResearchTaskStore';

const RUN = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '22222222-2222-4222-8222-222222222222';
const THREAD = '33333333-3333-4333-8333-333333333333';
const SUB = '44444444-4444-4444-8444-444444444444';
const OTHER_SUB = '55555555-5555-4555-8555-555555555555';
const ITEM = '66666666-6666-4666-8666-666666666666';
const OTHER_THREAD = '88888888-8888-4888-8888-888888888888';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xtask-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<XResearchTaskRecord> = {}): XResearchTaskRecord {
  return {
    version: 1,
    researchRunId: RUN,
    threadId: THREAD,
    projectRoot: '/projects/demo',
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:01:30.000Z',
    revision: 2,
    state: 'running',
    browserTabId: 'tab-abc',
    submissionIds: [SUB],
    ...overrides,
  };
}

function workItem(overrides: Partial<XResearchWorkItem> = {}): XResearchWorkItem {
  return {
    workItemId: ITEM,
    section: 'search',
    label: 'Qwen3.8 27B',
    product: 'Top',
    state: 'stopped',
    phaseDetail: null,
    status: 'observed',
    stopReason: 'explicit_ui_end',
    reason: null,
    posts: 87,
    omitted: 3,
    pages: 3,
    hasRoot: false,
    replies: 0,
    article: 'not_requested',
    scrolls: 12,
    expandActions: 2,
    ...overrides,
  };
}

function submission(overrides: Partial<XResearchSubmission> = {}): XResearchSubmission {
  return {
    version: 1,
    submissionId: SUB,
    researchRunId: RUN,
    threadId: THREAD,
    submitCallId: 'call-submit-1',
    batchId: 'batch-1',
    runId: '77777777-7777-4777-8777-777777777777',
    operation: 'search',
    objective: 'Qwen3.8 27B 量化版在 agentic 任务上的实际表现',
    state: 'done',
    budget: { scrolls: 500, expandActions: 500 },
    usage: { posts: 87, scrolls: 12, expandActions: 2 },
    workItems: [workItem()],
    createdAt: '2026-10-16T00:00:00.000Z',
    endedAt: '2026-10-16T00:05:00.000Z',
    ...overrides,
  };
}

it('writes and reads a task record atomically with 0600', async () => {
  const dir = root();
  const store = new XResearchTaskStore(dir);
  await store.writeTask(record());
  expect(store.taskDir(THREAD, RUN)).toBe(path.join(dir, THREAD, RUN));
  if (process.platform !== 'win32') {
    expect(statSync(store.taskDir(THREAD, RUN)).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(store.taskDir(THREAD, RUN), 'task.json')).mode & 0o777).toBe(0o600);
  }
  expect(await store.readTask(THREAD, RUN)).toEqual(record());
  expect(await store.readTask(THREAD, OTHER_RUN)).toBeNull();
});

it('treats a corrupt task.json as absent instead of throwing', async () => {
  const store = new XResearchTaskStore(root());
  await store.writeTask(record());
  expect(await store.readTask(THREAD, RUN)).not.toBeNull();
  writeFileSync(path.join(store.taskDir(THREAD, RUN), 'task.json'), '{"researchRunId": ');
  expect(await store.readTask(THREAD, RUN)).toBeNull();
});

it('reads a task record only from the path its ids name', async () => {
  const dir = root();
  const store = new XResearchTaskStore(dir);
  await store.writeTask(record());
  expect(await store.readTask(THREAD, RUN)).toEqual(record());
  const file = path.join(store.taskDir(THREAD, RUN), 'task.json');

  // 同一份记录挂在别的 run 目录下：内容里的 researchRunId 与路径不符
  const otherRunDir = store.taskDir(THREAD, OTHER_RUN);
  mkdirSync(otherRunDir, { recursive: true });
  copyFileSync(file, path.join(otherRunDir, 'task.json'));
  expect(await store.readTask(THREAD, OTHER_RUN)).toBeNull();

  // 同一份记录挂在别的 thread 目录下：内容里的 threadId 与路径不符
  const otherThreadDir = store.taskDir(OTHER_THREAD, RUN);
  mkdirSync(otherThreadDir, { recursive: true });
  copyFileSync(file, path.join(otherThreadDir, 'task.json'));
  expect(await store.readTask(OTHER_THREAD, RUN)).toBeNull();

  // 是合法 JSON，但不带 id：以前会把它当成一份记录返回
  writeFileSync(file, '{"version":1,"revision":2}');
  expect(await store.readTask(THREAD, RUN)).toBeNull();
});

it('rejects traversal-shaped ids before touching the filesystem', async () => {
  // 根目录套在 parent 里：`../escape` 若真被拼进路径，会落在 parent 这一层，读 parent 才看得见。
  const parent = root();
  const store = new XResearchTaskStore(path.join(parent, 'x-research'));
  await expect(store.readTask('../../etc', RUN)).rejects.toMatchObject({ code: 'research.not_found' });
  await expect(store.writeTask(record({ threadId: '../../etc' }))).rejects.toMatchObject({ code: 'research.not_found' });
  await expect(store.writeTask(record({ researchRunId: `${RUN}/../x` }))).rejects.toMatchObject({ code: 'research.not_found' });
  await expect(store.readSubmission(THREAD, RUN, '../../task')).rejects.toMatchObject({ code: 'research.not_found' });
  await expect(store.writeTask(record({ threadId: '../escape' }))).rejects.toMatchObject({ code: 'research.not_found' });
  expect(await readdir(parent)).toEqual([]);
});

it('writes and reads a submission, and treats a corrupt one as absent', async () => {
  const dir = root();
  const store = new XResearchTaskStore(dir);
  await store.writeSubmission(submission());
  const file = path.join(store.taskDir(THREAD, RUN), `submission-${SUB}.json`);
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await store.readSubmission(THREAD, RUN, SUB)).toEqual(submission());
  expect(await store.readSubmission(THREAD, RUN, OTHER_SUB)).toBeNull();
  writeFileSync(file, 'not json');
  expect(await store.readSubmission(THREAD, RUN, SUB)).toBeNull();
});

it('reads a submission only from the path its ids name', async () => {
  const dir = root();
  const store = new XResearchTaskStore(dir);
  await store.writeSubmission(submission());
  expect(await store.readSubmission(THREAD, RUN, SUB)).toEqual(submission());
  const file = path.join(store.taskDir(THREAD, RUN), `submission-${SUB}.json`);

  // 同一份记录挂在别的 submissionId 上
  copyFileSync(file, path.join(store.taskDir(THREAD, RUN), `submission-${OTHER_SUB}.json`));
  expect(await store.readSubmission(THREAD, RUN, OTHER_SUB)).toBeNull();

  // 同一份记录挂在别的 run 下
  const otherRunDir = store.taskDir(THREAD, OTHER_RUN);
  mkdirSync(otherRunDir, { recursive: true });
  copyFileSync(file, path.join(otherRunDir, `submission-${SUB}.json`));
  expect(await store.readSubmission(THREAD, OTHER_RUN, SUB)).toBeNull();

  // 是合法 JSON，但不带 id
  writeFileSync(file, '{"version":1,"state":"done"}');
  expect(await store.readSubmission(THREAD, RUN, SUB)).toBeNull();
});

// 写序、id 升序都与 createdAt 序**相反**：SUB 是更低的 id，但它是更晚创建的那一份。
// 于是「按 id 排」与「不排（目录序）」都会得到 [SUB, OTHER_SUB]，只有 createdAt 序给出下面这个期望。
const LATER = submission({ createdAt: '2026-10-16T00:02:00.000Z' });
const EARLIER = submission({
  submissionId: OTHER_SUB,
  operation: 'read',
  objective: 'x.com/a/status/19581',
  createdAt: '2026-10-16T00:00:00.000Z',
  deliveredAt: '2026-10-16T00:06:00.000Z',
  deliveryCallId: 'call-wait-1',
});

it('lists submissions in creation order and ignores files that are not submissions', async () => {
  const store = new XResearchTaskStore(root());
  await store.writeSubmission(LATER);
  await store.writeSubmission(EARLIER);
  writeFileSync(path.join(store.taskDir(THREAD, RUN), 'notes.json'), '{}');
  writeFileSync(path.join(store.taskDir(THREAD, RUN), 'submission-not-a-uuid.json'), '{}');
  const listed = await store.listSubmissions(THREAD, RUN);
  expect(listed.map((item) => item.submissionId)).toEqual([OTHER_SUB, SUB]);
  expect(listed[1]).toEqual(LATER);
  expect(await store.listSubmissions(THREAD, OTHER_RUN)).toEqual([]);
});

it('stores canonical payloads byte-for-byte and reads a missing one as null', async () => {
  const store = new XResearchTaskStore(root());
  const payload = '{"operation":"search","rows":["汉字😀"]}';
  await store.writeCanonical(THREAD, RUN, SUB, payload);
  expect(await readFile(path.join(store.taskDir(THREAD, RUN), `canonical-${SUB}.json`), 'utf8')).toBe(payload);
  expect(await store.readCanonical(THREAD, RUN, SUB)).toBe(payload);
  expect(await store.readCanonical(THREAD, RUN, OTHER_SUB)).toBeNull();
});

it('lists only run directories for a thread', async () => {
  const dir = root();
  const store = new XResearchTaskStore(dir);
  // 先写 OTHER_RUN：目录序（= 创建序）与排序后的期望相反，多了 `.sort()` 才排得出来。
  await store.writeTask(record({ researchRunId: OTHER_RUN }));
  await store.writeTask(record());
  writeFileSync(path.join(dir, THREAD, 'stray.json'), '{}');
  mkdirSync(path.join(dir, THREAD, 'run-notes'));
  expect(await store.listRuns(THREAD)).toEqual([RUN, OTHER_RUN]);
  expect(await store.listRuns(OTHER_THREAD)).toEqual([]);
});

it('removeRun deletes the whole task directory and leaves other runs alone', async () => {
  const store = new XResearchTaskStore(root());
  await store.writeTask(record());
  await store.writeSubmission(submission());
  await store.writeCanonical(THREAD, RUN, SUB, '{}');
  await store.writeTask(record({ researchRunId: OTHER_RUN }));
  await store.removeRun(THREAD, RUN);
  expect(await store.listRuns(THREAD)).toEqual([OTHER_RUN]);
  expect(await store.readTask(THREAD, RUN)).toBeNull();
  expect(await store.readSubmission(THREAD, RUN, SUB)).toBeNull();
  expect(await store.readCanonical(THREAD, RUN, SUB)).toBeNull();
  expect(await store.readTask(THREAD, OTHER_RUN)).toEqual(record({ researchRunId: OTHER_RUN }));
});

it('removeThread deletes the whole thread directory and leaves other threads alone', async () => {
  const dir = root();
  const store = new XResearchTaskStore(dir);
  await store.writeTask(record());
  await store.writeSubmission(submission());
  await store.writeCanonical(THREAD, RUN, SUB, '{}');
  await store.writeTask(record({ threadId: OTHER_THREAD }));
  await store.removeThread(THREAD);
  await expect(readdir(path.join(dir, THREAD))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(dir)).toEqual([OTHER_THREAD]);
  expect(await store.readTask(THREAD, RUN)).toBeNull();
  expect(await store.readTask(OTHER_THREAD, RUN)).toEqual(record({ threadId: OTHER_THREAD }));
});
