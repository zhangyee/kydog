import { KydogError } from '../../shared/errors';
import type { IdpEntry } from '../../shared/types';

/**
 * CARSI 机构清单的解析。**纯函数，只吃已经解成字符串的文本** —— 抓取与按 charset
 * 解码在 `main/institution/institutionService.ts`（`fetchIdpList` / `decodeByCharset`）。
 * 这条分工是有意的：字节怎么变成字符是协议层的事（响应头说了算），这里不该再猜一次。
 *
 * 每个 SP 自带一份清单，**不存在一份全局 CARSI 清单**。CNKI 的接口是
 * `GET https://fsso.cnki.net/idp/list?federation=2`，返回
 * `[{"<机构名>":"<值>"}, …]`。
 *
 * 实测（2026-09-08 首测，2026-09-09 复测同样的数）有两种值格式，且两种都要吃下：
 * - `federation=2`：`"<标志>|<entityID>"`，1064 条 / 938 个不同 entityID，
 *   标志是 "1"×1045 / "0"×19，另有 2 条缺冒号的坏 entityID（`https//…`）
 * - `federation=1`：裸 entityID，没有前缀，且**可能是 URN 不是 URL**（90 条）
 */

export type SkippedIdp = { name: string; raw: string; reason: string };

export type IdpListResult = {
  entries: IdpEntry[];
  skipped: SkippedIdp[];
  /**
   * 同名但 entityID 不同的机构名。
   *
   * 名字不是唯一键（实测 1064 个机构只有 938 个不同 entityID）。同名不同 ID 在设置页的
   * 下拉里就是**两行一模一样的文字**：用户选错一条，登录在 IdP 那边失败，界面无从解释。
   * 解析层看得见这件事，报出来让调用方能消歧（加后缀、并排显示 host 都行）。
   *
   * 同名**同** entityID 不算 —— 选哪条都通向同一套认证。
   */
  ambiguousNames: string[];
  /**
   * 撞到上限之后被丢掉的条数。**大于 0 时这两个数组就是不完整的，调用方必须说出口** ——
   * 静默截断会让「这个源只有这些机构」和「我只给你看了这些」长得一样。
   */
  dropped: { entries: number; skipped: number };
};

/**
 * 两个数组各自的上限。**这份清单来自网络**：端点异常返回几十万条时，两个数组连同
 * 每条的 `raw` 会全构造出来留在主进程内存里。实测真实清单 1064 条、跳过 2 条，
 * 这两个数留了足够余量。
 *
 * 挡不住的那一头写在这里免得下一个人以为挡住了：`JSON.parse` 已经把整份响应
 * 物化成了对象，真正的字节上限属于抓取那一侧（响应体大小），不在这个纯函数里。
 */
export const MAX_IDP_ENTRIES = 5_000;
export const MAX_IDP_SKIPPED = 500;

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
  catch { throw new KydogError('institution.idp_list_invalid', '机构清单不是合法 JSON'); }
  // 整份形状不对要抛错，不能返回空清单：空清单在界面上等于「这个 SP 一个机构都没有」，
  // 而真相是我们没读懂它 —— 两件事不能长得一样。
  if (!Array.isArray(parsed)) throw new KydogError('institution.idp_list_invalid', '机构清单不是数组');

  const entries: IdpEntry[] = [];
  const skipped: SkippedIdp[] = [];
  const dropped = { entries: 0, skipped: 0 };
  // 撞到上限之后只数数、不再构造对象（尤其是每条都带一份 raw）。
  const keep = (e: IdpEntry) => {
    if (entries.length >= MAX_IDP_ENTRIES) { dropped.entries += 1; return; }
    entries.push(e);
  };
  const skip = (name: string, raw: string, reason: string) => {
    if (skipped.length >= MAX_IDP_SKIPPED) { dropped.skipped += 1; return; }
    skipped.push({ name, raw, reason });
  };

  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skip('', String(item), '不是一个 {机构名: 值} 对象');
      continue;
    }
    const keys = Object.keys(item as Record<string, unknown>);
    if (keys.length === 0) { skip('', '{}', '空对象'); continue; }

    for (const key of keys) {
      const name = key.trim();
      const value = (item as Record<string, unknown>)[key];
      if (typeof value !== 'string' || value === '') {
        skip(name, String(value), '值不是非空字符串');
        continue;
      }
      if (name === '') { skip('', value, '机构名为空'); continue; }

      // "<标志>|<entityID>" 与裸 entityID 两种格式。标志的含义未知（实测 0/1 两种值，
      // "0" 里既有 985 也有中科院所）——**不知道含义就不拿它过滤**：猜错会让用户在
      // 列表里找不到自己的学校，而且不报任何错。但它是源接口给的**协议层事实**，
      // spec §4.6 说的是「一期不拿它过滤」不是「不保留它」，所以带上来。
      //
      // **只剥开头那个 `0|` / `1|`**，不是「第一个 | 之前全切掉」：entityID 自己可以
      // 带竖线（`https://idp.x.edu/sso?a=1|2`），按后者剥会切成 "2"，然后以
      // 「entityID 既不是网址也不是 URN：2」被跳过 —— 把解析器的 bug 记成数据的错。
      const m = /^([01])\|/.exec(value);
      const flag = m ? m[1] : null;
      const entityID = (m ? value.slice(m[0].length) : value).trim();

      if (!isUsableEntityId(entityID)) {
        // 官方数据里真有两条缺冒号的（新疆工业学院、广东金融学院）。跳过，但要留下
        // 可见的原因 —— 静默丢会让那两个学校的用户永远不知道为什么找不到自己。
        skip(name, value, `entityID 既不是 http(s) 网址也不是 URN：${entityID}`);
        continue;
      }
      // 同一个 entityID 可以被多个机构共用（中科院那 127 家），全部保留。
      keep({ name, entityID, flag });
    }
  }

  // 「读到了 N 条、一条都没留下」与「这个源真的一条都没有」**不能长得一样**。
  // 前者的真相是我们没读懂它（SP 换了值的形状就会这样），而它在界面上会变成一个
  // 空白的机构选择器 —— 与后者完全同形。这与文件开头「整份形状不对要抛错」是
  // 同一条规矩，只是那句话原先只覆盖了整份形状不对的情形。
  const seen = entries.length + skipped.length + dropped.entries + dropped.skipped;
  if (seen > 0 && entries.length === 0) {
    const why = skipped.slice(0, 3).map((x) => x.reason).join('；');
    throw new KydogError('institution.idp_list_invalid',
      `机构清单读到 ${seen} 条，一条都没能用上 —— 多半是这个接口换了值的形状。${why ? `前几条的原因：${why}` : ''}`);
  }

  const byName = new Map<string, Set<string>>();
  for (const e of entries) {
    const ids = byName.get(e.name) ?? new Set<string>();
    ids.add(e.entityID);
    byName.set(e.name, ids);
  }
  const ambiguousNames = [...byName].filter(([, ids]) => ids.size > 1).map(([n]) => n);

  return { entries, skipped, ambiguousNames, dropped };
}
