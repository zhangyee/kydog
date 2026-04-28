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

const logDir = path.join(os.homedir(), '.kydog', 'logs');
const logFile = path.join(logDir, 'main.log');
let dirEnsured = false;

async function ensureDir() {
  if (dirEnsured) return;
  await fs.mkdir(logDir, { recursive: true });
  dirEnsured = true;
}

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
  void ensureDir().then(() => fs.appendFile(logFile, line + '\n', 'utf8')).catch(() => {});
}

export const logger = {
  debug: (scope: string, msg: string, ctx?: unknown) => emit('debug', scope, msg, ctx),
  info:  (scope: string, msg: string, ctx?: unknown) => emit('info', scope, msg, ctx),
  warn:  (scope: string, msg: string, ctx?: unknown) => emit('warn', scope, msg, ctx),
  error: (scope: string, msg: string, ctx?: unknown) => emit('error', scope, msg, ctx),
};
