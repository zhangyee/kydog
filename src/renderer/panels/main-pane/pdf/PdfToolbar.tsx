import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton, NavIcon } from '../../../shared';
import { usePdfAnnotationStore, type Tool } from './pdfAnnotationStore';
import { canPressTranslate, translateUiState, usePdfTranslationStore, type TranslateUiState } from './pdfTranslationStore';
import { PANEL_SHADOW, PdfToolCard } from './PdfToolCard';

function Divider(): ReactNode {
  return <div style={{ width: 0.5, height: 16, background: 'var(--color-ink-hair)', margin: '0 3px', flexShrink: 0 }} />;
}

// 各状态的 tooltip；active 由调用处按 translateUiState 的返回值推，disabled 直接调
// canPressTranslate（而不是自己手写 state === 'none' || ... 的析取）。这份判据与
// annotationKeys.ts 的 L 分支共用同一个 translateUiState/canPressTranslate
// （pdfTranslationStore.ts），不在这里另写一遍——两处各判一次是最难查的那类 bug（一处能进、
// 另一处不能进），手写析取还会在 TranslateUiState 加新分支时不被 tsc 逼着同步（TRANSLATE_TIP
// 这张表会）。
//
// invalid / mismatch 两档文案是「重新翻译」而不是「翻译」：它们表示边车已经存在但有问题（结构
// 坏了 / 摘要对不上当前 PDF），进不了对照，主键唯一的动作就是重新跑一遍流水线——只有 none
// （压根没有译文）才是真正的「翻译」。active 态另有一个常驻的「重新翻译」键（见下方
// pdf-retranslate），把译文质量的判断交给用户自己，胶囊的主键因此不必身兼两义（Yee 拍板）。
const TRANSLATE_TIP: Record<TranslateUiState, string> = {
  translating: '正在翻译',
  pending: '翻译对照 · 正在准备页面',
  invalid: '重新翻译 · L',
  none: '翻译 · L',
  mismatch: '重新翻译 · L',
  active: '退出对照 · L',
  ready: '翻译对照 · L',
};

type Props = {
  tabId: string; pageLabel: string; zoomPct: number; onToggleDual: () => void;
  /** 只在 active 态可点（见下方 pdf-retranslate 的渲染条件）。 */
  onRetranslate: () => void;
};

/** 底部居中的胶囊：选择 · 高亮 · 文字 | 撤销 · 重做 | 翻译对照 | 读数（spec §7.1）。 */
export function PdfToolbar({ tabId, pageLabel, zoomPct, onToggleDual, onRetranslate }: Props) {
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
          disabled={!canPressTranslate(translateBucket)}
          active={translateState === 'active'}
          tone={translateState === 'active' ? 'ink' : 'default'}
          onClick={onToggleDual} testId="pdf-translate"
        >
          <NavIcon name="languages" size={15} />
        </IconButton>
        {/* 只在已经在对照中才渲染：mismatch/invalid 那两档进不了对照，主键本身语义就是「重新
            翻译」，胶囊上不必为它们再多一个键。渲染条件与 translating 天然互斥（job 存在时
            translateUiState 恒是 'translating' 不是 'active'，见 pdfTranslationStore.ts），
            所以正在跑的那一趟不会同时露出这颗键。 */}
        {translateState === 'active' && (
          <IconButton
            size={28} tooltip="重新翻译" tooltipPlacement="top"
            onClick={onRetranslate} testId="pdf-retranslate"
          >
            <NavIcon name="rotate-cw" size={15} />
          </IconButton>
        )}
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
