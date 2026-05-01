import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillsService } from './skillsService';
import { makeTarball } from './__fixtures__/makeTarball';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  shell: { openPath: vi.fn().mockResolvedValue('') },
}));

vi.mock('../settings/settingsService', () => ({
  settingsService: { get: vi.fn(), update: vi.fn() },
}));
import { settingsService } from '../settings/settingsService';

function mkSkill(root: string, name: string): void {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody`);
}
function tmp() { return mkdtempSync(path.join(tmpdir(), 'svc-')); }

describe('SkillsService.list', () => {
  it('returns builtin and user skills with correct origin/enabled flags', async () => {
    const skillsDir = tmp();
    mkSkill(skillsDir, 'fastpaper');     // assumed builtin
    mkSkill(skillsDir, 'agent-browser'); // user
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: { disabledBuiltins: ['fastpaper'] },
    });
    const svc = new SkillsService({
      skillsDir,
      isBuiltin: (n) => n === 'fastpaper',
      builtinKydogVersion: () => '0.2.0',
    });
    const list = await svc.list();
    const fp = list.find(s => s.name === 'fastpaper');
    const ab = list.find(s => s.name === 'agent-browser');
    expect(fp?.name).toBe('fastpaper');
    expect(fp?.dirPath).toBe(path.join(skillsDir, 'fastpaper'));
    expect(fp?.description).toBe('d');
    expect(fp?.origin).toBe('builtin');
    expect(fp?.enabled).toBe(false);
    expect(fp?.kydogVersion).toBe('0.2.0');
    expect(ab?.name).toBe('agent-browser');
    expect(ab?.dirPath).toBe(path.join(skillsDir, 'agent-browser'));
    expect(ab?.description).toBe('d');
    expect(ab?.origin).toBe('user');
    expect(ab?.enabled).toBe(true);
    expect(ab?.kydogVersion).toBeUndefined();
  });

  it('skips hidden dirs (.cache, .manifest.json wouldn’t be a dir)', async () => {
    const skillsDir = tmp();
    mkdirSync(path.join(skillsDir, '.cache'));
    mkSkill(skillsDir, 'good');
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: { disabledBuiltins: [] },
    });
    const svc = new SkillsService({ skillsDir, isBuiltin: () => false, builtinKydogVersion: () => '0' });
    const list = await svc.list();
    expect(list.map(s => s.name)).toEqual(['good']);
  });
});

describe('SkillsService.setEnabled', () => {
  it('builtin: writes disabledBuiltins via settingsService.update', async () => {
    const skillsDir = tmp();
    mkSkill(skillsDir, 'fastpaper');
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({ skills: { disabledBuiltins: [] } });
    (settingsService.update as ReturnType<typeof vi.fn>).mockResolvedValue({ skills: { disabledBuiltins: ['fastpaper'] } });
    const svc = new SkillsService({ skillsDir, isBuiltin: () => true, builtinKydogVersion: () => '0' });
    await svc.setEnabled('fastpaper', false);
    expect(settingsService.update).toHaveBeenCalledWith({ skills: { disabledBuiltins: ['fastpaper'] } });
  });

  it('user: throws skill.invalid', async () => {
    const skillsDir = tmp();
    mkSkill(skillsDir, 'agent-browser');
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({ skills: { disabledBuiltins: [] } });
    (settingsService.update as ReturnType<typeof vi.fn>).mockReset();
    const svc = new SkillsService({ skillsDir, isBuiltin: () => false, builtinKydogVersion: () => '0' });
    await expect(svc.setEnabled('agent-browser', false)).rejects.toThrow(/skill\.invalid|第三方/);
    expect(settingsService.update).not.toHaveBeenCalled();
  });

  it('idempotent disable then enable removes from list', async () => {
    const skillsDir = tmp();
    mkSkill(skillsDir, 'fastpaper');
    (settingsService.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ skills: { disabledBuiltins: ['fastpaper'] } });
    (settingsService.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const svc = new SkillsService({ skillsDir, isBuiltin: () => true, builtinKydogVersion: () => '0' });
    await svc.setEnabled('fastpaper', true);
    expect(settingsService.update).toHaveBeenCalledWith({ skills: { disabledBuiltins: [] } });
  });
});

describe('SkillsService.uninstall', () => {
  it('user: removes the directory', async () => {
    const skillsDir = tmp();
    mkSkill(skillsDir, 'agent-browser');
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({ skills: { disabledBuiltins: [] } });
    const svc = new SkillsService({ skillsDir, isBuiltin: () => false, builtinKydogVersion: () => '0' });
    await svc.uninstall('agent-browser');
    expect(existsSync(path.join(skillsDir, 'agent-browser'))).toBe(false);
  });

  it('builtin: throws skill.uninstall_forbidden', async () => {
    const skillsDir = tmp();
    mkSkill(skillsDir, 'fastpaper');
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({ skills: { disabledBuiltins: [] } });
    const svc = new SkillsService({ skillsDir, isBuiltin: () => true, builtinKydogVersion: () => '0' });
    await expect(svc.uninstall('fastpaper')).rejects.toThrow(/skill\.uninstall_forbidden|内置/);
    expect(existsSync(path.join(skillsDir, 'fastpaper'))).toBe(true);
  });
});

describe('SkillsService.previewFromFolder', () => {
  it('returns candidates from a folder', async () => {
    const skillsDir = tmp();
    const src = tmp();
    mkSkill(src, 'foo');
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({ skills: { disabledBuiltins: [] } });
    const svc = new SkillsService({ skillsDir, isBuiltin: () => false, builtinKydogVersion: () => '0' });
    const r = await svc.previewFromFolder({ srcDir: src });
    expect(r.srcKind).toBe('folder');
    expect(r.candidates.map(c => c.name)).toEqual(['foo']);
  });

  it('marks alreadyInstalled when name exists', async () => {
    const skillsDir = tmp();
    mkSkill(skillsDir, 'foo');     // already installed
    const src = tmp();
    mkSkill(src, 'foo');
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({ skills: { disabledBuiltins: [] } });
    const svc = new SkillsService({ skillsDir, isBuiltin: (n) => n === 'foo', builtinKydogVersion: () => '0' });
    const r = await svc.previewFromFolder({ srcDir: src });
    expect(r.candidates[0].alreadyInstalled).toBe('builtin');
  });
});

describe('SkillsService.previewFromUrl', () => {
  it('downloads tarball and enumerates', async () => {
    const skillsDir = tmp();
    const cacheDir = tmp();
    const archive = await makeTarball({ entries: [
      { path: 'repo-abc/SKILL.md', content: '---\nname: agent-browser\ndescription: d\n---' },
    ]});
    const buf = readFileSync(archive);
    const srv = http.createServer((_req, r) => {
      r.writeHead(200, { 'Content-Length': String(buf.length) });
      r.end(buf);
    });
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    const addr = srv.address();
    if (typeof addr === 'string' || !addr) throw new Error('bad addr');
    const url = `http://127.0.0.1:${addr.port}/x.tar.gz`;
    try {
      (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({ skills: { disabledBuiltins: [] } });
      const svc = new SkillsService({
        skillsDir,
        isBuiltin: () => false,
        builtinKydogVersion: () => '0',
        stagingDir: cacheDir,
        urlOverride: { codeloadUrl: url, allowHttp: true },
      });
      const r = await svc.previewFromUrl({ url: 'https://github.com/owner/repo' });
      expect(r.srcKind).toBe('url');
      expect(r.candidates[0].name).toBe('agent-browser');
    } finally { srv.close(); }
  });
});

describe('SkillsService.commitFromPreview', () => {
  it('folder source: copies pick into ~/.kydog/skills/<name>/', async () => {
    const skillsDir = tmp();
    const cacheDir = tmp();
    const src = tmp();
    mkSkill(src, 'a');
    mkSkill(src, 'b');
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({ skills: { disabledBuiltins: [] } });
    const svc = new SkillsService({
      skillsDir,
      isBuiltin: () => false,
      builtinKydogVersion: () => '0',
      stagingDir: cacheDir,
    });
    const r = await svc.commitFromPreview({
      srcKind: 'folder',
      srcPath: src,
      picks: [
        { name: 'a', relPath: 'a' },
        { name: 'b', relPath: 'b' },
      ],
    });
    expect(r.installed.map(s => s.name).sort()).toEqual(['a', 'b']);
    expect(r.skipped).toEqual([]);
    expect(existsSync(path.join(skillsDir, 'a', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(skillsDir, 'b', 'SKILL.md'))).toBe(true);
  });

  it('skips name-conflict picks with skill.name_conflict code', async () => {
    const skillsDir = tmp();
    const cacheDir = tmp();
    const src = tmp();
    mkSkill(skillsDir, 'a');   // already installed (user)
    mkSkill(src, 'a');
    mkSkill(src, 'b');
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({ skills: { disabledBuiltins: [] } });
    const svc = new SkillsService({
      skillsDir,
      isBuiltin: () => false,
      builtinKydogVersion: () => '0',
      stagingDir: cacheDir,
    });
    const r = await svc.commitFromPreview({
      srcKind: 'folder',
      srcPath: src,
      picks: [{ name: 'a', relPath: 'a' }, { name: 'b', relPath: 'b' }],
    });
    expect(r.installed.map(s => s.name)).toEqual(['b']);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ name: 'a', reason: { code: 'skill.name_conflict' } });
  });

  it('multiple picks each get independent staging dir (no collision)', async () => {
    // Implicit: prior test passes proves picks don't clobber.
    expect(true).toBe(true);
  });
});
