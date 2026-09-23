import { type KeyboardEvent, useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useComposerDraftStore, EMPTY_DRAFT } from './composerDraftStore';
import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';
import { useLlmStore } from '../../stores/llmStore';
import { useUiStore } from '../../stores/uiStore';
import { useSkillsStore } from '../../stores/skillsStore';
import { NavIcon, IconButton } from '../../shared';
import { ComposerModelMenu } from './ComposerModelMenu';
import { ComposerProjectMenu } from './ComposerProjectMenu';
import { ComposerSlashMenu } from './ComposerSlashMenu';
import { ComposerMentionMenu } from './ComposerMentionMenu';
import { ComposerSendButton } from './ComposerSendButton';
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor';
import { ComposerActionsRow } from './ComposerActionsRow';
import { ErrorMarginalia } from './ErrorMarginalia';
import { filterSkillEntries, dispatchInputKey, imageInputBlocked, folderMentionEdit, modelLabelParts } from './composerHelpers';
import { encodeUserTurn, IMAGE_UNSUPPORTED_TEXT } from '../../../shared/userTurn';
import { toMessagePath } from './attachments';
import { ingestFiles } from './composerIngest';
import { ComposerTray } from './ComposerTray';
import { ComposerCommentList } from './ComposerCommentList';
import { createMentionSession, type MentionEntry, type MentionSession, type MentionView } from './mentionSearch';
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
  const eligibleCount = allConfigured.filter((c) => c.authStatus.configured && c.models.length > 0).length;
  const showBYOK = eligibleCount === 0;
  const effectiveEntry = allConfigured.find((c) => c.providerId === effectiveProviderId);
  const modelParts = effectiveModelId ? modelLabelParts(effectiveEntry?.models, effectiveModelId) : null;
  const modelLabel = showBYOK
    ? 'BYOK'
    : effectiveProviderId && modelParts
    // 胶囊只放名字，id 留给选单 —— 胶囊在窄模式下本来就紧，两个一起放会挤掉后面的按钮。
    ? `${effectiveEntry?.displayName ?? effectiveProviderId} · ${modelParts.name}`
    : '选择模型';

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

  // @ 引用（spec §3.5 v2）：光标处的查询词由 ComposerEditor 报上来；一次弹出 = 一个会话（mentionSearch），
  // 列表开着才有，关掉 / 换项目 / 卸载就 dispose —— 往下读目录只在列表开着时进行。
  // 查询词（引号写法已去掉引号，交给会话的就是它）与「这个 @ 是不是引号写法」（选中文件夹时要保持引号）。
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionQuoted, setMentionQuoted] = useState(false);
  // 这个会话报上来的最新视图；null = 它还没报过（列表不渲染，也就不会闪上一次弹出的结果）。
  const [mentionView, setMentionView] = useState<MentionView | null>(null);
  // 高亮的是哪一项（按 rel 认，不按下标）：按名字找的结果随读随进，前面插进更好的一条时高亮不换人。
  // 换查询词时清成 null，下一次有结果的视图回来就钉在它的第一项上（会话的 onChange）—— 不让 null 一直
  // 代表「第一项」：更深处读到的更好结果插到最前面时，↵ 会选走一个用户没看着的。钉住的那项被挤出列表时
  // 改钉到当时的第一项。
  const [mentionPick, setMentionPick] = useState<string | null>(null);
  const mentionSessionRef = useRef<MentionSession | null>(null);
  // 交给当前会话的最后一个查询词。换查询词时清高亮、交给会话，每个查询词对每个会话只做一次：
  // 弹出时两个 effect 都会跑，第二次若再清一遍高亮，就会把会话当场报视图时刚钉上的那一项清掉。
  const mentionSentRef = useRef<string | null>(null);
  const handMentionQuery = (q: string) => {
    const session = mentionSessionRef.current;
    if (session === null || mentionSentRef.current === q) return;
    mentionSentRef.current = q;
    // 先清高亮再 setQuery：会话可能当场就报视图，那一次要能把高亮钉到新结果的第一项上。
    setMentionPick(null);
    session.setQuery(q);
  };
  const mentionProject = thread?.projectPath ?? null;
  const mentionOpen = mentionQuery !== null && mentionProject !== null;

  useEffect(() => {
    if (!mentionOpen || mentionProject === null || mentionQuery === null) return;
    const session = createMentionSession({
      projectPath: mentionProject,
      readDir: (path) => window.kydog.invoke('project.readDir', { path }),
      onChange: (v) => {
        setMentionView(v);
        if (v.items.length === 0) return;
        // 钉住的那一项还在就不动；不在了（第一次出结果，或被更好的结果挤出前 50）就钉到此刻真正高亮着的
        // 第 0 项 —— 否则 pick 还叫着那个不在的名字，高亮落在「第 0 项」上，之后又会跟着第 0 项漂。
        setMentionPick((p) => (p !== null && v.items.some((i) => i.rel === p) ? p : v.items[0].rel));
      },
    });
    mentionSessionRef.current = session;
    mentionSentRef.current = null;
    // 建会话时的查询词由这里交过去：只换了项目时查询词没变，下面那个 effect（deps 只有查询词）不会再跑，
    // 新会话就收不到查询词。
    handMentionQuery(mentionQuery);
    return () => {
      session.dispose();
      mentionSessionRef.current = null;
      mentionSentRef.current = null;
      setMentionView(null);
    };
  }, [mentionOpen, mentionProject]);

  useEffect(() => {
    if (mentionQuery !== null) handMentionQuery(mentionQuery);
  }, [mentionQuery]);

  const mentionItems = mentionView?.items ?? [];
  const mentionHighlight = Math.max(0, mentionPick === null ? 0 : mentionItems.findIndex((i) => i.rel === mentionPick));
  const moveMentionHighlight = (delta: number) => {
    const n = mentionItems.length;
    if (n === 0) return;
    setMentionPick(mentionItems[(mentionHighlight + delta + n) % n].rel);
  };
  /**
   * 进入一层后首行的「文件夹本身」插成文件夹标签：路径以 `/` 结尾，这一刻按会话里这次 readDir 给的类型写下
   * （spec §3.5 文件夹标签）。文件插成标签；其余文件夹进入下一层（把 `@查询词` 换成 `@<目录>/`，名字里有空白或 @、或已在引号里时写成
   * 两侧引号 `@"<目录>/"`、光标停在收尾引号前），不插标签。写不出能解析回来的查询词（名字里有 `"` 或 `\`）
   * 就什么都不做，列表照旧开着。
   */
  const commitMention = (item: MentionEntry) => {
    if (item.self) { editorHandle.current?.insertMention(`${item.rel}/`); return; }
    if (item.kind === 'file') { editorHandle.current?.insertMention(item.rel); return; }
    const edit = folderMentionEdit(item.rel, mentionQuoted);
    if (edit !== null) editorHandle.current?.replaceMentionQuery(edit);
  };

  // 光标处的 @ 比正文开头的 / 更具体：两者同时成立时 @ 赢。
  const slashMenuOpen = !mentionOpen && !menuForceClosed && skill === null && slashItems.length > 0;
  // 这一次的读取已经结束（逐级浏览读完这一层 / 按名字找读完整棵树）且一条都没有：列表里只剩
  // 「没有匹配的文件」，没有东西可插。这时 ↵ 不归列表管、照常走发送 —— 裁定 3 允许「谢谢@所有人」
  // 这种正文，末尾是个没匹配上的 @词也得能 ↵ 发出去。视图还没回来、或还在查找时不放：别把消息先发走了。
  // Tab 不放（仍是空操作，免得焦点跳走）；Esc / ↑↓ 照旧归列表。
  const mentionNoMatch = mentionOpen && mentionView !== null && mentionView.done && mentionView.items.length === 0;

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
      slashMenuOpen: slashMenuOpen || (mentionOpen && !(mentionNoMatch && e.key === 'Enter')),
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
        if (mentionOpen) moveMentionHighlight(1);
        else setSlashHighlight((i) => (slashItems.length === 0 ? 0 : (i + 1) % slashItems.length));
        break;
      case 'slash-up':
        e.preventDefault();
        if (mentionOpen) moveMentionHighlight(-1);
        else setSlashHighlight((i) => (slashItems.length === 0 ? 0 : (i - 1 + slashItems.length) % slashItems.length));
        break;
      case 'slash-commit':
        e.preventDefault();
        if (mentionOpen) { const item = mentionItems[mentionHighlight]; if (item) commitMention(item); }
        else commitSlash(slashHighlight);
        break;
      case 'slash-close':
        e.preventDefault();
        // 关 @ 列表要先让编辑器记住这个 @：松开 Esc 那一下 keyup 会再报一次光标处的 @（见 ComposerEditor）。
        if (mentionOpen) { editorHandle.current?.dismissMention(); setMentionQuery(null); }
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
            onMentionQuery={(q, quoted) => { setMentionQuery(q); setMentionQuoted(quoted === true); }}
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
      {mentionOpen && mentionView !== null && editorWrapperRef.current ? (
        <ComposerMentionMenu
          items={mentionView.items} done={mentionView.done} highlightIndex={mentionHighlight}
          anchorRect={editorWrapperRef.current.getBoundingClientRect()}
          onHover={(i) => setMentionPick(mentionItems[i]?.rel ?? null)}
          onSelect={commitMention}
        />
      ) : null}
    </div>
  );
}
