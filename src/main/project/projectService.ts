import { loadIndex, saveIndex } from '../persist/indexFile';
import type { Project, FsNode } from '../../shared/types';

class ProjectService {
  async list(): Promise<Project[]> {
    const idx = await loadIndex();
    return idx.projects;
  }
  async open(): Promise<Project> {
    throw new Error('project.open not implemented in G1; wired in Phase 3');
  }
  async close({ projectPath }: { projectPath: string }): Promise<void> {
    const idx = await loadIndex();
    idx.projects = idx.projects.filter(p => p.path !== projectPath);
    idx.threads = idx.threads.filter(t => t.projectPath !== projectPath);
    await saveIndex(idx);
  }
  async readDir(_args: { path: string }): Promise<FsNode[]> {
    throw new Error('project.readDir not implemented in G1; wired in Phase 3');
  }
}

export const projectService = new ProjectService();
