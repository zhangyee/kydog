import { useUiStore } from '../../stores/uiStore';
import { NavIcon } from '../../shared';
import { fileTitle } from './markdown/fileTabHelpers';
import { relativePrefix } from './fileCards';

type Props = { path: string; projectPath: string | null };

export function FileCard({ path, projectPath }: Props) {
  const openFile = useUiStore((s) => s.openFile);
  const prefix = relativePrefix(projectPath, path);
  return (
    <button
      type="button"
      data-testid={`file-card-${path}`}
      onClick={() => openFile(path)}
      className="ky-paper-deep w-full flex items-center gap-3 text-left hover:bg-[color:var(--color-hover-bg)]"
      style={{
        margin: '6px 0',
        padding: '10px 12px',
        border: '0.5px solid var(--color-ink-hair)',
        borderRadius: 3,
        fontFamily: 'var(--font-sans)',
      }}
    >
      <span
        className="inline-flex items-center justify-center shrink-0"
        style={{ width: 18, color: 'var(--color-accent)' }}
      >
        <NavIcon name="file-text" size={16} />
      </span>
      <span className="flex flex-col min-w-0 flex-1">
        <span className="truncate" style={{ fontSize: 13, color: 'var(--color-ink)' }}>
          {fileTitle(path)}
        </span>
        {prefix && (
          <span className="font-mono truncate" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>
            {prefix}
          </span>
        )}
      </span>
    </button>
  );
}
