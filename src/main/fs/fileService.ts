import { promises as fsp } from 'node:fs';
import { atomicWrite } from '../persist/atomicWrite';
import { KydogError } from '../../shared/errors';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 100 * 1024 * 1024;

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

  async writeText({ path, content }: { path: string; content: string }): Promise<void> {
    try {
      await atomicWrite(path, content);
    } catch (err) {
      throw new KydogError('fs.write_failed', `无法写入 ${path}`, err);
    }
  },
};
