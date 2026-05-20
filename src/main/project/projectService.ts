import { dialog, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { loadIndex, saveIndex } from '../persist/indexFile';
import { KydogError } from '../../shared/errors';
import type { Project, FsNode } from '../../shared/types';
import { fileWatcherService } from './fileWatcher';

export class ProjectService {
  async list(): Promise<Project[]> {
    const idx = await loadIndex();
    return idx.projects;
  }

  /** Boot-time watcher attach for all persisted projects. */
  async initWatchers(): Promise<void> {
    const idx = await loadIndex();
    for (const p of idx.projects) fileWatcherService.start(p.path);
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
    const idx = await loadIndex();
    let project = idx.projects.find((p) => p.path === absPath);
    if (!project) {
      project = { path: absPath, addedAt: new Date().toISOString() };
      idx.projects.push(project);
      await saveIndex(idx);
    }
    fileWatcherService.start(absPath);
    return project;
  }

  async close({ projectPath }: { projectPath: string }): Promise<void> {
    const idx = await loadIndex();
    idx.projects = idx.projects.filter((p) => p.path !== projectPath);
    idx.threads = idx.threads.filter((t) => t.projectPath !== projectPath);
    await saveIndex(idx);
    await fileWatcherService.stop(projectPath);
  }

  async readDir({ path: dirPath }: { path: string }): Promise<FsNode[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => ({
          name: e.name,
          path: path.join(dirPath, e.name),
          kind: e.isDirectory() ? 'dir' : 'file' as 'dir' | 'file',
        }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    } catch (err) {
      throw new KydogError('fs.read_failed', `cannot read ${dirPath}`, err);
    }
  }

  async openInOS({ projectPath }: { projectPath: string }): Promise<void> {
    const err = await shell.openPath(projectPath);
    if (err) throw new KydogError('fs.read_failed', err);
  }

  async update(args: { projectPath: string; label?: string; pinned?: boolean }): Promise<Project> {
    const idx = await loadIndex();
    const project = idx.projects.find((p) => p.path === args.projectPath);
    if (!project) throw new KydogError('project.not_found', `no project: ${args.projectPath}`);
    if (args.label !== undefined) project.label = args.label;
    if (args.pinned !== undefined) project.pinned = args.pinned;
    await saveIndex(idx);
    return project;
  }
}

export const projectService = new ProjectService();
