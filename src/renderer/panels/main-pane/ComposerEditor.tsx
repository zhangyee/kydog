import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  forwardRef,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { SkillEntry } from '../../../shared/types';
import { refTag, splitBody } from '../../../shared/userTurn';
import { mentionQueryAt, mentionReplaceEnd, mentionTokenAt, routePaste } from './composerHelpers';
import { fileTitle } from './markdown/fileTabHelpers';

export type ComposerEditorHandle = {
  focus: () => void;
  rootEl: () => HTMLDivElement | null;
  insertMention: (path: string) => void;
  /**
   * 把光标处 `@` 之后到光标的查询词换成 `text`（@ 列表里选中文件夹 = 进入下一层，spec §3.5 v2），
   * 光标放到替换后的末尾，照常报正文与新的查询词。不插标签。
   */
  replaceMentionQuery: (text: string) => void;
  /** 光标处的 @ 被 Esc 关掉了：记住它，之后不再报它，直到光标离开它或它的字变了。 */
  dismissMention: () => void;
};

type Props = {
  skill: SkillEntry | null;
  body: string;
  large: boolean;
  placeholder: string;
  /** Available skills — needed to re-resolve a SkillEntry from its DOM chip on input. */
  skills: readonly SkillEntry[];
  onChange: (skill: SkillEntry | null, body: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onPasteFiles: (files: File[]) => void;
  /**
   * 光标处的 @ 查询词变了就报一次；没有 @ 上下文时报 null（裁定 3）。引号写法（`@"…`）报的是去掉引号的
   * 查询词，`quoted` 为 true（spec §3.5）。
   */
  onMentionQuery: (query: string | null, quoted: boolean) => void;
};

const CHIP_ATTR = 'data-skill-chip-name';
const REF_ATTR = 'data-ref-path';

export const ComposerEditor = forwardRef<ComposerEditorHandle, Props>(function ComposerEditor(
  { skill, body, large, placeholder, skills, onChange, onKeyDown, onPasteFiles, onMentionQuery },
  ref,
) {
  const editorRef = useRef<HTMLDivElement>(null);
  // Remember the (skillName, body) we last extracted from a user-input event.
  // When state props match this snapshot, the DOM already reflects them, so we
  // skip the rebuild (avoids fighting the cursor + flicker on every keystroke).
  const lastUserInput = useRef<{ skillName: string | null; body: string } | null>(null);
  // Always points at the latest body so the chip's × button (a long-lived raw
  // DOM listener) reads the current body, not the body captured at build time.
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onMentionRef = useRef(onMentionQuery); onMentionRef.current = onMentionQuery;
  const skillsRef = useRef(skills); skillsRef.current = skills;
  // Esc 关掉的那个 @：文本节点 + `@` 在节点里的位置 + 当时的整个 @ 词。松开 Esc 的那一下 keyup
  // 还会走 reportMention —— 不记住它，列表就立刻重新弹出来（而且算新的一次弹出、目录又从头读一遍）。
  // 光标离开这个 @（落到别处、失焦）或这个词变了（接着打字、删字）就忘掉它，照常报。
  const dismissedRef = useRef<{ node: Text; start: number; token: string } | null>(null);
  const reportMention = () => {
    const hit = caretMention(editorRef.current);
    const d = dismissedRef.current;
    if (d && hit && hit.node === d.node && hit.start === d.start && mentionTokenAt(hit.node.data, hit.start, hit.end) === d.token) {
      onMentionRef.current(null, false);
      return;
    }
    dismissedRef.current = null;
    onMentionRef.current(hit?.query ?? null, hit?.quoted ?? false);
  };

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    rootEl: () => editorRef.current,
    dismissMention: () => {
      const hit = caretMention(editorRef.current);
      dismissedRef.current = hit ? { node: hit.node, start: hit.start, token: mentionTokenAt(hit.node.data, hit.start, hit.end) } : null;
    },
    insertMention: (path: string) => {
      const el = editorRef.current;
      const hit = caretMention(el);
      if (!el || !hit) return;
      // 从 @ 换到哪儿为止见 mentionReplaceEnd：收尾的 `"` 正好在光标上才连它一起换，否则只到光标。
      const range = document.createRange();
      range.setStart(hit.node, hit.start);
      range.setEnd(hit.node, mentionReplaceEnd(hit.node.data, hit.end, hit.quoted));
      range.deleteContents();
      const space = document.createTextNode(' ');
      range.insertNode(space);
      range.insertNode(buildRefChip(path));
      const after = document.createRange();
      after.setStart(space, 1);
      after.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(after);
      const parsed = parseEditor(el, skillsRef.current);
      lastUserInput.current = { skillName: parsed.skill?.name ?? null, body: parsed.body };
      onChangeRef.current(parsed.skill, parsed.body);
      onMentionRef.current(null, false);
    },
    replaceMentionQuery: (text: string) => {
      const el = editorRef.current;
      const hit = caretMention(el);
      if (!el || !hit) return;
      // 就地改这个文本节点：`@` 与新的查询词必须留在同一个文本节点里，caretMention 才认得出它
      // （插一个新文本节点的话，光标前那一段就没有 `@` 了，列表会当场关掉）。
      hit.node.replaceData(hit.start + 1, hit.end - hit.start - 1, text);
      const after = document.createRange();
      after.setStart(hit.node, hit.start + 1 + text.length);
      after.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(after);
      const parsed = parseEditor(el, skillsRef.current);
      lastUserInput.current = { skillName: parsed.skill?.name ?? null, body: parsed.body };
      onChangeRef.current(parsed.skill, parsed.body);
      reportMention();
    },
  }), []);

  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const desiredSkillName = skill?.name ?? null;
    if (
      lastUserInput.current
      && lastUserInput.current.skillName === desiredSkillName
      && lastUserInput.current.body === body
    ) {
      return;
    }
    el.innerHTML = '';
    if (skill) {
      el.appendChild(buildChipNode(skill, () => onChange(null, bodyRef.current)));
    }
    for (const seg of splitBody(body)) {
      el.appendChild(seg.kind === 'text' ? document.createTextNode(seg.text) : buildRefChip(seg.path));
    }
    lastUserInput.current = { skillName: desiredSkillName, body };
    placeCursorAtEnd(el);
  }, [skill, body, onChange]);

  const onInput = (e: FormEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const { skill: parsedSkill, body: parsedBody } = parseEditor(el, skills);
    lastUserInput.current = {
      skillName: parsedSkill?.name ?? null,
      body: parsedBody,
    };
    onChange(parsedSkill, parsedBody);
    reportMention();
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    // 不收富文本；文件与文字的先后见 routePaste（裁定 2）。
    e.preventDefault();
    const route = routePaste(e.clipboardData.getData('text/plain'), Array.from(e.clipboardData.files), window.kydog.pathForFile);
    if (route.kind === 'text') document.execCommand('insertText', false, route.text);
    else if (route.kind === 'files') onPasteFiles(route.files);
  };

  const isEmpty = !skill && body === '';

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={editorRef}
        data-testid="composer-input"
        contentEditable
        suppressContentEditableWarning
        onInput={onInput}
        onKeyDown={onKeyDown}
        onKeyUp={reportMention}
        onMouseUp={reportMention}
        onBlur={() => { dismissedRef.current = null; onMentionRef.current(null, false); }}
        onPaste={onPaste}
        className="font-serif w-full bg-transparent border-0 outline-none"
        style={{
          fontSize: large ? 15 : 14,
          lineHeight: 1.5,
          color: 'var(--color-ink)',
          minHeight: large ? 44 : 24,
          maxHeight: large ? 240 : 160,
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          cursor: 'text',
        }}
      />
      {isEmpty ? (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            color: 'var(--color-ink-faint)',
            fontSize: large ? 15 : 14,
            lineHeight: 1.5,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {placeholder}
        </div>
      ) : null}
    </div>
  );
});

function buildChipNode(skill: SkillEntry, onRemove: () => void): HTMLElement {
  const span = document.createElement('span');
  span.setAttribute('contenteditable', 'false');
  span.setAttribute('data-testid', 'skill-chip');
  span.setAttribute(CHIP_ATTR, skill.name);
  span.title = skill.description;
  span.className = 'font-mono';
  Object.assign(span.style, {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 4px 0 10px',
    background: 'color-mix(in srgb, var(--color-accent) 18%, transparent)',
    color: 'var(--color-accent)',
    borderRadius: '999px',
    fontSize: '12px',
    gap: '4px',
    lineHeight: '1.4',
    cursor: 'default',
    whiteSpace: 'nowrap',
    marginRight: '6px',
    verticalAlign: 'baseline',
    userSelect: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  const label = document.createElement('span');
  label.textContent = `/${skill.name}`;
  span.appendChild(label);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute('data-testid', 'skill-chip-remove');
  closeBtn.setAttribute('aria-label', '移除');
  Object.assign(closeBtn.style, {
    width: '16px',
    height: '16px',
    padding: '0',
    border: 'none',
    borderRadius: '999px',
    background: 'var(--color-accent)',
    color: 'var(--color-paper)',
    cursor: 'pointer',
    fontSize: '10px',
    lineHeight: '1',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: '0',
    transition: 'opacity 100ms',
  } satisfies Partial<CSSStyleDeclaration>);
  closeBtn.textContent = '×';
  closeBtn.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    onRemove();
  });
  span.appendChild(closeBtn);

  span.addEventListener('mouseenter', () => { closeBtn.style.opacity = '1'; });
  span.addEventListener('mouseleave', () => { closeBtn.style.opacity = '0'; });
  return span;
}

function parseEditor(el: HTMLElement, skills: readonly SkillEntry[]): { skill: SkillEntry | null; body: string } {
  const acc = { skill: null as SkillEntry | null, body: '' };
  serializeChildren(el, skills, acc);
  return acc;
}

function serializeChildren(el: Element, skills: readonly SkillEntry[], acc: { skill: SkillEntry | null; body: string }) {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) { acc.body += node.textContent ?? ''; continue; }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const elem = node as HTMLElement;
    const chipName = elem.getAttribute(CHIP_ATTR);
    if (chipName) {
      if (!acc.skill) acc.skill = skills.find((s) => s.name === chipName) ?? null;
      continue;
    }
    const refPath = elem.getAttribute(REF_ATTR);
    if (refPath !== null) { acc.body += refTag(refPath); continue; }
    if (elem.tagName === 'BR') { acc.body += '\n'; continue; }
    if (elem.querySelector(`[${REF_ATTR}]`)) {
      // 浏览器回车造出来的 <div> 里包着引用标签：逐个子节点走，别用 innerText 把标签压成文件名。
      if (acc.body !== '' && !acc.body.endsWith('\n')) acc.body += '\n';
      serializeChildren(elem, skills, acc);
      continue;
    }
    // Fallback for nested elements the browser may produce (e.g. <div> on Enter).
    acc.body += elem.innerText ?? elem.textContent ?? '';
  }
}

function buildRefChip(path: string): HTMLElement {
  const span = document.createElement('span');
  span.setAttribute('contenteditable', 'false');
  span.setAttribute('data-testid', 'ref-chip');
  span.setAttribute(REF_ATTR, path);
  span.title = path;
  span.className = 'font-mono';
  span.textContent = fileTitle(path);
  Object.assign(span.style, {
    display: 'inline-flex', alignItems: 'center', padding: '0 6px', margin: '0 1px',
    background: 'var(--color-hover-bg)', color: 'var(--color-ink)', borderRadius: '3px',
    fontSize: '12px', lineHeight: '1.4', whiteSpace: 'nowrap', verticalAlign: 'baseline', userSelect: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  return span;
}

function caretMention(root: HTMLElement | null): { node: Text; start: number; end: number; query: string; quoted: boolean } | null {
  const sel = window.getSelection();
  if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
  const m = mentionQueryAt((node as Text).data.slice(0, sel.anchorOffset));
  return m ? { node: node as Text, start: m.start, end: sel.anchorOffset, query: m.query, quoted: m.quoted } : null;
}

function placeCursorAtEnd(el: HTMLElement) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}
