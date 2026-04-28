type Props = { onPickCard: (slash: string) => void };

const CARDS: Array<{ tag: string; numeral: string; title: string; subtitle: string }> = [
  { tag: '/frontier',   numeral: 'I.',   title: '搜索某个方向的前沿进展',   subtitle: '并行查询 arXiv / PubMed / Semantic Scholar' },
  { tag: '/literature', numeral: 'II.',  title: '生成课题的文献综述',     subtitle: '基于 PDF 与写作偏好产出 IMRaD 大纲' },
  { tag: '/abstract',   numeral: 'III.', title: '为一份 PDF 做结构化摘要', subtitle: '抽取贡献 / 方法 / 实验 / 局限' },
  { tag: '/curate',     numeral: 'IV.',  title: '整理今天的研究日志',     subtitle: '提炼新条目、合并重复、淘汰过期' },
];

export function NewThreadEmptyState({ onPickCard }: Props) {
  return (
    <div className="flex flex-col items-center text-[color:var(--color-ink)] gap-4 py-8 px-6">
      <div className="font-mono text-[10px] tracking-widest text-[color:var(--color-ink-soft)] uppercase">前沿学术文献与科研 AI 智能体</div>
      <div className="font-serif text-3xl">KyDog 科研狗</div>
      <div className="italic text-[color:var(--color-ink-soft)]">Building a better world.</div>
      <div className="text-[color:var(--color-ink-soft)] italic flex items-center gap-2 my-2">
        <span className="h-px w-12 bg-[color:var(--color-paper-edge)]" />
        — 推荐起点 —
        <span className="h-px w-12 bg-[color:var(--color-paper-edge)]" />
      </div>
      <div className="grid grid-cols-2 gap-3 w-full max-w-[640px]">
        {CARDS.map((c) => (
          <button
            key={c.tag}
            data-testid={`chapter-${c.tag.slice(1)}`}
            onClick={() => onPickCard(c.tag)}
            className="text-left p-3 border border-[color:var(--color-paper-edge)] rounded hover:bg-[color:var(--color-paper-edge)]/30"
          >
            <div className="font-serif text-[color:var(--color-ink-soft)]">{c.numeral}</div>
            <div className="font-serif text-[color:var(--color-ink)]">{c.title}</div>
            <div className="text-xs text-[color:var(--color-ink-soft)]">{c.subtitle}</div>
            <div className="mt-1 inline-block font-mono text-[10px] border border-[color:var(--color-accent)] text-[color:var(--color-accent)] px-1.5 py-0.5 rounded">{c.tag}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
