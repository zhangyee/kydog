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
   * 真实位置内」的合法情况也拒了。两次 realpath + 一次读取在同一个异步函数里
   * 一次性做完，没有先查再读之间的 TOCTOU 窗口（两次 fs 调用之间没有让出到别的
   * 请求能改写这个路径的机会——Node 单线程事件循环，中间没有 await 边界之外的
   * 代码能插进来改这两个路径指向的文件系统状态）。
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
