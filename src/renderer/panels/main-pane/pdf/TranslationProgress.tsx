import type { JobProgress } from './translateDoc';

const LABEL: Record<JobProgress['phase'], string> = {
  extract: '正在抽取原文',
  translate: '正在翻译',
  // 收尾重试：整轮跑完之后回头跑失败页（translateDoc 的 pageAttempts）。单独一档是因为进度
  // 的分母换成了「这一轮要重试几页」——沿用「正在翻译」那一档的话，浮层会停在 N / N 不动。
  retry: '正在重试失败页',
  finalize: '正在保存',
};

/**
 * 右栏居中的进度浮层。
 *
 * 铺满父层（`inset: 0`），而父层就是右栏滚动容器的那个 `position: relative` 兄弟壳
 * （PdfFileTab 的渲染树）——所以它天生就是右栏矩形，不需要任何对准。二期原先那条「盖住视口
 * 右半边、不像素级对准右栏」的简化随 spec v8 §3.1 一起消掉了：右栏现在是个真实的滚动容器。
 * 放在滚动容器**外面**是有意的：放进去会随内容滚走。
 *
 * `finalize` 阶段取消按钮禁用：jobSeq 挡得住「写渲染层的 store」，挡不住一次**已经发出的
 * save**。提交点因此画在「发出 save 之前」——进入 finalize 就不再给取消，语义诚实，也不会出现
 * 「取消了但边车落了盘」的中间态（spec §9.3）。
 */
export function TranslationProgress({ job, onCancel }: { job: JobProgress; onCancel: () => void }) {
  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  return (
    <div
      data-testid="pdf-translate-progress"
      style={{
        position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 4,
        display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
          maxWidth: 320, padding: '18px 22px', borderRadius: 6,
          border: '0.5px solid var(--color-ink-hair)', background: 'var(--color-paper)',
          pointerEvents: 'auto',
        }}
      >
        <div className="font-mono" style={{ fontSize: 11, color: 'var(--color-ink-faint)' }}>
          {LABEL[job.phase]} · {job.done} / {job.total}
          {job.failed > 0 ? ` · ${job.failed} 页失败` : ''}
        </div>
        <div style={{ width: 200, height: 2, background: 'var(--color-ink-hair)' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-ink-soft)' }} />
        </div>
        <div className="font-serif" style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--color-ink-soft)', textAlign: 'center' }}>
          译文会保存在 PDF 旁边，下次打开直接对照。
        </div>
        <button
          type="button" data-testid="pdf-translate-cancel" className="font-mono"
          disabled={job.phase === 'finalize'}
          onClick={onCancel}
          style={{
            padding: '2px 12px', borderRadius: 2, border: '0.5px solid var(--color-ink-hair)',
            background: 'transparent', fontSize: 11, color: 'var(--color-ink)',
            cursor: job.phase === 'finalize' ? 'default' : 'pointer',
            opacity: job.phase === 'finalize' ? 0.4 : 1,
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
}
