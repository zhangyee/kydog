import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger, flushLog } from './log';

/**
 * **跑测试时 logger 绝不写开发者真实的 ~/.kydog**（2026-09-14 修的 bug）。
 *
 * `log.ts` 在模块加载那一刻用 `os.homedir()` 算出日志路径，不经过 `paths.ROOT` —— 所以
 * 测试里 `vi.spyOn(paths, 'ROOT', 'get')` 管不到它，每一次 `logger.*` 都写进真实的
 * `~/.kydog/logs/main.log`。实测后果：用户真实日志里混进上千条夹具产生的假 error
 * （`Error: boom` 之类），排查真实故障时被它误导；日志又只留一代备份，测试把它写满一次，
 * 上一份真实备份就被覆盖掉。
 *
 * 修法在 `vitest.config.ts`：测试进程的 HOME / USERPROFILE 指到一个临时目录，
 * `os.homedir()` 因此返回它。这条用例守的是：重定向真的生效了，而且 logger 真的写到了那里。
 *
 * **真实主目录用 `os.userInfo().homedir` 取**：它读系统账户记录，不看 HOME 环境变量
 * （实测：HOME 指到临时目录时 `os.homedir()` 跟着变，`os.userInfo().homedir` 不变）。
 */

/** 正向与否定两半共用同一个路径拼法：拼错了正向那半先红，不会让否定那半白绿。 */
const logUnder = (home: string, file = 'main.log') => path.join(home, '.kydog', 'logs', file);

afterEach(() => { vi.restoreAllMocks(); });

describe('测试期间 logger 不写真实主目录', () => {
  it('logger 写进被重定向的主目录；真实主目录下的日志里没有这一笔', async () => {
    const realHome = os.userInfo().homedir;
    expect(path.isAbsolute(realHome)).toBe(true);
    // 重定向必须在 log.ts 被 import 之前就生效 —— 它在模块加载时就算好了路径。
    // 这一句排在写入之前：没生效时在这里就红，不会再往真实日志里写一笔。
    expect(os.homedir()).not.toBe(realHome);

    // logger 会把同一行打到控制台，压掉，免得污染测试输出。
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const probe = `log-home-guard-${randomUUID()}`;
    logger.warn('test.guard', probe);
    await flushLog();

    // 正向前置（同一条用例里）：这一笔确实落盘了，而且落在被重定向的主目录下。
    expect(await fs.readFile(logUnder(os.homedir()), 'utf8')).toContain(probe);

    // 否定：真实主目录下的日志（含轮转出去的那一代）里没有这一笔。
    for (const file of ['main.log', 'main.log.1']) {
      const text = await fs.readFile(logUnder(realHome, file), 'utf8').catch(() => '');
      expect(text).not.toContain(probe);
    }
  });
});
