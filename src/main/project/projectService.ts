import { dialog, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { loadIndex, saveIndex, withIndexLock } from '../persist/indexFile';
import { KydogError } from '../../shared/errors';
import type { Project, FsNode, SettingsFile } from '../../shared/types';
import { isListedName } from './listing';
import { browserService } from '../browser/browserService';

export class ProjectService {
  private temporaryProject: Project | null = null;

  constructor(private scope: { readonly singleProjectPath: string | null } = { singleProjectPath: null }) {}

  get singleProjectPath(): string | null { return this.scope.singleProjectPath; }

  /** 只在主进程启动时调用；保存路径值，不持有会被后续设置更新替换的配置对象。 */
  async initialize(development: SettingsFile['development']): Promise<void> {
    this.temporaryProject = null;
    if (development?.singleProject.enabled !== true) {
      this.scope = { singleProjectPath: null };
      return;
    }
    const target = development.singleProject.path;
    const message = 'development.singleProject.path 必须是已存在目录的绝对路径；可运行 npm run dev-project off 后重新启动。';
    if (!target || !path.isAbsolute(target)) throw new KydogError('settings.invalid', message);
    try {
      if (!(await fs.stat(target)).isDirectory()) throw new KydogError('settings.invalid', message);
    } catch (err) {
      if (err instanceof KydogError) throw err;
      throw new KydogError('settings.invalid', message, err);
    }
    this.scope = { singleProjectPath: path.resolve(target) };
    await this.list();
  }

  async list(): Promise<Project[]> {
    const target = this.scope.singleProjectPath;
    if (target !== null) {
      const idx = await loadIndex({ strict: true });
      return [{ ...this.scopedProject(idx.projects, target) }];
    }
    const idx = await loadIndex();
    return idx.projects;
  }

  private scopedProject(projects: Project[], target: string): Project {
    const existing = projects.find(p => p.path === target);
    if (existing) return existing;
    // 临时调试项目只活在本次运行；不能把视图投影写回普通项目登记。
    this.temporaryProject ??= { path: target, addedAt: new Date().toISOString() };
    return this.temporaryProject;
  }

  async open(): Promise<Project> {
    this.assertProjectsUnlocked();
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

  private assertProjectsUnlocked(): void {
    if (this.scope.singleProjectPath !== null) {
      throw new KydogError('project.single_project_locked', '开发调试模式已锁定项目；请通过 dev-project 脚本修改配置并重启 KyDog。');
    }
  }

  async close({ projectPath }: { projectPath: string }): Promise<void> {
    this.assertProjectsUnlocked();
    return withIndexLock(async () => {
      const idx = await loadIndex();
      idx.projects = idx.projects.filter((p) => p.path !== projectPath);
      // 被带走的对话，它们名下的 agent 标签一起关（标签跟对话走，spec 2026-09-17-browser-tab-lifecycle-design）。
      const { disposeWebResearchThread } = await import('../webResearch/service');
      for (const t of idx.threads) if (t.projectPath === projectPath) {
        await disposeWebResearchThread(t.id);
        browserService.disposeForThread(t.id);
      }
      idx.threads = idx.threads.filter((t) => t.projectPath !== projectPath);
      await saveIndex(idx);
    });
  }

  async readDir({ path: dirPath }: { path: string }): Promise<FsNode[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const nodes = await Promise.all(entries.filter((e) => isListedName(e.name)).map(async (e): Promise<FsNode | null> => {
        const entryPath = path.join(dirPath, e.name);
        let mtimeMs: number | null = null;
        try {
          mtimeMs = (await fs.stat(entryPath)).mtimeMs;
        } catch (err) {
          // 条目在 readdir 后消失可略过；其他元数据错误保留名称，不伪造时间。
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        }
        return { name: e.name, path: entryPath, kind: e.isDirectory() ? 'dir' : 'file', mtimeMs };
      }));
      return nodes.filter((n): n is FsNode => n !== null)
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
      const idx = await loadIndex({ strict: this.singleProjectPath !== null });
      const existing = idx.projects.find((p) => p.path === args.projectPath);
      const project = existing ?? (this.singleProjectPath === args.projectPath
        ? this.scopedProject(idx.projects, args.projectPath) : undefined);
      if (!project) throw new KydogError('project.not_found', `no project: ${args.projectPath}`);
      if (args.label !== undefined) project.label = args.label;
      if (args.pinned !== undefined) project.pinned = args.pinned;
      if (existing) await saveIndex(idx);
      return { ...project };
    });
  }
}

export const projectService = new ProjectService();
