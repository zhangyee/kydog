import { describe, it, expect } from 'vitest';
import { toStageBounds, sameReport, clampBrowserWidth, nextReport, type StageReport } from './stage';
import { NO_EPOCH } from './browserStore';
import { MIN_BROWSER_WIDTH, DEFAULT_BROWSER_WIDTH } from '../../../shared/types';
import { sanitizeBrowserWidth, defaultSettings } from '../../../main/persist/settingsFile';

describe('toStageBounds：往里取整', () => {
  it('整数矩形原样过', () => {
    expect(toStageBounds({ left: 10, top: 20, width: 640, height: 900 }))
      .toEqual({ x: 10, y: 20, width: 640, height: 900 });
  });

  /**
   * **这一条是本模块的理由。** 原生 WebContentsView 永远盖在 DOM 之上：取大一个像素
   * 就压住旁边那条分栏手柄（黑边 + 鼠标点不到手柄），取小一个像素只是露出半个像素底色。
   * 四舍五入会往两个方向都走，所以判据必须是「向内」而不是「就近」。
   */
  it('左上向上取整、右下向下取整 —— 结果永远落在原矩形之内', () => {
    const r = { left: 10.2, top: 20.8, width: 640.9, height: 900.4 };
    const b = toStageBounds(r);
    expect(b).toEqual({ x: 11, y: 21, width: 640, height: 900 });
    expect(b.x).toBeGreaterThanOrEqual(r.left);
    expect(b.y).toBeGreaterThanOrEqual(r.top);
    expect(b.x + b.width).toBeLessThanOrEqual(r.left + r.width);
    expect(b.y + b.height).toBeLessThanOrEqual(r.top + r.height);
  });

  it('四舍五入会越界的那一档，这里不许越界', () => {
    // Math.round 会给 x=10、width=641 → 右边界 651 > 650.4，压住了手柄。
    const r = { left: 10.4, top: 0, width: 640, height: 10 };
    const b = toStageBounds(r);
    expect(b.x + b.width).toBeLessThanOrEqual(r.left + r.width);
  });

  it('塌掉的矩形给 0，不给负数', () => {
    expect(toStageBounds({ left: 0, top: 0, width: 0, height: 0 }))
      .toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(toStageBounds({ left: 10.5, top: 10.5, width: 0.2, height: 0.2 }))
      .toEqual({ x: 11, y: 11, width: 0, height: 0 });
  });
});

describe('sameReport：一次拖拽不许打成几百条 CDP 命令', () => {
  const base: StageReport = {
    epoch: 3, visible: true, occluded: false, bounds: { x: 1, y: 2, width: 3, height: 4 },
  };

  it('逐字段相同 → 同一件事', () => {
    expect(sameReport(base, { ...base, bounds: { ...base.bounds } })).toBe(true);
  });

  it('还没上报过（null）→ 一定不同', () => {
    expect(sameReport(null, base)).toBe(false);
  });

  // 五个字段各钉一条：少比一个就有一档变化会被静默吃掉。
  it('epoch 变了算不同', () => {
    expect(sameReport(base, { ...base, epoch: 4 })).toBe(false);
  });
  it('visible 变了算不同', () => {
    expect(sameReport(base, { ...base, visible: false })).toBe(false);
  });
  it('occluded 变了算不同', () => {
    expect(sameReport(base, { ...base, occluded: true })).toBe(false);
  });
  it('bounds 任何一维变了都算不同', () => {
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(sameReport(base, { ...base, bounds: { ...base.bounds, [k]: 99 } }), k).toBe(false);
    }
  });
});

describe('clampBrowserWidth', () => {
  it('比下限小的钳到下限', () => {
    expect(clampBrowserWidth(10)).toBe(MIN_BROWSER_WIDTH);
    expect(clampBrowserWidth(0)).toBe(MIN_BROWSER_WIDTH);
    expect(clampBrowserWidth(-500)).toBe(MIN_BROWSER_WIDTH);
  });

  it('下限本身收得下（钳的是「小于」，不是「小于等于」）', () => {
    expect(clampBrowserWidth(MIN_BROWSER_WIDTH)).toBe(MIN_BROWSER_WIDTH);
  });

  it('正常值取整后原样过', () => {
    expect(clampBrowserWidth(640.4)).toBe(640);
    expect(clampBrowserWidth(640.6)).toBe(641);
  });

  it('NaN / Infinity 不许漏过去 —— 它们会一路走到 setBounds', () => {
    expect(clampBrowserWidth(Number.NaN)).toBe(MIN_BROWSER_WIDTH);
    expect(clampBrowserWidth(Number.POSITIVE_INFINITY)).toBe(MIN_BROWSER_WIDTH);
  });
});

/**
 * 渲染层的钳位与主进程的 sanitize 必须**在同一处分界**。
 *
 * 这里刻意**不比两个常量**（它们是同一个符号的两条 import 路径，那样的断言永远不会红，
 * 是一条零信息的用例）。比的是**行为**：主进程收得下的值渲染层不许改动，主进程收不下的
 * 值渲染层必须在上报之前就拦住。有人在 `sanitizeBrowserWidth` 里重新写一个字面量下限，
 * 这里会红。
 *
 * 两边分界不一样的后果很具体：渲染层钳到 300、主进程 sanitize 到 320，于是每次拖到底
 * 再重启，宽度都会自己跳一下 —— 没有任何东西会报错。
 */
describe('宽度：渲染层的钳位与主进程的 sanitize 同一处分界', () => {
  const SWEEP = [0, 1, 100, MIN_BROWSER_WIDTH - 1, MIN_BROWSER_WIDTH, MIN_BROWSER_WIDTH + 1, 560, 2000];

  it('主进程收得下的值，渲染层原样放行', () => {
    for (const w of SWEEP) {
      if (sanitizeBrowserWidth(w) === w) expect(clampBrowserWidth(w), String(w)).toBe(w);
    }
  });

  it('主进程收不下的值，渲染层不许原样送出去', () => {
    for (const w of SWEEP) {
      if (sanitizeBrowserWidth(w) !== w) expect(clampBrowserWidth(w), String(w)).not.toBe(w);
    }
  });

  it('钳完的结果本身一定是主进程收得下的（钳到一个仍会被拒的值等于没钳）', () => {
    for (const w of [...SWEEP, -9999, Number.NaN]) {
      const c = clampBrowserWidth(w);
      expect(sanitizeBrowserWidth(c), String(w)).toBe(c);
    }
  });

  /**
   * 落盘默认值本身是 `null`（未设定，见 `defaultSettings().ui.browserWidth`）——
   * 那不是一个像素宽度，钳不上也没有意义。真正「全新安装第一次开侧栏该是多宽」
   * 由渲染层的 `browserWidthFor` 现算 4:6，`DEFAULT_BROWSER_WIDTH` 仍是它在
   * 别处（旧版本读到 null 时的降级、既有用例）当合法宽度用的那个常量，这里钉住
   * 它本身也钳得住。
   */
  it('DEFAULT_BROWSER_WIDTH 本身也钳得住', () => {
    expect(clampBrowserWidth(DEFAULT_BROWSER_WIDTH)).toBe(DEFAULT_BROWSER_WIDTH);
    expect(defaultSettings().ui.browserWidth).toBeNull();
  });
});

describe('nextReport：什么时候报、报什么', () => {
  const RECT = { left: 700, top: 40, width: 560, height: 800 };
  const BOUNDS = { x: 700, y: 40, width: 560, height: 800 };
  const base = { epoch: 3, visible: true, occluded: false, rect: RECT, last: null } as const;

  it('正常一帧：量出来就报', () => {
    expect(nextReport(base)).toEqual({ epoch: 3, visible: true, occluded: false, bounds: BOUNDS });
  });

  it('还没拿到 epoch → 一个字都不报（报了也会被主进程判过期丢掉）', () => {
    expect(nextReport({ ...base, epoch: NO_EPOCH })).toBeNull();
  });

  /**
   * 宽度 0 上报的具体后果：主进程 `applyViewport` 把它兜成 1，`scale = 1/1280`，
   * 逻辑视口高度塌成 1px，walker 把整页元素全滤掉 —— agent 拿到空快照并判定
   * 「这个源是空页面」，全程无错误。所以这一支必须是「不报」，不是「报个零」。
   */
  it('可见但矩形退化（宽或高为 0）→ 不报，让上一份几何继续有效', () => {
    expect(nextReport({ ...base, rect: { left: 0, top: 0, width: 0, height: 800 } })).toBeNull();
    expect(nextReport({ ...base, rect: { left: 0, top: 0, width: 560, height: 0 } })).toBeNull();
  });

  it('可见但压根没有元素可量 → 不报', () => {
    expect(nextReport({ ...base, rect: null })).toBeNull();
  });

  it('与上一次逐字段相同 → 不报', () => {
    const last: StageReport = { epoch: 3, visible: true, occluded: false, bounds: BOUNDS };
    expect(nextReport({ ...base, last })).toBeNull();
  });

  it('只有 occluded 变了也要报 —— 确认框盖上来时原生层必须让开', () => {
    const last: StageReport = { epoch: 3, visible: true, occluded: false, bounds: BOUNDS };
    expect(nextReport({ ...base, occluded: true, last }))
      .toEqual({ epoch: 3, visible: true, occluded: true, bounds: BOUNDS });
  });

  it('epoch 换了要重报 —— 渲染层重载后主进程只认新代号', () => {
    const last: StageReport = { epoch: 3, visible: true, occluded: false, bounds: BOUNDS };
    expect(nextReport({ ...base, epoch: 4, last })?.epoch).toBe(4);
  });

  /**
   * 收起侧栏时**带的是最后那一份真几何**，不是零矩形。零矩形会毁掉这个标签的逻辑视口
   * （理由同上面那条），而 spec §B 明写浏览器的能力与侧栏可见性完全解耦：
   * 隐藏只改「给人看的那一块在不在」，不改页面按多宽渲染。
   */
  it('收起侧栏：报 visible:false，bounds 沿用最后那一份真几何', () => {
    const last: StageReport = { epoch: 3, visible: true, occluded: false, bounds: BOUNDS };
    expect(nextReport({ epoch: 3, visible: false, occluded: false, rect: null, last }))
      .toEqual({ epoch: 3, visible: false, occluded: false, bounds: BOUNDS });
  });

  it('从没报过就不必报「藏起来」—— 没告诉过主进程有这块舞台，也就没有什么要藏', () => {
    expect(nextReport({ epoch: 3, visible: false, occluded: false, rect: null, last: null })).toBeNull();
  });

  it('收起时即使还量得到矩形，也不拿它当新几何（那一刻的 rect 已经不代表舞台了）', () => {
    const last: StageReport = { epoch: 3, visible: true, occluded: false, bounds: BOUNDS };
    const r = nextReport({ epoch: 3, visible: false, occluded: false, rect: { left: 0, top: 0, width: 1, height: 1 }, last });
    expect(r?.bounds).toEqual(BOUNDS);
  });
});
