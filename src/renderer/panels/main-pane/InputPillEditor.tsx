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

export type InputPillEditorHandle = {
  focus: () => void;
  rootEl: () => HTMLDivElement | null;
};

type Props = {
  skill: SkillEntry | null;
  body: string;
  disabled: boolean;
  large: boolean;
  placeholder: string;
  /** Available skills — needed to re-resolve a SkillEntry from its DOM chip on input. */
  skills: readonly SkillEntry[];
  onChange: (skill: SkillEntry | null, body: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
};

const CHIP_ATTR = 'data-skill-chip-name';

export const InputPillEditor = forwardRef<InputPillEditorHandle, Props>(function InputPillEditor(
  { skill, body, disabled, large, placeholder, skills, onChange, onKeyDown },
  ref,
) {
  const editorRef = useRef<HTMLDivElement>(null);
  // Remember the (skillName, body) we last extracted from a user-input event.
  // When state props match this snapshot, the DOM already reflects them, so we
  // skip the rebuild (avoids fighting the cursor + flicker on every keystroke).
  const lastUserInput = useRef<{ skillName: string | null; body: string } | null>(null);

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    rootEl: () => editorRef.current,
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
      el.appendChild(buildChipNode(skill, () => onChange(null, body)));
    }
    if (body) {
      el.appendChild(document.createTextNode(body));
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
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    // Strip rich formatting on paste.
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  };

  const isEmpty = !skill && body === '';

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={editorRef}
        data-testid="input-pill"
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={onInput}
        onKeyDown={onKeyDown}
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
          cursor: disabled ? 'not-allowed' : 'text',
          opacity: disabled ? 0.5 : 1,
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

function parseEditor(
  el: HTMLElement,
  skills: readonly SkillEntry[],
): { skill: SkillEntry | null; body: string } {
  let parsedSkill: SkillEntry | null = null;
  let parsedBody = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as Element;
      const chipName = elem.getAttribute(CHIP_ATTR);
      if (chipName) {
        if (!parsedSkill) parsedSkill = skills.find((s) => s.name === chipName) ?? null;
        continue;
      }
      if (elem.tagName === 'BR') {
        parsedBody += '\n';
        continue;
      }
      // Fallback for nested elements the browser may produce (e.g. <div> on Enter).
      parsedBody += (elem as HTMLElement).innerText ?? elem.textContent ?? '';
    } else if (node.nodeType === Node.TEXT_NODE) {
      parsedBody += node.textContent ?? '';
    }
  }
  return { skill: parsedSkill, body: parsedBody };
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
