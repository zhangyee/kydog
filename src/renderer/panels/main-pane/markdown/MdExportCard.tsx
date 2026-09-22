import { useEffect, type ReactNode } from 'react';
import type { MdExportOptions } from '../../../../shared/mdExport';
import { PANEL_SHADOW } from '../pdf/PdfToolCard';

const WIDTH = 220;

type Props = {
  fileName: string;
  options: MdExportOptions;
  onChange: (patch: Partial<MdExportOptions>) => void;
  onExport: () => void;
  onClose: () => void;
  /** 分享键与卡片共同的那一格：点在这里面不算「点卡片外」—— 否则点分享键想关卡片时，
   *  mousedown 先关掉、click 又把它打开。 */
  boundary: { current: { contains: (n: Node) => boolean } | null };
};

/** md 导出 PDF 的设置卡（spec 2026-09-22-md-export-pdf-design §2.2）。锚在分享键正上方，材质照 PdfToolCard。 */
export function MdExportCard({ fileName, options, onChange, onExport, onClose, boundary }: Props) {
  useEffect(() => {
    // 捕获阶段 + preventDefault：评论模式的 Esc 挂在 window 的冒泡阶段、且认 defaultPrevented，
    // 卡片开着时按 Esc 只关卡片，不连带退出评论模式。
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (boundary.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose, boundary]);

  return (
    <div
      data-testid="md-export-card"
      style={{
        position: 'absolute', left: '50%', bottom: 'calc(100% + 14px)', width: WIDTH, transform: 'translateX(-50%)',
        padding: '12px 12px 10px', borderRadius: 8,
        background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair)', boxShadow: PANEL_SHADOW,
        display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'auto',
      }}
    >
      <div className="font-sans" style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)', flexShrink: 0 }}>导出 PDF</span>
        <span style={{ fontSize: 12, color: 'var(--color-ink-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
      </div>
      {row('纸张', [
        segment('md-export-paper-a4', options.paper === 'a4', () => onChange({ paper: 'a4' }), 'A4'),
        segment('md-export-paper-letter', options.paper === 'letter', () => onChange({ paper: 'letter' }), 'Letter'),
      ])}
      {row('边距', [
        segment('md-export-margin-standard', options.margin === 'standard', () => onChange({ margin: 'standard' }), '标准'),
        segment('md-export-margin-narrow', options.margin === 'narrow', () => onChange({ margin: 'narrow' }), '窄'),
      ])}
      {row('页码', [
        <button
          key="switch" type="button" role="switch" aria-checked={options.pageNumbers} data-testid="md-export-page-numbers"
          onClick={() => onChange({ pageNumbers: !options.pageNumbers })}
          style={{
            width: 30, height: 18, borderRadius: 999, border: 'none', padding: 2, cursor: 'pointer',
            background: options.pageNumbers ? 'var(--color-accent)' : 'var(--color-ink-hair)',
            display: 'flex', justifyContent: options.pageNumbers ? 'flex-end' : 'flex-start',
          }}
        >
          <span style={{ width: 14, height: 14, borderRadius: 999, background: 'var(--color-paper)' }} />
        </button>,
      ], false)}
      <button
        type="button" data-testid="md-export-go" onClick={onExport} className="font-sans"
        style={{
          height: 28, borderRadius: 6, border: '0.5px solid var(--color-ink-hair)', cursor: 'pointer',
          background: 'var(--color-paper-deep)', color: 'var(--color-ink)', fontSize: 12.5, fontWeight: 500,
        }}
      >导出…</button>
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

// row / segment 是普通函数、返回元素，不是组件：miniReact 只渲染被测组件自己那一层、不展开子组件，
// 写成组件的话测试就找不到里面的 testid 与文字。
function row(label: string, controls: ReactNode[], track = true) {
  return (
    <div key={label} className="font-sans" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
      <span style={{ color: 'var(--color-ink-soft)' }}>{label}</span>
      {track
        ? <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 6, background: 'var(--color-paper-deep)' }}>{controls}</div>
        : controls}
    </div>
  );
}

function segment(testId: string, on: boolean, onClick: () => void, label: string) {
  return (
    <button
      key={testId} type="button" data-testid={testId} aria-pressed={on} onClick={onClick}
      style={{
        minWidth: 44, height: 22, padding: '0 8px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 12,
        background: on ? 'var(--color-paper)' : 'transparent',
        color: on ? 'var(--color-ink)' : 'var(--color-ink-soft)',
        boxShadow: on ? '0 1px 2px rgba(50,35,20,0.12)' : 'none',
      }}
    >{label}</button>
  );
}
