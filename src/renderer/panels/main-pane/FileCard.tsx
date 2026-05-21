import { useUiStore } from '../../stores/uiStore';
import { NavIcon } from '../../shared';
import { fileTitle } from './markdown/fileTabHelpers';
import { relativePrefix, formatBytes } from './fileCards';

type Props = { path: string; projectPath: string | null; size: number | null };

export function FileCard({ path, projectPath, size }: Props) {
  const openFile = useUiStore((s) => s.openFile);
  const prefix = relativePrefix(projectPath, path);
  const meta = size === null ? 'Markdown 文档' : `Markdown 文档 · ${formatBytes(size)}`;
  return (
    <button
      type="button"
      data-testid={`file-card-${path}`}
      onClick={() => openFile(path)}
      className="group ky-paper-deep w-full flex items-center gap-3 text-left hover:bg-[color:var(--color-hover-bg)]"
      style={{
        margin: '8px 0',
        padding: '12px 14px',
        border: '0.5px solid var(--color-ink-hair)',
        borderRadius: 4,
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* 纸张质感 tile：背后错位叠一张纸 + 前面主纸面 + 文档字形 */}
      <span className="relative inline-flex items-center justify-center shrink-0" style={{ width: 38, height: 44 }}>
        <span
          aria-hidden
          style={{
            position: 'absolute', left: 3, top: 4, width: 30, height: 38,
            borderRadius: 4, background: 'var(--color-paper)',
            border: '0.5px solid var(--color-ink-hair)',
            transform: 'rotate(-5deg)',
          }}
        />
        <span
          aria-hidden
          className="relative"
          style={{
            width: 32, height: 40, borderRadius: 4,
            background: 'var(--color-paper-edge)',
            border: '0.5px solid var(--color-ink-hair)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
          }}
        />
        <span className="absolute inset-0 inline-flex items-center justify-center" style={{ color: 'var(--color-accent)' }}>
          <NavIcon name="file-text" size={18} />
        </span>
      </span>

      {/* 文本区 */}
      <span className="flex flex-col min-w-0 flex-1" style={{ gap: 2 }}>
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="truncate" style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-ink)' }}>
            {fileTitle(path)}
          </span>
          {prefix && (
            <span className="font-mono truncate shrink-0" style={{ fontSize: 11, color: 'var(--color-ink-faint)' }}>
              {prefix}
            </span>
          )}
        </span>
        <span className="font-mono truncate" style={{ fontSize: 10.5, color: 'var(--color-ink-faint)' }}>
          {meta}
        </span>
      </span>

      {/* 打开 affordance：hover 整张卡时浮现 */}
      <span
        className="shrink-0 font-mono opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ fontSize: 11, color: 'var(--color-ink-soft)' }}
      >
        打开 →
      </span>
    </button>
  );
}
