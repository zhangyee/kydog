import { HarnessPanel } from './HarnessPanel';

/**
 * 「长期记忆」页：两个子标签（spec §6.2）。
 * Memory 这一格留给以后的科研过程知识图谱，这一版只占位、灰掉，不写任何逻辑；
 * 「memory」这个名字也留给它 —— 所以本页内部标识是 longTermMemory，Harness 那部分不叫 memory。
 */
export function LongTermMemorySection() {
  return (
    <div style={{ padding: '20px 28px 40px', maxWidth: 820 }}>
      <div role="tablist" className="flex font-sans" style={{ gap: 18, borderBottom: '0.5px solid var(--color-ink-hair-soft)', marginBottom: 18 }}>
        <SubTab label="KyDog Harness" testId="ltm-tab-harness" selected />
        <SubTab label="Memory" testId="ltm-tab-memory" disabled title="暂未开放" />
      </div>
      <HarnessPanel />
    </div>
  );
}

function SubTab({ label, testId, selected, disabled, title }: {
  label: string; testId: string; selected?: boolean; disabled?: boolean; title?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      data-testid={testId}
      aria-selected={selected ? 'true' : 'false'}
      // 与 NavPill 同一做法：不用 disabled 属性（那样悬停提示不一定出得来），只标 aria-disabled、不接点击。
      aria-disabled={disabled || undefined}
      title={title}
      style={{
        fontSize: 13, padding: '6px 0', marginBottom: -0.5,
        color: disabled ? 'var(--color-ink-faint)' : 'var(--color-ink)',
        fontWeight: selected ? 500 : 400,
        borderBottom: selected ? '1.5px solid var(--color-accent)' : '1.5px solid transparent',
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >{label}</button>
  );
}
