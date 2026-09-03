import type { Highlight, HighlightSegment, Note } from '../../../../shared/pdfSidecar';
import { HIGHLIGHT_FILL, NOTE_FONT_SIZE, NOTE_INK, STROKE_WIDTH } from './annotationInks';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
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

export function NoteBox({ n, layerScale, selected }: { n: Note; layerScale: number; selected: boolean }) {
  return (
    <div
      data-annotation-id={n.id} data-testid={`pdf-note-${n.id}`}
      className="font-serif"
      style={{
        position: 'absolute', left: n.x * layerScale, top: n.y * layerScale, width: n.width * layerScale,
        fontSize: NOTE_FONT_SIZE[n.size] * layerScale, lineHeight: 1.45, color: NOTE_INK[n.color],
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        outline: selected ? '1px dashed oklch(0.42 0.10 250)' : 'none', outlineOffset: 2,
      }}
    >
      {n.text}
    </div>
  );
}

/** 每页一层：SVG 画高亮（multiply），HTML 画文字注。放在清晰层的缩放容器内，跟着 zoom 与 layer.scale 一起变。 */
export function PdfAnnotationLayer({ tabId, page, pageWidth, pageHeight, layerScale }: LayerProps) {
  const annotations = usePdfAnnotationStore((s) => s.buckets[tabId]?.doc?.annotations);
  const selectedId = usePdfAnnotationStore((s) => s.buckets[tabId]?.selectedId ?? null);
  const mine = (annotations ?? []).filter((a) => a.page === page);
  return (
    <div data-testid={`pdf-annotation-layer-${page}`} style={{ position: 'absolute', inset: 0 }}>
      <svg
        viewBox={`0 0 ${pageWidth} ${pageHeight}`} width="100%" height="100%"
        style={{ position: 'absolute', inset: 0, mixBlendMode: 'multiply', pointerEvents: 'none', overflow: 'visible' }}
      >
        {mine.map((a) => (a.type === 'highlight' ? <HighlightGlyph key={a.id} h={a} selected={a.id === selectedId} /> : null))}
      </svg>
      {mine.map((a) => (a.type === 'note' ? <NoteBox key={a.id} n={a} layerScale={layerScale} selected={a.id === selectedId} /> : null))}
    </div>
  );
}
