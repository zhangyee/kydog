import { type KeyboardEvent, useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useComposerDraftStore, EMPTY_DRAFT } from './composerDraftStore';
import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';
import { useLlmStore } from '../../stores/llmStore';
import { useUiStore } from '../../stores/uiStore';
import { useSkillsStore } from '../../stores/skillsStore';
import { useFileIndexStore } from '../../stores/fileIndexStore';
import { NavIcon, IconButton } from '../../shared';
import { ComposerModelMenu } from './ComposerModelMenu';
import { ComposerProjectMenu } from './ComposerProjectMenu';
import { ComposerSlashMenu } from './ComposerSlashMenu';
import { ComposerMentionMenu } from './ComposerMentionMenu';
import { ComposerSendButton } from './ComposerSendButton';
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor';
import { ComposerActionsRow } from './ComposerActionsRow';
import { ErrorMarginalia } from './ErrorMarginalia';
import { filterSkillEntries, dispatchInputKey, imageInputBlocked } from './composerHelpers';
import { encodeUserTurn, IMAGE_UNSUPPORTED_TEXT } from '../../../shared/userTurn';
import { toMessagePath } from './attachments';
import { ingestFiles } from './composerIngest';
import { ComposerTray } from './ComposerTray';
import { ComposerCommentList } from './ComposerCommentList';
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 未发送的输入存在组件外（见 composerDraftStore）：切文件 tab / 设置页 / 别的
  // thread 都会把这个组件卸载掉，留在组件 state 里的字会跟着一起没。
  const draft = useComposerDraftStore((s) => s.byThread[threadId]) ?? EMPTY_DRAFT;
  const { skill, body, attachments, comments } = draft;
  const setDraft = useCallback((nextSkill: SkillEntry | null, nextBody: string) => {
    useComposerDraftStore.getState().setDraft(threadId, { skill: nextSkill, body: nextBody });
  }, [threadId]);
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [modelMenuRect, setModelMenuRect] = useState<DOMRect | null>(null);
  const [projectMenuRect, setProjectMenuRect] = useState<DOMRect | null>(null);
  const [menuForceClosed, setMenuForceClosed] = useState(false);
  // thread.send 失败（比如这条对话原来用的模型已经不可用）以前只 console.error，
  // 界面上什么反应都没有——用户看到的是发了消息就没下文。连同 threadId 一起记，
  // 切走再切回来是另一条 thread 的事，不该继承上一条的失败。
  const [sendFailure, setSendFailure] = useState<{ threadId: string; message: string } | null>(null);
  const sendFailureMessage = sendFailure?.threadId === threadId ? sendFailure.message : null;

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

  const effectiveEntry = allConfigured.find((c) => c.providerId === effectiveProviderId);
  const visionBlocked = imageInputBlocked({
    hasImages: attachments.some((a) => a.kind === 'image'),
    entry: effectiveEntry,
    modelId: effectiveModelId,
  });
  const projectPath = thread?.projectPath ?? '';

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

  // @ 引用（Task 8）：光标处的查询词由 ComposerEditor 报上来；结果查 project.searchFiles。
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionItems, setMentionItems] = useState<string[]>([]);
  const [mentionIndexed, setMentionIndexed] = useState(true);
  // 一次弹出（session）自己的第一条结果回来之前：不显示上一次 session 的旧结果，
  // 也不能把「还没回来」误判成「查完了、没有匹配」（未索引完要显示的是「正在索引…」，
  // 不是「没有匹配的文件」——两者用的是同一个初始 mentionIndexed=true，区分靠 ready）。
  const [mentionReady, setMentionReady] = useState(false);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const mentionSessionRef = useRef(false);
  const mentionProject = thread?.projectPath ?? null;
  const indexVersion = useFileIndexStore((s) => (mentionProject ? s.versionByProject[mentionProject] ?? 0 : 0));
  const mentionOpen = mentionQuery !== null && mentionProject !== null;

  useEffect(() => {
    if (mentionQuery === null || !mentionProject) { mentionSessionRef.current = false; return; }
    // 一次弹出只在第一次查询时请求重扫；之后的按键与索引更新都用手上最新的结果（spec §3.5）。
    const isNewSession = !mentionSessionRef.current;
    const rescan = isNewSession;
    mentionSessionRef.current = true;
    if (isNewSession) {
      // 新一次弹出：同步清掉上一次 session 留下的旧列表，回到「还没就绪」，
      // 列表因此在第一条结果回来之前不渲染（见下面 mentionOpen && mentionReady）。
      setMentionItems([]);
      setMentionReady(false);
    }
    let cancelled = false;
    void window.kydog.invoke('project.searchFiles', { projectPath: mentionProject, query: mentionQuery, rescan })
      .then((r) => {
        if (cancelled) return;
        setMentionItems(r.items.map((i) => i.path));
        setMentionIndexed(r.indexed);
        setMentionHighlight(0);
        setMentionReady(true);
      })
      .catch((err: unknown) => console.error('project.searchFiles failed', err));
    return () => { cancelled = true; };
  }, [mentionQuery, mentionProject, indexVersion]);

  // 光标处的 @ 比正文开头的 / 更具体：两者同时成立时 @ 赢。
  const slashMenuOpen = !mentionOpen && !menuForceClosed && skill === null && slashItems.length > 0;

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

  /** 发给模型的文字与图片（spec §4）。路径在这一刻按对话的项目换算 —— 空对话可能刚换过项目。 */
  const buildOutgoing = (d: typeof draft) => encodeUserTurn({
    body: composedContent(),
    attachments: d.attachments.map((a) => (a.kind === 'file'
      ? { kind: 'file' as const, path: toMessagePath(a.absPath, projectPath) }
      : { kind: 'image' as const, name: a.name, ...(a.absPath ? { path: toMessagePath(a.absPath, projectPath) } : {}), data: a.data, mimeType: a.mimeType })),
    comments: d.comments.map((c) => ({
      file: toMessagePath(c.absPath, projectPath),
      ...(c.section ? { section: c.section } : {}),
      quote: c.quote, note: c.note,
    })),
  });
  const hasPayload = composedContent().length > 0 || attachments.length > 0 || comments.length > 0;
  const canSend = hasPayload && !visionBlocked;

  const onSend = async () => {
    if (isRunning || !canSend) return;
    const snapshot = useComposerDraftStore.getState().byThread[threadId] ?? EMPTY_DRAFT;
    const { text, images } = buildOutgoing(snapshot);
    setSendFailure(null);
    useComposerDraftStore.getState().clearDraft(threadId);
    const messageId = crypto.randomUUID();
    appendUser(threadId, {
      id: messageId, role: 'user', content: text, createdAt: new Date().toISOString(),
      ...(images.length > 0 ? { images } : {}),
    });
    try {
      await window.kydog.invoke('thread.send', { threadId, content: text, ...(images.length > 0 ? { images } : {}) });
    } catch (err) {
      // 被拒一定发生在交给 pi 之前（ensureSession / 正忙 / 不读图都在 prompt 之前抛），
      // 这条消息没进会话：撤掉乐观写入的那条，把写好的东西原样放回（spec §7）。
      // 交给 pi 之后的失败走 run.ended，不经过这里。
      console.error('send failed', err);
      useThreadsStore.getState().removeMessage(threadId, messageId);
      useComposerDraftStore.getState().restoreDraft(threadId, snapshot);
      const message = err instanceof Error ? err.message : String(err);
      setSendFailure({ threadId, message });
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
      slashMenuOpen: slashMenuOpen || mentionOpen,
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
        if (mentionOpen) setMentionHighlight((i) => (mentionItems.length === 0 ? 0 : (i + 1) % mentionItems.length));
        else setSlashHighlight((i) => (slashItems.length === 0 ? 0 : (i + 1) % slashItems.length));
        break;
      case 'slash-up':
        e.preventDefault();
        if (mentionOpen) setMentionHighlight((i) => (mentionItems.length === 0 ? 0 : (i - 1 + mentionItems.length) % mentionItems.length));
        else setSlashHighlight((i) => (slashItems.length === 0 ? 0 : (i - 1 + slashItems.length) % slashItems.length));
        break;
      case 'slash-commit':
        e.preventDefault();
        if (mentionOpen) { const p = mentionItems[mentionHighlight]; if (p) editorHandle.current?.insertMention(p); }
        else commitSlash(slashHighlight);
        break;
      case 'slash-close':
        e.preventDefault();
        if (mentionOpen) setMentionQuery(null);
        else setMenuForceClosed(true);
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
        {sendFailureMessage ? (
          <div data-testid="composer-send-failure" style={{ marginBottom: 6 }}>
            <ErrorMarginalia text={sendFailureMessage} />
          </div>
        ) : null}
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
          <ComposerTray
            attachments={attachments}
            projectPath={thread?.projectPath ?? null}
            notice={draft.notice}
            blockedHint={visionBlocked ? IMAGE_UNSUPPORTED_TEXT : null}
            onRemove={(id) => useComposerDraftStore.getState().removeAttachment(threadId, id)}
          />
          <ComposerCommentList threadId={threadId} projectPath={thread?.projectPath ?? null} />
          <ComposerEditor
            ref={editorHandle}
            skill={skill}
            body={body}
            large={large}
            placeholder={effectivePlaceholder}
            skills={enabledSkills}
            onChange={onEditorChange}
            onKeyDown={onKeyDown}
            onPasteFiles={(files) => { void ingestFiles(threadId, files); }}
            onMentionQuery={setMentionQuery}
          />
          <ComposerActionsRow
            large={large}
            left={(
              <>
                <IconButton
                  size={22}
                  tooltip="添加图片或文件"
                  tooltipPlacement="top"
                  testId="composer-attach"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <NavIcon name="paperclip" size={14} />
                </IconButton>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  data-testid="composer-file-input"
                  onChange={(e) => {
                    const files = Array.from(e.currentTarget.files ?? []);
                    e.currentTarget.value = '';
                    void ingestFiles(threadId, files);
                  }}
                />
                {large && isEmptyThread ? (
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
                ) : null}
              </>
            )}
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
      {mentionOpen && mentionReady && editorWrapperRef.current ? (
        <ComposerMentionMenu
          items={mentionItems} indexed={mentionIndexed} highlightIndex={mentionHighlight}
          anchorRect={editorWrapperRef.current.getBoundingClientRect()}
          onHover={setMentionHighlight}
          onSelect={(p) => editorHandle.current?.insertMention(p)}
        />
      ) : null}
    </div>
  );
}
