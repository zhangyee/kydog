import { useMemo, useState } from 'react';
import { KyLogo, KyMascot, ChapterCard } from '../../shared';
import { useSkillsStore } from '../../stores/skillsStore';
import { useUiStore } from '../../stores/uiStore';
import { Composer } from './Composer';
import { pickFeaturedSkills } from './skillMenuItems';

type Props = { threadId: string };

export function NewThreadEmptyState({ threadId }: Props) {
  const [prefill, setPrefill] = useState<string | undefined>(undefined);

  // 推荐起点只列**真实装着且启用**的 skill —— 策展表见 skillMenuItems.ts。
  // 一个都没命中就整块不渲染，宁可少一节，也不给一张点下去无效的卡。
  const skills = useSkillsStore((s) => s.skills);
  const featured = useMemo(() => pickFeaturedSkills(skills), [skills]);

  // 窄模式判据与 Composer.tsx / MessageList.tsx 一致：browserOpen（协议层事实），
  // 不是宽度阈值。没跟这条的代价：360px 的对话栏里横向 padding 80 两边吃掉 160，
  // 内容盒只剩 200 —— 这是新建对话首屏，最常见的入口，不能漏。20 与 MessageList
  // 窄模式的横向 padding 取同一个数，不单独发明一档。
  const narrow = useUiStore((s) => s.browserOpen);

  return (
    <div className="ky-paper-grain ky-scroll flex-1 overflow-y-auto" data-testid="new-thread-empty-state">
      <div
        style={{
          maxWidth: 840,
          margin: '0 auto',
          padding: narrow ? '64px 20px' : '64px 80px',
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

        <div
          className="flex justify-center"
          style={{ color: 'var(--color-ink)', marginBottom: 14 }}
        >
          <KyMascot size={72} />
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
          <Composer
            threadId={threadId}
            large
            prefill={prefill}
            placeholder="问一个研究问题，或拖入 PDF / 文件夹…"
          />
        </div>

        {/* 推荐起点 */}
        {featured.length > 0 && (
          <>
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
              {featured.map((c) => (
                <ChapterCard
                  key={c.name}
                  num={c.numeral}
                  title={c.title}
                  subtitle={c.subtitle}
                  tag={c.command}
                  onClick={() => setPrefill(`${c.command} `)}
                  testId={`chapter-${c.name}`}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
