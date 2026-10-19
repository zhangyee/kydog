import { promises as fs } from 'node:fs';
import path from 'node:path';
import { KydogError } from '../../shared/errors';
import type { XResearchSubmission, XResearchTaskRecord } from '../../shared/xResearchTask';
import { atomicWriteWith0600Async } from '../persist/atomicWrite';
import * as paths from '../persist/paths';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_FILE = 'task.json';
const SUBMISSION_PREFIX = 'submission-';

/** 目录名来自 id，所以「不是 UUID」必须在碰文件系统之前就拒绝 —— `../../etc` 拼出来是别的目录。 */
function validId(id: string): void {
  if (!UUID.test(id)) throw new KydogError('research.not_found', 'X research task not found');
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * 研究目录 `<root>/<threadId>/<researchRunId>/`（spec §4.4）：
 * `task.json`（研究级索引）、`submission-<id>.json`（提交级工作项与实时状态）。
 * 结果正文不在这里：它按工件格式单独落盘（分块 + manifest + sha256），提交记录只存
 * `artifact` 引用 —— 交付时按那个引用读回来（R20）。
 *
 * 读的一律把「文件不在」与「文件坏了」都当 `null`：进程被杀留下的截断文件不是崩溃源，
 * 只是这份事实没写成功（§4.4「崩溃后的诚实表示」）。
 */
export class XResearchTaskStore {
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(private readonly configuredRoot?: string) {}
  private root(): string { return this.configuredRoot ?? paths.X_RESEARCH_DIR; }

  taskDir(threadId: string, researchRunId: string): string {
    validId(threadId);
    validId(researchRunId);
    return path.join(this.threadDir(threadId), researchRunId);
  }

  private threadDir(threadId: string): string {
    validId(threadId);
    return path.join(this.root(), threadId);
  }

  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.writes.get(key) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    this.writes.set(key, current);
    const clear = () => { if (this.writes.get(key) === current) this.writes.delete(key); };
    void current.then(clear, clear);
    return current;
  }

  /** 目录 0o700 由这里建：`atomicWriteWith0600Async` 自己的 mkdir 不带 mode，
   *  等它建就晚了（已存在的目录不会改权限）。 */
  private async ensureTaskDir(threadId: string, researchRunId: string): Promise<string> {
    const dir = this.taskDir(threadId, researchRunId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private async readJson<T>(file: string): Promise<T | null> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async readTask(threadId: string, researchRunId: string): Promise<XResearchTaskRecord | null> {
    const record = await this.readJson<XResearchTaskRecord>(
      path.join(this.taskDir(threadId, researchRunId), TASK_FILE));
    // 路径上的 id 必须和记录里的 id 逐一对上：对不上说明这份文件不是这个位置的记录（被复制过、
    // 被改过 id、或来自旧格式），照原样返回会让调用方拿别人的 run 当自己的事实。
    if (!record || record.threadId !== threadId || record.researchRunId !== researchRunId) return null;
    return record;
  }

  async writeTask(record: XResearchTaskRecord): Promise<void> {
    const file = path.join(await this.ensureTaskDir(record.threadId, record.researchRunId), TASK_FILE);
    await this.serial(file, () => atomicWriteWith0600Async(file, JSON.stringify(record)));
  }

  async readSubmission(threadId: string, researchRunId: string,
    submissionId: string): Promise<XResearchSubmission | null> {
    validId(submissionId);
    const record = await this.readJson<XResearchSubmission>(
      this.submissionFile(threadId, researchRunId, submissionId));
    // 同 `readTask`：路径上的三个 id 与记录里的三个 id 必须一致。
    if (!record || record.threadId !== threadId || record.researchRunId !== researchRunId
      || record.submissionId !== submissionId) return null;
    return record;
  }

  async writeSubmission(submission: XResearchSubmission): Promise<void> {
    validId(submission.submissionId);
    await this.ensureTaskDir(submission.threadId, submission.researchRunId);
    const file = this.submissionFile(submission.threadId, submission.researchRunId, submission.submissionId);
    await this.serial(file, () => atomicWriteWith0600Async(file, JSON.stringify(submission)));
  }

  async listSubmissions(threadId: string, researchRunId: string): Promise<XResearchSubmission[]> {
    const dir = this.taskDir(threadId, researchRunId);
    const names = await fs.readdir(dir).catch((error: unknown) => {
      if (missing(error)) return [] as string[];
      throw error;
    });
    const ids = names
      .filter((name) => name.startsWith(SUBMISSION_PREFIX) && name.endsWith('.json'))
      .map((name) => name.slice(SUBMISSION_PREFIX.length, -'.json'.length))
      .filter((id) => UUID.test(id));
    const submissions = await Promise.all(ids.map((id) => this.readSubmission(threadId, researchRunId, id)));
    // 顺序定死：提交顺序是「最早一份尚未交付」的依据（§4.5），不能靠目录顺序。
    return submissions
      .filter((item): item is XResearchSubmission => item !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.submissionId.localeCompare(b.submissionId));
  }

  async listRuns(threadId: string): Promise<string[]> {
    const dir = this.threadDir(threadId);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      if (missing(error)) return [];
      throw error;
    });
    return entries
      .filter((entry) => entry.isDirectory() && UUID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  async removeRun(threadId: string, researchRunId: string): Promise<void> {
    await fs.rm(this.taskDir(threadId, researchRunId), { recursive: true, force: true });
  }

  /** 删对话即删任务目录（§4.4）：这个 threadId 下的都是这次对话的产物，没有别的所有者。 */
  async removeThread(threadId: string): Promise<void> {
    await fs.rm(this.threadDir(threadId), { recursive: true, force: true });
  }

  private submissionFile(threadId: string, researchRunId: string, submissionId: string): string {
    return path.join(this.taskDir(threadId, researchRunId), `${SUBMISSION_PREFIX}${submissionId}.json`);
  }
}

export const xResearchTaskStore = new XResearchTaskStore();
