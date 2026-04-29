import { useState } from 'react';
import { KyLogo, ChapterCard } from '../../shared';
import { InputPill } from './InputPill';

type Props = { threadId: string };

const CARDS = [
  {
    tag: '/frontier',
    numeral: 'I.',
    title: '搜索某个方向的前沿进展',
    subtitle:
      '输入领域关键词，agent 并行查询 arXiv / PubMed / Semantic Scholar 并合并去重。',
  },
  {
    tag: '/literature',
    numeral: 'II.',
    title: '生成课题的文献综述',
    subtitle: '基于已有 PDF 与长期记忆中的写作偏好，产出 IMRaD 结构大纲。',
  },
  {
    tag: '/abstract',
    numeral: 'III.',
    title: '为一份 PDF 做结构化摘要',
    subtitle: '拖入论文，抽取贡献、方法、实验、局限；附带可引用 BibTeX。',
  },
  {
    tag: '/curate',
    numeral: 'IV.',
    title: '整理今天的研究日志',
    subtitle: '扫描 daily log 与 MEMORY.md，提炼新条目、合并重复、淘汰过期项。',
  },
] as const;

export function NewThreadEmptyState({ threadId }: Props) {
  const [prefill, setPrefill] = useState<string | undefined>(undefined);

  return (
    <div className="ky-paper-grain ky-scroll flex-1 overflow-y-auto">
      <div
        style={{
          maxWidth: 840,
          margin: '0 auto',
          padding: '64px 80px',
          textAlign: 'center',
        }}
      >
        {/* mast head */}
        <div
          className="font-mono uppercase inline-flex items-center"
          style={{
            gap: 10,
            fontSize: 10,
            letterSpacing: 3,
            color: 'var(--color-ink-faint)',
            marginBottom: 24,
          }}
        >
          <span style={{ width: 22, height: 1, background: 'var(--color-ink-hair)' }} />
          前沿学术文献与科研 AI 智能体
          <span style={{ width: 22, height: 1, background: 'var(--color-ink-hair)' }} />
        </div>

        <div className="flex items-baseline justify-center" style={{ gap: 18 }}>
          <KyLogo size={68} peerSize />
        </div>

        <div
          className="font-serif italic"
          style={{
            marginTop: 18,
            fontSize: 20,
            color: 'var(--color-ink)',
            fontWeight: 400,
            letterSpacing: 0.3,
          }}
        >
          Building a better world.
        </div>

        <div style={{ marginTop: 40, textAlign: 'left' }}>
          <InputPill
            threadId={threadId}
            large
            prefill={prefill}
            placeholder="问一个研究问题，或拖入 PDF / 文件夹…"
          />
        </div>

        {/* 推荐起点 */}
        <div
          className="flex items-center"
          style={{ marginTop: 40, marginBottom: 20, gap: 14 }}
        >
          <div style={{ flex: 1, height: 1, background: 'var(--color-ink-hair)' }} />
          <span
            className="font-serif italic"
            style={{
              fontSize: 12,
              color: 'var(--color-ink-faint)',
              letterSpacing: 0.3,
            }}
          >
            — 推荐起点 —
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--color-ink-hair)' }} />
        </div>

        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: '1fr 1fr', textAlign: 'left' }}
        >
          {CARDS.map((c) => (
            <ChapterCard
              key={c.tag}
              num={c.numeral}
              title={c.title}
              subtitle={c.subtitle}
              tag={c.tag}
              onClick={() => setPrefill(`${c.tag} `)}
              testId={`chapter-${c.tag.slice(1)}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
