import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton, NavIcon } from '../../../shared';
import { usePdfAnnotationStore, type Tool } from './pdfAnnotationStore';
import { canToggleDual, translateUiState, usePdfTranslationStore, type TranslateUiState } from './pdfTranslationStore';
import { PANEL_SHADOW, PdfToolCard } from './PdfToolCard';

function Divider(): ReactNode {
  return <div style={{ width: 0.5, height: 16, background: 'var(--color-ink-hair)', margin: '0 3px', flexShrink: 0 }} />;
}

// 四态各自的 tooltip；active 由调用处按 translateUiState 的返回值推，disabled 直接调
// canToggleDual（而不是自己手写 state === 'none' || ... 的析取）。这份判据与 annotationKeys.ts
// 的 L 分支共用同一个 translateUiState/canToggleDual（pdfTranslationStore.ts），不在这里另写
// 一遍——两处各判一次是最难查的那类 bug（一处能进、另一处不能进），手写析取还会在
// TranslateUiState 加新分支时不被 tsc 逼着同步（TRANSLATE_TIP 这张表会）。
const TRANSLATE_TIP: Record<TranslateUiState, string> = {
  none: '翻译对照 · 未找到译文',
  invalid: '翻译对照 · 译文文件有误',
  mismatch: '翻译对照 · 译文版本不匹配',
  ready: '翻译对照 · L',
  active: '退出对照 · L',
};

type Props = { tabId: string; pageLabel: string; zoomPct: number; onToggleDual: () => void };

/** 底部居中的胶囊：选择 · 高亮 · 文字 | 撤销 · 重做 | 翻译对照 | 读数（spec §7.1）。 */
export function PdfToolbar({ tabId, pageLabel, zoomPct, onToggleDual }: Props) {
  const bucket = usePdfAnnotationStore((s) => s.buckets[tabId]);
  const ready = !!bucket?.doc && !bucket.loadError;
  const tool: Tool = bucket?.tool ?? 'select';
  const st = usePdfAnnotationStore.getState;
  const translateBucket = usePdfTranslationStore((s) => s.buckets[tabId]);
  const translateState = translateUiState(translateBucket);
  const pillRef = useRef<HTMLDivElement>(null);
  const highlightBtnRef = useRef<HTMLButtonElement>(null);
  const noteBtnRef = useRef<HTMLButtonElement>(null);
  const [anchorX, setAnchorX] = useState<number | null>(null);

  // 卡片锚点：当前工具按钮相对胶囊内层的中心 x
  useLayoutEffect(() => {
    if (tool === 'select' || !ready) { setAnchorX(null); return; }
    const btn = tool === 'highlight' ? highlightBtnRef.current : noteBtnRef.current;
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
        <IconButton
          size={28} tooltip="选择 · V" tooltipPlacement="top" active={tool === 'select'} disabled={!ready}
          tone={tool === 'select' ? 'ink' : 'default'} onClick={() => st().setTool(tabId, 'select')} testId="pdf-tool-select"
        >
          <NavIcon name="mouse-pointer-2" size={15} />
        </IconButton>
        <IconButton
          ref={highlightBtnRef} size={28} tooltip="高亮笔 · H" tooltipPlacement="top" active={tool === 'highlight'} disabled={!ready}
          tone={tool === 'highlight' ? 'ink' : 'default'} onClick={() => st().setTool(tabId, 'highlight')} testId="pdf-tool-highlight"
        >
          <NavIcon name="highlighter" size={15} />
        </IconButton>
        <IconButton
          ref={noteBtnRef} size={28} tooltip="文字注 · T" tooltipPlacement="top" active={tool === 'note'} disabled={!ready}
          tone={tool === 'note' ? 'ink' : 'default'} onClick={() => st().setTool(tabId, 'note')} testId="pdf-tool-note"
        >
          <NavIcon name="type" size={15} />
        </IconButton>
        <Divider />
        <IconButton
          size={28} tooltip="撤销 · ⌘Z" tooltipPlacement="top" disabled={!ready || !bucket?.undo.length}
          onClick={() => st().undo(tabId)} testId="pdf-undo"
        >
          <NavIcon name="undo-2" size={15} />
        </IconButton>
        <IconButton
          size={28} tooltip="重做 · ⇧⌘Z" tooltipPlacement="top" disabled={!ready || !bucket?.redo.length}
          onClick={() => st().redo(tabId)} testId="pdf-redo"
        >
          <NavIcon name="redo-2" size={15} />
        </IconButton>
        <Divider />
        <IconButton
          size={28} tooltip={TRANSLATE_TIP[translateState]} tooltipPlacement="top"
          disabled={!canToggleDual(translateBucket)}
          active={translateState === 'active'}
          tone={translateState === 'active' ? 'ink' : 'default'}
          onClick={onToggleDual} testId="pdf-translate"
        >
          <NavIcon name="languages" size={15} />
        </IconButton>
        <Divider />
        <div
          className="font-mono" data-testid="pdf-readout"
          style={{ width: 92, textAlign: 'center', fontSize: 10, color: 'var(--color-ink-faint)', whiteSpace: 'nowrap' }}
        >
          {pageLabel} · {zoomPct}%
        </div>
        {anchorX !== null && tool !== 'select' && bucket?.cardOpen && (
          <PdfToolCard tabId={tabId} kind={tool} centerX={anchorX} />
        )}
      </div>
    </div>
  );
}
