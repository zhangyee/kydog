import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { loadIndex, saveIndex } from '../persist/indexFile';
import { sessionFileFor } from '../persist/paths';
import { agentService } from '../agent/AgentService';
import { questionBroker } from '../agent/questionBroker';
import { KydogError } from '../../shared/errors';
import type { AskAnswer } from '../../shared/askQuestion';
import type { EventSink } from '../ipc/broadcaster';
import type { Thread, Message } from '../../shared/types';

export class ThreadService {
  async list({ projectPath }: { projectPath: string }): Promise<Thread[]> {
    const idx = await loadIndex();
    return idx.threads.filter((t) => t.projectPath === projectPath);
  }

  async listAll(): Promise<Thread[]> {
    const idx = await loadIndex();
    return idx.threads;
  }

  async create({ projectPath, title }: { projectPath: string; title?: string }): Promise<Thread> {
    const idx = await loadIndex();
    if (!idx.projects.find((p) => p.path === projectPath)) {
      throw new KydogError('project.not_found', `project ${projectPath} is not opened`);
    }
    const now = new Date().toISOString();
    const thread: Thread = {
      id: randomUUID(),
      projectPath,
      title: title ?? '无标题',
      createdAt: now,
      lastActiveAt: now,
    };
    idx.threads.push(thread);
    await saveIndex(idx);
    return thread;
  }

  async delete({ threadId }: { threadId: string }): Promise<void> {
    const idx = await loadIndex();
    const thread = idx.threads.find((t) => t.id === threadId);
    if (!thread) throw new KydogError('thread.not_found', `thread ${threadId} not found`);
    await agentService.dispose(threadId);
    idx.threads = idx.threads.filter((t) => t.id !== threadId);
    await saveIndex(idx);
    await fs.rm(sessionFileFor(thread.projectPath, threadId), { force: true });
  }

  async rename({ threadId, title }: { threadId: string; title: string }): Promise<void> {
    const idx = await loadIndex();
    const t = idx.threads.find((x) => x.id === threadId);
    if (!t) throw new KydogError('thread.not_found', `thread ${threadId} not found`);
    t.title = title;
    await saveIndex(idx);
  }

  async update(args: {
    threadId: string;
    title?: string;
    pinned?: boolean;
    modelOverride?: { providerId: string; modelId: string } | null;
    projectPath?: string;
  }): Promise<Thread> {
    const idx = await loadIndex();
    const thread = idx.threads.find((t) => t.id === args.threadId);
    if (!thread) throw new KydogError('thread.not_found', `thread ${args.threadId} not found`);
    if (args.projectPath !== undefined && args.projectPath !== thread.projectPath) {
      const history = await agentService.loadHistory(thread.id, thread.projectPath);
      if (history.length > 0) {
        throw new KydogError('thread.has_messages', `thread ${args.threadId} already has messages`);
      }
      if (!idx.projects.find((p) => p.path === args.projectPath)) {
        throw new KydogError('project.not_found', `project ${args.projectPath} is not opened`);
      }
      const oldPath = sessionFileFor(thread.projectPath, thread.id);
      const newPath = sessionFileFor(args.projectPath, thread.id);
      await fs.rename(oldPath, newPath).catch(() =>
        fs.unlink(oldPath).catch(() => {}),
      );
      thread.projectPath = args.projectPath;
    }
    if (args.title !== undefined) thread.title = args.title;
    if (args.pinned !== undefined) thread.pinned = args.pinned;
    if (args.modelOverride === null) thread.modelOverride = undefined;
    else if (args.modelOverride) thread.modelOverride = args.modelOverride;
    thread.lastActiveAt = new Date().toISOString();
    await saveIndex(idx);
    return thread;
  }

  // replay 是发起这次调用的那个窗口的事件出口。有 run 在飞时，本轮已广播过的 run.* 事件
  // 会原样重放给它 —— 渲染进程重载后就是靠这个把在途 turn 接回去。见 protocol.ts 里
  // thread.loadHistory 那段注释，以及 AgentService.loadHistory。
  async loadHistory({ threadId }: { threadId: string }, replay?: EventSink): Promise<Message[]> {
    const idx = await loadIndex();
    const thread = idx.threads.find((t) => t.id === threadId);
    if (!thread) throw new KydogError('thread.not_found', `thread ${threadId} not found`);
    thread.lastActiveAt = new Date().toISOString();
    await saveIndex(idx);
    return agentService.loadHistory(threadId, thread.projectPath, replay);
  }

  async send({ threadId, content }: { threadId: string; content: string }): Promise<{ runId: string }> {
    const idx = await loadIndex();
    const thread = idx.threads.find((t) => t.id === threadId);
    if (!thread) throw new KydogError('thread.not_found', `thread ${threadId} not found`);
    const needsTitle = thread.title === '无标题';
    thread.lastActiveAt = new Date().toISOString();
    await saveIndex(idx);
    if (needsTitle) {
      // Dynamic import to break the circular dependency: titleService imports threadService.
      const { titleService } = await import('./titleService');
      titleService.generateForThread(threadId, content);
    }
    return agentService.send(threadId, thread.projectPath, content);
  }

  async abort({ threadId }: { threadId: string }): Promise<void> {
    agentService.abort(threadId);
  }

  async submitAsk(
    { threadId, toolCallId, answers }:
    { threadId: string; toolCallId: string; answers: AskAnswer[] },
  ): Promise<void> {
    // 校验不过时 broker 抛错，RPC 返回失败，UI 保持打开让用户重来。
    questionBroker.submit(threadId, toolCallId, answers);
  }

  async cancelAsk({ threadId, toolCallId }: { threadId: string; toolCallId: string }): Promise<void> {
    questionBroker.cancel(threadId, toolCallId);
  }
}

export const threadService = new ThreadService();
