import type { SettingsFile, ResearchVarKind } from './types';
import { PRESET_RESEARCH_VARS, PRESET_RESEARCH_VAR_NAMES } from './researchVars';
import { STATIC_META } from './apiKeyMeta';
import { MANAGED_VARS } from './managedCloudEnvVars';

export type ResearchValidationError = { field: string; message: string };

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f]/;

/**
 * 不允许被这一页写入的环境变量。三类：
 *  1. 云 provider 的 env —— 从 MANAGED_VARS 派生
 *  2. 进程关键变量 —— 只有这一类是字面量，因为它没有上游常量可派生
 *  3. LLM provider 的 key 变量 —— 从 STATIC_META 的 envFallback 派生
 *
 * 第 1、3 类刻意不抄一份副本：抄了就只能靠测试事后发现漂移，而派生让漂移
 * 在结构上就不可能发生。这也是 CLAUDE.md 那条原则的直接应用 —— 回到源头
 * 保留信号，而不是在下游补救。
 *
 * 第 3 类禁用的理由：ApiKeyForm 的 hint 明说「不填则自动 fallback 到环境变量
 * ANTHROPIC_API_KEY」，从这一页写进去会静默影响模型解析，而在「模型与提供商」
 * 页完全看不见 —— 等于给 LLM 凭证开了第二个真相来源。
 */
const PROCESS_CRITICAL_ENV_NAMES = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
] as const;

export const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set<string>([
  ...MANAGED_VARS,
  ...PROCESS_CRITICAL_ENV_NAMES,
  ...Object.values(STATIC_META).flatMap((m) => m.envFallback ?? []),
]);

/** trim 变量名与值；剔掉值为空的预设项（空 = 未设置）。自定义项一律保留条目。 */
export function normalizeResearch(r: SettingsFile['research']): SettingsFile['research'] {
  const presets: Record<string, string> = {};
  for (const [name, value] of Object.entries(r.presets ?? {})) {
    const v = (value ?? '').trim();
    if (v) presets[name.trim()] = v;
  }
  const custom = (r.custom ?? []).map((c) => ({
    name: (c.name ?? '').trim(),
    kind: c.kind,
    value: (c.value ?? '').trim(),
  }));
  return { presets, custom };
}

/** 单个自定义变量名的校验，供「+ 添加变量」就地反馈。合法返回 null。 */
export function validateCustomVarName(name: string, existing: string[]): string | null {
  if (!VAR_NAME_RE.test(name)) {
    return '变量名只能由字母、数字、下划线组成，且不能以数字开头';
  }
  if (PRESET_RESEARCH_VAR_NAMES.has(name)) return `${name} 已经是预设项，直接在上面填即可`;
  if (RESERVED_ENV_NAMES.has(name)) return `${name} 是保留变量名，不能在这里设置`;
  if (existing.includes(name)) return `${name} 已存在`;
  return null;
}

export function validateResearch(r: SettingsFile['research']): ResearchValidationError[] {
  const errors: ResearchValidationError[] = [];
  const kindOfPreset = new Map<string, ResearchVarKind>(PRESET_RESEARCH_VARS.map((v) => [v.name, v.kind]));

  for (const [name, value] of Object.entries(r.presets ?? {})) {
    if (!PRESET_RESEARCH_VAR_NAMES.has(name)) {
      errors.push({ field: name, message: `${name} 不是预设变量` });
      continue;
    }
    if (CONTROL_CHAR_RE.test(value)) {
      errors.push({ field: name, message: `${name} 的值含有换行或控制字符` });
      continue;
    }
    if (kindOfPreset.get(name) === 'email' && value && !EMAIL_RE.test(value)) {
      errors.push({ field: name, message: `${name} 不是合法的邮箱地址` });
    }
  }

  const seen: string[] = [];
  for (const c of r.custom ?? []) {
    const nameErr = validateCustomVarName(c.name, seen);
    if (nameErr) {
      errors.push({ field: c.name || '(空变量名)', message: nameErr });
      continue;
    }
    seen.push(c.name);
    if (CONTROL_CHAR_RE.test(c.value)) {
      errors.push({ field: c.name, message: `${c.name} 的值含有换行或控制字符` });
      continue;
    }
    if (c.kind === 'email' && c.value && !EMAIL_RE.test(c.value)) {
      errors.push({ field: c.name, message: `${c.name} 不是合法的邮箱地址` });
    }
  }

  return errors;
}
