/** @ 引用的排序（spec §3.5）。纯函数；路径是相对项目根、`/` 分隔的。 */

function basenameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function isSubsequence(q: string, s: string): boolean {
  let j = 0;
  for (let i = 0; i < s.length && j < q.length; i++) if (s[i] === q[j]) j++;
  return j === q.length;
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
