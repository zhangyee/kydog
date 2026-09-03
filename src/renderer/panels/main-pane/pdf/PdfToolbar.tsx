import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { NavIcon, Tooltip, type NavIconName } from '../../../shared';
import { usePdfAnnotationStore, type Tool } from './pdfAnnotationStore';
import { PANEL_SHADOW, PdfToolCard } from './PdfToolCard';

function ToolButton({ icon, tip, active, disabled, onClick, testId, color, btnRef }: {
  icon: NavIconName; tip: string; active?: boolean; disabled?: boolean; onClick: () => void; testId: string;
  color?: string; btnRef?: (el: HTMLButtonElement | null) => void;
}) {
  const btn = (
    <button
      ref={btnRef} type="button" data-testid={testId} disabled={disabled} aria-label={tip} onClick={onClick}
      className="inline-flex items-center justify-center rounded-md transition-colors hover:bg-[color:var(--color-hover-bg)] disabled:opacity-50"
      style={{
        width: 28, height: 28, border: 'none', padding: 0,
        background: active ? 'var(--color-hover-bg)' : 'transparent',
        color: color ?? (active ? 'var(--color-ink)' : 'var(--color-ink-soft)'),
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <NavIcon name={icon} size={15} />
    </button>
  );
  return disabled ? btn : <Tooltip content={tip} placement="top">{btn}</Tooltip>;
}

function Divider(): ReactNode {
  return <div style={{ width: 0.5, height: 16, background: 'var(--color-ink-hair)', margin: '0 3px', flexShrink: 0 }} />;
}

type Props = { tabId: string; pageLabel: string; zoomPct: number };

/** 底部居中的胶囊：选择 · 高亮 · 文字 | 撤销 · 重做 | 翻译（本期禁用） | 读数（spec §7.1）。 */
export function PdfToolbar({ tabId, pageLabel, zoomPct }: Props) {
  const bucket = usePdfAnnotationStore((s) => s.buckets[tabId]);
  const ready = !!bucket?.doc && !bucket.loadError;
  const tool: Tool = bucket?.tool ?? 'select';
  const st = usePdfAnnotationStore.getState;
  const pillRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [anchorX, setAnchorX] = useState<number | null>(null);

  // 卡片锚点：当前工具按钮相对胶囊内层的中心 x
  useLayoutEffect(() => {
    if (tool === 'select' || !ready) { setAnchorX(null); return; }
    const btn = btnRefs.current[tool];
    const pill = pillRef.current;
    if (!btn || !pill) { setAnchorX(null); return; }
    setAnchorX(btn.offsetLeft - pill.clientLeft + btn.offsetWidth / 2);
  }, [tool, ready]);

  return (
    <div
      data-testid={`pdf-toolbar-${tabId}`}
      style={{ position: 'absolute', left: 0, right: 0, bottom: 16, display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 5 }}
    >
      <div
        ref={pillRef}
        style={{
          position: 'relative', display: 'flex', alignItems: 'center', gap: 2, padding: '4px 6px', borderRadius: 999,
          background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair)', boxShadow: PANEL_SHADOW,
          pointerEvents: 'auto',
        }}
      >
        <ToolButton icon="mouse-pointer-2" tip="选择 · V" active={tool === 'select'} disabled={!ready}
          onClick={() => st().setTool(tabId, 'select')} testId="pdf-tool-select" />
        <ToolButton icon="highlighter" tip="高亮笔 · H" active={tool === 'highlight'} disabled={!ready}
          onClick={() => st().setTool(tabId, 'highlight')} testId="pdf-tool-highlight"
          btnRef={(el) => { btnRefs.current.highlight = el; }} />
        <ToolButton icon="type" tip="文字注 · T" active={tool === 'note'} disabled={!ready}
          onClick={() => st().setTool(tabId, 'note')} testId="pdf-tool-note"
          btnRef={(el) => { btnRefs.current.note = el; }} />
        <Divider />
        <ToolButton icon="undo-2" tip="撤销 · ⌘Z" disabled={!ready || !bucket?.undo.length}
          onClick={() => st().undo(tabId)} testId="pdf-undo" />
        <ToolButton icon="redo-2" tip="重做 · ⇧⌘Z" disabled={!ready || !bucket?.redo.length}
          onClick={() => st().redo(tabId)} testId="pdf-redo" />
        <Divider />
        <ToolButton icon="languages" tip="翻译对照 · 即将开放" disabled onClick={() => {}} testId="pdf-translate" />
        <Divider />
        <div
          className="font-mono" data-testid="pdf-readout"
          style={{ width: 92, textAlign: 'center', fontSize: 10, color: 'var(--color-ink-faint)', whiteSpace: 'nowrap' }}
        >
          {pageLabel} · {zoomPct}%
        </div>
        {anchorX !== null && tool !== 'select' && (
          <PdfToolCard tabId={tabId} kind={tool} centerX={anchorX} />
        )}
      </div>
    </div>
  );
}
