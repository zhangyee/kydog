import { useState } from 'react';

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 border-l-2 border-[color:var(--color-marginalia)] pl-3" data-testid="thinking-block">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="text-xs italic text-[color:var(--color-marginalia)] hover:underline"
      >
        {open ? '收起思考' : '展开思考'}
      </button>
      {open && (
        <div className="mt-1 text-sm italic text-[color:var(--color-ink-soft)] font-serif whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
