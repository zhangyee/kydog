// 开发调试：只显示一个项目。配置写入后重启 KyDog 生效。
// npm run dev-project on [目录] | off | status
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { lock } from 'proper-lockfile';

const root = path.join(os.homedir(), '.kydog');
const file = path.join(root, 'kydog.json');
const [command, folder, ...extra] = process.argv.slice(2);
const usage = '用法：npm run dev-project on [目录] | off | status';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function read() {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') throw new Error('尚无 ~/.kydog/kydog.json，请先启动一次 KyDog。');
    throw err;
  }
  let settings;
  try { settings = JSON.parse(raw); }
  catch { throw new Error('kydog.json 不是合法 JSON，原文件未修改。'); }
  // 不迁移或重建配置，以免改动其他设置或覆盖较新应用写下的数据。
  if (!object(settings) || !Number.isInteger(settings.schemaVersion) || settings.schemaVersion < 2 || settings.schemaVersion > 9) {
    throw new Error('kydog.json 的配置版本不受此脚本支持，原文件未修改。');
  }
  return settings;
}

async function write(settings) {
  const tmp = `${file}.tmp.${randomUUID()}`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // 与 persist/atomicWrite.ts 相同的 Windows 临时占用策略；脚本保持纯 Node ESM，
    // 避免直接加载应用 TS 源码触发 MODULE_TYPELESS_PACKAGE_JSON 警告。
    const backoff = [10, 25, 50, 100, 200, 400, 800];
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, file);
        break;
      } catch (err) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || attempt >= backoff.length) throw err;
        await new Promise(resolve => setTimeout(resolve, backoff[attempt]));
      }
    }
    if (process.platform !== 'win32') await fs.chmod(file, 0o600);
  } finally { await fs.rm(tmp, { force: true }); }
}

async function main() {
  if (!['on', 'off', 'status'].includes(command) || extra.length || (command !== 'on' && folder !== undefined)) {
    throw new Error(usage);
  }
  if (command === 'status') {
    const settings = await read();
    const single = settings.development?.singleProject;
    console.log(`单项目模式配置：${single?.enabled === true ? '开启' : '关闭'}`);
    console.log(`目标目录：${typeof single?.path === 'string' ? single.path : '未设置'}`);
    console.log('配置在重启 KyDog 后生效。');
    return;
  }
  // 先验证配置存在，再拿与 SettingsService 相同的跨进程锁；必须在锁内重新读取。
  await read();
  const release = await lock(root, {
    lockfilePath: path.join(root, '.kydog.json.lock'), realpath: false,
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 }, stale: 10_000,
  });
  try {
    const settings = await read();
    const development = object(settings.development) ? settings.development : {};
    const saved = development.singleProject?.path;
    let target = typeof saved === 'string' ? saved : null;
    if (command === 'on') {
      if (folder !== undefined) target = path.resolve(folder);
      if (!target || !path.isAbsolute(target)) throw new Error('请指定项目目录：npm run dev-project on <目录>');
      const stat = await fs.stat(target).catch(() => null);
      if (!stat?.isDirectory()) throw new Error(`目标不是可用目录：${target}`);
      target = path.resolve(target);
    }
    settings.development = { ...development, singleProject: { enabled: command === 'on', path: target } };
    await write(settings);
    console.log(`单项目模式配置已${command === 'on' ? '开启' : '关闭'}。请重启 KyDog 生效。`);
    console.log(`目标目录：${target ?? '未设置'}`);
  } finally { await release(); }
}

main().catch(err => {
  console.error(err.code === 'ELOCKED' ? '配置正被其他进程写入，请稍后重试。' : err.message);
  process.exitCode = 1;
});
