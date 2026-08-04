// src/main/research/researchEnv.ts
import type { SettingsFile } from '../../shared/types';
import { normalizeResearch, validateResearch } from '../../shared/researchValidate';
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
 *
 * 过滤按名字而非按条目：同一个变量名只要有任何一个条目非法（比如自定义项
 * 与预设重名、或两个自定义项重名），该名字下的所有条目都不写入。这是有意
 * 的 —— 配置说同一个环境变量有两个互相矛盾的值时，拒绝猜比随便挑一个安全。
 * 正常路径下构造不出这种状态（UI 录入时 validateCustomVarName 会拦，
 * research.save 会整单拒绝），只有手改 kydog.json 才会触发。
 *
 * 入参先过 normalizeResearch 再校验：这里吃的是磁盘原始值（main.ts 启动时
 * 直接传 settingsService.get() 的结果，未经 research.save 那关），custom
 * 数组里可能混入 null（手改 kydog.json，或 JSON.stringify 把数组空洞序列化
 * 成 null）。不 normalize 就直接访问 c.name 会在启动必经路径上抛错，把整个
 * 应用挡在门外——比忽略一条脏数据严重得多。
 */
export function applyResearchEnv(input: SettingsFile['research']): void {
  const research = normalizeResearch(input);
  const errors = validateResearch(research);
  const bad = new Set(errors.map((e) => e.field));
  if (errors.length > 0) {
    logger.warn('research.env', 'skipping invalid entries', {
      errors: errors.map((e) => `${e.field}: ${e.message}`),
    });
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
