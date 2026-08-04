import { useCallback, useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useAskStore } from '../../stores/askStore';
import { QuestionCustomRow, QuestionOptionRow } from './QuestionOptionRow';
import { firstUnhandled, goTo, pickOption, setCustom, skipQuestion, toAnswers } from './askDraft';

const COMPOSER_FADE_HEIGHT = 32;

export function QuestionComposer({ threadId }: { threadId: string }) {
  const pending = useAskStore((s) => s.pendingByThread[threadId]);
  const draft = useAskStore((s) => s.draftByThread[threadId]);
  const updateDraft = useAskStore((s) => s.updateDraft);
  const customInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => { rootRef.current?.focus(); }, [pending?.toolCallId]);

  const onCancel = useCallback(async () => {
    if (!pending) return;
    await window.kydog.invoke('ask.cancel', { threadId, toolCallId: pending.toolCallId });
  }, [threadId, pending]);

  if (!pending || !draft) return null;

  const total = pending.questions.length;
  const q = pending.questions[draft.cursor];
  const cur = draft.byQuestionId[q.id];
  const answered = cur?.kind === 'answered' ? cur : null;
  const selectedIds = answered?.optionIds ?? [];
  const custom = answered?.custom ?? '';
  const isLast = draft.cursor === total - 1;

  const onSubmit = async () => {
    const gap = firstUnhandled(draft, pending.questions);
    // 不置灰按钮：还有没处理的题就跳过去，而不是让用户对着一个禁用控件猜原因。
    if (gap !== null) { updateDraft(threadId, (d) => goTo(d, gap, total)); return; }
    try {
      await window.kydog.invoke('ask.submit', {
        threadId, toolCallId: pending.toolCallId, answers: toAnswers(draft, pending.questions),
      });
    } catch (err) {
      console.error('ask.submit failed', err);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // 全部快捷键只在焦点不在输入框时生效：框里数字键就是打字、←→ 就是移光标。
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') { e.preventDefault(); void onCancel(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); updateDraft(threadId, (d) => goTo(d, d.cursor - 1, total)); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); updateDraft(threadId, (d) => goTo(d, d.cursor + 1, total)); return; }
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > q.options.length + 1) return;
    e.preventDefault();
    if (n === q.options.length + 1) { customInputRef.current?.focus(); return; }
    updateDraft(threadId, (d) => pickOption(d, q, q.options[n - 1].id, total));
  };

  return (
    <div className="shrink-0" style={{ position: 'relative', marginTop: -COMPOSER_FADE_HEIGHT }}>
      <div
        aria-hidden
        style={{
          height: COMPOSER_FADE_HEIGHT,
          background: 'linear-gradient(to bottom, transparent, var(--paper-deep))',
          pointerEvents: 'none',
        }}
      />
      <div className="ky-paper-grain" style={{ backgroundColor: 'var(--paper-deep)', padding: '0 22px 14px' }}>
        <div style={{ maxWidth: 840, margin: '0 auto' }}>
          {/* 外壳与 Composer 完全一致：形态切换看起来像同一个容器换了内容。 */}
          <div
            ref={rootRef}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            data-testid="question-composer"
            style={{
              background: 'var(--color-paper)',
              border: '0.5px solid var(--color-ink-hair)',
              borderRadius: 4,
              padding: '12px 14px',
              boxShadow: '0 1px 0 var(--color-card-shadow-strong)',
              outline: 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ flex: 1, fontSize: 14, color: 'var(--color-ink)' }}>{q.question}</span>
              <button
                type="button" data-testid="ask-prev" aria-label="上一题"
                disabled={draft.cursor === 0}
                onClick={() => updateDraft(threadId, (d) => goTo(d, d.cursor - 1, total))}
                style={navStyle}
              >‹</button>
              <span className="font-mono" style={{ fontSize: 11, color: 'var(--color-ink-faint)' }}>
                {draft.cursor + 1} / {total}
              </span>
              <button
                type="button" data-testid="ask-next" aria-label="下一题"
                disabled={isLast}
                onClick={() => updateDraft(threadId, (d) => goTo(d, d.cursor + 1, total))}
                style={navStyle}
              >›</button>
              <button
                type="button" data-testid="ask-close" aria-label="关闭提问"
                onClick={() => void onCancel()} style={navStyle}
              >×</button>
            </div>

            {q.options.map((o, i) => (
              <QuestionOptionRow
                key={o.id}
                option={o}
                index={i}
                multiSelect={q.multiSelect === true}
                selected={selectedIds.includes(o.id)}
                onSelect={() => updateDraft(threadId, (d) => pickOption(d, q, o.id, total))}
              />
            ))}
            <QuestionCustomRow
              index={q.options.length}
              multiSelect={q.multiSelect === true}
              value={custom}
              inputRef={customInputRef}
              onChange={(text) => updateDraft(threadId, (d) => setCustom(d, q, text))}
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button
                type="button" data-testid="ask-skip"
                onClick={() => updateDraft(threadId, (d) => skipQuestion(d, q, total))}
                style={{ ...btnStyle, border: 'none', color: 'var(--color-ink-soft)' }}
              >跳过</button>
              <button type="button" data-testid="ask-submit" onClick={() => void onSubmit()} style={btnStyle}>
                {isLast ? '提交' : '下一题'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const navStyle: CSSProperties = {
  border: 'none', background: 'transparent', cursor: 'pointer',
  fontSize: 13, color: 'var(--color-ink-faint)', padding: '0 2px',
};

const btnStyle: CSSProperties = {
  fontSize: 12, height: 26, padding: '0 12px', borderRadius: 4,
  border: '0.5px solid var(--color-ink-hair)', background: 'transparent',
  color: 'var(--color-ink)', cursor: 'pointer',
};
