type Props = { projectPath: string };

export function ProjectCard({ projectPath }: Props) {
  const name = projectPath.split('/').pop() ?? projectPath;
  return (
    <div style={{ padding: '10px 14px 6px' }}>
      <div
        className="font-mono uppercase"
        style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-ink-faint)', letterSpacing: 1, marginBottom: 6 }}
      >项目</div>
      <div
        data-testid="project-card"
        className="flex items-center gap-2"
        style={{
          padding: '8px 10px', background: 'var(--color-paper)',
          border: '0.5px solid var(--color-ink-hair)', borderRadius: 4,
        }}
      >
        <span
          style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-moss)', flexShrink: 0 }}
        />
        <div className="min-w-0 flex-1">
          <div className="font-sans truncate" style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-ink)' }}>{name}</div>
          <div className="font-mono truncate" style={{ fontSize: 9.5, color: 'var(--color-ink-faint)' }}>{projectPath}</div>
        </div>
      </div>
    </div>
  );
}
