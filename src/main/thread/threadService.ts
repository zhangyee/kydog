import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { loadIndex, saveIndex } from '../persist/indexFile';
import { sessionFileFor } from '../persist/paths';
import { agentService } from '../agent/AgentService';
import { KydogError } from '../../shared/errors';
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

  async update(args: { threadId: string; title?: string; pinned?: boolean; modelOverride?: { providerId: string; modelId: string } | null }): Promise<Thread> {
    const idx = await loadIndex();
    const thread = idx.threads.find((t) => t.id === args.threadId);
    if (!thread) throw new KydogError('thread.not_found', `thread ${args.threadId} not found`);
    if (args.title !== undefined) thread.title = args.title;
    if (args.pinned !== undefined) thread.pinned = args.pinned;
    if (args.modelOverride === null) thread.modelOverride = undefined;
    else if (args.modelOverride) thread.modelOverride = args.modelOverride;
    thread.lastActiveAt = new Date().toISOString();
    await saveIndex(idx);
    return thread;
  }

  async loadHistory({ threadId }: { threadId: string }): Promise<Message[]> {
    const idx = await loadIndex();
    const thread = idx.threads.find((t) => t.id === threadId);
    if (!thread) throw new KydogError('thread.not_found', `thread ${threadId} not found`);
    thread.lastActiveAt = new Date().toISOString();
    await saveIndex(idx);
    return agentService.loadHistory(threadId, thread.projectPath);
  }

  async send({ threadId, content }: { threadId: string; content: string }): Promise<{ runId: string }> {
    const idx = await loadIndex();
    const thread = idx.threads.find((t) => t.id === threadId);
    if (!thread) throw new KydogError('thread.not_found', `thread ${threadId} not found`);
    if (thread.title === '无标题') {
      thread.title = content.slice(0, 40);
    }
    thread.lastActiveAt = new Date().toISOString();
    await saveIndex(idx);
    return agentService.send(threadId, thread.projectPath, content);
  }

  async abort({ threadId }: { threadId: string }): Promise<void> {
    agentService.abort(threadId);
  }
}

export const threadService = new ThreadService();
