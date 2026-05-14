import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';
import { useLlmStore } from '../../stores/llmStore';
import { useUiStore } from '../../stores/uiStore';
import { useSkillsStore } from '../../stores/skillsStore';
import { NavIcon } from '../../shared';
import { InputPillModelMenu } from './InputPillModelMenu';
import { InputPillProjectMenu } from './InputPillProjectMenu';
import { InputPillSlashMenu } from './InputPillSlashMenu';
import { InputPillSendButton } from './InputPillSendButton';
import { InputPillSkillChip } from './InputPillSkillChip';
import { InputPillTextarea, type InputPillTextareaHandle } from './InputPillTextarea';
import { InputPillChipBar } from './InputPillChipBar';
import { filterSkillEntries, dispatchInputKey } from './inputPillHelpers';
import type { SkillEntry } from '../../../shared/types';

type Props = {
  threadId: string;
  placeholder?: string;
  large?: boolean;
  prefill?: string;
};

const CHIP_GAP_PX = 6;

export function InputPill({ threadId, placeholder, large = false, prefill }: Props) {
  const textareaHandle = useRef<InputPillTextareaHandle>(null);
  const [skill, setSkill] = useState<SkillEntry | null>(null);
  const [body, setBody] = useState('');
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [modelMenuRect, setModelMenuRect] = useState<DOMRect | null>(null);
  const [projectMenuRect, setProjectMenuRect] = useState<DOMRect | null>(null);
  const [menuForceClosed, setMenuForceClosed] = useState(false);

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

  // Slash menu data: installed enabled skills.
  const skillEntries = useSkillsStore((s) => s.skills);
  const enabledSkills = useMemo(
    () => skillEntries.filter((s) => s.enabled),
    [skillEntries],
  );
  const slashItems = useMemo(
    () => (skill !== null ? [] : filterSkillEntries(enabledSkills, body)),
    [skill, enabledSkills, body],
  );
  const slashMenuOpen = !menuForceClosed && skill === null && slashItems.length > 0;

  useEffect(() => {
    if (slashHighlight >= slashItems.length) setSlashHighlight(0);
  }, [slashItems.length, slashHighlight]);

  // Measure the chip width to indent the textarea's first line.
  const chipOverlayRef = useRef<HTMLDivElement>(null);
  const [chipIndent, setChipIndent] = useState(0);
  useLayoutEffect(() => {
    if (!skill) { setChipIndent(0); return; }
    const w = chipOverlayRef.current?.getBoundingClientRect().width ?? 0;
    setChipIndent(w > 0 ? w + CHIP_GAP_PX : 0);
  }, [skill]);

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

  const composedContent = (): string => {
    const b = body.trim();
    if (skill) return b ? `/${skill.name} ${b}` : `/${skill.name}`;
    return b;
  };

  const onSend = async () => {
    const content = composedContent();
    if (!content || isRunning) return;
    setSkill(null);
    setBody('');
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
    setSkill(item);
    setBody('');
    setSlashHighlight(0);
    setMenuForceClosed(false);
    requestAnimationFrame(() => textareaHandle.current?.focus());
  };

  const removeSkill = () => {
    setSkill(null);
    requestAnimationFrame(() => textareaHandle.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Backspace at the very start of the body removes the leading skill chip.
    if (e.key === 'Backspace' && skill !== null) {
      const ta = textareaHandle.current?.el();
      if (ta && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        e.preventDefault();
        removeSkill();
        return;
      }
    }

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
        setMenuForceClosed(true);
        break;
      case 'ignore':
      default:
        break;
    }
  };

  const onBodyChange = (next: string) => {
    setBody(next);
    setMenuForceClosed(false);
  };

  // When prefill arrives, parse "/<skill> <rest>" and either set a chip or fall
  // back to placing the raw text in the body. The skill list may not have
  // loaded yet — when it loads, this effect re-runs (enabledSkills change).
  useEffect(() => {
    if (prefill === undefined) return;
    const match = prefill.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (match) {
      const found = enabledSkills.find((s) => s.name === match[1]);
      if (found) {
        setSkill(found);
        setBody(match[2] ?? '');
        setMenuForceClosed(false);
        return;
      }
    }
    setSkill(null);
    setBody(prefill);
    setMenuForceClosed(false);
  }, [prefill, enabledSkills]);

  const effectivePlaceholder = isRunning
    ? '运行中…'
    : (placeholder ?? (large ? '问一个研究问题，或拖入 PDF / 文件夹…' : '继续追问…'));

  const canSend = composedContent().length > 0;

  return (
    <div
      className="ky-paper-grain shrink-0"
      style={{ padding: '12px 22px 14px' }}
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
          <div style={{ position: 'relative' }}>
            {skill ? (
              <div
                ref={chipOverlayRef}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  // Match the textarea's first-line box exactly so the chip is
                  // vertically centered against the typed text's baseline.
                  // fontSize (14 or 15) × lineHeight (1.5).
                  height: large ? '22.5px' : '21px',
                  display: 'flex',
                  alignItems: 'center',
                  pointerEvents: 'auto',
                }}
              >
                <InputPillSkillChip skill={skill} onRemove={removeSkill} />
              </div>
            ) : null}
            <InputPillTextarea
              ref={textareaHandle}
              value={body}
              disabled={isRunning}
              large={large}
              placeholder={effectivePlaceholder}
              onChange={onBodyChange}
              onKeyDown={onKeyDown}
              inlineStartPadding={chipIndent}
            />
          </div>
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
                  <InputPillSendButton variant="send" disabled={!canSend} onClick={onSend} />
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
            setSkill(item);
            setBody('');
            setSlashHighlight(0);
            setMenuForceClosed(false);
            requestAnimationFrame(() => textareaHandle.current?.focus());
          }}
        />
      ) : null}
    </div>
  );
}
