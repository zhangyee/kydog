import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../persist/atomicWrite';
import { KydogError } from '../../shared/errors';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 100 * 1024 * 1024;

/**
 * target 的 realpath 是否严格落在 base 的 realpath 之内（不含等于 base 本身）。
 *
 * 不能用 `target.startsWith(base)`：`/proj-evil/x.png` 会字符串前缀匹配上 `/proj`，
 * 必须靠 `path.relative` 按路径分隔符边界判定——结果不以 `..` 开头、也不是绝对路径
 * （跨盘符时 `path.relative` 会退化成返回 target 本身，此时是绝对路径），才算真的在里面。
 */
function isWithin(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export const fileService = {
  async readText({ path }: { path: string }): Promise<{ content: string }> {
    let stat;
    try {
      stat = await fsp.stat(path);
    } catch (err) {
      throw new KydogError('fs.read_failed', `无法读取 ${path}`, err);
    }
    if (!stat.isFile()) {
      throw new KydogError('fs.read_failed', `${path} 不是文件`);
    }
    if (stat.size > MAX_BYTES) {
      throw new KydogError('fs.too_large', `${path} 超过 2MB 上限`);
    }
    try {
      const content = await fsp.readFile(path, 'utf8');
      return { content };
    } catch (err) {
      throw new KydogError('fs.read_failed', `无法读取 ${path}`, err);
    }
  },

  async readBytes({ path }: { path: string }): Promise<{ bytes: Uint8Array<ArrayBuffer> }> {
    let stat;
    try {
      stat = await fsp.stat(path);
    } catch (err) {
      throw new KydogError('fs.read_failed', `无法读取 ${path}`, err);
    }
    if (!stat.isFile()) {
      throw new KydogError('fs.read_failed', `${path} 不是文件`);
    }
    if (stat.size > MAX_BINARY_BYTES) {
      throw new KydogError('fs.too_large', `${path} 超过 100MB 上限`);
    }
    try {
      const buf = await fsp.readFile(path);
      return { bytes: new Uint8Array(buf) };
    } catch (err) {
      throw new KydogError('fs.read_failed', `无法读取 ${path}`, err);
    }
  },

  /**
   * 只在渲染进程需要「路径必须落在某个目录树内」时用（目前是学习报告内联本地图片，
   * 见 reportTheme.ts 的 inlineLocalImages）。跟 readBytes 的区别不是权限模型，是
   * 多一道 realpath 校验：`resolveInlineTarget` 那层字符串校验挡的是 `../`、绝对路径、
   * 扩展名——挡不住符号链接（文件名带白名单扩展名、字符串上一眼在目录树内，
   * 实际指向树外任意文件）。readBytes 用的 `fsp.stat`/`fsp.readFile` 默认跟随符号链接，
   * 单纯的字符串校验拦不住这个向量。
   *
   * base 与 target 都要 realpath：base 自己也可能是符号链接（比如项目目录本身），
   * 只 realpath target 不 realpath base 会把「两边都是符号链接、实际互相在彼此
   * 真实位置内」的合法情况也拒了。
   *
   * TOCTOU：两次 realpath 之间没有让出点，这一段确实原子。但 isWithin 通过之后
   * 调的 `this.readBytes` 内部还有独立的 `await fsp.stat` / `await fsp.readFile`——
   * realpath 解析完成到真正读取之间仍有两次 await，理论上本地有写权限的攻击者
   * 能在这个窗口把 realTarget 指向的文件换掉，窗口很窄（几个微任务）但不是零。
   * 在「本地单用户桌面应用」的威胁模型下判定为可接受，且不比引入这个 RPC 之前更差
   * （readBytes 本来就没有原子性保证）。要彻底消除得换成 `O_NOFOLLOW` 打开或者
   * 先开 fd 再 fstat，目前没做。
   */
  async readBytesWithin(
    { baseDir, path: target }: { baseDir: string; path: string },
  ): Promise<{ bytes: Uint8Array<ArrayBuffer> }> {
    let realBase: string;
    try {
      realBase = await fsp.realpath(baseDir);
    } catch (err) {
      throw new KydogError('fs.read_failed', `无法解析目录 ${baseDir}`, err);
    }
    let realTarget: string;
    try {
      realTarget = await fsp.realpath(target);
    } catch (err) {
      throw new KydogError('fs.read_failed', `无法读取 ${target}`, err);
    }
    if (!isWithin(realBase, realTarget)) {
      throw new KydogError('fs.access_denied', `${target} 不在 ${baseDir} 目录树内`);
    }
    return this.readBytes({ path: realTarget });
  },

  async writeText({ path, content }: { path: string; content: string }): Promise<void> {
    try {
      await atomicWrite(path, content);
    } catch (err) {
      throw new KydogError('fs.write_failed', `无法写入 ${path}`, err);
    }
  },
};
