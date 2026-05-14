import { useState } from 'react';
import { KyLogo, ChapterCard } from '../../shared';
import { InputPill } from './InputPill';
import { SKILL_MENU_ITEMS } from './skillMenuItems';

type Props = { threadId: string };

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
          {SKILL_MENU_ITEMS.map((c) => (
            <ChapterCard
              key={c.name}
              num={c.numeral}
              title={c.title}
              subtitle={c.subtitle}
              tag={c.name}
              onClick={() => setPrefill(`${c.name} `)}
              testId={`chapter-${c.name.slice(1)}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
