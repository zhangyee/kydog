import { useEffect, useRef, useState } from 'react';
import type { Block } from '../../../../shared/zhSidecar';
import { fitFontScale } from './fitFontScale';
import { inkForBackground, toCss } from './inkForBackground';
import type { RGB } from './pageBackground';
import { splitPlaceholders, type Segment } from './renderPlaceholders';

const MIN_RATIO = 0.5;
const WEIGHT = (kind: Block['kind']) => (kind === 'title' ? 600 : 400);
const SIZE_MUL = (kind: Block['kind']) => (kind === 'caption' ? 0.9 : 1);

/**
 * fontScale 缓存。
 *
 * 模块级、不落盘——agent 写边车时算不出这个值，让它成为契约字段只会逼 agent 编一个。
 * 模块级 Map 在同一个渲染进程内是单例，而应用支持同时打开多个 PDF tab（每个 tab 各挂一份
 * TranslationBlocks，都写同一个 fitCache）：block.id 按 spec 只保证「文档内」唯一，两篇不同
 * 论文完全可能都有 `p1-b01`。key 必须带上 docKey（调用方传 tab.id，= 文件绝对路径，天然
 * 跨文档唯一）才能避免后打开的文档撞上前一份文档缓存的 fontScale。
 *
 * 分两层（域 → key → ratio）而不是一张扁平表：key 里含全文 measureText 与 bbox 之后，agent
 * 每重译一次就是一整代**全新的** key，旧代再也不会被命中——扁平表下它们只是永不释放的死数据
 * （单条约 0.5–1 KB，30 页论文一代约 450 条，而本期的主工作流恰恰是「让 agent 反复重译同一
 * 篇」，KyDog 又是会开好几天的桌面应用）。分层之后一次测量就能按「域」整代换掉。
 *
 * 域是 (docKey, page)，不是 docKey：TranslationBlocks 是**按页**挂载的（blocksByPage 已经把
 * 块分好桶），一趟测量只看得见一页的块。按 docKey 整代换会把同一文档其余页的条目当成「本轮
 * 没出现」而误删——那些页只是没在这一趟里被测，不是失效了。
 */
const fitCache = new Map<string, Map<string, number>>();

/** 淘汰域。见 fitCache 的注释：一趟测量覆盖的正好是一页。 */
export function fitCacheDomain(docKey: string, page: number): string {
  return JSON.stringify([docKey, page]);
}

/**
 * 一趟测量的缓存句柄。
 *
 * 淘汰按**精确集合差**做，而且是由构造成立的：读到的（`get` 命中）与新算的（`set`）都记进这一
 * 代的表，`commit` 拿它整个替掉旧表——「本轮没出现过的条目」于是自然不在新表里。判据是集合本身，
 * 不是条目数、不是时间、不是访问顺序（LRU / maxSize 那类阈值会给这份缓存引进一个近似判据，
 * 正是 CLAUDE.md 那条原则要避开的东西）。
 *
 * 只有跑完整趟才 `commit`：换页 / 换文档 / 重译中途作废的那一趟（alive=false）压根不落地，
 * 半代结果不会替掉完整的上一代。
 */
export type FitRound = {
  get(key: string): number | undefined;
  set(key: string, ratio: number): void;
  commit(): void;
};

export function beginFitRound(domain: string): FitRound {
  const prev = fitCache.get(domain);
  const next = new Map<string, number>();
  return {
    get(key) {
      const hit = prev?.get(key);
      if (hit !== undefined) next.set(key, hit); // 命中 = 本轮也用到了，带进新一代
      return hit;
    },
    set(key, ratio) { next.set(key, ratio); },
    commit() {
      if (next.size > 0) fitCache.set(domain, next);
      else fitCache.delete(domain); // 整页的块都没了：连域一起收掉，不留空表
    },
  };
}

/**
 * 缓存 key 的构造。
 *
 * key 里必须带上**决定这个比例的那几个量本身**：measureText（真正被排版的那串字）、块的
 * bbox（`b.width` 是测量宿主的宽、`b.height` 是要装进去的高）、以及测量用的 font。这几项
 * 加上「同一个 measure 实现」就是 ratio 的全部输入，一项不落。
 *
 * 原先的 key 是 `docKey|blockId|font`——拿 `block.id` 当这些量的身份代理。这在本期的主工作流
 * 下是错的：agent 重新翻译同一份 PDF 时源字节没变（`source.sha256` 仍匹配、version 仍 ok、
 * dual 保持），blocks 却换成了新的，而 `b.id` 与 `b.fontSize` 通常不变——于是新译文命中旧
 * 缓存，继续用按旧文本算出来的比例：偏大就溢出成块内滚动条，偏小就留一大片空白。fitCache 又是
 * 模块级、`docKey` 是文件路径，关掉 tab 重开同一个文件照样命中，只有重启应用才清得掉。
 *
 * 也是 CLAUDE.md 那条原则的一次应用：判定要基于协议层事实（这里就是 measure 的那几个入参），
 * 不拿 id 这种身份代理去替。
 *
 * 用 JSON.stringify 一个数组、不用 `a|b|c` 拼串：路径与译文里都可能出现分隔符，拼串会让
 * 「不同的入参组合」撞成同一个 key。
 */
export function fitCacheKey(
  docKey: string, blockId: string, font: string, measureText: string, width: number, height: number,
): string {
  return JSON.stringify([docKey, blockId, font, width, height, measureText]);
}

/**
 * 一个 segment 在排版上与普通正文的差别。**测量与渲染共用这一份**：measureFit 把它 Object.assign
 * 到宿主里的 span 上，下面的渲染把它当 React style 用。
 *
 * 分成两份写过一次，代价是测量宿主用纯文本（`host.textContent = measureText`）、渲染却把同一
 * 串文本切成带 italic / 等宽字体的 span——等宽字体通常更宽，含 inline-code 的块量出来的行数
 * 少于真正画出来的行数，于是「刚好装下」的比例一渲染就溢出成块内滚动条。
 *
 * 写成 Record 而不是 if/else 链还有个好处：Placeholder 加了新 kind，tsc 会逼这里补上。
 */
const SEG_STYLE: Record<Segment['kind'], { fontStyle?: string; fontFamily?: string }> = {
  text: {},
  citation: {},
  formula: { fontStyle: 'italic' },
  'inline-code': { fontFamily: 'var(--font-mono)' },
};

/** 把 segments 按渲染时的同一套 span 结构填进测量宿主。 */
function fillHost(host: HTMLElement, segs: Segment[]) {
  host.textContent = '';
  for (const s of segs) {
    const el = document.createElement('span');
    Object.assign(el.style, SEG_STYLE[s.kind]);
    el.textContent = s.text;
    host.appendChild(el);
  }
}

/**
 * 等这一次测量真正会用到的字体族到位。
 *
 * 字族从宿主与它的 span 上现读（`getComputedStyle(...).fontFamily`），不写死某一个族名：
 * `--font-serif` 是一整串回退栈（Source Serif 4 Variable / Noto Serif SC / Songti SC / Georgia），
 * 拉丁文与数字实际命中的是栈里靠前的那个，只等 `"Noto Serif SC"` 等不到它；inline-code 段
 * 用的是 `--font-mono`，更是另一条栈。`document.fonts.load` 接受完整的 font shorthand（含
 * 整串 family list），会把其中所有匹配到的 face 一并加载。
 *
 * 加载失败不阻断测量：字体本来就有回退，量出来的比例可能略偏，但拒绝整块渲染更糟。
 */
async function awaitFonts(host: HTMLElement, weight: number, px: number, text: string) {
  const stacks = new Set<string>([getComputedStyle(host).fontFamily]);
  for (const el of Array.from(host.children)) stacks.add(getComputedStyle(el).fontFamily);
  await Promise.all([...stacks].map(async (family) => {
    try {
      await document.fonts.load(`${weight} ${px}px ${family}`, text);
    } catch {
      /* 无法解析的 font shorthand / 加载失败：按回退字体量，见上 */
    }
  }));
}

/**
 * 在一个隐藏宿主里量一次，得到能装进 maxH 的最大字号比例。
 *
 * 必须先等字体真的到位：@fontsource/noto-serif-sc 是 font-display: swap 且按 unicode-range
 * 分片加载（node_modules/@fontsource/noto-serif-sc/400.css 与 600.css 各自切片），不等就量的
 * 是回退字体，而结果只算一次就被缓存——版面会永久错。等哪些族见 awaitFonts。
 *
 * document.fonts.load 的第二个参数决定加载哪些子集，所以要传测量会真正用到的字符：这里用
 * 占位符已还原的文本（splitPlaceholders 拼接），而不是 b.target 原文——b.target 里还留着
 * `{v1}` 这样的字面 token，用它去请求字体子集，测出来的换行也是按 token 长度、不是按真实
 * 显示文本，两者在公式/引用较长时会明显偏差。
 *
 * 宿主的宽是**未缩放的 `b.width`**、字号是 `px * r`，两者都与当前缩放无关，量出来的比例
 * 因此也与缩放无关（结果又只算一次就进缓存）。宿主上那个 `zoom: 1` 起不到这个作用——CSS
 * `zoom` 是累乘继承的，写 1 只表示「不再额外缩放」，宿主仍处在层容器的 visualScale /
 * layer.scale 之下。
 */
async function measureFit(
  round: FitRound, docKey: string, b: Block, segs: Segment[], measureText: string, host: HTMLElement,
): Promise<number> {
  const px = b.fontSize * SIZE_MUL(b.kind);
  const weight = WEIGHT(b.kind);
  const font = `${weight} ${px}px "Noto Serif SC"`;
  const key = fitCacheKey(docKey, b.id, font, measureText, b.width, b.height);
  const hit = round.get(key);
  if (hit !== undefined) return hit;

  // 先填一次是为了让 awaitFonts 能从真正的 span 上现读字族（它在第一个 await 之前就把
  // getComputedStyle 读完了，这一段与 fillHost 之间没有让出点）。
  fillHost(host, segs);
  await awaitFonts(host, weight, px, measureText);

  // 等完字体**重新落一次宿主状态再量**：宿主是这个组件唯一的一个 DOM 节点，上面那个 await 是
  // 一个让出点。同一个组件的测量 effect 会因为 blocks 换了新数组而重跑（每次重探译文都会产生
  // 新的 doc → 新的 blocksByPage → 新数组），cleanup 只置 alive=false，拦不住已经挂在 await 上
  // 的那一趟——旧 loop 恢复后量到的会是新 loop 刚填进去的内容，然后以**旧内容的正确 key**把这个
  // 错值写进 fitCache，正是这份缓存要消灭的「key 对但值错」。重填之后到 fitFontScale 之间全是
  // 同步的（fitFontScale 的二分本身是同步函数），写与量因此重新变回原子的。
  //
  // 重填走的仍是 fillHost + SEG_STYLE，与渲染同一份 span 结构与字体栈——测量与渲染同源那条不能
  // 因为这次修复而破掉。
  host.style.width = `${b.width}px`;
  host.style.fontWeight = String(weight);
  fillHost(host, segs);

  const ratio = fitFontScale((r) => {
    host.style.fontSize = `${px * r}px`;
    return host.scrollHeight;
  }, b.height, MIN_RATIO);

  round.set(key, ratio);
  return ratio;
}

type Props = {
  /** fitCache key 的文档隔离维度。调用方传 tab.id（= 文件绝对路径，天然跨文档唯一）。 */
  docKey: string;
  /**
   * 这一层挂的是第几页。与 `blocks` 里各块的 `b.page` 同值（blocks 出自 blocksByPage 的同一个
   * `n`），显式传是为了让 fitCache 的淘汰域在**blocks 为空时也有定义**——某一代译文把整页的块
   * 都删掉时，正是要靠这一趟空测量把该页上一代的条目收掉。
   */
  page: number;
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
   *
   * 有一个后果是**有意接受**的，不是漏做：左格渲染失败的页，右格连译文都不显示，整页空白。
   * 链路是左格只在 `onRenderSuccess` 里把 canvas 写进注册表（PdfFileTab 的 LeftCell），
   * `onRenderError` 只调 `onSettled` → `leftCanvas` 恒 null → RightPage 早退、从不调
   * `onBackground` → 这里的 `bg` 恒 null → 译文层永久 hidden。理由同上：那一页底下露出来的是
   * 滚动容器的 paper-deep，按任何颜色推墨色都是猜。
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
export function TranslationBlocks({ blocks, size, rasterScale, bg, docKey, page }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState<Record<string, number>>({});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    const round = beginFitRound(fitCacheDomain(docKey, page));
    void (async () => {
      const out: Record<string, number> = {};
      for (const b of blocks) {
        if (b.target === undefined) continue;
        const segs = splitPlaceholders(b.target, b.placeholders ?? []);
        const measureText = segs.map((s) => s.text).join('');
        out[b.id] = await measureFit(round, docKey, b, segs, measureText, host);
        if (!alive) return; // 换页/换文档中途作废：不把已经量到一半的结果落地
      }
      if (!alive) return;
      setFits(out);
      // 整趟跑完才落地这一代缓存：本轮没出现过的条目随旧表一起被换掉（见 beginFitRound）。
      round.commit();
    })();
    return () => { alive = false; };
  }, [blocks, docKey, page]);

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
        // 左格渲染失败的页 bg 会**恒为** null（onRenderError 不给 leftCanvas），那一页的右格
        // 因此整页空白、连译文都不显示——有意接受的边界，链路见上面 bg 那条 prop 的注释。
        visibility: bg ? undefined : 'hidden',
      }}
    >
      {/* 测量宿主：不可见、不参与布局（绝对定位）、不接收指针事件。
          `zoom: 1` 不是「与缩放无关」的来源——CSS zoom 累乘继承，写 1 只表示「不再额外缩放」，
          这个宿主仍处在层容器的 visualScale / layer.scale 之下；写它只是防止外面某处给宿主
          链路加了 zoom。真正让结果与缩放无关的是 measureFit：宿主按未缩放的 b.width 定宽、
          按 px * r 定字号，两者都不含缩放，而且结果只算一次就进 fitCache。 */}
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
            {/* 与测量宿主同一份 SEG_STYLE、同一套 span 结构（见 fillHost）——两边一分家，
                量出来的行数就不是真正画出来的行数。 */}
            {splitPlaceholders(b.target, b.placeholders ?? []).map((s, i) => (
              <span key={i} style={SEG_STYLE[s.kind]}>{s.text}</span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
