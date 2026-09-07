import { describe, it, expect } from 'vitest';
import type { PageLine } from '../../../../shared/zhSidecar';
import { GroupError } from './layoutProtocol';
import { checkGroupGeometry, repairGroupGeometry } from './groupGeometry';

// 10 pt 行、行距 14：n 行的 y = 90 + (n-1)*14
const line = (n: number, x: number, w: number, y: number): PageLine =>
  ({ n, x, y, w, h: 10, size: 10, text: `L${n}` });

describe('checkGroupGeometry', () => {
  it('单栏相邻两段：各自的矩形不含对方的行中心 → 通过', () => {
    const lines = [line(1, 72, 400, 90), line(2, 72, 400, 104), line(3, 72, 400, 118)];
    expect(() => checkGroupGeometry(
      [{ lines: [1, 2], kind: 'text', target: 'a' }, { lines: [3], kind: 'text', target: 'b' }], lines,
    )).not.toThrow();
  });

  it('内容流交错的双栏：非连续分组 {1,3} / {2,4} 通过', () => {
    const lines = [line(1, 72, 200, 90), line(2, 320, 200, 90), line(3, 72, 200, 104), line(4, 320, 200, 104)];
    expect(() => checkGroupGeometry(
      [{ lines: [1, 3], kind: 'text', target: 'L' }, { lines: [2, 4], kind: 'text', target: 'R' }], lines,
    )).not.toThrow();
  });

  it('跨栏错分（组的矩形横跨两栏、又纵跨两行）→ 含了别组行的中心 → 抛', () => {
    // 四行两栏：1/2 在上一行的左右栏，3/4 在下一行。把 1 与 4 错分进同一组，它的并集矩形
    // 就横跨两栏、纵跨两行，行 2 与行 3 的中心都落进去。
    //
    // **不要改成 `{1,2}` + `{3}`**：那样组 {1,2} 的矩形只有上面那一行的高度（外扩后 y 88.5..101.5），
    // 而行 3 的中心在 y=109，落在外面 —— 不会抛，用例会红。这条用例必须让「被盖住的行」真的落在
    // 合并矩形的 y 带内才成立。
    const lines = [line(1, 72, 200, 90), line(2, 320, 200, 90), line(3, 72, 200, 104), line(4, 320, 200, 104)];
    expect(() => checkGroupGeometry([
      { lines: [1, 4], kind: 'text', target: 'X' },
      { lines: [2], kind: 'text', target: 'Y' },
      { lines: [3], kind: 'text', target: 'Z' },
    ], lines)).toThrow(GroupError);
  });

  it('行距紧到字身框相邻（未外扩时刚好不含、外扩后含）→ 抛；这一条钉住「校验的是外扩后的矩形」', () => {
    // 组 A = 行 1（y 90..100）；行 2 的 y = 100..110，中心 105。
    // 未外扩：A 的矩形 y 90..100，不含 105 → 会漏过。
    // 外扩 1.5：y 88.5..101.5，仍不含 105 —— 所以构造得更紧一点：行 2 高 2、y 100..102，中心 101。
    const lines: PageLine[] = [
      { n: 1, x: 72, y: 90, w: 400, h: 10, size: 10, text: 'a' },
      { n: 2, x: 72, y: 100, w: 400, h: 2, size: 2, text: 'b' },
    ];
    const groups = [
      { lines: [1], kind: 'text' as const, target: 'A' },
      { lines: [2], kind: 'text' as const, target: 'B' },
    ];
    expect(() => checkGroupGeometry(groups, lines)).toThrow(GroupError);
  });

  it('不可译 kind 的组不参与校验（它压根不填色）', () => {
    const lines = [line(1, 72, 200, 90), line(2, 320, 200, 90)];
    expect(() => checkGroupGeometry(
      [{ lines: [1, 2], kind: 'table' }, ], lines,
    )).not.toThrow();
  });

  // M-1：判据换成了 isTranslatable(kind)，不是「有没有 target」——两步协议里这一关跑在第一步
  // 之后、译文还没回来，那时每个组的 target 都是 undefined。按 target 判会让整层校验静默失效。
  it('可译 kind 即使没有 target 也照样校验（两步协议里第一步之后 target 本就还没回来）', () => {
    const lines = [line(1, 72, 200, 90), line(2, 320, 200, 90)];
    expect(() => checkGroupGeometry(
      [{ lines: [1], kind: 'text' }, { lines: [2], kind: 'skip' }], lines,
    )).not.toThrow();
    // 同样的几何：矩形横向覆盖到另一栏，把另一行的中心也含进来才该抛。用宽矩形（单行但 width
    // 撑满两栏）触发它。
    const wide = [{ ...line(1, 72, 568, 90) }, line(2, 320, 200, 90)];
    expect(() => checkGroupGeometry(
      [{ lines: [1], kind: 'text' }], wide,
    )).toThrow(GroupError);
  });

  it('不可译 kind（code）同样几何不校验、不抛——判据是 kind 不是有没有 target', () => {
    const wide = [line(1, 72, 568, 90), line(2, 320, 200, 90)];
    expect(() => checkGroupGeometry(
      [{ lines: [1], kind: 'code' }], wide,
    )).not.toThrow();
  });

  it('mask 按墨迹矩形：字身框并集不含另一行中心、墨迹框并集含 → 抛', () => {
    // 组 {1}：字身框 y 100–110；降部把墨迹底推到 118。第 2 行 y 116–126，中心 121。
    // 字身框 + PAD 1.5 → 到 111.5，不含 121；墨迹框 + PAD → 到 119.5，仍不含；把降部再放大到 122
    // 才含——这里就取 inkBottom 122 让它含，证明用的是 ink 而不是字身框。
    const lines = [
      { n: 1, x: 72, y: 100, w: 400, h: 10, size: 10, text: 'a', inkTop: 103, inkBottom: 122 },
      { n: 2, x: 72, y: 116, w: 400, h: 10, size: 10, text: 'b' },
    ];
    expect(() => checkGroupGeometry([{ lines: [1], kind: 'text', target: 'T' }, { lines: [2], kind: 'skip' }], lines))
      .toThrow(/盖住了不属于它的行 2/);
    // 去掉度量 → 退回字身框 → 通过
    const plain = lines.map(({ inkTop: _a, inkBottom: _b, ...l }) => l);
    expect(() => checkGroupGeometry([{ lines: [1], kind: 'text', target: 'T' }, { lines: [2], kind: 'skip' }], plain)).not.toThrow();
  });

  it('被查行是挂在基线下的算符字形：字身框中心落进 mask、墨迹中心在外 → 不抛（2512.03413 第 8 页）', () => {
    // 组 {1}：墨迹底 374.0 + PAD 1.5 = 375.5。行 2 字身框 371.1–379.1（中心 375.1，在内），墨迹 378.6–383.9（中心 381.2，在外）。
    const lines = [
      { n: 1, x: 73, y: 352, w: 222, h: 20, size: 9, text: 'a', inkTop: 354.6, inkBottom: 374.0 },
      { n: 2, x: 92, y: 371.1, w: 10.8, h: 8, size: 8, text: 'Ö', inkTop: 378.6, inkBottom: 383.9 },
    ];
    expect(() => checkGroupGeometry([{ lines: [1], kind: 'text' }, { lines: [2], kind: 'formula' }], lines)).not.toThrow();
    // 反过来：墨迹中心在内（把行 2 的墨迹抬到 372–378，中心 375）→ 抛
    const inside = [lines[0], { ...lines[1], inkTop: 372, inkBottom: 378 }];
    expect(() => checkGroupGeometry([{ lines: [1], kind: 'text' }, { lines: [2], kind: 'formula' }], inside)).toThrow(/盖住了不属于它的行 2/);
  });
});

describe('repairGroupGeometry（跨栏的组先拆再校验，spec 2026-09-07 §8.7）', () => {
  // 双栏页：行 1 是左栏顶的标题（别组），行 2/3 是左栏下方的段落前半，行 4 是它在右栏顶的后半，
  // 行 5 是右栏紧接着的下一段（别组）。段落 {2,3,4} 的并集横跨两栏、纵跨 y 90..128，行 1 与行 5
  // 的中心都落进去——2512.03413.pdf 第 5 页就是这个形状（51-59 在左栏底、60-62 在右栏顶）。
  const twoColumn = [line(1, 72, 200, 90), line(2, 72, 200, 104), line(3, 72, 200, 118), line(4, 320, 200, 90), line(5, 320, 200, 104)];

  it('跨栏段落按栏切成两组，位置留在原组处、kind 不变、别的组原样', () => {
    const groups = [
      { lines: [1], kind: 'title' as const },
      { lines: [2, 3, 4], kind: 'text' as const },
      { lines: [5], kind: 'text' as const },
    ];
    expect(() => checkGroupGeometry(groups, twoColumn)).toThrow(/盖住了不属于它的行 1/);
    expect(repairGroupGeometry(groups, twoColumn)).toEqual([
      { lines: [1], kind: 'title' },
      { lines: [2, 3], kind: 'text' },
      { lines: [4], kind: 'text' },
      { lines: [5], kind: 'text' },
    ]);
  });

  it('切点跟着模型给的行序走：右栏那半排在前面就先出右栏', () => {
    const groups = [{ lines: [1], kind: 'title' as const }, { lines: [4, 2, 3], kind: 'text' as const }, { lines: [5], kind: 'text' as const }];
    expect(repairGroupGeometry(groups, twoColumn).map((g) => g.lines)).toEqual([[1], [4], [2, 3], [5]]);
  });

  it('本来就合几何的组一个不动（拆只发生在会盖住别人的组上）', () => {
    const groups = [{ lines: [1], kind: 'title' as const }, { lines: [2, 3], kind: 'text' as const }, { lines: [4, 5], kind: 'text' as const }];
    expect(repairGroupGeometry(groups, twoColumn)).toEqual(groups);
  });

  it('不可译 kind 的组并集再大也不拆、不抛（它不填色）', () => {
    const groups = [{ lines: [1, 2, 3, 4, 5], kind: 'figure' as const }];
    expect(repairGroupGeometry(groups, twoColumn)).toEqual(groups);
  });

  it('拆到单行仍盖住别人（一行本身横跨两栏）→ 照抛，原因仍是「盖住了不属于它的行」', () => {
    const wide = [line(1, 72, 568, 90), line(2, 320, 200, 90)];
    expect(() => repairGroupGeometry([{ lines: [1], kind: 'text' }, { lines: [2], kind: 'text' }], wide))
      .toThrow(/盖住了不属于它的行 2/);
  });

  it('「别组的行」按拆之前的组算：内容流交错的同一段（{1,3} 与 {2,4} 各成一组）不会被切碎', () => {
    // 与 checkGroupGeometry 那条「非连续分组通过」同一份几何：{1,3} 的并集不含 2/4 的中心，本就合几何，
    // 但这里故意把 1 与 3 之间放一行别组的窄行 6 在右栏，让 {1,3} 单看仍合几何——拆不发生。
    const lines = [line(1, 72, 200, 90), line(2, 320, 200, 90), line(3, 72, 200, 104), line(4, 320, 200, 104)];
    const groups = [{ lines: [1, 3], kind: 'text' as const }, { lines: [2, 4], kind: 'text' as const }];
    expect(repairGroupGeometry(groups, lines)).toEqual(groups);
  });
});
