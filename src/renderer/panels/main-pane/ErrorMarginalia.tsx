export function ErrorMarginalia({ text }: { text: string }) {
  return (
    <div className="border-l-2 border-[color:var(--color-accent)] pl-3 my-2 italic text-sm text-[color:var(--color-accent)] font-serif">
      {text}
    </div>
  );
}
