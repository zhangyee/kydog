import type { HighlightColor, Level, NoteColor } from '../../../../shared/pdfSidecar';
import { HIGHLIGHT_COLORS, LEVELS, NOTE_COLORS, NOTE_FONT_SIZE, STROKE_PREVIEW, SWATCH } from './annotationInks';
import { usePdfAnnotationStore } from './pdfAnnotationStore';

export const PANEL_SHADOW = '0 12px 32px rgba(50,35,20,0.14), 0 2px 6px rgba(50,35,20,0.08)';
const WIDTH = 184;

type Props = { tabId: string; kind: 'highlight' | 'note'; centerX: number };

/** 锚在当前工具按钮正上方的参数卡片：一行颜色、一行粗细或字号（spec §7.2）。centerX 相对胶囊内层。 */
export function PdfToolCard({ tabId, kind, centerX }: Props) {
  const hl = usePdfAnnotationStore((s) => s.buckets[tabId]?.hl);
  const note = usePdfAnnotationStore((s) => s.buckets[tabId]?.note);
  const st = usePdfAnnotationStore.getState;
  const colors: Array<HighlightColor | NoteColor> = kind === 'highlight' ? HIGHLIGHT_COLORS : NOTE_COLORS;
  const selColor = kind === 'highlight' ? hl?.color : note?.color;
  const selLevel = kind === 'highlight' ? hl?.width : note?.size;
  const pickColor = (c: HighlightColor | NoteColor) => {
    if (kind === 'highlight') st().setHlParams(tabId, { color: c as HighlightColor });
    else st().setNoteParams(tabId, { color: c as NoteColor });
  };
  const pickLevel = (lv: Level) => {
    if (kind === 'highlight') st().setHlParams(tabId, { width: lv });
    else st().setNoteParams(tabId, { size: lv });
  };
  return (
    <div
      data-testid={`pdf-tool-card-${kind}`}
      style={{
        position: 'absolute', left: centerX - WIDTH / 2, bottom: 'calc(100% + 10px)', width: WIDTH,
        padding: '12px 12px 10px', borderRadius: 8,
        background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair)', boxShadow: PANEL_SHADOW,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 8px' }}>
        {colors.map((c) => (
          <button
            key={c} type="button" data-testid={`pdf-color-${c}`} aria-label={c}
            onClick={() => pickColor(c)}
            style={{
              width: 20, height: 20, borderRadius: 999, border: 'none', padding: 0, cursor: 'pointer',
              background: SWATCH[c],
              boxShadow: c === selColor ? '0 0 0 2px var(--color-paper), 0 0 0 3.5px var(--color-ink)' : 'none',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        {LEVELS.map((lv) => (
          <button
            key={lv} type="button" data-testid={`pdf-level-${lv}`} aria-label={`档位 ${lv}`}
            onClick={() => pickLevel(lv)}
            style={{
              width: 50, height: kind === 'highlight' ? 28 : 30, borderRadius: 6, border: 'none', cursor: 'pointer',
              padding: kind === 'highlight' ? 0 : '0 0 5px',
              background: lv === selLevel ? 'var(--color-hover-bg)' : 'transparent',
              display: 'flex', alignItems: kind === 'highlight' ? 'center' : 'flex-end', justifyContent: 'center',
            }}
          >
            {kind === 'highlight'
              ? <span style={{ display: 'block', width: 30, height: STROKE_PREVIEW[lv], borderRadius: 999, background: SWATCH[selColor ?? 'amber'] }} />
              : <span className="font-serif" style={{ fontSize: NOTE_FONT_SIZE[lv], lineHeight: 1, color: SWATCH.ink }}>A</span>}
          </button>
        ))}
      </div>
      <div
        style={{
          position: 'absolute', left: WIDTH / 2 - 5, bottom: -6, width: 10, height: 10,
          background: 'var(--color-paper)',
          borderRight: '0.5px solid var(--color-ink-hair)', borderBottom: '0.5px solid var(--color-ink-hair)',
          transform: 'rotate(45deg)',
        }}
      />
    </div>
  );
}
