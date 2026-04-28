type Props = { name: string; content: string };

export function UserMessage({ name, content }: Props) {
  return (
    <div className="my-4 border-l-2 border-[color:var(--color-marginalia)] pl-3">
      <div className="font-serif text-[color:var(--color-accent)] text-sm">{name}</div>
      <div className="font-serif text-[color:var(--color-ink)] whitespace-pre-wrap">{content}</div>
    </div>
  );
}
