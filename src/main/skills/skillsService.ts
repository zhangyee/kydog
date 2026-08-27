import { existsSync, readFileSync, readdirSync, mkdirSync, promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, shell } from 'electron';
import type { SkillCommitArgs, SkillCommitResult, SkillEntry, SkillPreview } from '../../shared/types';
import { KydogError, serializeError, type SerializedError } from '../../shared/errors';
import { settingsService } from '../settings/settingsService';
import { parseSkillFrontmatter } from './parseSkillFrontmatter';
import { listBuiltinSkills, builtinSkillsRoot } from './builtinSkills';
import { KYDOG_SKILLS_DIR } from './skillResourceLoader';
import { enumerateSkills } from './enumerateSkills';
import { downloadToFile } from './urlFetch';
import { extractTarGz } from './urlExtract';
import { parseGithubUrl } from './githubUrl';
import { withSkillTree } from './skillTreeLock';

export interface SkillsServiceDeps {
  skillsDir: string;
  isBuiltin: (name: string) => boolean;
  builtinKydogVersion: () => string;
  stagingDir?: string;
  urlOverride?: { codeloadUrl: string; allowHttp?: boolean };
}

export class SkillsService {
  constructor(private readonly deps: SkillsServiceDeps) {}

  async list(): Promise<SkillEntry[]> {
    return withSkillTree(() => this.listUnlocked());
  }

  // 无锁实现，给已经持锁的调用方用（如 locale.set）；list() 是给 RPC 用的加锁壳。
  // 别在已持锁的方法体内调用 list()——那是重入死锁，应该调这个。
  async listUnlocked(): Promise<SkillEntry[]> {
    if (!existsSync(this.deps.skillsDir)) mkdirSync(this.deps.skillsDir, { recursive: true });
    const entries = readdirSync(this.deps.skillsDir, { withFileTypes: true });
    const disabled = (await settingsService.get()).skills.disabledBuiltins;
    const out: SkillEntry[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(this.deps.skillsDir, e.name);
      const skillFile = path.join(dir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const parsed = await parseSkillFrontmatter(readFileSync(skillFile, 'utf-8'));
      if (!parsed.ok) {
        console.warn(`[skills] skipping ${e.name}: ${parsed.reason}`);
        continue;
      }
      const origin: 'builtin' | 'user' = this.deps.isBuiltin(e.name) ? 'builtin' : 'user';
      const entry: SkillEntry = {
        name: e.name, // dirname is canonical id (§A.1)
        description: parsed.description,
        origin,
        enabled: origin === 'user' ? true : !disabled.includes(e.name),
        dirPath: dir,
      };
      if (origin === 'builtin') entry.kydogVersion = this.deps.builtinKydogVersion();
      out.push(entry);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async setEnabled(name: string, enabled: boolean): Promise<SkillEntry[]> {
    if (!this.deps.isBuiltin(name)) {
      throw new KydogError('skill.invalid', '第三方 skill 不支持禁用，请使用卸载');
    }
    const current = (await settingsService.get()).skills.disabledBuiltins;
    const next = enabled
      ? current.filter((n) => n !== name)
      : Array.from(new Set([...current, name]));
    await settingsService.update({ skills: { disabledBuiltins: next } });
    return this.list();
  }

  async uninstall(name: string): Promise<SkillEntry[]> {
    return withSkillTree(async () => {
      if (this.deps.isBuiltin(name)) {
        throw new KydogError('skill.uninstall_forbidden', '内置 skill 不支持卸载');
      }
      const dir = path.join(this.deps.skillsDir, name);
      await fsp.rm(dir, { recursive: true, force: true });
      return this.listUnlocked();
    });
  }

  async openInOS(name: string): Promise<void> {
    const dir = path.join(this.deps.skillsDir, name);
    // 锁里只放对 skill 树的那一次读：`shell.openPath` 是系统 UI 调用（Finder 可能弹权限框、
    // 可能挂住），而 skillTreeLock 无超时，且新建 session 的 createKydogResourceLoader
    // 也排在这把锁上 —— 把它圈进来等于让一次「在访达中显示」有机会卡死整个 skill 通路。
    await withSkillTree(async () => {
      if (!existsSync(dir)) throw new KydogError('skill.invalid', `未找到 skill ${name}`);
    });
    await shell.openPath(dir);
  }

  async previewFromFolder(args: { srcDir: string }): Promise<SkillPreview> {
    if (!existsSync(args.srcDir)) {
      throw new KydogError('skill.invalid', `路径不存在：${args.srcDir}`);
    }
    const result = await enumerateSkills(args.srcDir);
    const annotated = result.candidates.map((c) => ({
      ...c,
      alreadyInstalled: this.lookupExisting(c.name),
    }));
    return { srcKind: 'folder', srcPath: args.srcDir, candidates: annotated };
  }

  async previewFromUrl(args: { url: string }): Promise<SkillPreview> {
    const parsed = this.deps.urlOverride
      ? { codeloadUrl: this.deps.urlOverride.codeloadUrl, ref: '', subPath: '', owner: '', repo: '' }
      : parseGithubUrl(args.url);
    const stagingRoot = this.deps.stagingDir ?? path.join(this.deps.skillsDir, '..', '.cache', 'staging');
    mkdirSync(stagingRoot, { recursive: true });
    const rand = randomUUID();
    const archive = path.join(stagingRoot, `${rand}.archive`);
    const dir = path.join(stagingRoot, rand);
    mkdirSync(dir, { recursive: true });
    try {
      await downloadToFile(parsed.codeloadUrl, archive, {
        maxBytes: 50 * 1024 * 1024,
        timeoutMs: 60_000,
        allowHttp: this.deps.urlOverride?.allowHttp,
      });
      await extractTarGz(archive, dir);
      await fsp.unlink(archive).catch(() => {});
      const baseDir = computeBaseDir(dir, parsed.subPath);
      const result = await enumerateSkills(baseDir);
      const annotated = result.candidates.map((c) => ({
        ...c,
        alreadyInstalled: this.lookupExisting(c.name),
      }));
      return { srcKind: 'url', srcPath: baseDir, candidates: annotated };
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      await fsp.unlink(archive).catch(() => {});
      throw err;
    }
  }

  async commitFromPreview(args: SkillCommitArgs): Promise<SkillCommitResult> {
    return withSkillTree(async () => {
      const installed: SkillEntry[] = [];
      const skipped: { name: string; reason: SerializedError }[] = [];
      const stagingRoot = this.deps.stagingDir ?? path.join(this.deps.skillsDir, '..', '.cache', 'staging');
      mkdirSync(stagingRoot, { recursive: true });

      for (const pick of args.picks) {
        try {
          const srcSkillDir = path.join(args.srcPath, pick.relPath);
          const skillFile = path.join(srcSkillDir, 'SKILL.md');
          if (!existsSync(skillFile)) {
            throw new KydogError('skill.invalid', `pick 路径已不存在：${pick.relPath}`);
          }
          const parsed = await parseSkillFrontmatter(readFileSync(skillFile, 'utf-8'));
          if (!parsed.ok) {
            throw new KydogError('skill.invalid', `frontmatter 无效：${parsed.reason}`);
          }
          const finalName = parsed.name; // §A.1
          const targetDir = path.join(this.deps.skillsDir, finalName);
          if (existsSync(targetDir)) {
            throw new KydogError('skill.name_conflict', `已有同名 skill：${finalName}`);
          }

          const pickRand = randomUUID();
          if (args.srcKind === 'folder') {
            const stage = path.join(stagingRoot, `.commit-${pickRand}`);
            await fsp.cp(srcSkillDir, stage, { recursive: true });
            await fsp.rename(stage, targetDir);
          } else {
            // url: srcSkillDir already lives under stagingRoot's volume; rename direct
            await fsp.rename(srcSkillDir, targetDir);
          }
          const entry: SkillEntry = {
            name: finalName,
            description: parsed.description,
            origin: this.deps.isBuiltin(finalName) ? 'builtin' : 'user',
            enabled: true,
            dirPath: targetDir,
          };
          installed.push(entry);
        } catch (err) {
          skipped.push({ name: pick.name, reason: serializeError(err) });
        }
      }

      if (args.srcKind === 'url') {
        // Clean up the entire staging child for this preview (the dir containing srcPath)
        // srcPath is e.g. <stagingRoot>/<rand>/repo-<sha>/<subPath>; clean up <stagingRoot>/<rand>
        const rand = path.relative(stagingRoot, args.srcPath).split(path.sep)[0];
        if (rand && rand !== '..' && !rand.startsWith('..' + path.sep)) {
          await fsp.rm(path.join(stagingRoot, rand), { recursive: true, force: true }).catch(() => {});
        }
      }

      // 已经持锁，不能再调 list()（重入死锁），用无锁版
      const list = await this.listUnlocked();
      return { installed, skipped, list };
    });
  }

  private lookupExisting(name: string): 'builtin' | 'user' | null {
    const dir = path.join(this.deps.skillsDir, name);
    if (!existsSync(dir)) return null;
    return this.deps.isBuiltin(name) ? 'builtin' : 'user';
  }
}

function computeBaseDir(stagingChild: string, subPath: string): string {
  const entries = readdirSync(stagingChild, { withFileTypes: true })
    .filter((e) => e.isDirectory());
  if (entries.length === 1) {
    const wrap = path.join(stagingChild, entries[0].name);
    return subPath ? path.join(wrap, subPath) : wrap;
  }
  return subPath ? path.join(stagingChild, subPath) : stagingChild;
}

export const skillsService = new SkillsService({
  skillsDir: KYDOG_SKILLS_DIR,
  isBuiltin: (name) => listBuiltinSkills(builtinSkillsRoot()).includes(name),
  builtinKydogVersion: () => app.getVersion(),
});
