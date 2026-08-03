import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { ABOUT_DOCS, ABOUT_LICENSES } from './about/aboutDocs';
import { AboutMarkdown } from './about/AboutMarkdown';

const HAIRLINE = '0.5px solid var(--color-ink-hair-soft)';

export function AboutSection() {
  const appVersion = useSettingsStore((s) => s.appVersion);
  // null = 看当前篇（ABOUT_DOCS[0]）
  const [viewingSlug, setViewingSlug] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const latest = ABOUT_DOCS[0] ?? null;
  const doc = (viewingSlug ? ABOUT_DOCS.find((d) => d.slug === viewingSlug) : null) ?? latest;
  // 往期列表恒为「除最新篇外的所有篇」，不随 viewingSlug 变化，列表才不会跳动。
  const archive = ABOUT_DOCS.slice(1);
  const isArchive = !!doc && !!latest && doc.slug !== latest.slug;

  // 往期列表在页面底部，设置页一长就会滚动。切篇后把标题滚回可见范围，
  // 不然读者视线还停在列表上，「← 回到最新」也渲染到了视口外面。
  useEffect(() => {
    titleRef.current?.scrollIntoView({ block: 'start' });
  }, [doc?.slug]);

  return (
    <div style={{ padding: '28px 28px 40px', maxWidth: 720 }}>
      {/* 版本行说的是「你正在跑的版本」，翻看往期篇时也不变。 */}
      <div
        className="font-mono uppercase"
        style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 1.5, marginBottom: 14 }}
        data-testid="about-version"
      >
        KyDog · v{appVersion || '0.1.0'}
      </div>

      {isArchive && doc && (
        <button
          type="button"
          onClick={() => setViewingSlug(null)}
          data-testid="about-back-to-latest"
          className="font-mono"
          style={{
            display: 'block', marginBottom: 12, padding: 0,
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 10.5, letterSpacing: 0.6, color: 'var(--color-marginalia)',
          }}
        >
          ← 回到最新 · {doc.date}
        </button>
      )}

      {doc && (
        <>
          <h1
            ref={titleRef}
            className="font-serif"
            data-testid="about-title"
            style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.3, color: 'var(--color-ink)', margin: '0 0 14px' }}
          >
            {doc.title}
          </h1>
          <div data-testid="about-body">
            <AboutMarkdown content={doc.body} />
          </div>
        </>
      )}

      {archive.length > 0 && (
        <div style={{ borderTop: HAIRLINE, marginTop: 26, paddingTop: 18 }}>
          <div
            className="font-mono uppercase"
            style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 1.4, marginBottom: 8 }}
          >
            往期
          </div>
          {archive.map((d) => {
            const isCurrent = d.slug === doc?.slug;
            return (
              <button
                key={d.slug}
                type="button"
                data-testid="about-archive-item"
                aria-current={isCurrent ? 'true' : undefined}
                onClick={() => setViewingSlug(d.slug)}
                className="font-serif"
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '5px 8px', margin: '0 -8px', borderRadius: 2,
                  background: isCurrent ? 'var(--color-paper-edge)' : 'none',
                  border: 'none', cursor: 'pointer',
                  fontSize: 12.5, lineHeight: 1.6, fontWeight: isCurrent ? 500 : 400,
                  color: isCurrent ? 'var(--color-ink)' : 'var(--color-ink-soft)',
                }}
              >
                <span
                  className="font-mono"
                  style={{ fontSize: 10.5, color: 'var(--color-ink-faint)', marginRight: 10 }}
                >
                  {d.date}
                </span>
                {d.title}
              </button>
            );
          })}
        </div>
      )}

      {ABOUT_LICENSES && (
        <div style={{ borderTop: HAIRLINE, marginTop: 26, paddingTop: 18 }}>
          <div
            data-testid="about-ofl-text"
            tabIndex={0}
            style={{
              maxHeight: 280, overflow: 'auto',
              background: 'var(--color-paper-deep)',
              border: HAIRLINE, borderRadius: 2, padding: '12px 14px',
            }}
          >
            <AboutMarkdown content={ABOUT_LICENSES} fontSize={11.5} />
          </div>
        </div>
      )}
    </div>
  );
}
