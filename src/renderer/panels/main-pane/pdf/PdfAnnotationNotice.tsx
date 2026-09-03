import { sidecarPath } from '../../../../shared/pdfSidecar';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import { pdfSaveScheduler } from './saveScheduler';

const HAIRLINE = '0.5px solid var(--color-ink-hair-soft)';

/** 胶囊上方的一行提示：边车无法读取（常显、无动作）或保存失败（带「重试」）。spec §8.2 / §8.3。 */
export function PdfAnnotationNotice({ tabId, pdfPath }: { tabId: string; pdfPath: string }) {
  const loadError = usePdfAnnotationStore((s) => s.buckets[tabId]?.loadError ?? null);
  const saveError = usePdfAnnotationStore((s) => s.buckets[tabId]?.saveError ?? null);
  if (!loadError && !saveError) return null;
  const text = loadError
    ? `标注文件无法读取：${loadError}（${sidecarPath(pdfPath, 'annotations')}）`
    : `标注未能保存：${saveError}`;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 64, display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 5 }}>
      <div
        data-testid="pdf-notice"
        style={{
          display: 'flex', alignItems: 'center', gap: 10, maxWidth: '80%',
          padding: '5px 12px', borderRadius: 4, border: HAIRLINE,
          background: 'var(--color-paper-edge)', color: 'var(--color-ink-soft)',
          fontSize: 12, lineHeight: 1.5, pointerEvents: 'auto',
        }}
      >
        <span className="font-serif" style={{ overflowWrap: 'anywhere' }}>{text}</span>
        {!loadError && (
          // 与更新横幅 / 设置页「立即检查」同一套描边小按钮
          <button
            type="button" data-testid="pdf-notice-retry" className="font-mono"
            onClick={() => { void pdfSaveScheduler.flush(tabId); }}
            style={{
              padding: '2px 10px', borderRadius: 2, border: HAIRLINE, background: 'transparent',
              cursor: 'pointer', fontSize: 11, lineHeight: 1.5, color: 'var(--color-ink)', whiteSpace: 'nowrap',
            }}
          >
            重试
          </button>
        )}
      </div>
    </div>
  );
}
