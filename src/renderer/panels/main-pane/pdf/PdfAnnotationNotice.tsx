import { sidecarPath } from '../../../../shared/pdfSidecar';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import { usePdfTranslationStore } from './pdfTranslationStore';
import { pdfSaveScheduler } from './saveScheduler';

const HAIRLINE = '0.5px solid var(--color-ink-hair-soft)';

/**
 * 胶囊上方的一行提示：Notice 只有一行，多条同时成立时只显示优先级最高的一条。顺序（高到低）：
 *   1. 标注文件无法读取（loadError，常显、无动作）
 *   2. 标注未能保存（saveError，带「重试」）
 *   3. 译文文件有误（loadError）
 *   4. 译文对应另一个版本的 PDF（version === 'mismatch'）
 *   5. 译文未记录源摘要（version === 'unknown' 且已有 doc——可用，只是没法校验版本）
 *   6. 译文块因几何越界被丢（dropped > 0）
 * 标注（1-2）排在译文（3-6）之前：标注是打开 PDF 就在用的常驻能力，译文对照本期默认关闭、
 * 按 L 才进，常驻能力的故障更值得占住这一行。spec §8.2 / §8.3（标注）、Task 8（译文）。
 */
export function PdfAnnotationNotice({ tabId, pdfPath }: { tabId: string; pdfPath: string }) {
  const loadError = usePdfAnnotationStore((s) => s.buckets[tabId]?.loadError ?? null);
  const saveError = usePdfAnnotationStore((s) => s.buckets[tabId]?.saveError ?? null);
  const t = usePdfTranslationStore((s) => s.buckets[tabId]);

  let text: string | null = null;
  if (loadError) text = `标注文件无法读取：${loadError}（${sidecarPath(pdfPath, 'annotations')}）`;
  else if (saveError) text = `标注未能保存：${saveError}`;
  else if (t?.loadError) text = `译文文件有误：${t.loadError}`;
  else if (t?.version === 'mismatch') text = '译文对应的是另一个版本的 PDF；请重新翻译，或重新打开该文件';
  else if (t && t.version === 'unknown' && t.doc) text = '未记录源文件摘要，无法确认译文与当前 PDF 匹配';
  else if (t && t.dropped > 0) text = `${t.dropped} 条译文块超出页面范围，已跳过`;
  if (!text) return null;

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
        {!loadError && !!saveError && (
          // 只在正在显示的是标注保存失败这条时才给「重试」——其余五条（标注 loadError、
          // 译文那四条）都没有对应的重试动作。原来 `!loadError` 就够，是因为那时只有这两条
          // 消息、非 loadError 必是 saveError；加了译文那四条之后必须把 saveError 也显式判上。
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
