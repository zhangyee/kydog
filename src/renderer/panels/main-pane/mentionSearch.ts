/**
 * @ 列表的一次弹出 = 一个会话（spec §3.5 v2）。纯逻辑：读目录的函数由调用方注入 —— Composer 传
 * `project.readDir`（与文件树同一套过滤与排序），单测传假目录树。
 *
 * 两种模式，按查询词判（`parseMentionQuery`）：
 * - **逐级浏览**（空、或含 `/`）：只读 `/` 之前那一个目录，按 `/` 之后的筛选词筛这一层。
 * - **按名字找**（非空、不含 `/`）：先出根目录这一层（文件夹也算，便于进入），同时从浅到深一层层往下读，
 *   名字命中的**文件**随读随进列表，取前 `limit` 名。
 *
 * 读过的目录记在会话内存里；换查询词只在已读的内容里重筛，往下读的进度接着走；逐级浏览时暂停往下读。
 * **整个会话同一时间只有一个 readDir 在飞。** 不设文件数上限、不设时限、不跨会话缓存 —— 唯一的边界是
 * 「列表开着」：Composer 在列表关掉时 `dispose()`，之后不再读、不再报。
 */

export type MentionEntry = { rel: string; name: string; kind: 'file' | 'dir'; depth: number };
export type MentionView = { mode: 'browse' | 'name'; items: MentionEntry[]; done: boolean };
export type ReadDirFn = (absPath: string) => Promise<Array<{ name: string; path: string; kind: 'file' | 'dir' }>>;
export type ParsedMentionQuery =
  | { mode: 'browse'; dir: string; leaf: string }
  | { mode: 'name'; leaf: string }
  | { mode: 'invalid' };
export type MentionSession = { setQuery(q: string): void; dispose(): void };

/** @ 结果上限（Global Constraints）。只截按名字找的结果；逐级浏览列这一层全部。 */
const DEFAULT_LIMIT = 50;

/**
 * 查询词 → 模式。含 `..` 段、以 `/` `\` 或盘符开头的不列（只在项目内浏览）—— `..` 按 `/` 与 `\` 两种
 * 分隔都查一遍：Windows 上路径按 `\` 拼，`a\..\..` 这种段一样会越出项目。空段与 `.` 段不改变目录。
 */
export function parseMentionQuery(q: string): ParsedMentionQuery {
  if (/^[\\/]/.test(q) || /^[A-Za-z]:/.test(q)) return { mode: 'invalid' };
  if (q.split(/[\\/]/).includes('..')) return { mode: 'invalid' };
  if (q !== '' && !q.includes('/')) return { mode: 'name', leaf: q };
  const segs = q.split('/');
  const leaf = segs.pop() ?? '';
  return { mode: 'browse', dir: segs.filter((s) => s !== '' && s !== '.').join('/'), leaf };
}

/** 贪心地逐个找查询里的字（最早的匹配就是最优的）。 */
function isSubsequence(q: string, s: string): boolean {
  let from = 0;
  for (let k = 0; k < q.length; k++) {
    const at = s.indexOf(q[k], from);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}

/** 分档（小的好）：名字以筛选词开头 0 > 连续包含 1 > 子序列 2；都不中 -1。两个参数都已小写。 */
function tierOf(nameLower: string, leafLower: string): number {
  if (nameLower.startsWith(leafLower)) return 0;
  if (nameLower.includes(leafLower)) return 1;
  if (isSubsequence(leafLower, nameLower)) return 2;
  return -1;
}

type Item = { entry: MentionEntry; lower: string };
/** 一个读过的目录：`items` 是 readDir 给的次序；`byKind` 是「文件夹在前、再按名字」，筛选时才算、算一次。 */
type Listing = { items: Item[]; byKind: Item[] | null } | 'failed';
type Ranked = { item: Item; tier: number };

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 按名字找的次序：档 > 深度浅 > 路径短 > 字母序。 */
function compareRanked(a: Ranked, b: Ranked): number {
  const ea = a.item.entry;
  const eb = b.item.entry;
  return a.tier - b.tier || ea.depth - eb.depth || ea.rel.length - eb.rel.length || byText(ea.rel, eb.rel);
}

function sameView(a: MentionView, b: MentionView): boolean {
  return a.mode === b.mode && a.done === b.done
    && a.items.length === b.items.length && a.items.every((x, i) => x === b.items[i]);
}

export function createMentionSession(opts: {
  /** 项目的绝对路径。 */
  projectPath: string;
  readDir: ReadDirFn;
  onChange: (view: MentionView) => void;
  limit?: number;
}): MentionSession {
  const { projectPath, readDir, onChange } = opts;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  // 读目录的路径一律是「项目路径 + / + rel」：不从项目路径猜分隔符 —— Node 在 Windows 上也认 `/`，
  // 主进程 readDir 再用 path.join 拼子项。rel 只由 readDir 给的名字拼出来（`父 rel/名字`）。
  const absOf = (rel: string) => (rel === '' ? projectPath : `${projectPath}/${rel}`);

  const listings = new Map<string, Listing>();
  let inFlight = false;
  // 按名字找的 BFS：队列里是待处理目录的 rel，`head` 之前的都已处理（进了 pool、子目录进了队列）。
  const queue: string[] = [''];
  let head = 0;
  // 按名字找的候选：根这一层的全部条目 + 更深各层的文件。
  const pool: Item[] = [];
  // 当前筛选词下的前 `limit` 名（有序）。`topLeaf` 是它对应的小写筛选词，null = 还没算过。
  let top: Ranked[] = [];
  let topLeaf: string | null = null;

  let query: string | null = null;
  let parsed: ParsedMentionQuery | null = null;
  let emitted: MentionView | null = null;
  let disposed = false;

  function consider(item: Item) {
    if (topLeaf === null || limit <= 0) return;
    const tier = tierOf(item.lower, topLeaf);
    if (tier < 0) return;
    const r = { item, tier };
    if (top.length === limit && compareRanked(r, top[limit - 1]) >= 0) return;
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareRanked(r, top[mid]) < 0) hi = mid; else lo = mid + 1;
    }
    top.splice(lo, 0, r);
    if (top.length > limit) top.pop();
  }

  function rebuildTop(leafLower: string) {
    top = [];
    topLeaf = leafLower;
    for (const item of pool) consider(item);
  }

  function toListing(nodes: Awaited<ReturnType<ReadDirFn>>, parentRel: string): Listing {
    const depth = parentRel === '' ? 0 : parentRel.split('/').length;
    const items = nodes.map((n): Item => ({
      entry: { rel: parentRel === '' ? n.name : `${parentRel}/${n.name}`, name: n.name, kind: n.kind, depth },
      lower: n.name.toLowerCase(),
    }));
    return { items, byKind: null };
  }

  /** 逐级浏览：筛选词为空原样列出；否则按档分三桶，桶内沿用「文件夹在前、再按名字」的次序。 */
  function browseItems(listing: Exclude<Listing, 'failed'>, leaf: string): MentionEntry[] {
    if (leaf === '') return listing.items.map((i) => i.entry);
    listing.byKind ??= [...listing.items].sort((a, b) => (a.entry.kind === b.entry.kind
      ? a.entry.name.localeCompare(b.entry.name)
      : a.entry.kind === 'dir' ? -1 : 1));
    const q = leaf.toLowerCase();
    const buckets: MentionEntry[][] = [[], [], []];
    for (const item of listing.byKind) {
      const t = tierOf(item.lower, q);
      if (t >= 0) buckets[t].push(item.entry);
    }
    return buckets.flat();
  }

  /** 把已经读回来的、排在队首的目录依次处理掉（同步），直到碰上一个还没读的。 */
  function drainBfs() {
    while (head < queue.length) {
      const listing = listings.get(queue[head]);
      if (listing === undefined) return;
      const isRoot = head === 0;
      head++;
      if (listing === 'failed') continue;
      for (const item of listing.items) {
        if (item.entry.kind === 'dir') queue.push(item.entry.rel);
        if (isRoot || item.entry.kind === 'file') { pool.push(item); consider(item); }
      }
    }
  }

  function read(rel: string) {
    inFlight = true;
    let p: ReturnType<ReadDirFn>;
    try { p = readDir(absOf(rel)); } catch (err) { p = Promise.reject(err); }
    p.then(
      (nodes) => { if (!disposed) listings.set(rel, toListing(nodes, rel)); },
      () => { if (!disposed) listings.set(rel, 'failed'); },
    ).then(() => {
      if (disposed) return;
      inFlight = false;
      step();
    });
  }

  /** 这个查询词要的第一层还没读到时返回 null。 */
  function currentView(): MentionView | null {
    if (parsed === null) return null;
    if (parsed.mode === 'invalid') return { mode: 'browse', items: [], done: true };
    if (parsed.mode === 'browse') {
      const listing = listings.get(parsed.dir);
      if (listing === undefined) return null;
      if (listing === 'failed') return { mode: 'browse', items: [], done: true };
      return { mode: 'browse', items: browseItems(listing, parsed.leaf), done: true };
    }
    if (head === 0) return null;
    return { mode: 'name', items: top.map((r) => r.item.entry), done: head >= queue.length };
  }

  function emit() {
    if (parsed === null) return;
    let view = currentView();
    if (view === null) {
      // 第一次出结果之前什么都不报（列表不渲染，不先闪一下空的）；已经出过结果、又换到一个还没读的
      // 目录时，报一个「未读完、无结果」—— 不留着上一个查询词的结果让人按 ↵ 选走。
      if (emitted === null) return;
      view = { mode: parsed.mode === 'name' ? 'name' : 'browse', items: [], done: false };
    }
    if (emitted !== null && sameView(emitted, view)) return;
    emitted = view;
    onChange(view);
  }

  function step() {
    if (disposed || parsed === null) return;
    if (parsed.mode === 'name') {
      drainBfs();
      if (!inFlight && head < queue.length) read(queue[head]);
    } else if (parsed.mode === 'browse') {
      if (!inFlight && !listings.has(parsed.dir)) read(parsed.dir);
    }
    emit();
  }

  return {
    setQuery(q: string) {
      if (disposed || q === query) return;
      query = q;
      parsed = parseMentionQuery(q);
      if (parsed.mode === 'name') {
        const leafLower = parsed.leaf.toLowerCase();
        if (leafLower !== topLeaf) rebuildTop(leafLower);
      }
      step();
    },
    dispose() {
      disposed = true;
      listings.clear();
      pool.length = 0;
      top = [];
    },
  };
}
