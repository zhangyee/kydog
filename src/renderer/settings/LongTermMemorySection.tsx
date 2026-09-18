import { useEffect, type ReactNode } from 'react';
import { HARNESS_FILE_NAMES, type HarnessFileName, type HarnessFileStatus, type HarnessReadResult } from '../../shared/types';
import { NavIcon, type NavIconName } from '../shared';
import { HARNESS_FILE_ROLE, harnessSubtitle, templateStateShort } from '../shared/harnessCopy';
import { useHarnessStore, isDraftDirty } from '../stores/harnessStore';
import { openHarness, refreshHarness, updateHarness } from './harnessActions';

/**
 * 「长期记忆」页（spec §6.2，方案 B）：上面是 Harness 三张窄条卡，点开在右侧检视栏里看、改、更新；
 * 下面是 Memory —— 这一版只占位。「memory」这个名字留给它，所以本页内部标识是 longTermMemory。
 */
export function LongTermMemorySection() {
  const revision = useHarnessStore((s) => s.revision);
  const statuses = useHarnessStore((s) => s.statuses);
  const docs = useHarnessStore((s) => s.docs);
  const opened = useHarnessStore((s) => s.opened);
  const drafts = useHarnessStore((s) => s.drafts);
  const loadError = useHarnessStore((s) => s.loadError);

  useEffect(() => { void refreshHarness(); }, [revision]);

  return (
    <div data-testid="ltm-page" style={{ padding: '22px 28px 40px', display: 'flex', flexDirection: 'column', gap: 28 }}>
      <section aria-label="Harness" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SectionLabel right="点一张在右侧检视栏里打开">Harness · 每次新对话都读</SectionLabel>
        {loadError && (
          <div data-testid="harness-load-error" className="font-sans" style={{ fontSize: 12, color: 'var(--color-accent)' }}>
            读不出这三份文件：{loadError}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {HARNESS_FILE_NAMES.map((name) => {
            const d = drafts[name];
            return (
              <HarnessCard
                key={name}
                name={name}
                status={statuses?.find((s) => s.name === name) ?? null}
                doc={docs[name] ?? null}
                opened={opened === name}
                dirty={d !== undefined && isDraftDirty(d)}
              />
            );
          })}
        </div>
      </section>
      <MemoryPlaceholder />
    </div>
  );
}

function SectionLabel({ children, right }: { children: ReactNode; right?: string }) {
  return (
    <div className="flex items-baseline justify-between" style={{ gap: 12 }}>
      <span className="font-mono uppercase" style={{ fontSize: 10.5, letterSpacing: 1.4, color: 'var(--color-ink-faint)' }}>{children}</span>
      {right && <span className="font-sans" style={{ fontSize: 11.5, color: 'var(--color-ink-faint)' }}>{right}</span>}
    </div>
  );
}

const DOT: Record<HarnessFileStatus['template'], string> = {
  available: 'var(--color-accent)',
  kept: 'var(--color-ink-soft)',
  latest: 'var(--color-ink-hair)',
  missing: 'transparent',
};

/**
 * 一张窄条卡。点卡片本身 = 在检视栏里打开；悬停（或键盘焦点落进来）时右侧的状态换成操作按钮。
 * 这一版不做删除（Yee 2026-09-18 定）。
 */
function HarnessCard({ name, status, doc, opened, dirty }: {
  name: HarnessFileName;
  status: HarnessFileStatus | null;
  doc: HarnessReadResult | null;
  opened: boolean;
  dirty: boolean;
}) {
  const exists = doc?.exists === true;
  const sub = doc?.exists ? harnessSubtitle(doc.frontmatterName, doc.body) : '';
  const canUpdate = status !== null && status.template !== 'latest';
  return (
    <div
      data-testid={`harness-card-${name}`}
      data-opened={opened ? 'true' : 'false'}
      className="group relative flex items-center transition-shadow hover:shadow-[0_6px_16px_rgba(70,55,40,0.10)]"
      style={{
        height: 64, borderRadius: 8, paddingRight: 8,
        background: opened ? 'var(--color-paper-edge)' : 'var(--color-paper)',
        border: `0.5px solid ${opened ? 'var(--color-ink-faint)' : 'var(--color-ink-hair)'}`,
      }}
    >
      <button
        type="button"
        data-testid={`harness-card-open-${name}`}
        aria-pressed={opened}
        onClick={() => void openHarness(name)}
        className="flex-1 min-w-0 h-full flex items-center text-left"
        style={{ gap: 12, padding: '0 8px 0 14px', borderRadius: 8 }}
      >
        <span aria-hidden="true" style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: status ? DOT[status.template] : 'transparent',
          border: status?.template === 'missing' ? '1px dashed var(--color-ink-faint)' : undefined,
        }} />
        <span className="flex-1 min-w-0 flex flex-col" style={{ gap: 2 }}>
          <span className="font-mono flex items-center" style={{ fontSize: 10.5, color: 'var(--color-ink-faint)', gap: 6 }}>
            {name}
            {dirty && <span data-testid={`harness-dirty-${name}`} aria-label="有未保存的修改" style={{ color: 'var(--color-accent)' }}>●</span>}
          </span>
          <span className="font-serif truncate" style={{ fontSize: 15, color: 'var(--color-ink)' }}>
            {HARNESS_FILE_ROLE[name]}
            {sub && <span style={{ color: 'var(--color-ink-faint)' }}> · {sub}</span>}
          </span>
        </span>
      </button>
      {status && (
        <span
          data-testid={`harness-card-status-${name}`}
          className="font-sans shrink-0 group-hover:hidden group-focus-within:hidden"
          style={{ fontSize: 11, color: status.template === 'available' ? 'var(--color-accent)' : 'var(--color-ink-faint)' }}
        >{templateStateShort(status)}</span>
      )}
      <span className="hidden group-hover:flex group-focus-within:flex shrink-0" style={{ gap: 0 }}>
        {exists && <CardAction testId={`harness-card-view-${name}`} icon="book-open-text" label="查看" onClick={() => void openHarness(name)} />}
        {exists && <CardAction testId={`harness-card-edit-${name}`} icon="pencil-line" label="编辑" onClick={() => void openHarness(name, { edit: true })} />}
        {canUpdate && (
          <CardAction
            testId={`harness-card-update-${name}`}
            icon="rotate-cw"
            label={status.template === 'missing' ? '创建' : '更新到新版'}
            onClick={() => void openHarness(name).then(() => updateHarness(name))}
          />
        )}
      </span>
    </div>
  );
}

function CardAction({ testId, icon, label, onClick }: { testId: string; icon: NavIconName; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex items-center justify-center rounded-md hover:bg-[color:var(--color-hover-bg)]"
      style={{ width: 28, height: 28, color: 'var(--color-ink-soft)' }}
    >
      <NavIcon name={icon} size={14} />
    </button>
  );
}

/**
 * Memory：研究过程里沉淀下来的记忆 —— 每天用过 KyDog 的对话合并成当日记忆，重要的再抽成全局记忆。
 * 这一版只占位，三个标签灰掉、不写任何逻辑。
 */
function MemoryPlaceholder() {
  return (
    <section data-testid="ltm-memory" aria-label="Memory" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 标题与三个标签整体压淡，一眼看得出「还没开放」—— 与侧栏禁用项（NavPill 的 opacity 0.5）同一个灰法。 */}
      <div data-testid="ltm-memory-head" style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: 0.5 }}>
        <SectionLabel>Memory</SectionLabel>
        <div role="tablist" className="flex font-sans" style={{ gap: 22, borderBottom: '0.5px solid var(--color-ink-hair-soft)' }}>
          {([['graph', '研究图谱'], ['daily', '每日记忆'], ['global', '全局记忆']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              data-testid={`ltm-memory-tab-${id}`}
              aria-selected="false"
              // 不用 disabled 属性（那样悬停提示不一定出得来），只标 aria-disabled、不接点击；与 NavPill 同一做法。
              aria-disabled="true"
              title="暂未开放"
              style={{ fontSize: 13, padding: '0 0 8px', color: 'var(--color-ink-faint)', cursor: 'default' }}
            >{label}</button>
          ))}
        </div>
      </div>
      <div
        className="font-serif italic"
        style={{
          minHeight: 160, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, color: 'var(--color-ink-faint)',
          border: '0.5px dashed var(--color-ink-hair)', borderRadius: 8,
        }}
      >暂未开放</div>
    </section>
  );
}
