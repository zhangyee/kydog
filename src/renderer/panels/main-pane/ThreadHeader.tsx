import { useThreadsStore } from '../../stores/threadsStore';

type Props = { threadId: string };

export function ThreadHeader({ threadId }: Props) {
  const number = useThreadsStore((s) => {
    const t = Object.values(s.threadsByProject).flat().find(x => x.id === threadId);
    if (!t) return null;
    const all = (s.threadsByProject[t.projectPath] ?? [])
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return all.findIndex(x => x.id === threadId) + 1;
  });
  const thread = useThreadsStore((s) =>
    Object.values(s.threadsByProject).flat().find(x => x.id === threadId),
  );
  if (!thread || number === null) return null;

  const projectName = thread.projectPath.split(/[\\/]/).pop() ?? thread.projectPath;
  const numberLabel = `Thread · No. ${String(number).padStart(4, '0')}`;
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        className="font-mono uppercase"
        style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 1.5, marginBottom: 4 }}
      >
        {numberLabel}
      </div>
      <h1
        className="font-serif"
        style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-ink)', margin: 0, letterSpacing: -0.2, lineHeight: 1.25 }}
      >
        {thread.title}
      </h1>
      <div
        className="font-serif italic"
        style={{ fontSize: 13, color: 'var(--color-ink-soft)', marginTop: 4 }}
      >
        {projectName} · {thread.projectPath}
      </div>
    </div>
  );
}
