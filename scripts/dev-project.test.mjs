import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lock } from 'proper-lockfile';

const repo = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./dev-project.mjs', import.meta.url));
let home;
let root;
let file;
let target;
let initial;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'kydog-dev-cli-'));
  root = path.join(home, '.kydog');
  mkdirSync(root);
  file = path.join(root, 'kydog.json');
  target = path.join(home, 'debug project');
  mkdirSync(target);
  initial = { schemaVersion: 9, ui: { collapsedProjects: ['/kept'] },
    llm: { auth: { provider: { type: 'api_key', key: 'preserved-key' } } }, futureSetting: { keep: true } };
  writeFileSync(file, JSON.stringify(initial));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
  });
}
const read = () => JSON.parse(readFileSync(file, 'utf8'));

it('通过 npm 无分隔符开启相对路径，关闭保留目录，再次开启可复用', () => {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'dev-project', 'on', path.relative(repo, target)], {
    cwd: repo, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
  });
  expect({ code: result.status, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  expect(read().development).toEqual({ singleProject: { enabled: true, path: target } });
  expect(result.stdout).toContain('重启');
  const rest = read();
  delete rest.development;
  expect(rest).toEqual(initial);
  expect(run('off').status).toBe(0);
  expect(read().development).toEqual({ singleProject: { enabled: false, path: target } });
  expect(run('on').status).toBe(0);
  expect(read().development).toEqual({ singleProject: { enabled: true, path: target } });
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
});

it('status 只报告配置与路径，不写文件', () => {
  expect(run('on', target).status).toBe(0);
  const before = readFileSync(file, 'utf8');
  const result = run('status');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('开启');
  expect(result.stdout).toContain(target);
  expect(readFileSync(file, 'utf8')).toBe(before);
});

it.each([['on'], ['on', 'missing'], ['on', 'package.json'], ['wat'], ['off', 'extra'], ['on', 'one', 'two']])(
  '无效参数或目录 %j 失败且原文件保持不变', (...args) => {
    const before = readFileSync(file, 'utf8');
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
  },
);

it('关闭不依赖目标仍存在，能从失效目录配置中恢复', () => {
  expect(run('on', target).status).toBe(0);
  rmSync(target, { recursive: true });
  expect(run('off').status).toBe(0);
  expect(read().development.singleProject).toEqual({ enabled: false, path: target });
});

it.each(['{broken', '[]', '{"schemaVersion":999,"secret":"kept"}'])(
  '损坏或不支持的设置不被覆盖：%s', raw => {
    writeFileSync(file, raw);
    expect(run('on', target).status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  },
);

it('使用与应用相同的锁，锁被占用时不覆盖，释放后读取最新设置', async () => {
  expect(run('on', target).status).toBe(0);
  const release = await lock(root, { lockfilePath: path.join(root, '.kydog.json.lock'), realpath: false });
  const before = readFileSync(file, 'utf8');
  try {
    expect(run('off').status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
    const settings = read();
    settings.futureSetting.keep = 'newer';
    writeFileSync(file, JSON.stringify(settings));
  } finally { await release(); }
  expect(run('off').status).toBe(0);
  expect(read().futureSetting.keep).toBe('newer');
  expect(read().development.singleProject).toEqual({ enabled: false, path: target });
});

it('Windows 重命名遇到一次 EBUSY 后重试，仍写入完整配置', () => {
  const preload = path.join(home, 'busy-rename.mjs');
  writeFileSync(preload, `
    import { promises as fs } from 'node:fs';
    const rename = fs.rename;
    let first = true;
    fs.rename = async (...args) => {
      if (first) { first = false; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }
      return rename(...args);
    };
    Object.defineProperty(process, 'platform', { value: 'win32' });
  `);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, 'on', target], {
    cwd: repo, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
  });
  expect({ code: result.status, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  expect(read().development.singleProject).toEqual({ enabled: true, path: target });
  expect(read().llm).toEqual(initial.llm);
});
