import { useEffect, useRef, useState } from 'react';
import type { Block } from '../../../../shared/zhSidecar';
import { fitFontScale } from './fitFontScale';
import { inkForBackground, toCss } from './inkForBackground';
import type { RGB } from './pageBackground';
import { splitPlaceholders } from './renderPlaceholders';

const MIN_RATIO = 0.5;
const WEIGHT = (kind: Block['kind']) => (kind === 'title' ? 600 : 400);
const SIZE_MUL = (kind: Block['kind']) => (kind === 'caption' ? 0.9 : 1);

/**
 * fontScale 缓存：key = docKey + block.id + 用于测量的 font shorthand。
 *
 * 模块级、不落盘——agent 写边车时算不出这个值，让它成为契约字段只会逼 agent 编一个。
 * 模块级 Map 在同一个渲染进程内是单例，而应用支持同时打开多个 PDF tab（每个 tab 各挂一份
 * TranslationBlocks，都写同一个 fitCache）：block.id 按 spec 只保证「文档内」唯一，两篇不同
 * 论文完全可能都有 `p1-b01`。key 必须带上 docKey（调用方传 tab.id，= 文件绝对路径，天然
 * 跨文档唯一）才能避免后打开的文档撞上前一份文档缓存的 fontScale——那个比例是按另一份译文的
 * 长度和 bbox 算出来的，对这份文档而言是错的，且不会自愈、依赖打开顺序。
 */
const fitCache = new Map<string, number>();

/** 缓存 key 的构造：抽成纯函数，单测钉住「不同 docKey 必须得到不同 key」。 */
export function fitCacheKey(docKey: string, blockId: string, font: string): string {
  return `${docKey}|${blockId}|${font}`;
}

/**
 * 在一个 zoom:1 的隐藏宿主里量一次，得到能装进 maxH 的最大字号比例。
 *
 * 必须先等字体真的到位：@fontsource/noto-serif-sc 是 font-display: swap 且按 unicode-range
 * 分片加载（node_modules/@fontsource/noto-serif-sc/400.css 与 600.css 各自切片），不等就量的
 * 是回退字体（Source Serif 4 / Songti SC），而结果只算一次就被缓存——版面会永久错。
 *
 * document.fonts.load 的第二个参数决定加载哪些子集，所以要传测量会真正用到的字符：这里用
 * 占位符已还原的文本（splitPlaceholders 拼接），而不是 b.target 原文——b.target 里还留着
 * `{v1}` 这样的字面 token，用它去请求字体子集，测出来的换行也是按 token 长度、不是按真实
 * 显示文本，两者在公式/引用较长时会明显偏差。
 */
async function measureFit(
  docKey: string, b: Block, measureText: string, host: HTMLElement,
): Promise<number> {
  const px = b.fontSize * SIZE_MUL(b.kind);
  const weight = WEIGHT(b.kind);
  const font = `${weight} ${px}px "Noto Serif SC"`;
  const key = fitCacheKey(docKey, b.id, font);
  const hit = fitCache.get(key);
  if (hit !== undefined) return hit;

  await document.fonts.load(font, measureText);
  host.style.width = `${b.width}px`;
  host.style.fontWeight = String(weight);
  host.textContent = measureText;

  const ratio = fitFontScale((r) => {
    host.style.fontSize = `${px * r}px`;
    return host.scrollHeight;
  }, b.height, MIN_RATIO);

  fitCache.set(key, ratio);
  return ratio;
}

type Props = {
  /** fitCache key 的文档隔离维度。调用方传 tab.id（= 文件绝对路径，天然跨文档唯一）。 */
  docKey: string;
  /** 这一页 scale 1 的视口尺寸（pt）。容器按它显式定宽高——与 RightPage 的 canvas 同源，不靠隐式布局撑起来。 */
  size: { w: number; h: number };
  /** 所在清晰层的已提交缩放；与 RightPage 的 rasterScale 是同一个数。 */
  rasterScale: number;
  /** 这一页的译文块。只渲染有 target 的（右格只在这些矩形里盖过原文）。 */
  blocks: Block[];
  /**
   * RightPage 这一次**实际填进块矩形的那个底色**（探测到的页背景，或探测不到时它退回去填的
   * 主题纸色）。墨色按它推，两边说的是同一块像素。
   *
   * null 只有一个含义：右格还一次都没合成过。此时块底下压根没有我们填的底，露出来的是滚动
   * 容器的 `--color-paper-deep`——按任何一个颜色推墨色都是猜，所以整层先不显示（见下面的
   * visibility），等底图落地。
   */
  bg: RGB | null;
};

/**
 * 右格的第三层（spec §3.2 / §7 步骤 3）：把译文 HTML 叠在 RightPage 已经拷贝+填色的底图上。
 *
 * 高度是**固定**的 `b.height * rasterScale`，不是 minHeight：用 minHeight 会让长译文撑高、
 * 压到下一个块，版面就不再与左栏一致——而两栏版面一致是这整个功能的立身之本。译文短则顶对齐
 * 留白，长则先靠 fontScale 收，收到下限（0.5）仍装不下才在块内滚动（overflow-y: auto）。
 *
 * 墨色由实际背景推导，不跟应用主题：译文块的底是 PDF 的底（白纸或深色页），而 --color-ink
 * 跟应用主题走，midnight 主题下它接近白，压在白纸上对比度只有 ~1.23:1——与 annotationInks.ts
 * 开头那条「标注墨色是内容，不随主题变」同一条原则。
 *
 * 本期不接 KaTeX：边车里的 formula placeholder 只是 pdf.js 从内容流里抽出的字形文本
 * （zhSidecar.ts 的 Placeholder.text），不是 LaTeX 源，KaTeX 没有输入可渲染。formula 段落只
 * 用 font-style: italic 做视觉区分，这是本期的诚实边界，留给以后接抽取 LaTeX 源之后再补。
 */
export function TranslationBlocks({ blocks, size, rasterScale, bg, docKey }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState<Record<string, number>>({});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    void (async () => {
      const out: Record<string, number> = {};
      for (const b of blocks) {
        if (b.target === undefined) continue;
        const measureText = splitPlaceholders(b.target, b.placeholders ?? [])
          .map((s) => s.text).join('');
        out[b.id] = await measureFit(docKey, b, measureText, host);
        if (!alive) return; // 换页/换文档中途作废：不把已经量到一半的结果落地
      }
      if (alive) setFits(out);
    })();
    return () => { alive = false; };
  }, [blocks, docKey]);

  // bg 为 null 时整层是 hidden 的（见下面容器的 visibility），这里的白底只是个占位，不会有
  // 任何一个像素按它着色——真正的判据永远是 RightPage 交回来的那个「实际填下去的底色」。
  const ink = toCss(inkForBackground(bg ?? [255, 255, 255]));

  return (
    <div
      data-translation-blocks
      style={{
        position: 'absolute', top: 0, left: 0,
        // Math.floor 与 RightPage 给 canvas 的 CSS 尺寸同一个算法（size.w/h × rasterScale 再
        // floor），两层因此逐像素同源，不依赖「兄弟节点先渲染过、我再靠 inset:0 借它的尺寸」。
        width: Math.floor(size.w * rasterScale), height: Math.floor(size.h * rasterScale),
        pointerEvents: 'none', // 块本身开 user-select: text 可各自接收指针事件；容器不拦截
        // 底图还没合成过（bg === null）就先别显示：那时块底下是滚动容器的深色 paper-deep，
        // 不是我们填的任何一个颜色，墨色按什么推都是猜。visibility 不影响布局，测量宿主照常
        // 量得到 scrollHeight，字号该收敛还是会收敛。
        visibility: bg ? undefined : 'hidden',
      }}
    >
      {/* 测量宿主：zoom 1、不可见、不参与布局、不接收指针事件。量出来的比例因此与当前缩放无关。 */}
      <div
        ref={hostRef}
        aria-hidden
        style={{
          position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
          top: 0, left: 0, zoom: 1,
          fontFamily: 'var(--font-serif)', lineHeight: 1.5,
          textAlign: 'justify', textJustify: 'inter-ideograph' as never,
        }}
      />
      {blocks.map((b) => {
        if (b.target === undefined) return null;
        const fit = fits[b.id] ?? 1;
        return (
          <div
            key={b.id}
            data-translation-block={b.id}
            style={{
              position: 'absolute',
              left: b.x * rasterScale, top: b.y * rasterScale,
              width: b.width * rasterScale, height: b.height * rasterScale,
              fontSize: b.fontSize * SIZE_MUL(b.kind) * fit * rasterScale,
              fontWeight: WEIGHT(b.kind),
              fontFamily: 'var(--font-serif)', lineHeight: 1.5, color: ink,
              textAlign: 'justify', textJustify: 'inter-ideograph' as never,
              overflowY: 'auto', userSelect: 'text', pointerEvents: 'auto',
            }}
          >
            {splitPlaceholders(b.target, b.placeholders ?? []).map((s, i) => (
              <span
                key={i}
                style={
                  s.kind === 'formula' ? { fontStyle: 'italic' }
                    : s.kind === 'inline-code' ? { fontFamily: 'var(--font-mono)' }
                      : undefined
                }
              >
                {s.text}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
