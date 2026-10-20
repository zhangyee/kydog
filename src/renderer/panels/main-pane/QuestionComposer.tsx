import { useCallback, useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useAskStore } from '../../stores/askStore';
import { QuestionCustomRow, QuestionOptionRow } from './QuestionOptionRow';
import { ErrorMarginalia } from './ErrorMarginalia';
import type { AskQuestion } from '../../../shared/askQuestion';
import { firstUnhandled, goTo, pickOption, setCustom, skipQuestion, toAnswers, type AskDraft } from './askDraft';

const COMPOSER_FADE_HEIGHT = 32;

export function QuestionComposer({ threadId }: { threadId: string }) {
  const pending = useAskStore((s) => s.pendingByThread[threadId]);
  const draft = useAskStore((s) => s.draftByThread[threadId]);
  const updateDraft = useAskStore((s) => s.updateDraft);
  const submission = useAskStore((s) => s.submissionByThread[threadId]);
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
  // 主按钮的文案必须和它的动作读同一个来源。用 isLast 决定文案会撒谎：
  // 用户翻回第 1 题复看时三题都已处理，按钮写着「下一题」，点下去却是提交。
  const gap = firstUnhandled(draft, pending.questions);

  const locked = submission?.status === 'submitting' || submission?.status === 'submitted';

  // 同一事件快照可能连续触发；每次从 store 取当前身份与草稿，不让闭包旧值覆盖本次选择。
  const current = () => {
    const state = useAskStore.getState();
    const latestPending = state.pendingByThread[threadId];
    const latestDraft = state.draftByThread[threadId];
    const status = state.submissionByThread[threadId]?.status;
    if (latestPending?.toolCallId !== pending.toolCallId || !latestDraft ||
        status === 'submitting' || status === 'submitted') return null;
    return { pending: latestPending, draft: latestDraft };
  };

  const editDraft = (fn: (d: AskDraft, question: AskQuestion, total: number) => AskDraft) => {
    const latest = current();
    if (!latest) return;
    const { questions } = latest.pending;
    updateDraft(threadId, (d) => fn(d, questions[d.cursor], questions.length));
  };

  const submitDraft = async (nextDraft: AskDraft): Promise<void> => {
    const latest = current();
    if (!latest) return;
    const { toolCallId, questions } = latest.pending;
    const nextGap = firstUnhandled(nextDraft, questions);
    // 不置灰未答全的按钮：先把用户引导到缺口，不隐式跳过。
    if (nextGap !== null) {
      updateDraft(threadId, () => goTo(nextDraft, nextGap, questions.length));
      return;
    }
    if (!useAskStore.getState().beginSubmit(threadId, toolCallId)) return;
    try {
      await window.kydog.invoke('ask.submit', {
        threadId, toolCallId, answers: toAnswers(nextDraft, questions),
      });
      useAskStore.getState().finishSubmit(threadId, toolCallId);
    } catch (err) {
      useAskStore.getState().finishSubmit(threadId, toolCallId, err instanceof Error ? err.message : String(err));
    }
  };

  const onPickOption = (optionId: string): void => {
    const latest = current();
    if (!latest) return;
    const { questions } = latest.pending;
    const question = questions[latest.draft.cursor];
    if (!question.options.some((option) => option.id === optionId)) return;
    const nextDraft = pickOption(latest.draft, question, optionId, questions.length);
    updateDraft(threadId, () => nextDraft);
    if (latest.draft.cursor === questions.length - 1 && !question.multiSelect) void submitDraft(nextDraft);
  };

  const onSubmit = () => {
    const latest = current();
    if (latest) void submitDraft(latest.draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // 全部快捷键只在焦点不在输入框时生效：框里数字键就是打字、←→ 就是移光标。
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') { e.preventDefault(); void onCancel(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); editDraft((d, _q, count) => goTo(d, d.cursor - 1, count)); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); editDraft((d, _q, count) => goTo(d, d.cursor + 1, count)); return; }
    const latest = current();
    if (!latest || e.repeat) return;
    const question = latest.pending.questions[latest.draft.cursor];
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > question.options.length + 1) return;
    e.preventDefault();
    if (n === question.options.length + 1) { customInputRef.current?.focus(); return; }
    onPickOption(question.options[n - 1].id);
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
                disabled={locked || draft.cursor === 0}
                onClick={() => editDraft((d, _q, count) => goTo(d, d.cursor - 1, count))}
                style={navStyle}
              >‹</button>
              <span className="font-mono" style={{ fontSize: 11, color: 'var(--color-ink-faint)' }}>
                {draft.cursor + 1} / {total}
              </span>
              <button
                type="button" data-testid="ask-next" aria-label="下一题"
                disabled={locked || isLast}
                onClick={() => editDraft((d, _q, count) => goTo(d, d.cursor + 1, count))}
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
                onSelect={() => onPickOption(o.id)}
              />
            ))}
            <QuestionCustomRow
              index={q.options.length}
              multiSelect={q.multiSelect === true}
              value={custom}
              inputRef={customInputRef}
              onChange={(text) => editDraft((d, question) => setCustom(d, question, text))}
            />

            {submission?.status === 'error' && <ErrorMarginalia text={submission.error ?? ''} />}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button
                type="button" data-testid="ask-skip"
                disabled={locked}
                onClick={() => editDraft((d, question, count) => skipQuestion(d, question, count))}
                style={{ ...btnStyle, border: 'none', color: 'var(--color-ink-soft)' }}
              >跳过</button>
              <button type="button" data-testid="ask-submit" disabled={locked} onClick={onSubmit} style={btnStyle}>
                {gap === null ? '提交' : '下一题'}
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
