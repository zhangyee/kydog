import type { HighlightColor, Level, NoteColor } from '../../../../shared/pdfSidecar';
import { NavIcon } from '../../../shared';
import {
  HIGHLIGHT_COLORS, HIGHLIGHT_SWATCH, LEVELS, NOTE_COLORS, NOTE_SIZE_PREVIEW, STROKE_PREVIEW, SWATCH,
} from './annotationInks';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import { PANEL_SHADOW } from './PdfToolCard';

export type Anchor = { left: number; top: number; bottom: number; width: number };
const BAR_HEIGHT = 32;
const GAP = 6;

/** 选中态浮条：颜色、粗细或字号、删除（spec §7.5）。anchor 是选中项相对外层容器的框。 */
export function PdfSelectionBar({ tabId, anchor }: { tabId: string; anchor: Anchor }) {
  const selected = usePdfAnnotationStore((s) => {
    const b = s.buckets[tabId];
    return b?.doc?.annotations.find((a) => a.id === b.selectedId) ?? null;
  });
  if (!selected) return null;
  const st = usePdfAnnotationStore.getState;
  const isHl = selected.type === 'highlight';
  const colors: Array<HighlightColor | NoteColor> = isHl ? HIGHLIGHT_COLORS : NOTE_COLORS;
  const level: Level = isHl ? selected.width : selected.size;
  // 高亮的黄绿另有一套亮色（见 annotationInks.ts）；文字注仍用语义色的暗调，那是要当正文读的
  const swatch = (c: HighlightColor | NoteColor): string =>
    (isHl ? HIGHLIGHT_SWATCH[c as HighlightColor] : SWATCH[c]);
  const top = anchor.top - GAP - BAR_HEIGHT >= 0 ? anchor.top - GAP - BAR_HEIGHT : anchor.bottom + GAP;
  return (
    <div
      data-testid="pdf-selection-bar"
      style={{
        position: 'absolute', left: anchor.left + anchor.width / 2, top, transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 8, zIndex: 6,
        background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair)', boxShadow: PANEL_SHADOW,
      }}
    >
      {colors.map((c) => (
        <button
          key={c} type="button" data-testid={`pdf-selection-color-${c}`} aria-label={c}
          onClick={() => st().restyle(tabId, selected.id, { color: c })}
          style={{
            width: 12, height: 12, borderRadius: 999, border: 'none', padding: 0, cursor: 'pointer', background: swatch(c),
            boxShadow: c === selected.color ? '0 0 0 2px var(--color-paper), 0 0 0 3px var(--color-ink)' : 'none',
          }}
        />
      ))}
      <div style={{ width: 0.5, height: 16, background: 'var(--color-ink-hair)', margin: '0 3px' }} />
      {LEVELS.map((lv) => (
        <button
          key={lv} type="button" data-testid={`pdf-selection-level-${lv}`} aria-label={`档位 ${lv}`}
          onClick={() => st().restyle(tabId, selected.id, { level: lv })}
          style={{
            width: 30, height: 22, borderRadius: 5, border: 'none', padding: 0, cursor: 'pointer',
            background: lv === level ? 'var(--color-hover-bg)' : 'transparent',
            display: 'flex', alignItems: isHl ? 'center' : 'flex-end', justifyContent: 'center',
          }}
        >
          {isHl
            ? <span style={{ display: 'block', width: 18, height: STROKE_PREVIEW[lv], borderRadius: 999, background: swatch(selected.color) }} />
            : <span className="font-serif" style={{ fontSize: NOTE_SIZE_PREVIEW[lv] * 0.8, lineHeight: 1, color: SWATCH.ink, paddingBottom: 3 }}>A</span>}
        </button>
      ))}
      <div style={{ width: 0.5, height: 16, background: 'var(--color-ink-hair)', margin: '0 3px' }} />
      <button
        type="button" data-testid="pdf-selection-delete" aria-label="删除"
        onClick={() => st().remove(tabId, selected.id)}
        className="inline-flex items-center justify-center rounded-md hover:bg-[color:var(--color-hover-bg)]"
        style={{ width: 22, height: 22, border: 'none', padding: 0, background: 'transparent', color: 'var(--color-ink-soft)', cursor: 'pointer' }}
      >
        <NavIcon name="trash-2" size={13} />
      </button>
    </div>
  );
}
