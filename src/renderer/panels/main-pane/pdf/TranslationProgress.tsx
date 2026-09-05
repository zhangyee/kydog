import type { JobProgress } from './translateDoc';

const LABEL: Record<JobProgress['phase'], string> = {
  extract: '正在抽取原文',
  translate: '正在翻译',
  finalize: '正在保存',
};

/**
 * 右半边居中的进度浮层。
 *
 * 覆盖的是**滚动容器的右半边**，不是像素级对准右栏矩形：进对照会 fit-width，此时行宽等于视口宽，
 * 右半边与右栏近乎重合（差一个 PAGE_GAP / 2）；用户在翻译期间手动缩放会让它偏离。这是刻意的
 * 简化——「整个右栏」在 DOM 里不是一个元素（右格是每页一个），为像素级对准去造一个跟随缩放与
 * 滚动的镜像矩形换不来任何东西（spec §9）。
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
        position: 'absolute', left: '50%', right: 0, top: 0, bottom: 0, zIndex: 4,
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
