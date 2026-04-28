import { loadIndex } from '../persist/indexFile';
import type { Thread, Message } from '../../shared/types';

class ThreadService {
  async list({ projectPath }: { projectPath: string }): Promise<Thread[]> {
    const idx = await loadIndex();
    return idx.threads.filter(t => t.projectPath === projectPath);
  }
  async listAll(): Promise<Thread[]> {
    const idx = await loadIndex();
    return idx.threads;
  }
  async create(_args: { projectPath: string; title?: string }): Promise<Thread> {
    throw new Error('thread.create not implemented in G1; wired in Phase 2');
  }
  async delete(_args: { threadId: string }): Promise<void> {
    throw new Error('thread.delete not implemented in G1; wired in Phase 3');
  }
  async rename(_args: { threadId: string; title: string }): Promise<void> {
    throw new Error('thread.rename not implemented in G1; wired in Phase 3');
  }
  async loadHistory(_args: { threadId: string }): Promise<Message[]> {
    throw new Error('thread.loadHistory not implemented in G1; wired in Phase 2');
  }
  async send(_args: { threadId: string; content: string }): Promise<{ runId: string }> {
    throw new Error('thread.send not implemented in G1; wired in Phase 2');
  }
  async abort(_args: { threadId: string }): Promise<void> {
    throw new Error('thread.abort not implemented in G1; wired in Phase 2');
  }
}

export const threadService = new ThreadService();
