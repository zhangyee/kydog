// src/renderer/panels/main-pane/InputPillTextarea.tsx
import { useEffect, useRef, forwardRef, useImperativeHandle, type CSSProperties, type KeyboardEvent } from 'react';

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
  /** Indent the first line by this many pixels (used to make room for a leading skill chip overlay). */
  firstLineIndent?: number;
};

export const InputPillTextarea = forwardRef<InputPillTextareaHandle, Props>(function InputPillTextarea(
  { value, disabled, large, placeholder, onChange, onKeyDown, firstLineIndent = 0 },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
    el: () => taRef.current,
  }), []);

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

  const style: CSSProperties = {
    fontSize: large ? 15 : 14,
    lineHeight: 1.5,
    color: 'var(--color-ink)',
    minHeight: large ? 44 : 24,
    textIndent: firstLineIndent ? `${firstLineIndent}px` : undefined,
  };

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
      style={style}
    />
  );
});
