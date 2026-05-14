import { type KeyboardEvent, useEffect, useRef, useState, useMemo } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';
import { useLlmStore } from '../../stores/llmStore';
import { useUiStore } from '../../stores/uiStore';
import { NavIcon } from '../../shared';
import { InputPillModelMenu } from './InputPillModelMenu';
import { InputPillProjectMenu } from './InputPillProjectMenu';
import { InputPillSlashMenu } from './InputPillSlashMenu';
import { InputPillSendButton } from './InputPillSendButton';
import { InputPillTextarea, type InputPillTextareaHandle } from './InputPillTextarea';
import { InputPillChipBar } from './InputPillChipBar';
import { SKILL_MENU_ITEMS } from './skillMenuItems';
import { filterSlashItems, dispatchInputKey } from './inputPillHelpers';

type Props = {
  threadId: string;
  placeholder?: string;
  large?: boolean;
  prefill?: string;
};

export function InputPill({ threadId, placeholder, large = false, prefill }: Props) {
  const textareaHandle = useRef<InputPillTextareaHandle>(null);
  const [text, setText] = useState('');
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [modelMenuRect, setModelMenuRect] = useState<DOMRect | null>(null);
  const [projectMenuRect, setProjectMenuRect] = useState<DOMRect | null>(null);
  const [justPrefilled, setJustPrefilled] = useState(false);

  const runState = useRunsStore((s) => s.runStateByThread[threadId]);
  const isRunning = runState?.status === 'running';
  const appendUser = useThreadsStore((s) => s.appendUserMessage);
  const thread = useThreadsStore((s) =>
    Object.values(s.threadsByProject).flat().find((t) => t.id === threadId),
  );
  const messages = useThreadsStore((s) => s.historyByThread[threadId]) ?? [];
  const isEmptyThread = messages.length === 0;

  const projectName = thread ? (thread.projectPath.split('/').pop() ?? '') : '';

  // Model picker state (existing pattern preserved).
  const defaultProvider = useLlmStore((s) => s.defaultProvider);
  const defaultModel = useLlmStore((s) => s.defaultModel);
  const allConfigured = useLlmStore((s) => s.configured);
  const openSettings = useUiStore((s) => s.openSettings);
  const override = thread?.modelOverride;
  const effectiveProviderId = override?.providerId ?? defaultProvider;
  const effectiveModelId =
    override?.modelId
    ?? defaultModel
    ?? allConfigured.find((c) => c.providerId === effectiveProviderId)?.defaultModel
    ?? null;
  const eligibleCount = allConfigured.filter((c) => c.authStatus.configured && c.modelIds.length > 0).length;
  const showBYOK = eligibleCount === 0;
  const modelLabel = showBYOK
    ? 'BYOK'
    : effectiveProviderId && effectiveModelId
    ? `${allConfigured.find((c) => c.providerId === effectiveProviderId)?.displayName ?? effectiveProviderId} · ${effectiveModelId}`
    : '选择模型';

  // Slash menu state (derived from text).
  const slashItems = useMemo(() => filterSlashItems(SKILL_MENU_ITEMS, text), [text]);
  // Exception: when prefill just put a complete "/name " into textarea, do not show menu.
  const exactPrefillMatch = SKILL_MENU_ITEMS.some((it) => text === `${it.name} `);
  const slashMenuOpen = slashItems.length > 0 && !(justPrefilled && exactPrefillMatch);

  useEffect(() => {
    if (slashHighlight >= slashItems.length) setSlashHighlight(0);
  }, [slashItems.length, slashHighlight]);

  const modelPillRef = useRef<HTMLButtonElement>(null);
  const projectPillRef = useRef<HTMLButtonElement>(null);
  const textareaWrapperRef = useRef<HTMLDivElement>(null);

  const onModelPillClick = () => {
    if (showBYOK) { openSettings('provider'); return; }
    if (!threadId) return;
    const r = modelPillRef.current?.getBoundingClientRect();
    if (r) setModelMenuRect(r);
  };

  const onProjectPillClick = () => {
    const r = projectPillRef.current?.getBoundingClientRect();
    if (r) setProjectMenuRect(r);
  };

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

  const commitSlash = (idx: number) => {
    const item = slashItems[idx];
    if (!item) return;
    setText(`${item.name} `);
    setJustPrefilled(false);
    setSlashHighlight(0);
    requestAnimationFrame(() => textareaHandle.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = dispatchInputKey({
      key: e.key,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      isComposing: e.nativeEvent.isComposing,
      slashMenuOpen,
    });
    switch (action.kind) {
      case 'send':
        e.preventDefault();
        void onSend();
        break;
      case 'newline':
        // let default textarea behavior insert newline
        break;
      case 'slash-down':
        e.preventDefault();
        setSlashHighlight((i) => (slashItems.length === 0 ? 0 : (i + 1) % slashItems.length));
        break;
      case 'slash-up':
        e.preventDefault();
        setSlashHighlight((i) => (slashItems.length === 0 ? 0 : (i - 1 + slashItems.length) % slashItems.length));
        break;
      case 'slash-commit':
        e.preventDefault();
        commitSlash(slashHighlight);
        break;
      case 'slash-close':
        e.preventDefault();
        // close by inserting a space — keeps text but breaks menu condition
        setText((t) => (t.startsWith('/') ? `${t} ` : t));
        break;
      case 'ignore':
      default:
        break;
    }
  };

  const onTextChange = (next: string) => {
    setText(next);
    setJustPrefilled(false);
  };

  // When prefill arrives, mark it so slash menu doesn't pop on a fresh card click.
  useEffect(() => {
    if (prefill !== undefined) setJustPrefilled(true);
  }, [prefill]);

  const effectivePlaceholder = isRunning
    ? '运行中…'
    : (placeholder ?? (large ? '问一个研究问题，或拖入 PDF / 文件夹…' : '继续追问…'));

  return (
    <div
      className="ky-paper-deep shrink-0"
      style={{ borderTop: '0.5px solid var(--color-ink-hair)', padding: '12px 22px 14px' }}
    >
      <div style={{ maxWidth: 840, margin: '0 auto' }}>
        <div
          ref={textareaWrapperRef}
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
          <InputPillTextarea
            ref={textareaHandle}
            value={text}
            disabled={isRunning}
            large={large}
            placeholder={effectivePlaceholder}
            onChange={onTextChange}
            onKeyDown={onKeyDown}
            prefill={prefill}
          />
          <InputPillChipBar
            large={large}
            left={large && isEmptyThread ? (
              <button
                ref={projectPillRef}
                type="button"
                data-testid="project-pill"
                onClick={onProjectPillClick}
                className="font-mono inline-flex items-center"
                style={{
                  padding: '2px 10px',
                  borderRadius: 999,
                  border: '0.5px solid var(--color-ink-hair)',
                  background: 'transparent',
                  fontSize: 10,
                  color: 'var(--color-ink)',
                  cursor: 'pointer',
                  gap: 6,
                }}
              >
                <NavIcon name="folder" size={11} />
                <span>{projectName || 'Project'}</span>
                <NavIcon name="chevron-down" size={10} />
              </button>
            ) : undefined}
            right={
              <>
                <button
                  ref={modelPillRef}
                  type="button"
                  data-testid="model-pill"
                  onClick={onModelPillClick}
                  className="font-mono"
                  style={{
                    padding: '2px 10px',
                    borderRadius: 999,
                    border: '0.5px solid var(--color-ink-hair)',
                    background: 'transparent',
                    fontSize: 10,
                    color: showBYOK ? 'var(--color-ink-faint)' : 'var(--color-ink)',
                    cursor: 'pointer',
                  }}
                >
                  {modelLabel}
                  {!showBYOK ? ' ▾' : ''}
                  {override ? (
                    <span title="本 thread 已覆盖" style={{ marginLeft: 4, color: 'var(--color-ink-faint)' }}>ⓘ</span>
                  ) : null}
                </button>
                {isRunning ? (
                  <InputPillSendButton variant="stop" onClick={onStop} />
                ) : (
                  <InputPillSendButton variant="send" disabled={!text.trim()} onClick={onSend} />
                )}
              </>
            }
          />
        </div>
      </div>

      {modelMenuRect && threadId ? (
        <InputPillModelMenu
          threadId={threadId}
          anchorRect={modelMenuRect}
          onClose={() => setModelMenuRect(null)}
        />
      ) : null}
      {projectMenuRect && thread ? (
        <InputPillProjectMenu
          threadId={threadId}
          currentProjectPath={thread.projectPath}
          anchorRect={projectMenuRect}
          onClose={() => setProjectMenuRect(null)}
        />
      ) : null}
      {slashMenuOpen && textareaWrapperRef.current ? (
        <InputPillSlashMenu
          items={slashItems}
          highlightIndex={slashHighlight}
          anchorRect={textareaWrapperRef.current.getBoundingClientRect()}
          onHover={setSlashHighlight}
          onSelect={(item) => {
            setText(`${item.name} `);
            setJustPrefilled(false);
            requestAnimationFrame(() => textareaHandle.current?.focus());
          }}
        />
      ) : null}
    </div>
  );
}
