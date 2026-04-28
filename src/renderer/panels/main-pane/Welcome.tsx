export function Welcome() {
  return (
    <div className="h-full flex flex-col items-center justify-center font-serif text-[color:var(--color-ink)] gap-4 select-none">
      <div className="text-3xl tracking-tight">KyDog 科研狗</div>
      <div className="italic text-[color:var(--color-ink-soft)]">Building a better world.</div>
      <div className="text-sm text-[color:var(--color-ink-soft)]">先打开一个 Project 文件夹，再新建对话。</div>
    </div>
  );
}
