import { loadIndex as defaultLoad } from '../persist/indexFile';
import type { Thread, Message, IndexFile } from '../../shared/types';
import { KydogError } from '../../shared/errors';

export class ThreadService {
  constructor(
    private readonly load: () => Promise<IndexFile> = defaultLoad,
  ) {}
  async list({ projectPath }: { projectPath: string }): Promise<Thread[]> {
    const idx = await this.load();
    return idx.threads.filter(t => t.projectPath === projectPath);
  }
  async listAll(): Promise<Thread[]> {
    const idx = await this.load();
    return idx.threads;
  }
  async create(_args: { projectPath: string; title?: string }): Promise<Thread> {
    throw new KydogError('not_implemented', 'thread.create not implemented in G1; wired in Phase 2');
  }
  async delete(_args: { threadId: string }): Promise<void> {
    throw new KydogError('not_implemented', 'thread.delete not implemented in G1; wired in Phase 3');
  }
  async rename(_args: { threadId: string; title: string }): Promise<void> {
    throw new KydogError('not_implemented', 'thread.rename not implemented in G1; wired in Phase 3');
  }
  async loadHistory(_args: { threadId: string }): Promise<Message[]> {
    throw new KydogError('not_implemented', 'thread.loadHistory not implemented in G1; wired in Phase 2');
  }
  async send(_args: { threadId: string; content: string }): Promise<{ runId: string }> {
    throw new KydogError('not_implemented', 'thread.send not implemented in G1; wired in Phase 2');
  }
  async abort(_args: { threadId: string }): Promise<void> {
    throw new KydogError('not_implemented', 'thread.abort not implemented in G1; wired in Phase 2');
  }
}

export const threadService = new ThreadService();
