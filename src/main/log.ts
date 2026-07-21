import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SECRET_KEYS = new Set(['apikey', 'authorization', 'password', 'token', 'secret', 'cookie', 'set-cookie']);

export function redactSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value instanceof Uint8Array) return '[Bytes]';
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map(v => redactSecrets(v, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactSecrets(v, seen);
    }
    return out;
  }
  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): Level {
  const raw = (process.env.KYDOG_LOG ?? 'info').toLowerCase();
  return (raw in LEVELS ? raw : 'info') as Level;
}

// 串行写 + size-cap 轮换：超过 maxSize 时 rename 成 <file>.1（只留一代）。
// appendFile 每次按路径打开，rename 后下一笔写入自动新建空文件，无需重开流。
export function createLogSink(file: string, maxSize: number) {
  let approxSize = -1; // -1 = 未初始化，首笔写入时从磁盘 stat
  let queue = Promise.resolve();
  return {
    write(line: string): Promise<void> {
      queue = queue.then(async () => {
        if (approxSize < 0) {
          await fs.mkdir(path.dirname(file), { recursive: true });
          approxSize = await fs.stat(file).then(s => s.size, () => 0);
        }
        if (approxSize > maxSize) {
          await fs.rename(file, file + '.1').catch(() => {});
          approxSize = 0;
        }
        await fs.appendFile(file, line + '\n', 'utf8');
        approxSize += Buffer.byteLength(line) + 1;
      }).catch(() => {});
      return queue;
    },
  };
}

const logFile = path.join(os.homedir(), '.kydog', 'logs', 'main.log');
const sink = createLogSink(logFile, 2 * 1024 * 1024);

function emit(level: Level, scope: string, msg: string, ctx?: unknown) {
  if (LEVELS[level] < LEVELS[envLevel()]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(ctx === undefined ? {} : { ctx: redactSecrets(ctx) }),
  });
  console[level === 'debug' ? 'log' : level](line);
  void sink.write(line);
}

export const logger = {
  debug: (scope: string, msg: string, ctx?: unknown) => emit('debug', scope, msg, ctx),
  info:  (scope: string, msg: string, ctx?: unknown) => emit('info', scope, msg, ctx),
  warn:  (scope: string, msg: string, ctx?: unknown) => emit('warn', scope, msg, ctx),
  error: (scope: string, msg: string, ctx?: unknown) => emit('error', scope, msg, ctx),
};
