import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Highlight, HighlightSegment, Note } from '../../../../shared/pdfSidecar';
import { NavIcon } from '../../../shared';
import { HIGHLIGHT_FILL, NOTE_FONT_SIZE, NOTE_INK, STROKE_WIDTH } from './annotationInks';
import { usePdfAnnotationStore, type Tool } from './pdfAnnotationStore';
import { straightSegment, type Point } from './straightenStroke';
import type { TextLine } from './textLines';

export type EnsureLines = (page: number) => Promise<TextLine[]>;

export type LayerProps = {
  tabId: string;
  page: number;
  pageWidth: number;    // scale 1 的页尺寸（视口坐标单位）
  pageHeight: number;
  layerScale: number;   // 所在清晰层的已提交缩放；HTML 部分要乘它，SVG 靠 viewBox 自动换算
  ensureLines: EnsureLines;
};

export function segmentPath(s: HighlightSegment): string {
  if (s.kind === 'line') return `M${s.x1} ${s.y}L${s.x2} ${s.y}`;
  return s.points.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('');
}

function bbox(h: Highlight): { x: number; y: number; w: number; h: number } {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of h.segments) {
    const pts: [number, number][] = s.kind === 'line' ? [[s.x1, s.y], [s.x2, s.y]] : s.points;
    for (const [x, y] of pts) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
  }
  const pad = STROKE_WIDTH[h.width] / 2 + 2;
  return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
}

export function HighlightGlyph({ h, selected }: { h: Highlight; selected: boolean }) {
  const box = selected ? bbox(h) : null;
  return (
    <g data-annotation-id={h.id} data-testid={`pdf-highlight-${h.id}`}>
      {h.segments.map((s, i) => (
        <path
          key={i} d={segmentPath(s)} fill="none"
          stroke={HIGHLIGHT_FILL[h.color]} strokeWidth={STROKE_WIDTH[h.width]}
          strokeLinecap="round" strokeLinejoin="round"
          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        />
      ))}
      {box && (
        <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={3} fill="none"
          stroke="oklch(0.42 0.10 250)" strokeWidth={1} strokeDasharray="3 2" style={{ pointerEvents: 'none' }} />
      )}
    </g>
  );
}

type ToPage = (e: ReactPointerEvent) => Point;
const DRAG_THRESHOLD = 4;
const GRIP = 18;   // 文字注左上角的拖动把手边长（scale 1 下）

// 高亮笔的鼠标指针：一支记号笔，笔尖对准热点。十字准星是给「精确取点」用的，与记号笔的手感不符。
// 先用纸色描一层粗轮廓，压在黑字上也看得清。图像走 data URI，颜色只用 hex —— 光标位图不在 CSS 上下文里，
// oklch() 这类颜色函数在这里不保证认。笔形取 Lucide 的 highlighter（与胶囊上那颗图标同源）。
const MARKER_TIP = 'm9 11-6 6v3h9l3-3';
const MARKER_BODY = 'm22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4';
const MARKER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">`
  + `<g stroke="#fffdf7" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">`
  + `<path d="${MARKER_TIP}"/><path d="${MARKER_BODY}"/></g>`
  + `<path d="${MARKER_TIP}" fill="#fffdf7" stroke="#2b2721" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  + `<path d="${MARKER_BODY}" stroke="#2b2721" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const MARKER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(MARKER_SVG)}") 3 21, crosshair`;

// 输入中的草稿按 note id 记在这张模块级表里（spec §6.2）：缩放顶替会把 layers[0] 换成新的 Layer，
// 整棵覆盖层子树（含 NoteBox）随 React key 变化而重挂，textarea 的组件内 state 会丢；不能改用「卸载时提交」
// 来兜底——src/renderer/main.tsx 开了 StrictMode，dev 下挂载效果会双调用一次，卸载时提交会把每个刚创建、
// 还是空文本的新笔记误提交成「清空即删除」，在 dev 里把新建笔记直接干掉。改成模块级表：挂载时从表里
// 恢复草稿，提交/丢弃时清表，不依赖卸载时机。
const noteDrafts = new Map<string, string>();

// 刚落下、还没提交过的笔记：挂载时自动聚焦，但**不进选中态**——选中会弹出改样式浮条，而插入时不该弹，
// 第二次点它才弹（用户反馈 5，与高亮笔一致）。和草稿表一样放模块级，缩放顶替重挂之后照样认得这条 id。
const noteAutoFocus = new Set<string>();

export function NoteBox({ tabId, n, layerScale, selected, tool, toPage }: {
  tabId: string; n: Note; layerScale: number; selected: boolean; tool: Tool; toPage: ToPage;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => noteDrafts.get(n.id) ?? n.text);
  const [hover, setHover] = useState(false);                  // 悬停时显虚线框，让空白处的笔记有边界可循
  const [offset, setOffset] = useState<Point | null>(null);   // 拖动中的临时位移
  const drag = useRef<{ start: Point; origin: { x: number; y: number } } | null>(null);

  // 挂载时若草稿表里还留着这条 id 的草稿（刚经历一次缩放顶替的重挂），不要用 n.text 覆盖它；
  // 其余情况（外部改动，如撤销/重做把 doc 换回旧快照）照常跟随 n.text。
  useEffect(() => { if (!noteDrafts.has(n.id)) setText(n.text); }, [n.text, n.id]);
  // 刚新建的框自动聚焦（它没被选中，所以不弹浮条）；已有的框在被选中时聚焦，落下光标。
  useEffect(() => {
    if (noteAutoFocus.has(n.id) || (selected && tool !== 'highlight')) ref.current?.focus();
  }, [selected, tool, n.id]);

  const autosize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(() => { autosize(); }, [text, layerScale, n.size, n.width, autosize]);

  const commit = () => {
    const st = usePdfAnnotationStore.getState();
    noteDrafts.delete(n.id);     // 提交或丢弃都清草稿，不然下次挂载会误读已经交代过的旧草稿
    noteAutoFocus.delete(n.id);  // 交代过一次之后就不再是「刚落下的新框」，别再抢焦点
    if (text.trim() === '') {
      // 已提交过的笔记（n.text 非空）被清空 = 删除：走 remove，压快照、可撤销。
      // 从未提交过的笔记（n.text 仍是新建时的空串）清空 = 放弃：走 discardNote，不入撤销栈——
      // 它在撤销栈里本来就不存在过一条「有文本」的记录，没有『删除』可言（spec §6.1/§7.4）。
      if (n.text !== '') st.remove(tabId, n.id);
      else st.discardNote(tabId, n.id);
    } else if (text !== n.text) {
      st.commitNoteText(tabId, n.id, text);
    }
  };

  // 点框body只选中、不拖：框里是文本，按住拖该是选字（原生行为）。挪位置走左上角那个把手，
  // 意图明确、不跟选字抢手势（用户反馈的交互设计问题）。
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === 'highlight' || e.button !== 0) return;
    e.stopPropagation();   // 根层不要把这一下当成「点空白取消选中」，也不要当成「在这儿新建一个框」
    usePdfAnnotationStore.getState().select(tabId, n.id);
  };
  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    usePdfAnnotationStore.getState().select(tabId, n.id);
    ref.current?.blur();   // 拖动期间不编辑；blur 顺带把已输入的文本提交掉
    drag.current = { start: toPage(e), origin: { x: n.x, y: n.y } };
    e.currentTarget.setPointerCapture(e.pointerId);   // 把手上按下即捕获：不需要阈值，意图已经明确
  };
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toPage(e);
    setOffset([p[0] - d.start[0], p[1] - d.start[1]]);
  };
  const onGripUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    // touch/pen 手势在 pointercancel 时浏览器已经自行释放了捕获，这里若还去 release 会抛异常（Chromium）
    const el = e.currentTarget;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const p = toPage(e);
    setOffset(null);
    usePdfAnnotationStore.getState().moveNote(tabId, n.id, d.origin.x + p[0] - d.start[0], d.origin.y + p[1] - d.start[1]);
  };

  const x = n.x + (offset?.[0] ?? 0);
  const y = n.y + (offset?.[1] ?? 0);
  const frame = (selected || hover) && tool !== 'highlight';   // 虚线框与把手同时出现
  return (
    <div
      data-annotation-id={n.id} data-testid={`pdf-note-${n.id}`}
      className="font-serif"
      onPointerDown={onPointerDown}
      onPointerEnter={() => { if (tool !== 'highlight') setHover(true); }}
      onPointerLeave={() => setHover(false)}
      style={{
        position: 'absolute', left: x * layerScale, top: y * layerScale, width: n.width * layerScale,
        fontSize: NOTE_FONT_SIZE[n.size] * layerScale, lineHeight: 1.45, color: NOTE_INK[n.color],
        outline: frame ? '1px dashed oklch(0.42 0.10 250)' : 'none', outlineOffset: 2,
        cursor: tool === 'highlight' ? 'inherit' : 'text',
      }}
    >
      {/* 拖动把手：虚线框出现时它才在（悬停或选中）。位置这件事的手柄挂在对象自己身上，
          浮条只管样式（颜色 / 字号 / 删除）—— 这是所有设计工具的分工，找起来不用猜。
          挂在框的**左侧**而不是上方：上方是选中态浮条的位置，两者都在那儿就会互相盖住（实测过）。
          贴着页面左边距的框往右侧放，免得把手跑到纸外面去。 */}
      {frame && (
        <div
          data-testid={`pdf-note-grip-${n.id}`} title="拖动挪位置"
          onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp}
          style={{
            position: 'absolute', top: 0,
            left: (n.x >= GRIP + 4 ? -(GRIP + 3) : n.width + 3) * layerScale,
            width: GRIP * layerScale, height: GRIP * layerScale,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair)',
            borderRadius: 4 * layerScale, color: 'var(--color-ink-soft)',
            cursor: 'grab', touchAction: 'none',
          }}
        >
          <NavIcon name="grip-vertical" size={13 * layerScale} />
        </div>
      )}
      <textarea
        ref={ref} data-testid={`pdf-note-input-${n.id}`}
        value={text} rows={1} readOnly={tool === 'highlight'}
        onChange={(e) => { setText(e.target.value); noteDrafts.set(n.id, e.target.value); }} onBlur={commit}
        style={{
          display: 'block', width: '100%', border: 'none', background: 'transparent', resize: 'none',
          padding: 0, margin: 0, outline: 'none', overflow: 'hidden',
          fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit', color: 'inherit',
          pointerEvents: tool === 'highlight' ? 'none' : 'auto',
        }}
      />
    </div>
  );
}

/** 每页一层：SVG 画高亮（multiply），HTML 画文字注；按当前工具处理指针（spec §7.3–§7.5）。 */
export function PdfAnnotationLayer({ tabId, page, pageWidth, pageHeight, layerScale, ensureLines }: LayerProps) {
  const annotations = usePdfAnnotationStore((s) => s.buckets[tabId]?.doc?.annotations);
  const selectedId = usePdfAnnotationStore((s) => s.buckets[tabId]?.selectedId ?? null);
  const tool = usePdfAnnotationStore((s) => s.buckets[tabId]?.tool ?? 'select');
  const hl = usePdfAnnotationStore((s) => s.buckets[tabId]?.hl);
  const noteParams = usePdfAnnotationStore((s) => s.buckets[tabId]?.note);
  const ready = usePdfAnnotationStore((s) => !!s.buckets[tabId]?.doc && !s.buckets[tabId]?.loadError);
  const rootRef = useRef<HTMLDivElement>(null);
  // 一笔只记起点与当前点：直线由这两点加行表算出来（spec §6.3），不再攒采样点。
  const drawing = useRef<{ from: Point; to: Point; lines: TextLine[]; ready: Promise<TextLine[]> } | null>(null);
  const press = useRef<Point | null>(null);
  const [live, setLive] = useState<HighlightSegment | null>(null);
  const mine = (annotations ?? []).filter((a) => a.page === page);

  // 页坐标 = 相对页元素的比例 × scale 1 的页尺寸；只依赖 boundingClientRect，不引用缩放值（spec §6.2）
  const toPage = useCallback((e: ReactPointerEvent): Point => {
    const r = rootRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * pageWidth, ((e.clientY - r.top) / r.height) * pageHeight];
  }, [pageWidth, pageHeight]);

  // 按住期间每一帧都按「起点 + 当前点 + 行表」重算预览：屏幕上显示的就是松手后落下的那条
  const refreshLive = useCallback(() => {
    const d = drawing.current;
    setLive(d ? straightSegment(d.from, d.to, d.lines) : null);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!ready || e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest('textarea')) return;
    const p = toPage(e);
    const st = usePdfAnnotationStore.getState();
    // 第一次在页面上落笔就收起参数卡片（用户反馈 3）；已经收起时不再多发一次 set
    if (st.buckets[tabId]?.cardOpen) st.closeCard(tabId);
    if (tool === 'highlight') {
      e.preventDefault();
      rootRef.current!.setPointerCapture(e.pointerId);
      const ready = ensureLines(page);
      drawing.current = { from: p, to: p, lines: [], ready };
      setLive(null);
      // 行表是异步取的：没到之前预览按「没有行」画直连线，到了立刻重算一次贴上去
      void ready.then((ls) => { if (drawing.current) { drawing.current.lines = ls; refreshLive(); } });
      return;
    }
    // 文字注工具下点在空白处：要新建一个框，先把旧的选中放掉（浮条不该还指着上一个框）
    if (tool === 'note') { st.select(tabId, null); press.current = p; return; }
    const hit = target.closest<HTMLElement>('[data-annotation-id]');
    st.select(tabId, hit?.dataset.annotationId ?? null);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drawing.current;
    if (!d) return;
    d.to = toPage(e);
    refreshLive();
  };
  const onPointerUp = async (e: ReactPointerEvent<HTMLDivElement>) => {
    const st = usePdfAnnotationStore.getState();
    if (drawing.current) {
      const d = drawing.current;
      d.to = toPage(e);
      drawing.current = null;
      setLive(null);
      // touch/pen 手势在 pointercancel 时浏览器已经自行释放了捕获，这里若还去 release 会抛异常（Chromium）
      if (rootRef.current?.hasPointerCapture(e.pointerId)) rootRef.current.releasePointerCapture(e.pointerId);
      // 第一笔可能赶在行表到位之前就松手了，这时补等一下——落盘的那条必须贴行
      const lines = d.lines.length > 0 ? d.lines : await d.ready;
      const seg = straightSegment(d.from, d.to, lines);
      if (!seg || !hl) return;
      st.addHighlight(tabId, {
        id: crypto.randomUUID(), type: 'highlight', page,
        color: hl.color, width: hl.width, segments: [seg], createdAt: new Date().toISOString(),
      });
      return;
    }
    if (tool === 'note' && press.current && noteParams) {
      const p = toPage(e);
      const start = press.current;
      press.current = null;
      if (Math.hypot(p[0] - start[0], p[1] - start[1]) >= DRAG_THRESHOLD) return;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      // 先登记自动聚焦再落框：NoteBox 一挂载就照着这张表抢焦点，不必经过选中态（用户反馈 5）
      noteAutoFocus.add(id);
      st.addNote(tabId, {
        id, type: 'note', page, color: noteParams.color, size: noteParams.size,
        x: p[0], y: p[1], width: Math.max(120, pageWidth * 0.4), text: '', createdAt: now, updatedAt: now,
      });
    }
  };

  return (
    <div
      ref={rootRef} data-testid={`pdf-annotation-layer-${page}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={(e) => { void onPointerUp(e); }}
      // pointercancel 也交给 onPointerUp：手势被系统打断时仍按「抬手」结算这一笔（吸附或丢弃），不留半笔（spec §7.3）
      onPointerCancel={(e) => { void onPointerUp(e); }}
      style={{
        position: 'absolute', inset: 0,
        // 只有高亮笔工具下才吞掉触摸滚动（要接管手势画笔画）；其余工具下让触摸照常滚动阅读（item 8）
        touchAction: tool === 'highlight' ? 'none' : 'auto',
        cursor: tool === 'highlight' ? MARKER_CURSOR : tool === 'note' ? 'text' : 'default',
      }}
    >
      <svg
        viewBox={`0 0 ${pageWidth} ${pageHeight}`} width="100%" height="100%"
        style={{ position: 'absolute', inset: 0, mixBlendMode: 'multiply', pointerEvents: 'none', overflow: 'visible' }}
      >
        {mine.map((a) => (a.type === 'highlight' ? <HighlightGlyph key={a.id} h={a} selected={a.id === selectedId} /> : null))}
        {live && hl && (
          <path d={segmentPath(live)} fill="none"
            stroke={HIGHLIGHT_FILL[hl.color]} strokeWidth={STROKE_WIDTH[hl.width]} strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
      {mine.map((a) => (a.type === 'note'
        ? <NoteBox key={a.id} tabId={tabId} n={a} layerScale={layerScale} selected={a.id === selectedId} tool={tool} toPage={toPage} />
        : null))}
    </div>
  );
}
