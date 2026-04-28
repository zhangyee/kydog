import { useState } from 'react';

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const charCount = text.length;
  return (
    <div
      data-testid="thinking-block"
      className="my-2 cursor-pointer text-[color:var(--color-marginalia)] select-none"
      onClick={() => setOpen(v => !v)}
    >
      <div className="text-xs italic flex items-center gap-2 hover:opacity-80">
        <span className="font-serif">§ 思考</span>
        <span className="font-mono opacity-60">· {charCount} 字</span>
      </div>
      {open && (
        <div className="mt-1 text-sm italic font-serif text-[color:var(--color-ink-soft)] whitespace-pre-wrap pl-3 border-l border-[color:var(--color-marginalia)]/40 select-text">
          {text}
        </div>
      )}
    </div>
  );
}
