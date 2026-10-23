import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from 'electron';
import * as paths from '../persist/paths';
import { saveIndex } from '../persist/indexFile';
import { KydogError } from '../../shared/errors';
import { isTrashablePath, type TrashFilesArgs } from '../../shared/files';
import { SKIP_WITHOUT_SYMLINK, SYMLINK_SKIP_REASON } from '../../test-support/symlinkCapability';
import { trashFiles } from './trashFiles';
import { projectService } from '../project/projectService';

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }));
vi.mock('../browser/browserService', () => ({ browserService: {} }));

let temp: string;
let root: string;
let trash: string;

async function register(projectPath = root) {
  await saveIndex({ schemaVersion: 1, projects: [{ path: projectPath, addedAt: '2026-10-20T00:00:00Z' }], threads: [] });
}

async function document(name: string, content = '# report', parent = root) {
  const target = path.join(parent, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

async function move(target: string) {
  await fs.rename(target, path.join(trash, path.basename(target)));
}

// Every refusal first proves the same real index/filesystem/shell route can move a normal file.
async function positiveControl() {
  const control = await document('control.md', 'CONTROL');
  expect(await trashFiles({ projectPath: root, paths: [control] })).toEqual({ trashed: [control], failed: [] });
  expect(await fs.readFile(path.join(trash, 'control.md'), 'utf8')).toBe('CONTROL');
}

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-trash-'));
  root = path.join(temp, 'project');
  trash = path.join(temp, 'trash');
  await fs.mkdir(root);
  await fs.mkdir(trash);
  vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(temp, 'index.json'));
  await register();
  vi.mocked(shell.trashItem).mockReset().mockImplementation(move);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temp, { recursive: true, force: true });
});

describe('trashFiles', () => {
  it('临时项目在 on 可移至废纸篓，off 后未登记目录不可操作，文件边界仍受校验', async () => {
    await saveIndex({ schemaVersion: 1, projects: [], threads: [] });
    const scope = vi.spyOn(projectService, 'singleProjectPath', 'get').mockReturnValue(root);
    await positiveControl();
    const valid = await document('valid.md', 'VALID');
    const outside = await document('outside.md', 'OUTSIDE', path.join(temp, 'outside'));
    await expect(trashFiles({ projectPath: root, paths: [valid, outside] }))
      .rejects.toMatchObject({ code: 'fs.access_denied' });
    expect(await fs.readFile(valid, 'utf8')).toBe('VALID');
    scope.mockReturnValue(null);
    await expect(trashFiles({ projectPath: root, paths: [valid] }))
      .rejects.toMatchObject({ code: 'fs.access_denied' });
    expect(await fs.readFile(valid, 'utf8')).toBe('VALID');
    expect(await fs.readdir(trash)).toEqual(['control.md']);
  });

  it('deduplicates original paths and moves only selected documents, preserving sidecars and attachments', async () => {
    const md = await document('report.md');
    const pdf = await document('paper.pdf', '%PDF-paper');
    const markdown = await document('notes.MARKDOWN', 'NOTES');
    const pdfSidecar = await document('.paper.pdf.json', 'ANNOTATIONS');
    const translation = await document('.paper.pdf.zh.json', 'TRANSLATION');
    const image = await document('figure.png', 'IMAGE');
    expect(await trashFiles({ projectPath: root, paths: [md, pdf, md, markdown] }))
      .toEqual({ trashed: [md, pdf, markdown], failed: [] });
    expect(await fs.readFile(path.join(trash, 'report.md'), 'utf8')).toBe('# report');
    expect(await fs.readFile(path.join(trash, 'paper.pdf'), 'utf8')).toBe('%PDF-paper');
    expect(await fs.readFile(path.join(trash, 'notes.MARKDOWN'), 'utf8')).toBe('NOTES');
    expect(await fs.readdir(root)).toEqual(['.paper.pdf.json', '.paper.pdf.zh.json', 'figure.png']);
    expect(await fs.readFile(pdfSidecar, 'utf8')).toBe('ANNOTATIONS');
    expect(await fs.readFile(translation, 'utf8')).toBe('TRANSLATION');
    expect(await fs.readFile(image, 'utf8')).toBe('IMAGE');
  });

  it('preserves a failed file and continues after a shell error with per-path serialized write errors', async () => {
    const md = await document('report.md');
    const pdf = await document('paper.pdf', '%PDF-paper');
    const after = await document('after.md', 'AFTER');
    vi.mocked(shell.trashItem).mockImplementation(async (target) => {
      if (target === pdf) throw Object.assign(new Error('operation denied'), { code: 'EPERM' });
      await move(target);
    });
    const result = await trashFiles({ projectPath: root, paths: [md, pdf, after] });
    expect(result).toEqual({ trashed: [md, after], failed: [{ path: pdf, error: { code: 'fs.write_failed', message: expect.stringContaining('EPERM') } }] });
    expect(await fs.readFile(path.join(trash, 'report.md'), 'utf8')).toBe('# report');
    expect(await fs.readFile(path.join(trash, 'after.md'), 'utf8')).toBe('AFTER');
    expect(await fs.readFile(pdf, 'utf8')).toBe('%PDF-paper');
    expect(await fs.readdir(trash)).toEqual(['after.md', 'report.md']);
  });

  it.each(['root', 'directory', 'html', 'relative', 'sibling', 'unregistered', 'missing'] as const)(
    'rejects the whole batch before moving valid.md when target is %s', async (kind) => {
      await positiveControl();
      const valid = await document('valid.md', 'VALID');
      let target: string;
      switch (kind) {
        case 'root': target = root; break;
        case 'directory': target = path.join(root, 'folder.md'); await fs.mkdir(target); break;
        case 'html': target = await document('page.html', 'HTML'); break;
        case 'relative': target = 'valid.md'; break;
        case 'sibling': target = await document('outside.md', 'OUTSIDE', `${root}-sibling`); break;
        case 'unregistered': target = await document('other.md'); await register(path.join(temp, 'other-project')); break;
        case 'missing': target = path.join(root, 'missing.md'); break;
      }
      await expect(trashFiles({ projectPath: root, paths: [valid, target] })).rejects.toBeInstanceOf(KydogError);
      expect(await fs.readFile(valid, 'utf8')).toBe('VALID');
      expect(await fs.readdir(trash)).toEqual(['control.md']);
    },
  );

  it('allows children whose names begin with two dots and retains their original path identity', async () => {
    const target = await document('notes.pdf', 'DOTS', path.join(root, '..notes'));
    expect(await trashFiles({ projectPath: root, paths: [target] })).toEqual({ trashed: [target], failed: [] });
    expect(await fs.readFile(path.join(trash, 'notes.pdf'), 'utf8')).toBe('DOTS');
  });

  it('returns an empty result for an empty selection', async () => {
    await positiveControl();
    expect(await trashFiles({ projectPath: root, paths: [] })).toEqual({ trashed: [], failed: [] });
    expect(await fs.readdir(trash)).toEqual(['control.md']);
  });

  it.each([
    null, undefined, {}, { projectPath: undefined, paths: [] }, { projectPath: 7, paths: [] },
    { projectPath: '.', paths: [] }, { paths: null }, { paths: 'valid.md' },
    { paths: [7] }, { paths: ['valid.md', null] },
  ])('rejects malformed runtime args with fs.access_denied: %j', async (input) => {
    await positiveControl();
    const valid = await document('valid.md', 'VALID');
    const args = input && typeof input === 'object' ? {
      projectPath: root, ...input,
      ...('paths' in input && Array.isArray(input.paths)
        ? { paths: input.paths.map((target) => target === 'valid.md' ? valid : target) } : {}),
    } : input;
    await expect(trashFiles(args as TrashFilesArgs)).rejects.toMatchObject({ code: 'fs.access_denied' });
    expect(await fs.readFile(valid, 'utf8')).toBe('VALID');
    expect(await fs.readdir(trash)).toEqual(['control.md']);
  });

  it.skipIf(SKIP_WITHOUT_SYMLINK)(`rejects a file symlink even inside the project; ${SYMLINK_SKIP_REASON}`, async () => {
    await positiveControl();
    const valid = await document('valid.md', 'VALID');
    const destination = await document('target.md', 'TARGET');
    const link = path.join(root, 'link.md');
    await fs.symlink(destination, link);
    await expect(trashFiles({ projectPath: root, paths: [valid, link] })).rejects.toMatchObject({ code: 'fs.access_denied' });
    expect(await fs.readFile(valid, 'utf8')).toBe('VALID');
    expect(await fs.readFile(destination, 'utf8')).toBe('TARGET');
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(trash)).toEqual(['control.md']);
  });

  it.skipIf(SKIP_WITHOUT_SYMLINK)(`rejects a target escaping through a parent symlink; ${SYMLINK_SKIP_REASON}`, async () => {
    await positiveControl();
    const valid = await document('valid.md', 'VALID');
    const outside = path.join(temp, 'outside');
    const target = await document('secret.pdf', 'SECRET', outside);
    const link = path.join(root, 'linked-folder');
    await fs.symlink(outside, link, 'dir');
    await expect(trashFiles({ projectPath: root, paths: [valid, path.join(link, 'secret.pdf')] })).rejects.toMatchObject({ code: 'fs.access_denied' });
    expect(await fs.readFile(valid, 'utf8')).toBe('VALID');
    expect(await fs.readFile(target, 'utf8')).toBe('SECRET');
    expect(await fs.readdir(trash)).toEqual(['control.md']);
  });

  it.skipIf(SKIP_WITHOUT_SYMLINK)(`allows a registered symlink project root using its real boundary; ${SYMLINK_SKIP_REASON}`, async () => {
    const linkRoot = path.join(temp, 'project-link');
    await fs.symlink(root, linkRoot, 'dir');
    await register(linkRoot);
    await document('paper.pdf', 'LINKED');
    const target = path.join(linkRoot, 'paper.pdf');
    expect(await trashFiles({ projectPath: linkRoot, paths: [target] })).toEqual({ trashed: [target], failed: [] });
    expect(await fs.readFile(path.join(trash, 'paper.pdf'), 'utf8')).toBe('LINKED');
  });

  it.skipIf(SKIP_WITHOUT_SYMLINK)(`rechecks each target after preflight and preserves a replacement symlink target; ${SYMLINK_SKIP_REASON}`, async () => {
    const first = await document('first.md', 'FIRST');
    const second = await document('second.pdf', 'SECOND');
    const outside = await document('outside.pdf', 'OUTSIDE', temp);
    vi.mocked(shell.trashItem).mockImplementation(async (target) => {
      await move(target);
      if (target === first) {
        await fs.rename(second, path.join(temp, 'original-second.pdf'));
        await fs.symlink(outside, second);
      }
    });
    expect(await trashFiles({ projectPath: root, paths: [first, second] })).toEqual({
      trashed: [first], failed: [{ path: second, error: { code: 'fs.write_failed', message: expect.any(String) } }],
    });
    expect(await fs.readFile(path.join(trash, 'first.md'), 'utf8')).toBe('FIRST');
    expect(await fs.readFile(outside, 'utf8')).toBe('OUTSIDE');
    expect((await fs.lstat(second)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(temp, 'original-second.pdf'), 'utf8')).toBe('SECOND');
    expect(await fs.readdir(trash)).toEqual(['first.md']);
  });
});

describe('isTrashablePath shared eligibility', () => {
  it.each([
    ['report.md', true], ['report.MD', true], ['notes.markdown', true], ['notes.MARKDOWN', true],
    ['paper.pdf', true], ['paper.PDF', true], ['page.html', false], ['page.htm', false],
    ['figure.png', false], ['draft.mdx', false], ['notes.txt', false], ['paper.pdf.json', false],
    ['paper.pdf.zh.json', false], ['', false],
  ])('%s → %s', (target, expected) => { expect(isTrashablePath(target)).toBe(expected); });
});
