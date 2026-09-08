import { KydogError } from '../../shared/errors';
import type { IdpEntry } from '../../shared/types';

/**
 * CARSI 机构清单的解析。纯函数 —— 抓取在 browserService 里做。
 *
 * 每个 SP 自带一份清单，**不存在一份全局 CARSI 清单**。CNKI 的接口是
 * `GET https://fsso.cnki.net/idp/list?federation=2`，返回
 * `[{"<机构名>":"<值>"}, …]`。
 *
 * 实测（2026-09-08，1064 条）有两种值格式，且两种都要吃下：
 * - `federation=2`：`"<标志>|<entityID>"`，标志实测是 "1"×1045 / "0"×19
 * - `federation=1`：裸 entityID，没有前缀，且**可能是 URN 不是 URL**
 */

export type SkippedIdp = { name: string; raw: string; reason: string };
export type IdpListResult = { entries: IdpEntry[]; skipped: SkippedIdp[] };

/** entityID 要么是 http(s) URL，要么是 URN。其余一律当坏数据。 */
function isUsableEntityId(v: string): boolean {
  if (v.startsWith('urn:')) return v.length > 'urn:'.length;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

export function parseIdpList(raw: string): IdpListResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new KydogError('skill.invalid', '机构清单不是合法 JSON'); }
  // 整份形状不对要抛错，不能返回空清单：空清单在界面上等于「这个 SP 一个机构都没有」，
  // 而真相是我们没读懂它 —— 两件事不能长得一样。
  if (!Array.isArray(parsed)) throw new KydogError('skill.invalid', '机构清单不是数组');

  const entries: IdpEntry[] = [];
  const skipped: SkippedIdp[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skipped.push({ name: '', raw: String(item), reason: '不是一个 {机构名: 值} 对象' });
      continue;
    }
    const keys = Object.keys(item as Record<string, unknown>);
    if (keys.length === 0) { skipped.push({ name: '', raw: '{}', reason: '空对象' }); continue; }

    for (const key of keys) {
      const name = key.trim();
      const value = (item as Record<string, unknown>)[key];
      if (typeof value !== 'string' || value === '') {
        skipped.push({ name, raw: String(value), reason: '值不是非空字符串' });
        continue;
      }
      if (name === '') { skipped.push({ name: '', raw: value, reason: '机构名为空' }); continue; }

      // "<标志>|<entityID>" 与裸 entityID 两种格式。标志的含义未知（实测 0/1 两种值，
      // "0" 里既有 985 也有中科院所）——**不知道含义就不拿它过滤**：猜错会让用户在
      // 列表里找不到自己的学校，而且不报任何错。这里只把它切掉。
      const bar = value.indexOf('|');
      const entityID = bar === -1 ? value.trim() : value.slice(bar + 1).trim();

      if (!isUsableEntityId(entityID)) {
        // 官方数据里真有两条缺冒号的（新疆工业学院、广东金融学院）。跳过，但要留下
        // 可见的原因 —— 静默丢会让那两个学校的用户永远不知道为什么找不到自己。
        skipped.push({ name, raw: value, reason: `entityID 既不是 http(s) 网址也不是 URN：${entityID}` });
        continue;
      }
      // 同一个 entityID 可以被多个机构共用（中科院那 127 家），全部保留。
      entries.push({ name, entityID });
    }
  }
  return { entries, skipped };
}
