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
      className="group ky-paper-deep relative overflow-hidden w-full flex items-center gap-4 text-left hover:bg-[color:var(--color-hover-bg)]"
      style={{
        margin: '8px 0',
        padding: '18px 20px',
        border: '0.5px solid var(--color-ink-hair)',
        borderRadius: 10,
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* 文档图标框：绝对定位、骑在卡片底边上探出，下半截被卡片裁掉；
          hover 以底边为轴回正 + 微放大，底边始终在裁切线下方不外露 */}
      <span
        aria-hidden
        className="absolute inline-flex items-start justify-center -rotate-6 group-hover:rotate-0 group-hover:scale-105 transition-transform duration-200 ease-out"
        style={{
          left: 22, bottom: -14, width: 48, height: 62, paddingTop: 12,
          borderRadius: 11,
          background: 'var(--color-paper-edge)',
          border: '0.5px solid var(--color-ink-hair)',
          boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
          color: 'var(--color-accent)',
          transformOrigin: 'center bottom',
        }}
      >
        <NavIcon name="file-text" size={24} />
      </span>

      {/* 文本区：左侧让出图标宽度 */}
      <span className="flex flex-col min-w-0 flex-1" style={{ marginLeft: 70, gap: 3 }}>
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="truncate min-w-0" style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-ink)' }}>
            {fileTitle(path)}
          </span>
          {prefix && (
            <span className="font-mono truncate min-w-0 shrink-[3]" style={{ fontSize: 11, color: 'var(--color-ink-faint)' }}>
              {prefix}
            </span>
          )}
        </span>
        <span className="font-mono truncate" style={{ fontSize: 10.5, color: 'var(--color-ink-faint)' }}>
          {meta}
        </span>
      </span>

      {/* 打开 pill：hover 整张卡时浮现 */}
      <span
        className="shrink-0 inline-flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
        style={{
          fontSize: 11.5,
          color: 'var(--color-ink-soft)',
          padding: '5px 11px',
          borderRadius: 999,
          border: '0.5px solid var(--color-ink-hair)',
          background: 'var(--color-paper)',
        }}
      >
        打开
        <NavIcon name="arrow-right" size={13} />
      </span>
    </button>
  );
}
