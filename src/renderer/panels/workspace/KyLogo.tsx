export function KyLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="font-serif text-[color:var(--color-ink)] tracking-tight select-none flex items-baseline gap-1">
      <span className="text-lg font-semibold">KyDog</span>
      {!compact && <span className="text-base">科研狗</span>}
    </div>
  );
}
