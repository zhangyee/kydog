import { useEffect, useState } from 'react';
import { PANEL_SHADOW } from '../pdf/PdfToolCard';
import { TOAST_MS } from '../../workspace/SidebarToast';

export type ExportToast =
  | { id: number; kind: 'done'; pdfPath: string; fileName: string }
  | { id: number; kind: 'failed'; message: string };

type Props = {
  toast: ExportToast | null;
  platform: string;
  onOpen: (pdfPath: string) => void;
  onReveal: (pdfPath: string) => void;
  onDismiss: () => void;
};

export function revealLabel(platform: string): string {
  if (platform === 'darwin') return '在访达中显示';
  if (platform === 'win32') return '在资源管理器中显示';
  return '在文件夹中显示';
}

/**
 * md 导出 PDF 的结果提示（spec 2026-09-22-md-export-pdf-design §2.4）：md 标签内、胶囊正上方。
 * 计时照 SidebarToast：TOAST_MS 后消失、悬停不计时；hover / 计时状态挂在按 toast.id 换 key 的
 * Body 上，理由见 SidebarToast 顶部那段注释（点动作时指针正停在提示上、没有 mouseleave，
 * hovered 会卡死在 true，下一条的计时器就再也不起）。
 */
export function MdExportToast(props: Props) {
  if (!props.toast) return null;
  return <MdExportToastBody key={props.toast.id} {...props} toast={props.toast} />;
}

export function MdExportToastBody({ toast, platform, onOpen, onReveal, onDismiss }: Props & { toast: ExportToast }) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (hovered) return;
    const timer = setTimeout(onDismiss, TOAST_MS);
    return () => clearTimeout(timer);
  }, [hovered, onDismiss]);

  const action = (testId: string, label: string, run: () => void) => (
    <button
      type="button" data-testid={testId} onClick={run} className="font-sans"
      style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontSize: 12, fontWeight: 500, color: 'var(--color-accent)', flexShrink: 0 }}
    >{label}</button>
  );
  const message = toast.kind === 'done' ? `已导出 ${toast.fileName}` : `导出失败：${toast.message}`;

  return (
    <div
      data-testid="md-export-toast" data-kind={toast.kind}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        position: 'absolute', left: '50%', bottom: 16 + 38 + 10, transform: 'translateX(-50%)', zIndex: 6,
        // 宽度随内容，但不超出这个标签（左右各留 16）：文件名或出错原因很长、窗格又窄时，省略的是文字，
        // 两个动作键整颗留着（flexShrink: 0）。width: max-content 不能省：绝对定位的盒子按「包含块宽 − left」
        // 收缩适配，left: 50% 时最多只有半个标签宽；max-width 的百分比按整个标签算。
        width: 'max-content', maxWidth: 'calc(100% - 32px)',
        display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 8, whiteSpace: 'nowrap',
        background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair)', boxShadow: PANEL_SHADOW,
      }}
    >
      {/* 省略掉的部分靠 title 悬停读全 */}
      <span
        data-testid="md-export-toast-text" title={message} className="font-sans"
        style={{ fontSize: 12.5, color: 'var(--color-ink)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
      >{message}</span>
      {toast.kind === 'done' ? (
        <>
          {action('md-export-open', '打开', () => onOpen(toast.pdfPath))}
          {action('md-export-reveal', revealLabel(platform), () => onReveal(toast.pdfPath))}
        </>
      ) : null}
    </div>
  );
}
