import { sidecarPath } from '../../../../shared/pdfSidecar';
import { Tooltip } from '../../../shared';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import { usePdfTranslationStore, type TBucket } from './pdfTranslationStore';
import { pdfSaveScheduler } from './saveScheduler';

const HAIRLINE = '0.5px solid var(--color-ink-hair-soft)';

/**
 * 胶囊上方的一行提示：Notice 只有一行，多条同时成立时只显示优先级最高的一条。顺序（高到低）：
 *   1. 标注文件无法读取（loadError，常显、无动作）
 *   2. 标注未能保存（saveError，带「重试」）
 *   3. 翻译流水线失败（translateError——没配模型、写盘失败、「这份 PDF 没有文本层」等，PdfFileTab
 *      的 startTranslation catch 里落的那个 state）
 *   4. 译文文件有误（loadError）
 *   5. 译文对应另一个版本的 PDF（version === 'mismatch'）
 *   6. 译文未记录源摘要（version === 'unknown' 且已有 doc——可用，只是没法校验版本）
 *   7. 译文块因几何越界被丢（dropped > 0）
 *   8. 这份译文里有页翻译失败（doc.failedPages，那几页右栏保留原文）。判据取自**边车自己**
 *      而不是内存里某个作业留下的数字：失败页号由跑翻译那一趟写进 `TranslatedDoc.failedPages`
 *      （zhSidecar.ts），所以它天然描述的就是当前这份 doc——关 tab 重开、重启应用、切窗口
 *      触发的重探都读得回真值，也不会在 agent 重写边车之后还挂着上一份的陈旧计数。
 *      不用 job.failed：作业一完成 job 就整个变 null，用它判的话这条消息在跑完那一刻——
 *      用户恰恰需要看它的时刻——必然读不到（Task 14 审查发现的洞）
 * 标注（1-2）排在译文（3-8）之前：标注是打开 PDF 就在用的常驻能力，译文对照本期默认关闭、
 * 按 L 才进，常驻能力的故障更值得占住这一行。translateError 排在译文其余几条（4-8）之前：
 * 它是「刚刚这一次动作」的直接失败反馈（常见如 llm.not_configured——首次使用没配模型），比边车
 * 文件本身状态的静态描述更紧迫，且没有它翻译失败就是一次双栏闪回单栏、全程零提示的死状态。
 * spec §8.2 / §8.3（标注）、Task 8 / Task 14（译文）。
 *
 * 抽成纯函数是为了让这条优先级链离开 DOM 也测得到（PdfAnnotationNotice.test.ts）；返回 null =
 * 这一行不显示。
 */
export function noticeText(a: {
  pdfPath: string;
  loadError: string | null;
  saveError: string | null;
  translateError: string | null;
  t: TBucket | undefined;
}): { text: string; isFailedPages: boolean } | null {
  const { pdfPath, loadError, saveError, translateError, t } = a;
  let text: string | null = null;
  // 第 8 条分支自己置位，showReasons 判它而不是回头从 text 里抠子串——text 是给人看的文案，
  // 不是给代码分支用的 tag，靠 includes('页翻译失败') 反推「当前渲染的是第几条」是在拿渲染结果
  // 当输入用，文案措辞一改这条判断就悄悄失真。
  let isFailedPages = false;
  if (loadError) text = `标注文件无法读取：${loadError}（${sidecarPath(pdfPath, 'annotations')}）`;
  else if (saveError) text = `标注未能保存：${saveError}`;
  else if (translateError) text = `翻译失败：${translateError}`;
  else if (t?.loadError) text = `译文文件有误：${t.loadError}`;
  else if (t?.version === 'mismatch') text = '译文对应的是另一个版本的 PDF；请重新翻译，或重新打开该文件';
  else if (t && t.version === 'unknown' && t.doc) text = '未记录源文件摘要，无法确认译文与当前 PDF 匹配';
  else if (t && t.dropped > 0) text = `${t.dropped} 条译文块超出页面范围，已跳过`;
  else if (t?.doc?.failedPages?.length) {
    isFailedPages = true;
    const pages = t.doc.failedPages;
    text = `${pages.length} 页翻译失败（第 ${pages.join('、')} 页），右栏保留原文`;
  }
  return text ? { text, isFailedPages } : null;
}

/** 胶囊上方的那一行提示。显示哪一条、文案是什么，见上面的 noticeText。 */
export function PdfAnnotationNotice(
  { tabId, pdfPath, translateError }: { tabId: string; pdfPath: string; translateError: string | null },
) {
  const loadError = usePdfAnnotationStore((s) => s.buckets[tabId]?.loadError ?? null);
  const saveError = usePdfAnnotationStore((s) => s.buckets[tabId]?.saveError ?? null);
  const t = usePdfTranslationStore((s) => s.buckets[tabId]);

  const notice = noticeText({ pdfPath, loadError, saveError, translateError, t });
  if (!notice) return null;
  const { text, isFailedPages } = notice;

  const reasons = t?.doc?.failureReasons;
  const failed = t?.doc?.failedPages ?? [];
  const showReasons = isFailedPages && !!reasons && failed.some((p) => reasons[String(p)]);
  const body = <span className="font-serif" style={{ overflowWrap: 'anywhere' }}>{text}</span>;

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
        {showReasons ? (
          <Tooltip
            placement="top"
            content={
              <div
                data-testid="pdf-notice-reasons"
                style={{ whiteSpace: 'normal', maxWidth: 'min(60vw, 520px)', overflowWrap: 'anywhere' }}
              >
                {failed.filter((p) => reasons![String(p)]).map((p) => (
                  <div key={p}>{`第 ${p} 页：${reasons![String(p)]}`}</div>
                ))}
              </div>
            }
          >
            {body}
          </Tooltip>
        ) : body}
        {!loadError && !!saveError && (
          // 只在正在显示的是标注保存失败这条时才给「重试」——其余七条（标注 loadError、
          // 译文那六条）都没有对应的重试动作。原来 `!loadError` 就够，是因为那时只有这两条
          // 消息、非 loadError 必是 saveError；加了译文那几条之后必须把 saveError 也显式判上。
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
