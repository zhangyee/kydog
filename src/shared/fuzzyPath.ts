/** @ 引用的排序（spec §3.5）。纯函数；路径是相对项目根、`/` 分隔的。 */

function basenameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** 贪心地逐个找查询里的字（最早的匹配就是最优的）；用原生 indexOf 找，比逐字比较的循环快得多。 */
function isSubsequence(q: string, s: string): boolean {
  let from = 0;
  for (let k = 0; k < q.length; k++) {
    const at = s.indexOf(q[k], from);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}

function tierOf(pathLower: string, baseLower: string, q: string): number {
  if (baseLower.startsWith(q)) return 0;
  if (baseLower.includes(q)) return 1;
  if (pathLower.includes(q)) return 2;
  if (isSubsequence(q, baseLower)) return 3;
  if (isSubsequence(q, pathLower)) return 4;
  return -1;
}

const depthOf = (p: string): number => p.split('/').length;
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 排序的**定义**：分档（文件名开头 > 文件名连续包含 > 路径连续包含 > 文件名子序列 > 路径子序列，
 * 都不中的排除）→ 路径长度 → 字典序；空查询 → 目录深度 → 字典序。
 *
 * 每次都把全部路径重新小写、整体排序 —— 大项目上太慢（100 万条路径空查询 2.7s、查 `d` 443ms，
 * 全卡在主进程上）。线上走下面的 `buildPathIndex` + `searchPathIndex`；这个函数留作语义的参照，
 * `fuzzyPath.test.ts` 的等价性用例把两者钉在一起 —— 改排序规则就两边一起改。
 */
export function rankPaths(paths: readonly string[], query: string, limit = 50): string[] {
  const q = query.toLowerCase();
  if (q === '') return [...paths].sort((a, b) => depthOf(a) - depthOf(b) || byText(a, b)).slice(0, limit);
  const scored: Array<{ p: string; t: number }> = [];
  for (const p of paths) {
    const t = tierOf(p.toLowerCase(), basenameOf(p).toLowerCase(), q);
    if (t >= 0) scored.push({ p, t });
  }
  scored.sort((a, b) => a.t - b.t || a.p.length - b.p.length || byText(a.p, b.p));
  return scored.slice(0, limit).map((s) => s.p);
}

/** 扫完一趟就算好的东西：每条路径的小写全路径、小写文件名、目录深度，外加空查询的前若干名。 */
export type PathIndex = {
  readonly paths: readonly string[];
  readonly lower: readonly string[];
  readonly baseLower: readonly string[];
  readonly depth: Uint32Array;
  /** 空查询的前 `EMPTY_TOP` 名（深度 → 字典序）。 */
  readonly emptyTop: readonly string[];
};

/** 空查询预先算好几名：与 @ 结果上限一致（Global Constraints：50）。 */
const EMPTY_TOP = 50;

/**
 * 有界的前 k 名：一趟扫过去，只留最好的 k 个（从好到坏排好）。不对全部候选排序 —— 绝大多数候选
 * 只跟当前第 k 名比一次就被丢掉。先比 `primary`（小的好；负数 = 不要这一条），相等再比 `tie`。
 * 新来的排在与它完全相等的之后，与稳定排序同序。
 */
function topK(n: number, k: number, primary: (i: number) => number, tie: (a: number, b: number) => number): number[] {
  const idx: number[] = [];
  const key: number[] = [];
  if (k <= 0) return idx;
  for (let i = 0; i < n; i++) {
    const p = primary(i);
    if (p < 0) continue;
    if (idx.length === k && (p - key[k - 1] || tie(i, idx[k - 1])) >= 0) continue;
    let lo = 0;
    let hi = idx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((p - key[mid] || tie(i, idx[mid])) < 0) hi = mid; else lo = mid + 1;
    }
    idx.splice(lo, 0, i);
    key.splice(lo, 0, p);
    if (idx.length > k) { idx.pop(); key.pop(); }
  }
  return idx;
}

function emptyQueryTop(index: Omit<PathIndex, 'emptyTop'>, k: number): string[] {
  const { paths, depth } = index;
  return topK(paths.length, k, (i) => depth[i], (a, b) => byText(paths[a], paths[b])).map((i) => paths[i]);
}

/** 扫完一趟时调一次：把每条路径要用的小写串与深度算好，查询时不再逐条 `toLowerCase` / `split`。 */
export function buildPathIndex(paths: readonly string[]): PathIndex {
  const n = paths.length;
  const lower = new Array<string>(n);
  const baseLower = new Array<string>(n);
  const depth = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const p = paths[i];
    lower[i] = p.toLowerCase();
    baseLower[i] = basenameOf(p).toLowerCase();
    let d = 1;
    for (let j = p.indexOf('/'); j !== -1; j = p.indexOf('/', j + 1)) d++;
    depth[i] = d; // 与 depthOf 的 split('/').length 相同
  }
  const base = { paths, lower, baseLower, depth };
  return { ...base, emptyTop: emptyQueryTop(base, EMPTY_TOP) };
}

/** 与 `rankPaths(index.paths, query, limit)` 结果逐条相同（等价性用例守着），但只扫一趟、不整体排序。 */
export function searchPathIndex(index: PathIndex, query: string, limit = 50): string[] {
  const q = query.toLowerCase();
  const { paths, lower, baseLower } = index;
  if (q === '') {
    if (limit <= index.emptyTop.length || index.emptyTop.length === paths.length) return index.emptyTop.slice(0, Math.max(0, limit));
    return emptyQueryTop(index, limit);
  }
  return topK(
    paths.length, limit,
    (i) => tierOf(lower[i], baseLower[i], q),
    (a, b) => paths[a].length - paths[b].length || byText(paths[a], paths[b]),
  ).map((i) => paths[i]);
}
