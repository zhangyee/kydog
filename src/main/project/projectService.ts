import { dialog, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { loadIndex, saveIndex, withIndexLock } from '../persist/indexFile';
import { KydogError } from '../../shared/errors';
import type { Project, FsNode } from '../../shared/types';
import { isListedName } from './listing';
import { browserService } from '../browser/browserService';

export class ProjectService {
  async list(): Promise<Project[]> {
    const idx = await loadIndex();
    return idx.projects;
  }

  async open(): Promise<Project> {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'KyDog — 打开 Project 文件夹',
      defaultPath: os.homedir(),
    });
    if (result.canceled || result.filePaths.length === 0) {
      throw new KydogError('project.access_denied', '用户取消');
    }
    const absPath = path.resolve(result.filePaths[0]);
    return withIndexLock(async () => {
      const idx = await loadIndex();
      let project = idx.projects.find((p) => p.path === absPath);
      if (!project) {
        project = { path: absPath, addedAt: new Date().toISOString() };
        idx.projects.push(project);
        await saveIndex(idx);
      }
      return project;
    });
  }

  async close({ projectPath }: { projectPath: string }): Promise<void> {
    return withIndexLock(async () => {
      const idx = await loadIndex();
      idx.projects = idx.projects.filter((p) => p.path !== projectPath);
      // 被带走的对话，它们名下的 agent 标签一起关（标签跟对话走，spec 2026-09-17-browser-tab-lifecycle-design）。
      for (const t of idx.threads) if (t.projectPath === projectPath) browserService.disposeForThread(t.id);
      idx.threads = idx.threads.filter((t) => t.projectPath !== projectPath);
      await saveIndex(idx);
    });
  }

  async readDir({ path: dirPath }: { path: string }): Promise<FsNode[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter((e) => isListedName(e.name))
        .map((e) => ({
          name: e.name,
          path: path.join(dirPath, e.name),
          kind: e.isDirectory() ? 'dir' : 'file' as 'dir' | 'file',
        }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    } catch (err) {
      // 文件树会把这句话原样显示出来：带上 errno，用户截图就能分清是被删了（ENOENT）还是没权限（EPERM）。
      const code = (err as NodeJS.ErrnoException).code;
      throw new KydogError('fs.read_failed', code ? `cannot read ${dirPath} (${code})` : `cannot read ${dirPath}`, err);
    }
  }

  async openInOS({ projectPath }: { projectPath: string }): Promise<void> {
    const err = await shell.openPath(projectPath);
    if (err) throw new KydogError('fs.read_failed', err);
  }

  async update(args: { projectPath: string; label?: string; pinned?: boolean }): Promise<Project> {
    return withIndexLock(async () => {
      const idx = await loadIndex();
      const project = idx.projects.find((p) => p.path === args.projectPath);
      if (!project) throw new KydogError('project.not_found', `no project: ${args.projectPath}`);
      if (args.label !== undefined) project.label = args.label;
      if (args.pinned !== undefined) project.pinned = args.pinned;
      await saveIndex(idx);
      return project;
    });
  }
}

export const projectService = new ProjectService();
