import { describe, it, expect } from 'vitest';
import type { PageLine } from '../../../../shared/zhSidecar';
import { GroupError } from './parseGroups';
import { checkGroupGeometry } from './groupGeometry';

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

  it('没有 target 的组不参与校验（它压根不填色）', () => {
    const lines = [line(1, 72, 200, 90), line(2, 320, 200, 90)];
    expect(() => checkGroupGeometry(
      [{ lines: [1, 2], kind: 'table' }, ], lines,
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
});
