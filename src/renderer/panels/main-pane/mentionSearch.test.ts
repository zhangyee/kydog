import { describe, it, expect } from 'vitest';
import { parseMentionQuery, createMentionSession, type MentionView, type ReadDirFn } from './mentionSearch';

/**
 * @ 列表的一次弹出（spec §3.5 v2）。假目录树 + 可控的 readDir：
 * - `dirs` 以相对项目根的目录为键（'' 是根），名字以 `/` 结尾的是文件夹；
 * - `manual: true` 时每次读都挂起，由用例 `release()` 一个个放行 —— 用来看「同一时间在飞几个」
 *   与「读到一半时换查询词」；否则在下一个微任务里就回来。
 * - 不在 `dirs` 里的目录、或列进 `fail` 的目录，读的时候抛错。
 */
function fakeFs(dirs: Record<string, string[]>, opts: { manual?: boolean; fail?: string[]; root?: string; sep?: string } = {}) {
  const root = opts.root ?? '/proj';
  const sep = opts.sep ?? '/';
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const relOf = (abs: string) => (abs === root ? '' : abs.slice(root.length + 1).split(sep).join('/'));
  const readDir: ReadDirFn = (abs) => {
    calls.push(abs);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const answer = () => {
      inFlight -= 1;
      const rel = relOf(abs);
      if ((opts.fail ?? []).includes(rel) || !(rel in dirs)) throw new Error(`cannot read ${abs}`);
      return dirs[rel].map((n) => {
        const isDir = n.endsWith('/');
        const name = isDir ? n.slice(0, -1) : n;
        return { name, path: `${abs}${sep}${name}`, kind: isDir ? 'dir' as const : 'file' as const };
      });
    };
    if (!opts.manual) return Promise.resolve().then(answer);
    return new Promise((res, rej) => {
      pending.push(() => { try { res(answer()); } catch (e) { rej(e); } });
    });
  };
  return {
    readDir, calls, pending,
    maxInFlight: () => maxInFlight,
    /** 放行最早挂起的那一次读，并让它的回调落地。 */
    release: async () => { pending.shift()!(); await settle(); },
  };
}

const settle = () => new Promise<void>((r) => { setTimeout(r, 0); });
const rels = (v: MentionView | undefined) => (v ? v.items.map((i) => i.rel) : null);

function start(fs: ReturnType<typeof fakeFs>, opts: { projectPath?: string; limit?: number } = {}) {
  const views: MentionView[] = [];
  const s = createMentionSession({ projectPath: opts.projectPath ?? '/proj', readDir: fs.readDir, onChange: (v) => views.push(v), limit: opts.limit });
  return { s, views, last: () => views[views.length - 1] };
}

describe('parseMentionQuery', () => {
  it('空、或含 / → 逐级浏览（/ 之前是目录、之后是这一层的筛选词）；非空且不含 / → 按名字找', () => {
    expect(parseMentionQuery('')).toEqual({ mode: 'browse', dir: '', leaf: '' });
    expect(parseMentionQuery('refs/')).toEqual({ mode: 'browse', dir: 'refs', leaf: '' });
    expect(parseMentionQuery('refs/dp')).toEqual({ mode: 'browse', dir: 'refs', leaf: 'dp' });
    expect(parseMentionQuery('a/b/c')).toEqual({ mode: 'browse', dir: 'a/b', leaf: 'c' });
    // 空段与 `.` 段不改变目录
    expect(parseMentionQuery('./refs//x')).toEqual({ mode: 'browse', dir: 'refs', leaf: 'x' });
    expect(parseMentionQuery('dpo')).toEqual({ mode: 'name', leaf: 'dpo' });
    // `..` 只在作为一整段时才算：名字里带两个点照常
    expect(parseMentionQuery('a..b')).toEqual({ mode: 'name', leaf: 'a..b' });
    expect(parseMentionQuery('..x/')).toEqual({ mode: 'browse', dir: '..x', leaf: '' });
  });

  it('含 .. 段、以 / 或 \\ 开头、以盘符开头 → 不列（只在项目内浏览）', () => {
    // 正向：同形状但合法的查询词都能解析（上一条用例之外，这里就地再证一次）
    expect(parseMentionQuery('x/y').mode).toBe('browse');
    expect(parseMentionQuery('C').mode).toBe('name');
    for (const q of ['..', '../', '../x', 'a/../b', 'a/..', 'a\\..\\b/', '/etc/', '/x', '\\x', '\\\\srv\\share', 'C:', 'C:/x', 'c:\\x']) {
      expect(parseMentionQuery(q), q).toEqual({ mode: 'invalid' });
    }
  });
});

describe('逐级浏览', () => {
  it('只读查询词指的那一个目录；筛选词为空时原样列出这一层（保持 readDir 的次序）；读完才出第一次结果', async () => {
    const fs = fakeFs({ '': ['zeta/', 'alpha.md', 'Beta.md'], zeta: ['deep.md'] }, { manual: true });
    const { s, views, last } = start(fs);
    s.setQuery('');
    expect(fs.calls).toEqual(['/proj']);
    // 自己这一层还没读回来：不出结果（列表因此不渲染，不会先闪一下空列表）
    expect(views).toHaveLength(0);
    await fs.release();
    expect(last()).toEqual({
      mode: 'browse', done: true,
      items: [
        { rel: 'zeta', name: 'zeta', kind: 'dir', depth: 0 },
        { rel: 'alpha.md', name: 'alpha.md', kind: 'file', depth: 0 },
        { rel: 'Beta.md', name: 'Beta.md', kind: 'file', depth: 0 },
      ],
    });
    // 只读了这一个目录：zeta 没被往下读
    expect(fs.calls).toEqual(['/proj']);
  });

  it('按档筛：开头 > 连续包含 > 子序列，大小写不敏感；同档文件夹在前、再按名字（不靠 readDir 的次序）', async () => {
    const fs = fakeFs({ lib: ['zzz.md', 'xdp.md', 'dpb.md', 'D_P.md', 'ydp/', 'pd.md', 'dpa.md', 'dp-notes/'] });
    const { s, last } = start(fs);
    s.setQuery('lib/');
    await settle();
    // 正向：下面被筛掉的 zzz.md / pd.md 确实在这一层里
    expect(rels(last())).toEqual(['zzz.md', 'xdp.md', 'dpb.md', 'D_P.md', 'ydp', 'pd.md', 'dpa.md', 'dp-notes'].map((n) => `lib/${n}`));
    s.setQuery('lib/dp');
    expect(rels(last())).toEqual(['dp-notes', 'dpa.md', 'dpb.md', 'ydp', 'xdp.md', 'D_P.md'].map((n) => `lib/${n}`));
    expect(last().done).toBe(true);
    s.setQuery('lib/DP');
    expect(rels(last())).toEqual(['dp-notes', 'dpa.md', 'dpb.md', 'ydp', 'xdp.md', 'D_P.md'].map((n) => `lib/${n}`));
    // 换筛选词只在读过的内容里重筛，不再读
    expect(fs.calls).toEqual(['/proj/lib']);
  });

  it('子目录：读 <项目>/<目录>，rel 带目录前缀、depth 按层数；同一会话里读过的目录不再读；空目录 → 空列表 + done', async () => {
    const fs = fakeFs({ '': ['refs/'], refs: ['dpo-2023.pdf', 'draft.pdf', 'old/'], 'refs/old': [] });
    const { s, last } = start(fs);
    s.setQuery('refs/');
    await settle();
    expect(fs.calls).toEqual(['/proj/refs']);
    expect(last()).toEqual({
      mode: 'browse', done: true,
      items: [
        { rel: 'refs/dpo-2023.pdf', name: 'dpo-2023.pdf', kind: 'file', depth: 1 },
        { rel: 'refs/draft.pdf', name: 'draft.pdf', kind: 'file', depth: 1 },
        { rel: 'refs/old', name: 'old', kind: 'dir', depth: 1 },
      ],
    });
    s.setQuery('refs/dr');
    expect(rels(last())).toEqual(['refs/draft.pdf']);
    s.setQuery('refs/old/');
    await settle();
    expect(last()).toEqual({ mode: 'browse', items: [], done: true });
    // 'd' 在 old 里是「连续包含」：同档文件夹在前，但档比两个开头命中的文件低
    s.setQuery('refs/d');
    expect(rels(last())).toEqual(['refs/dpo-2023.pdf', 'refs/draft.pdf', 'refs/old']);
    expect(fs.calls).toEqual(['/proj/refs', '/proj/refs/old']);
  });

  it('换到一个还没读的目录：先出一个「未读完、无结果」的视图（不留着上一层的结果），读完再出结果', async () => {
    const fs = fakeFs({ '': ['refs/', 'x.md'], refs: ['a.md'] }, { manual: true });
    const { s, last } = start(fs);
    s.setQuery('');
    await fs.release();
    expect(rels(last())).toEqual(['refs', 'x.md']);
    s.setQuery('refs/');
    expect(last()).toEqual({ mode: 'browse', items: [], done: false });
    await fs.release();
    expect(last()).toEqual({ mode: 'browse', items: [{ rel: 'refs/a.md', name: 'a.md', kind: 'file', depth: 1 }], done: true });
  });

  it('读不了的目录 → 空列表 + done', async () => {
    const fs = fakeFs({ '': ['ok/', 'bad/'], ok: ['a.md'] }, { fail: ['bad'] });
    const { s, last } = start(fs);
    s.setQuery('ok/');
    await settle();
    expect(last()).toMatchObject({ items: [{ rel: 'ok/a.md' }], done: true }); // 正向：能读的目录照常出结果
    s.setQuery('bad/');
    await settle();
    expect(fs.calls).toEqual(['/proj/ok', '/proj/bad']);
    expect(last()).toEqual({ mode: 'browse', items: [], done: true });
  });

  it('不合法的查询词：不读任何目录，直接出「读完、无结果」', async () => {
    const fs = fakeFs({ '': ['a.md'] });
    const { s, views, last } = start(fs);
    s.setQuery('../x');
    await settle();
    expect(views).toHaveLength(1);
    expect(last()).toEqual({ mode: 'browse', items: [], done: true });
    expect(fs.calls).toEqual([]);
    // 正向：同一个会话换成合法的查询词就照常读
    s.setQuery('');
    await settle();
    expect(fs.calls).toEqual(['/proj']);
    expect(rels(last())).toEqual(['a.md']);
  });

  it('Windows 项目：分隔符从项目路径推（含 \\），读 C:\\proj\\refs；rel 一律用 / 分隔', async () => {
    const fs = fakeFs({ '': ['refs/'], refs: ['dpo.pdf', 'sub/'], 'refs/sub': ['dpo-x.md'] }, { root: 'C:\\proj', sep: '\\' });
    const { s, last } = start(fs, { projectPath: 'C:\\proj' });
    s.setQuery('refs/');
    await settle();
    expect(fs.calls).toEqual(['C:\\proj\\refs']);
    expect(rels(last())).toEqual(['refs/dpo.pdf', 'refs/sub']);
    // 按名字找：从根往下读，refs 已经读过、用内存里的；refs/sub 用 readDir 给的绝对路径去读
    s.setQuery('dpo');
    await settle();
    expect(fs.calls).toEqual(['C:\\proj\\refs', 'C:\\proj', 'C:\\proj\\refs\\sub']);
    expect(last()).toEqual({
      mode: 'name', done: true,
      items: [
        { rel: 'refs/dpo.pdf', name: 'dpo.pdf', kind: 'file', depth: 1 },
        { rel: 'refs/sub/dpo-x.md', name: 'dpo-x.md', kind: 'file', depth: 2 },
      ],
    });
  });
});

describe('按名字找', () => {
  it('先出根目录这一层（文件夹也算）；再从浅到深一层层读（BFS），同一时间只有一个在飞；更深的文件夹不进列表；整棵树读完才 done', async () => {
    const fs = fakeFs({
      '': ['refs/', 'dpo-notes.md', 'dpo-dir/', 'other.md'],
      refs: ['dpo-2023.pdf', 'dpo-sub/'],
      'refs/dpo-sub': ['x.md'],
      'dpo-dir': ['y.md'],
    }, { manual: true });
    const { s, views, last } = start(fs);
    s.setQuery('dpo');
    expect(fs.calls).toEqual(['/proj']);
    expect(views).toHaveLength(0);

    await fs.release();
    expect(last()).toEqual({
      mode: 'name', done: false,
      items: [
        { rel: 'dpo-dir', name: 'dpo-dir', kind: 'dir', depth: 0 },
        { rel: 'dpo-notes.md', name: 'dpo-notes.md', kind: 'file', depth: 0 },
      ],
    });
    expect(fs.pending).toHaveLength(1);

    await fs.release(); // refs
    // 正向：根这一层的文件夹 dpo-dir 在列表里；否定：更深一层的文件夹 refs/dpo-sub 名字也命中，但不进列表
    expect(rels(last())).toEqual(['dpo-dir', 'dpo-notes.md', 'refs/dpo-2023.pdf']);
    expect(last().done).toBe(false);
    expect(fs.pending).toHaveLength(1);

    await fs.release(); // dpo-dir
    expect(last().done).toBe(false);
    await fs.release(); // refs/dpo-sub
    expect(last().done).toBe(true);
    expect(rels(last())).toEqual(['dpo-dir', 'dpo-notes.md', 'refs/dpo-2023.pdf']);
    // 一层读完再下一层：dpo-dir（第 1 层）在 refs/dpo-sub（第 2 层）之前 —— 深度优先会反过来
    expect(fs.calls).toEqual(['/proj', '/proj/refs', '/proj/dpo-dir', '/proj/refs/dpo-sub']);
    expect(fs.maxInFlight()).toBe(1);
  });

  it('排序：档 > 深度浅 > 路径短 > 字母序；只留前 limit 名，后读到的更好的一条插到前面', async () => {
    const fs = fakeFs({
      '': ['a/', 'xdpo.md'],
      a: ['dpo.md', 'b/'],
      'a/b': ['x_d_p_o.md', 'dpoz.md', 'dpo.pdf', 'dpo.md'],
    }, { manual: true });
    const { s, last } = start(fs, { limit: 3 });
    s.setQuery('dpo');
    await fs.release();
    expect(rels(last())).toEqual(['xdpo.md']);
    await fs.release(); // a：更深但档更好（开头），排到根那条「连续包含」之前
    expect(rels(last())).toEqual(['a/dpo.md', 'xdpo.md']);
    await fs.release(); // a/b
    expect(last().done).toBe(true);
    // 完整次序是 a/dpo.md, a/b/dpo.md, a/b/dpo.pdf, a/b/dpoz.md, xdpo.md, a/b/x_d_p_o.md；取前 3
    expect(rels(last())).toEqual(['a/dpo.md', 'a/b/dpo.md', 'a/b/dpo.pdf']);
  });

  it('缺省取前 50；不设文件数上限：60 个文件都读到，逐级浏览时 60 个都列', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `f${String(i).padStart(2, '0')}.md`);
    const fs = fakeFs({ '': ['many/'], many: names });
    const { s, last } = start(fs);
    s.setQuery('many/');
    await settle();
    // 正向：第 51～60 个确实在这个目录里
    expect(rels(last())).toHaveLength(60);
    expect(rels(last())).toContain('many/f59.md');
    s.setQuery('f');
    await settle();
    expect(last().done).toBe(true);
    expect(rels(last())).toEqual(names.slice(0, 50).map((n) => `many/${n}`));
    expect(rels(last())).not.toContain('many/f59.md');
  });

  it('读不了的目录跳过、其余照常读完；根读不了 → 空列表 + done', async () => {
    const fs = fakeFs({ '': ['bad/', 'ok/'], ok: ['dp.md'] }, { fail: ['bad'] });
    const { s, last } = start(fs);
    s.setQuery('dp');
    await settle();
    expect(fs.calls).toEqual(['/proj', '/proj/bad', '/proj/ok']);
    expect(last()).toEqual({ mode: 'name', done: true, items: [{ rel: 'ok/dp.md', name: 'dp.md', kind: 'file', depth: 1 }] });

    const broken = fakeFs({}, {});
    const b = start(broken);
    b.s.setQuery('dp');
    await settle();
    expect(broken.calls).toEqual(['/proj']);
    expect(b.last()).toEqual({ mode: 'name', items: [], done: true });
  });

  it('接着打字：只在已读到的内容里重筛（当场出结果），往下读的进度接着走、不从头读', async () => {
    const fs = fakeFs({ '': ['a/', 'b/', 'dp.md'], a: ['dpx.md'], b: ['dpy.md', 'dpx2.md'] }, { manual: true });
    const { s, last } = start(fs);
    s.setQuery('dp');
    await fs.release(); // 根
    await fs.release(); // a
    expect(rels(last())).toEqual(['dp.md', 'a/dpx.md']); // 正向：dp.md 在旧查询词下是命中的
    expect(fs.calls).toEqual(['/proj', '/proj/a', '/proj/b']);
    s.setQuery('dpx');
    expect(rels(last())).toEqual(['a/dpx.md']);
    expect(last().done).toBe(false);
    await fs.release(); // b
    expect(rels(last())).toEqual(['a/dpx.md', 'b/dpx2.md']);
    expect(last().done).toBe(true);
    expect(fs.calls).toEqual(['/proj', '/proj/a', '/proj/b']);
  });

  it('切到逐级浏览时暂停往下读；切回按名字找时从停下的地方接着读，读过的不再读', async () => {
    const fs = fakeFs({ '': ['a/', 'b/', 'c/'], a: ['dp1.md'], b: ['dp2.md'], c: ['dp3.md'] }, { manual: true });
    const { s, last } = start(fs);
    s.setQuery('dp');
    await fs.release(); // 根；a 已在飞
    expect(fs.calls).toEqual(['/proj', '/proj/a']);
    s.setQuery('a/'); // 要的正是在飞的这个：等它回来，不重复读
    await fs.release();
    expect(last()).toMatchObject({ mode: 'browse', done: true, items: [{ rel: 'a/dp1.md' }] });
    // 暂停：没有再往下读 b
    expect(fs.calls).toEqual(['/proj', '/proj/a']);
    expect(fs.pending).toHaveLength(0);

    s.setQuery('dp');
    // 正向：回到按名字找就接着读 b；a 是读过的，当场进结果
    expect(fs.calls).toEqual(['/proj', '/proj/a', '/proj/b']);
    expect(rels(last())).toEqual(['a/dp1.md']);
    await fs.release();
    await fs.release();
    expect(last()).toMatchObject({ mode: 'name', done: true });
    expect(rels(last())).toEqual(['a/dp1.md', 'b/dp2.md', 'c/dp3.md']);
    expect(fs.calls).toEqual(['/proj', '/proj/a', '/proj/b', '/proj/c']);
  });

  it('逐级浏览要读的目录也排在在飞的那一次之后：整个会话同一时间只有一个 readDir 在飞', async () => {
    const fs = fakeFs({ '': ['a/', 'b/', 'c/'], a: ['dp1.md'], b: ['dp2.md'], c: ['dp3.md'] }, { manual: true });
    const { s, last } = start(fs);
    s.setQuery('dp');
    await fs.release(); // 根；a 在飞
    s.setQuery('c/');
    expect(fs.pending).toHaveLength(1);
    expect(last()).toEqual({ mode: 'browse', items: [], done: false });
    await fs.release(); // a 回来 → 这才读 c（不是 BFS 的下一个 b）
    expect(fs.calls).toEqual(['/proj', '/proj/a', '/proj/c']);
    await fs.release();
    expect(last()).toMatchObject({ mode: 'browse', done: true, items: [{ rel: 'c/dp3.md' }] });
    s.setQuery('dp');
    await fs.release(); // b
    expect(last()).toMatchObject({ mode: 'name', done: true });
    expect(rels(last())).toEqual(['a/dp1.md', 'b/dp2.md', 'c/dp3.md']);
    expect(fs.calls).toEqual(['/proj', '/proj/a', '/proj/c', '/proj/b']);
    expect(fs.maxInFlight()).toBe(1);
  });
});

describe('会话', () => {
  it('dispose 之后：不再发起 readDir，在飞的那个回来也丢掉，不再 onChange', async () => {
    const fs = fakeFs({ '': ['a/', 'b/'], a: ['dp.md'], b: ['dp.md'] }, { manual: true });
    const { s, views } = start(fs);
    s.setQuery('dp');
    await fs.release();
    expect(views).toHaveLength(1); // 正向：dispose 之前确实在出结果
    expect(fs.calls).toEqual(['/proj', '/proj/a']);
    s.dispose();
    await fs.release(); // a 回来了
    s.setQuery('d');
    s.setQuery('a/');
    await settle();
    expect(views).toHaveLength(1);
    expect(fs.calls).toEqual(['/proj', '/proj/a']);
  });

  it('不跨会话缓存：下一次弹出从头读（agent 刚写出的文件自然就在）', async () => {
    const tree = { '': ['a.md'] } as Record<string, string[]>;
    const fs = fakeFs(tree);
    const first = start(fs);
    first.s.setQuery('');
    await settle();
    expect(rels(first.last())).toEqual(['a.md']);
    first.s.dispose();
    tree[''] = ['a.md', 'new.md'];
    const second = start(fs);
    second.s.setQuery('');
    await settle();
    expect(fs.calls).toEqual(['/proj', '/proj']);
    expect(rels(second.last())).toEqual(['a.md', 'new.md']);
  });
});
