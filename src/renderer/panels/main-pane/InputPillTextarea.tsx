// src/renderer/panels/main-pane/InputPillTextarea.tsx
import { useEffect, useRef, forwardRef, useImperativeHandle, type KeyboardEvent } from 'react';

export type InputPillTextareaHandle = {
  focus: () => void;
  el: () => HTMLTextAreaElement | null;
};

type Props = {
  value: string;
  disabled: boolean;
  large: boolean;
  placeholder: string;
  onChange: (next: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  prefill?: string;
};

export const InputPillTextarea = forwardRef<InputPillTextareaHandle, Props>(function InputPillTextarea(
  { value, disabled, large, placeholder, onChange, onKeyDown, prefill },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
    el: () => taRef.current,
  }), []);

  // Apply external prefill (e.g. ChapterCard click). `onChange` is intentionally
  // omitted from deps: it changes identity every render (parent passes an inline
  // closure), and re-firing this effect would clobber user-typed text with the
  // last prefill value. Only re-run when `prefill` itself changes.
  useEffect(() => {
    if (prefill !== undefined) onChange(prefill);
  }, [prefill]);

  // Auto-grow textarea as content changes (capped to keep send button visible).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = large ? 240 : 160;
    const next = Math.min(el.scrollHeight, max);
    el.style.height = next + 'px';
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value, large]);

  return (
    <textarea
      ref={taRef}
      data-testid="input-pill"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      rows={large ? 2 : 1}
      className="font-serif w-full resize-none bg-transparent border-0 outline-none disabled:opacity-50"
      style={{
        fontSize: large ? 15 : 14,
        lineHeight: 1.5,
        color: 'var(--color-ink)',
        minHeight: large ? 44 : 24,
      }}
    />
  );
});
