import { useLayoutEffect, useRef } from 'react';
import type { Block } from '../../../../shared/zhSidecar';
import { pageBackground, type RGB } from './pageBackground';
import { toCss } from './inkForBackground';
import { coverRect } from './blockRect';

type Props = {
  /** 这一页 scale 1 的视口尺寸（pt）。右格的 CSS 尺寸按它算，与左格逐字段同源。 */
  size: { w: number; h: number };
  /** 所在清晰层的已提交缩放（= 左格 <Page scale>）。 */
  rasterScale: number;
  /** 这一页的译文块。只有带 target 的才会被盖掉。 */
  blocks: Block[];
  /** 左格已经画完的 canvas。null = 还没就绪，右格先空着（CSS 尺寸已占位，版面不跳）。 */
  leftCanvas: HTMLCanvasElement | null;
  /**
   * 每次合成都把**这次实际填下去的底色**交出去（Task 7：译文块拿它推墨色）。
   * 探测得到就是探测值，探测不到就是下面 themePaperRgb 解析出的主题纸色——两者都是真的填过的
   * 那个颜色，不是「探测结果」本身。只在真的合成过一次时调用；早退（leftCanvas 未就绪）不调用，
   * 调用方的初始 state 是 null，含义是「还没有底图」。
   */
  onBackground?: (bg: RGB) => void;
  /**
   * 翻译进行中：右格**不合成底图**，只画一个与左格同尺寸的纸色矩形（spec §1「右栏先空白」）。
   *
   * 也不调 `onBackground`：它的语义是「这次实际填下去的底色」，译文块拿它推墨色——而翻译期间
   * 译文层整层不渲染（PdfFileTab 那边同一个开关），把这块兜底纸色交出去只会让重译结束、块回来
   * 的那一瞬用错底色推一次墨。
   */
  blank?: boolean;
};

/**
 * 页背景八点取样取不到时，右格退回去填的那个颜色：应用主题的 `--color-paper`，解析成 sRGB 三元组。
 *
 * 必须解析成 RGB 才能交出去，不能只把 CSS 串丢给 fillStyle 了事：译文墨色要按「底下实际是什么
 * 颜色」推（inkForBackground），而主题 token 是 oklch()——新版 Chromium 的 getComputedStyle
 * 原样保留 oklch() 语法、不再折算成 rgb()，那个字符串本身参与不了亮度计算。过一次 1×1 画布再
 * 读像素是本仓库已有的做法（`app/domColor.ts` 的 cssColorToHex，那边是为了喂 Electron 的颜色
 * 解析器），这里走同一条路，只是停在 RGB 上不再转 hex。
 *
 * 返回值同时用于「填」和「推墨色」，所以哪怕解析失败（fillStyle 保持默认黑）两者也仍然自洽：
 * 填下去的和推墨色用的恒是同一个数。
 */
function themePaperRgb(el: Element): RGB {
  const css = getComputedStyle(el).getPropertyValue('--color-paper').trim();
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  if (!ctx || !css) return [255, 255, 255];
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

/**
 * 右格底图（spec §3.2 / §7）：
 *   1. 原样拷一份左格位图 —— 图、表、公式、页眉页脚因此全部保留
 *   2. 只在**有 target** 的块矩形里填页背景色 —— 只盖要放译文的地方
 *   3.（Task 7）译文 HTML 叠在上面
 *
 * `blank`（翻译进行中）时这三步一步都不做，只填一格纸色——见该 prop 的注释。
 *
 * 为什么默认保留整页、只盖译文矩形，而不是先把正文从 PDF 里剥掉再渲染：删内容流会连带改掉
 * ET 之后的图形状态，而 Form XObject 里也可能整段都是正文——这两条都被实测证否过（spec §0）。
 * 矩形覆盖对二者天然免疫，且不需要任何「这是不是扫描页」的判定：抽不出文本就没有块，步骤 2
 * 空转，右栏 = 原图。
 *
 * **要保的不变量**：右格合成的那次 commit 恒排在双缓冲顶替的那次 commit 之前——否则会有一帧
 * 「新层已经顶上来、右格还空着」。
 *
 * 它由**优先级车道**保证，不由这段代码维持。信号源是左格的 `onRenderSuccess`，它在同一个回调
 * 里做两件事：`registry.set` 把画完的 canvas 交给右格，`onSettled` 可能触发顶替。两件事走的车道
 * 不同：
 *
 * - `registry.set` 通知的是右格的 `useSyncExternalStore` 订阅，React 的 `forceStoreRerender`
 *   **无条件**用 SyncLane（`react-dom/cjs/react-dom-client.development.js:8260`，与触发它的是不是
 *   discrete 事件无关——spec §12 的 v7 订正已经对着源码核过一次）；
 * - 顶替走的是 `setLayers`，而 `onRenderSuccess` 出自 react-pdf 的异步续体（不是事件处理器），
 *   拿到的是 DefaultLane。
 *
 * 同一个 root 上两者都挂着时，React 先冲 Sync 再冲 Default，于是「右格拿到 leftCanvas 并合成」
 * 必然先于「顶替」。**注意理由已经变了**：这里原先写的是「同一批 setState」——那是 leftCanvas 还
 * 走 `MountedPageCells` 本地 state 时的事，改成跨树注册表之后那句不再是事实，结论却仍成立。
 *
 * 仍然用 useLayoutEffect 而不是 useEffect：合成要落在**画出这张 canvas 的那次 commit 绘制之前**。
 * 上面那条 Sync 路径上两者其实等价（sync commit 末尾同步冲 passive effect，中间不插绘制），但这个
 * effect 的依赖里还有走 DefaultLane 的量——`size.w` 出自页尺寸预取续体里的 `setSizes`，那条路上
 * passive effect 走 MessageChannel 宏任务，浏览器会在中间绘制一帧，右格就会拿旧位图配新 CSS 尺寸
 * 露出来。useLayoutEffect 让两条路一视同仁。
 */
export function RightPage({ size, rasterScale, blocks, leftCanvas, onBackground, blank }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const c = ref.current;
    // width === 0：react-pdf 卸载 canvas 时会把位图清零（Canvas.js 的 cleanup），拷过来是一片空白
    if (!c || !leftCanvas || leftCanvas.width === 0) return;
    const src = leftCanvas.getContext('2d');
    const ctx = c.getContext('2d');
    if (!src || !ctx) return;

    // 两栏同源：位图尺寸逐字段照抄左格，所以下面这次 drawImage 是 1:1 拷贝，不做任何缩放
    c.width = leftCanvas.width;
    c.height = leftCanvas.height;

    // 翻译进行中：整格填纸色就结束——不 drawImage、不填块矩形、不调 onBackground（见 blank 的
    // 注释）。位图尺寸仍照抄左格（上面两行），所以两格的 CSS 尺寸与几何一个字都没变，右格空不
    // 空白与不变量 #2 / #3 无关。
    if (blank) {
      ctx.fillStyle = toCss(themePaperRgb(c));
      ctx.fillRect(0, 0, c.width, c.height);
      return;
    }

    ctx.drawImage(leftCanvas, 0, 0);

    // 位图像素 / pt。等于 rasterScale × devicePixelRatio，但从 canvas 反推更可靠：
    // 左格由 react-pdf 开，dpr 是它自己读的，我们不该在这里再假设一遍。
    const S = leftCanvas.width / size.w;

    // 八点取样，逐点读 1×1（不读整页位图）。取不到（页边有出血图、局部底色）就退回主题纸色 ——
    // 已知妥协：深色 PDF 配浅色主题时这一块会填错色（spec §6），但比猜一个"众数底色"稳。
    const bg = pageBackground(
      (x, y) => {
        const d = src.getImageData(x, y, 1, 1).data;
        return [d[0], d[1], d[2]] as RGB;
      },
      leftCanvas.width, leftCanvas.height,
    );
    // 取不到统一背景色就退回主题纸色。交出去给译文块推墨色的必须是**这次实际填下去的颜色**，
    // 不是探测结果本身：底色是谁填的，墨色就得按谁推。交出 null、让译文块自己「按白底兜底」
    // 是错的——midnight 主题下这块填的是深蓝灰，按白底推出来的近黑字压上去只有约 1.4:1，
    // 直接违反 spec §14 不变量 #12（译文永远读得清）。触发面也不是个别情况：八点精确相等的
    // 判据下，任何扫描件（JPEG 噪声让四角逐字节不等）、任何四边压着出血图的页都落进这条兜底。
    const fill = bg ?? themePaperRgb(c);
    ctx.fillStyle = toCss(fill);
    onBackground?.(fill);

    for (const b of blocks) {
      if (b.target === undefined) continue;   // 不翻译的块不盖：公式、表格、页眉页脚原样留着
      // 纵向按墨迹矩形（含降部；老边车没有 ink 就退回字身框）、外扩、向外取整——见 coverRect。
      const r = coverRect(b, S);
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }, [leftCanvas, blocks, size.w, onBackground, blank]);

  return (
    <canvas
      ref={ref}
      className="shadow-md"
      data-pdf-right="1"
      // Math.floor 是照抄 react-pdf 给左格 canvas 的 CSS 尺寸（Canvas.js:59「style.width =
      // Math.floor(viewport.width)」）。viewport.width 就是 size.w × scale 这同一个乘法，
      // 所以两栏的 CSS 尺寸逐字段相等，行里两格恒等高——不是"差不多齐"。
      style={{
        display: 'block',
        width: Math.floor(size.w * rasterScale),
        height: Math.floor(size.h * rasterScale),
      }}
    />
  );
}
