import { useEffect, useRef, useState } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';
import { useSettingsStore } from '../../stores/settingsStore';

type Props = {
  threadId: string;
  placeholder?: string;
  large?: boolean;
  /**
   * External prefill value. When this changes (e.g. user clicks a ChapterCard),
   * the textarea text is reset to this value.
   * NOTE: Re-clicking the SAME card with the same string won't re-trigger the
   * effect (React only runs effects when deps change). Acceptable MVP UX.
   */
  prefill?: string;
};

export function InputPill({
  threadId,
  placeholder = '继续追问，或 ⌘K 切换 Skill…',
  large = false,
  prefill,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const runState = useRunsStore((s) => s.runStateByThread[threadId]);
  const isRunning = runState?.status === 'running';
  const provider = useSettingsStore((s) => s.settings?.llm.provider);
  const appendUser = useThreadsStore((s) => s.appendUserMessage);
  const thread = useThreadsStore((s) =>
    Object.values(s.threadsByProject).flat().find((t) => t.id === threadId),
  );
  const projectName = thread ? (thread.projectPath.split('/').pop() ?? '') : '';

  // Apply external prefill (e.g. ChapterCard click) to internal text.
  useEffect(() => {
    if (prefill !== undefined) setText(prefill);
  }, [prefill]);

  // Auto-grow textarea as content changes (capped to keep send button visible).
  useEffect(() => {
    if (!textareaRef.current) return;
    const el = textareaRef.current;
    el.style.height = 'auto';
    const max = large ? 240 : 160;
    const next = Math.min(el.scrollHeight, max);
    el.style.height = next + 'px';
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [text, large]);

  const onSend = async () => {
    const content = text.trim();
    if (!content || isRunning) return;
    setText('');
    appendUser(threadId, {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    });
    try {
      await window.kydog.invoke('thread.send', { threadId, content });
    } catch (err) {
      console.error('send failed', err);
    }
  };

  const onStop = async () => {
    await window.kydog.invoke('thread.abort', { threadId });
  };

  return (
    <div
      className="ky-paper-deep shrink-0"
      style={{ borderTop: '0.5px solid var(--color-ink-hair)', padding: '12px 22px 14px' }}
    >
      <div
        style={{
          background: 'var(--color-paper)',
          border: '0.5px solid var(--color-ink-hair)',
          borderRadius: 4,
          padding: large ? '14px 18px 12px' : '10px 14px',
          boxShadow:
            '0 1px 0 var(--color-card-shadow-strong)' +
            (large ? ', 0 8px 24px var(--color-card-shadow-strong)' : ''),
        }}
      >
        <textarea
          ref={textareaRef}
          data-testid="input-pill"
          value={text}
          disabled={isRunning}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void onSend();
            }
          }}
          placeholder={isRunning ? '运行中…' : placeholder}
          rows={large ? 2 : 1}
          className="font-serif w-full resize-none bg-transparent border-0 outline-none disabled:opacity-50"
          style={{
            fontSize: large ? 15 : 14,
            lineHeight: 1.5,
            color: 'var(--color-ink)',
            minHeight: large ? 44 : 24,
          }}
        />
        <div
          className="flex items-center gap-2"
          style={{
            marginTop: large ? 10 : 8,
            paddingTop: large ? 10 : 8,
            borderTop: '0.5px solid var(--color-ink-hair-soft)',
          }}
        >
          {[`＠ ${projectName || 'Project'}`, '§ Skills', '¶ 记忆'].map((s) => (
            <span
              key={s}
              className="font-sans"
              style={{
                padding: large ? '3px 9px' : '2px 8px',
                border: '0.5px solid var(--color-ink-hair)',
                borderRadius: 2,
                fontSize: large ? 11 : 10.5,
                color: 'var(--color-ink-soft)',
              }}
            >
              {s}
            </span>
          ))}
          <span style={{ flex: 1 }} />
          <span
            className="font-mono"
            style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}
          >
            {provider ? `${provider.name} · ${provider.model}` : 'BYOK'}
          </span>
          <span
            className="font-mono"
            style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}
          >
            ⌘↵
          </span>
          {isRunning ? (
            <button
              type="button"
              data-testid="stop-button"
              onClick={onStop}
              className="font-serif bg-[color:var(--color-accent)] transition-colors hover:bg-[color:var(--color-accent-hover)]"
              style={{
                width: large ? 30 : 26,
                height: large ? 30 : 26,
                padding: 0,
                color: 'var(--color-paper)',
                borderRadius: 2,
                fontSize: large ? 13 : 12,
              }}
              aria-label="停止"
            >
              ■
            </button>
          ) : (
            <button
              type="button"
              data-testid="send-button"
              onClick={onSend}
              disabled={!text.trim()}
              className="font-serif italic bg-[color:var(--color-accent)] disabled:opacity-50 transition-colors hover:bg-[color:var(--color-accent-hover)]"
              style={{
                width: large ? 30 : 26,
                height: large ? 30 : 26,
                padding: 0,
                color: 'var(--color-paper)',
                borderRadius: 2,
                fontSize: large ? 15 : 13,
              }}
              aria-label="发送"
            >
              ↵
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
