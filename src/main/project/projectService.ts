import { loadIndex, saveIndex } from '../persist/indexFile';
import type { Project, FsNode } from '../../shared/types';
import { logger } from '../log';
import { KydogError } from '../../shared/errors';

export class ProjectService {
  async list(): Promise<Project[]> {
    const idx = await loadIndex();
    return idx.projects;
  }
  async open(): Promise<Project> {
    throw new KydogError('not_implemented', 'project.open not implemented in G1; wired in Phase 3');
  }
  async close({ projectPath }: { projectPath: string }): Promise<void> {
    const idx = await loadIndex();
    idx.projects = idx.projects.filter(p => p.path !== projectPath);
    idx.threads = idx.threads.filter(t => t.projectPath !== projectPath);
    await saveIndex(idx);
    logger.info('project.close', 'closed', { projectPath });
  }
  async readDir(_args: { path: string }): Promise<FsNode[]> {
    throw new KydogError('not_implemented', 'project.readDir not implemented in G1; wired in Phase 3');
  }
}

export const projectService = new ProjectService();
