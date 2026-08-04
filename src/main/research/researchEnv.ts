// src/main/research/researchEnv.ts
import type { SettingsFile } from '../../shared/types';
import { validateResearch } from '../../shared/researchValidate';
import { logger } from '../log';

/** KyDog 首次接管某变量时它的原始值。只记第一次 —— 这才是「启动时的环境值」。 */
const ambient = new Map<string, string | undefined>();
/** 上一轮真正写进 process.env 的变量名。 */
let lastApplied = new Set<string>();

/**
 * 把文献检索密钥写进 process.env。
 *
 * 语义是 fallback 而不是接管（对比 llm/cloudEnvSync.ts 的先全清再写）：
 * 用户可能已经在 shell profile 里配好了同名变量，一个没填的表单不该抹掉它。
 * 因此清空某项时恢复到 ambient 快照，只有 ambient 本身不存在才 delete。
 *
 * 快照是惰性的（写之前才记）：自定义变量名在启动时还不知道，等真要写它
 * 的那一刻再记，覆盖面与「按固定名单统一快照」等价。
 */
export function applyResearchEnv(research: SettingsFile['research']): void {
  const bad = new Set(validateResearch(research).map((e) => e.field));
  if (bad.size > 0) {
    logger.warn('research.env', 'skipping invalid entries', { fields: [...bad] });
  }

  const desired = new Map<string, string>();
  for (const [name, value] of Object.entries(research.presets ?? {})) {
    if (value && !bad.has(name)) desired.set(name, value);
  }
  for (const c of research.custom ?? []) {
    if (c.value && !bad.has(c.name)) desired.set(c.name, c.value);
  }

  for (const name of lastApplied) {
    if (desired.has(name)) continue;
    const orig = ambient.get(name);
    if (orig === undefined) delete process.env[name];
    else process.env[name] = orig;
  }

  for (const [name, value] of desired) {
    if (!ambient.has(name)) ambient.set(name, process.env[name]);
    process.env[name] = value;
  }

  lastApplied = new Set(desired.keys());
}

/** 仅测试用：清掉模块级快照与上一轮记录。 */
export function __resetResearchEnvForTest(): void {
  ambient.clear();
  lastApplied = new Set();
}
