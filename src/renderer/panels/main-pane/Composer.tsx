import { type KeyboardEvent, useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useComposerDraftStore, EMPTY_DRAFT } from './composerDraftStore';
import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';
import { useLlmStore } from '../../stores/llmStore';
import { useUiStore } from '../../stores/uiStore';
import { useSkillsStore } from '../../stores/skillsStore';
import { NavIcon } from '../../shared';
import { ComposerModelMenu } from './ComposerModelMenu';
import { ComposerProjectMenu } from './ComposerProjectMenu';
import { ComposerSlashMenu } from './ComposerSlashMenu';
import { ComposerSendButton } from './ComposerSendButton';
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor';
import { ComposerActionsRow } from './ComposerActionsRow';
import { filterSkillEntries, dispatchInputKey } from './composerHelpers';
import type { SkillEntry } from '../../../shared/types';

type Props = {
  threadId: string;
  placeholder?: string;
  large?: boolean;
  prefill?: string;
};

// Vertical strip at the top of the composer that overlays MessageList's
// bottom region with a transparent → paper-deep gradient. Messages scrolling
// up into this strip dissolve into the composer's paper-deep tone.
const COMPOSER_FADE_HEIGHT = 32;

export function Composer({ threadId, placeholder, large = false, prefill }: Props) {
  const editorHandle = useRef<ComposerEditorHandle>(null);
  // 未发送的输入存在组件外（见 composerDraftStore）：切文件 tab / 设置页 / 别的
  // thread 都会把这个组件卸载掉，留在组件 state 里的字会跟着一起没。
  const { skill, body } = useComposerDraftStore((s) => s.byThread[threadId]) ?? EMPTY_DRAFT;
  const setDraft = useCallback((nextSkill: SkillEntry | null, nextBody: string) => {
    useComposerDraftStore.getState().setDraft(threadId, { skill: nextSkill, body: nextBody });
  }, [threadId]);
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

  const projectName = thread ? (thread.projectPath.split(/[\\/]/).pop() ?? '') : '';

  // Model picker state (existing pattern preserved).
  const defaultProvider = useLlmStore((s) => s.defaultProvider);
  const defaultModel = useLlmStore((s) => s.defaultModel);
  const allConfigured = useLlmStore((s) => s.configured);
  const openSettings = useUiStore((s) => s.openSettings);
  // 窄模式判据用 browserOpen（协议层事实：浏览器侧栏开着），不是「对话栏宽度 <
  // 某阈值」——后者是启发式 proxy（CLAUDE.md 开篇那条原则）。代价是把浏览器拖得
  // 很窄、对话栏本身很宽时窄模式仍然生效——这是刻意取舍，不是没量准。
  const narrow = useUiStore((s) => s.browserOpen);
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

  const modelPillRef = useRef<HTMLButtonElement>(null);
  const projectPillRef = useRef<HTMLButtonElement>(null);
  const editorWrapperRef = useRef<HTMLDivElement>(null);

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
    useComposerDraftStore.getState().clearDraft(threadId);
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

  const applySlashSelection = (item: SkillEntry) => {
    // Strip the leading "/<query><whitespace>" from body and keep the rest.
    // body always starts with "/" here (slash-menu open condition).
    const afterSlash = body.startsWith('/') ? body.slice(1) : body;
    const wsMatch = afterSlash.match(/\s/);
    const remaining = wsMatch ? afterSlash.slice((wsMatch.index ?? 0) + 1) : '';
    setDraft(item, remaining);
    setSlashHighlight(0);
    setMenuForceClosed(false);
    requestAnimationFrame(() => editorHandle.current?.focus());
  };

  const commitSlash = (idx: number) => {
    const item = slashItems[idx];
    if (!item) return;
    applySlashSelection(item);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
        // let default contenteditable behavior insert a line break
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

  const onEditorChange = useCallback((nextSkill: SkillEntry | null, nextBody: string) => {
    setDraft(nextSkill, nextBody);
    setMenuForceClosed(false);
  }, [setDraft]);

  // When prefill arrives, parse "/<skill> <rest>" into chip + body if the skill
  // exists; otherwise put the raw text in the body. enabledSkills is in deps so
  // a late-arriving skill list still gets a chance to upgrade plain text → chip.
  useEffect(() => {
    if (prefill === undefined) return;
    const match = prefill.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (match) {
      const found = enabledSkills.find((s) => s.name === match[1]);
      if (found) {
        setDraft(found, match[2] ?? '');
        setMenuForceClosed(false);
        return;
      }
    }
    setDraft(null, prefill);
    setMenuForceClosed(false);
  }, [prefill, enabledSkills, setDraft]);

  const effectivePlaceholder = isRunning
    ? '运行中，可继续编辑下一条…'
    : (placeholder ?? (large ? '问一个研究问题，或拖入 PDF / 文件夹…' : '继续追问…'));

  const canSend = composedContent().length > 0;

  return (
    <div
      className="shrink-0"
      data-thread-id={threadId}
      style={{ position: 'relative', marginTop: -COMPOSER_FADE_HEIGHT }}
    >
      {/* Gradient fade that overlays the last ~32px of MessageList so messages
       * scrolling under the composer dissolve into the paper-deep tone instead
       * of hitting a hard edge. */}
      <div
        aria-hidden
        style={{
          height: COMPOSER_FADE_HEIGHT,
          background: 'linear-gradient(to bottom, transparent, var(--paper-deep))',
          pointerEvents: 'none',
        }}
      />
      <div
        className="ky-paper-grain"
        style={{ backgroundColor: 'var(--paper-deep)', padding: narrow ? '0 12px 14px' : '0 22px 14px' }}
      >
        <div style={{ maxWidth: 840, margin: '0 auto' }}>
        <div
          ref={editorWrapperRef}
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
          <ComposerEditor
            ref={editorHandle}
            skill={skill}
            body={body}
            large={large}
            placeholder={effectivePlaceholder}
            skills={enabledSkills}
            onChange={onEditorChange}
            onKeyDown={onKeyDown}
          />
          <ComposerActionsRow
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
                {/* 模型 pill 是切模型的唯一入口。窄模式（浏览器侧栏开着）下把它收起来
                    之后，用户必须先关浏览器侧栏才能换模型——这是产品已经确认接受的
                    取舍，不是漏做的功能。别因为「窄模式下换不了模型」把这段当 bug
                    修回去、加一个窄模式也显示 pill 的例外分支。 */}
                {!narrow && (
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
                )}
                {isRunning ? (
                  <ComposerSendButton variant="stop" onClick={onStop} />
                ) : (
                  <ComposerSendButton variant="send" disabled={!canSend} onClick={onSend} />
                )}
              </>
            }
          />
        </div>
      </div>
      </div>

      {modelMenuRect && threadId ? (
        <ComposerModelMenu
          threadId={threadId}
          anchorRect={modelMenuRect}
          onClose={() => setModelMenuRect(null)}
        />
      ) : null}
      {projectMenuRect && thread ? (
        <ComposerProjectMenu
          threadId={threadId}
          currentProjectPath={thread.projectPath}
          anchorRect={projectMenuRect}
          onClose={() => setProjectMenuRect(null)}
        />
      ) : null}
      {slashMenuOpen && editorWrapperRef.current ? (
        <ComposerSlashMenu
          items={slashItems}
          highlightIndex={slashHighlight}
          anchorRect={editorWrapperRef.current.getBoundingClientRect()}
          onHover={setSlashHighlight}
          onSelect={applySlashSelection}
        />
      ) : null}
    </div>
  );
}
