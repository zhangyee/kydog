import { useEffect, useRef, useState } from 'react';
import { ABOUT_DOCS, ABOUT_LICENSES } from './about/aboutDocs';
import { AboutMarkdown } from './about/AboutMarkdown';

const HAIRLINE = '0.5px solid var(--color-ink-hair-soft)';

// post: slug === null 看当前篇（ABOUT_DOCS[0]），否则看指定往期篇。
// licenses: 整页替换成开源许可（字体 + 依赖库），不是叠在 post 视图下面的附加区块。
// 用一个判别联合而不是拆开的两个布尔，state 不会出现「两边都为真」这种互相矛盾的组合。
type View = { kind: 'post'; slug: string | null } | { kind: 'licenses' };

export function AboutSection() {
  const [view, setView] = useState<View>({ kind: 'post', slug: null });
  // 每次切换视图（往期切篇 / 进出开源许可页），把这个 ref 指向的元素滚回可见区域。
  // 设置页整体会滚动，翻到底部点了链接之后，不滚的话新内容会渲染到视口外面。
  // post 视图挂在 <h1>，licenses 视图挂在返回按钮，两种元素类型不同，用回调 ref 统一存进同一个盒子。
  const topRef = useRef<HTMLElement | null>(null);
  const setTopRef = (el: HTMLElement | null) => { topRef.current = el; };

  const latest = ABOUT_DOCS[0] ?? null;
  const doc = view.kind === 'post'
    ? (view.slug ? ABOUT_DOCS.find((d) => d.slug === view.slug) : null) ?? latest
    : null;
  // 往期列表恒为「除最新篇外的所有篇」，不随 view 变化，列表才不会跳动。
  const archive = ABOUT_DOCS.slice(1);
  const isArchive = !!doc && !!latest && doc.slug !== latest.slug;
  const viewKey = view.kind === 'post' ? `post:${view.slug ?? 'latest'}` : 'licenses';

  useEffect(() => {
    topRef.current?.scrollIntoView({ block: 'start' });
  }, [viewKey]);

  return (
    <div style={{ padding: '28px 28px 40px', maxWidth: 720 }}>
      {view.kind === 'licenses' ? (
        <>
          <button
            ref={setTopRef}
            type="button"
            onClick={() => setView({ kind: 'post', slug: null })}
            data-testid="about-licenses-back"
            className="font-mono"
            style={{
              display: 'block', marginBottom: 12, padding: 0,
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 10.5, letterSpacing: 0.6, color: 'var(--color-marginalia)',
            }}
          >
            ← 返回
          </button>
          <AboutMarkdown content={ABOUT_LICENSES} />
        </>
      ) : (
        <>
          {isArchive && doc && (
            <button
              type="button"
              onClick={() => setView({ kind: 'post', slug: null })}
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
                ref={setTopRef}
                className="font-serif"
                data-testid="about-title"
                style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.3, color: 'var(--color-ink)', margin: '0 0 14px' }}
              >
                {doc.title}
              </h1>
              <div data-testid="about-body">
                <AboutMarkdown content={doc.body} softBreaks />
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
                    onClick={() => setView({ kind: 'post', slug: d.slug })}
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
              <button
                type="button"
                data-testid="about-licenses-entry"
                onClick={() => setView({ kind: 'licenses' })}
                className="font-serif"
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '5px 8px', margin: '0 -8px', borderRadius: 2,
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-ink-soft)',
                }}
              >
                开源许可
                {/* 尾箭头是这一条唯一的可点提示 —— 它没有「往期」那样的日期前缀，
                    纯文字会和上面的分组标签看起来一样，像个空小节。 */}
                <span
                  className="font-mono"
                  style={{ fontSize: 10.5, color: 'var(--color-ink-faint)', marginLeft: 8 }}
                >
                  →
                </span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
