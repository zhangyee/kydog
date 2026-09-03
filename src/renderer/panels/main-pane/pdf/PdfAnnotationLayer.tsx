import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Highlight, HighlightSegment, Note } from '../../../../shared/pdfSidecar';
import { HIGHLIGHT_FILL, NOTE_FONT_SIZE, NOTE_INK, STROKE_WIDTH } from './annotationInks';
import { usePdfAnnotationStore, type Tool } from './pdfAnnotationStore';
import { snapToLines, type Point } from './snapToLines';
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

export function NoteBox({ tabId, n, layerScale, selected, tool, toPage }: {
  tabId: string; n: Note; layerScale: number; selected: boolean; tool: Tool; toPage: ToPage;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(n.text);
  const [offset, setOffset] = useState<Point | null>(null);   // 拖动中的临时位移
  const drag = useRef<{ start: Point; origin: { x: number; y: number }; moving: boolean } | null>(null);

  useEffect(() => { setText(n.text); }, [n.text]);
  useEffect(() => { if (selected && tool !== 'highlight') ref.current?.focus(); }, [selected, tool]);

  const autosize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(() => { autosize(); }, [text, layerScale, n.size, n.width, autosize]);

  const commit = () => {
    const st = usePdfAnnotationStore.getState();
    if (text.trim() === '') st.discardNote(tabId, n.id);
    else if (text !== n.text) st.commitNoteText(tabId, n.id, text);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (tool !== 'select' || e.button !== 0) return;
    e.stopPropagation();   // 根层不要把这一下当成「点空白取消选中」
    usePdfAnnotationStore.getState().select(tabId, n.id);
    drag.current = { start: toPage(e), origin: { x: n.x, y: n.y }, moving: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons === 0) { drag.current = null; return; }   // 手势已经在别处结束（越界/丢事件），别再当悬停算拖动
    const d = drag.current;
    if (!d) return;
    const p = toPage(e);
    const dx = p[0] - d.start[0];
    const dy = p[1] - d.start[1];
    if (!d.moving) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.moving = true;
      ref.current?.blur();   // 拖动期间不选字；blur 会顺带提交文本
      e.currentTarget.setPointerCapture(e.pointerId);   // 越过阈值才捕获，之前的点击照常落在 textarea 上放 caret
    }
    setOffset([dx, dy]);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moving) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const p = toPage(e);
    usePdfAnnotationStore.getState().moveNote(tabId, n.id, d.origin.x + p[0] - d.start[0], d.origin.y + p[1] - d.start[1]);
    setOffset(null);
    ref.current?.focus();
  };

  const x = n.x + (offset?.[0] ?? 0);
  const y = n.y + (offset?.[1] ?? 0);
  return (
    <div
      data-annotation-id={n.id} data-testid={`pdf-note-${n.id}`}
      className="font-serif"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      style={{
        position: 'absolute', left: x * layerScale, top: y * layerScale, width: n.width * layerScale,
        fontSize: NOTE_FONT_SIZE[n.size] * layerScale, lineHeight: 1.45, color: NOTE_INK[n.color],
        outline: selected ? '1px dashed oklch(0.42 0.10 250)' : 'none', outlineOffset: 2,
        cursor: tool === 'select' ? 'text' : 'inherit',
      }}
    >
      <textarea
        ref={ref} data-testid={`pdf-note-input-${n.id}`}
        value={text} rows={1} readOnly={tool === 'highlight'}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
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
  const drawing = useRef<{ points: Point[]; lines: Promise<TextLine[]> } | null>(null);
  const press = useRef<Point | null>(null);
  const [live, setLive] = useState<Point[] | null>(null);
  const mine = (annotations ?? []).filter((a) => a.page === page);

  // 页坐标 = 相对页元素的比例 × scale 1 的页尺寸；只依赖 boundingClientRect，不引用缩放值（spec §6.2）
  const toPage = useCallback((e: ReactPointerEvent): Point => {
    const r = rootRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * pageWidth, ((e.clientY - r.top) / r.height) * pageHeight];
  }, [pageWidth, pageHeight]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!ready || e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest('textarea')) return;
    const p = toPage(e);
    const st = usePdfAnnotationStore.getState();
    if (tool === 'highlight') {
      e.preventDefault();
      rootRef.current!.setPointerCapture(e.pointerId);
      drawing.current = { points: [p], lines: ensureLines(page) };
      setLive([p]);
      return;
    }
    if (tool === 'note') { press.current = p; return; }
    const hit = target.closest<HTMLElement>('[data-annotation-id]');
    st.select(tabId, hit?.dataset.annotationId ?? null);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing.current) return;
    drawing.current.points.push(toPage(e));
    setLive([...drawing.current.points]);
  };
  const onPointerUp = async (e: ReactPointerEvent<HTMLDivElement>) => {
    const st = usePdfAnnotationStore.getState();
    if (drawing.current) {
      const { points, lines } = drawing.current;
      drawing.current = null;
      setLive(null);
      rootRef.current?.releasePointerCapture(e.pointerId);
      const segments = snapToLines(points, await lines);
      if (segments.length === 0 || !hl) return;
      st.addHighlight(tabId, {
        id: crypto.randomUUID(), type: 'highlight', page,
        color: hl.color, width: hl.width, segments, createdAt: new Date().toISOString(),
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
      st.addNote(tabId, {
        id, type: 'note', page, color: noteParams.color, size: noteParams.size,
        x: p[0], y: p[1], width: Math.max(120, pageWidth * 0.4), text: '', createdAt: now, updatedAt: now,
      });
      st.select(tabId, id);
    }
  };

  return (
    <div
      ref={rootRef} data-testid={`pdf-annotation-layer-${page}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={(e) => { void onPointerUp(e); }} onPointerCancel={(e) => { void onPointerUp(e); }}
      style={{
        position: 'absolute', inset: 0, touchAction: 'none',
        cursor: tool === 'highlight' ? 'crosshair' : tool === 'note' ? 'text' : 'default',
      }}
    >
      <svg
        viewBox={`0 0 ${pageWidth} ${pageHeight}`} width="100%" height="100%"
        style={{ position: 'absolute', inset: 0, mixBlendMode: 'multiply', pointerEvents: 'none', overflow: 'visible' }}
      >
        {mine.map((a) => (a.type === 'highlight' ? <HighlightGlyph key={a.id} h={a} selected={a.id === selectedId} /> : null))}
        {live && hl && (
          <path d={segmentPath({ kind: 'path', points: live })} fill="none"
            stroke={HIGHLIGHT_FILL[hl.color]} strokeWidth={STROKE_WIDTH[hl.width]} strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
      {mine.map((a) => (a.type === 'note'
        ? <NoteBox key={a.id} tabId={tabId} n={a} layerScale={layerScale} selected={a.id === selectedId} tool={tool} toPage={toPage} />
        : null))}
    </div>
  );
}
