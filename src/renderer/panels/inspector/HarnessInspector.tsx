import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { HarnessFileName } from '../../../shared/types';
import { NavIcon } from '../../shared';
import { HARNESS_FILE_ROLE, editStateLine, templateStateLabel } from '../../shared/harnessCopy';
import { useHarnessStore, isDraftDirty } from '../../stores/harnessStore';
import { makeMarkdownComponents } from '../main-pane/markdownComponents';
import { Btn, hintStyle } from '../../settings/ui';
import { cancelHarnessEdit, closeHarness, refreshHarness, saveHarness, startHarnessEdit, updateHarness } from '../../settings/harnessActions';

// 建在模块层：react-markdown 按引用比较 components，放进组件体里每次渲染都会重建整棵子树。
const COMPONENTS = makeMarkdownComponents({ citations: false, compact: true });

/**
 * 检视栏里的一份 harness 文件（spec §6.3，方案 B）：查看、编辑、更新。
 *
 * 查看用 citations: false 的组件表渲染（不用对话里的 MarkdownBlock：它会把 [1] 标成引用上标），
 * 标题用 compact 那一档 —— 检视栏窄，关于页的 26px 一级标题会占掉半屏；
 * 编辑用纯文本框整份原样读写 —— 不用 Crepe，它会把头部的 --- 改成 ***、改写边车契约的写法。
 * 检视栏可以拖宽，改长文件时拖宽一点。
 */
export function HarnessInspector({ name }: { name: HarnessFileName }) {
  const status = useHarnessStore((s) => s.statuses?.find((x) => x.name === name) ?? null);
  const doc = useHarnessStore((s) => s.docs[name] ?? null);
  const draft = useHarnessStore((s) => s.drafts[name]);
  const mode = useHarnessStore((s) => s.mode);
  const note = useHarnessStore((s) => s.notes[name] ?? null);
  const busy = useHarnessStore((s) => s.busy);

  useEffect(() => { void refreshHarness(); }, [name]);

  const exists = doc?.exists === true;
  // 在不在改看 mode，不看「有没有草稿」：草稿会留着（离开页面、切去看别的），点「查看」时应当看到查看态。
  const editing = mode === 'edit' && draft !== undefined;
  const pendingDraft = !editing && draft !== undefined && isDraftDirty(draft);
  const explain = status && (status.template === 'available' || status.template === 'kept') ? editStateLine(status) : null;

  return (
    <div data-testid="harness-inspector" className="flex-1 min-h-0 flex flex-col">
      <div style={{ padding: '14px 16px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span className="font-mono flex-1" style={{ fontSize: 11, color: 'var(--color-ink-faint)' }}>{name}</span>
          {status && (
            <span data-testid="harness-status" className="font-sans" style={{
              fontSize: 11.5, color: status.template === 'latest' ? 'var(--color-ink-faint)' : 'var(--color-accent)',
            }}>{templateStateLabel(status)}</span>
          )}
          <button
            type="button"
            data-testid="harness-inspector-close"
            aria-label="关闭"
            onClick={() => void closeHarness()}
            className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[color:var(--color-hover-bg)]"
            style={{ color: 'var(--color-ink-soft)' }}
          ><NavIcon name="x" size={13} /></button>
        </div>
        <div className="font-serif" style={{ fontSize: 21, color: 'var(--color-ink)' }}>{HARNESS_FILE_ROLE[name]}</div>
        {exists && doc.frontmatterName && (
          <div data-testid="harness-frontmatter-name" className="font-sans" style={{ fontSize: 12, color: 'var(--color-ink-soft)' }}>
            称呼：{doc.frontmatterName}
          </div>
        )}
        {explain && (
          <div className="font-sans" style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--color-ink-soft)' }}>{explain}</div>
        )}
        <div className="flex items-center flex-wrap" style={{ gap: 6, padding: '6px 0 12px', borderBottom: '0.5px solid var(--color-ink-hair-soft)' }}>
          {status && status.template !== 'latest' && (
            <Btn testId="harness-update" onClick={() => void updateHarness(name)} disabled={busy || draft !== undefined}
              title={draft !== undefined ? '编辑中不能更新，先保存或取消' : undefined}>
              {status.template === 'missing' ? '创建' : '更新到新版'}
            </Btn>
          )}
          {exists && !editing && (
            <Btn testId="harness-edit" variant="secondary" onClick={() => void startHarnessEdit(name)} disabled={busy}>
              {pendingDraft ? '继续编辑' : '编辑'}
            </Btn>
          )}
        </div>
        {pendingDraft && (
          <div data-testid="harness-pending-draft" className="font-sans" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--color-accent)', paddingTop: 2 }}>
            这份有没保存的修改，下面显示的是磁盘上现在的内容。
          </div>
        )}
        {note && (
          <div data-testid="harness-note" className="font-sans" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--color-ink-soft)', paddingTop: 2 }}>{note}</div>
        )}
      </div>

      {editing && draft !== undefined ? (
        <div className="flex-1 min-h-0 flex flex-col" style={{ padding: '10px 16px 14px', gap: 10 }}>
          <textarea
            data-testid="harness-editor"
            value={draft.text}
            onChange={(e) => useHarnessStore.getState().setDraft(name, { ...draft, text: e.target.value })}
            // 保存途中不许再打字：写成功后草稿整份清掉，这段时间打进去的字会跟着没了。
            readOnly={busy}
            spellCheck={false}
            className="font-mono ky-scroll flex-1 min-h-0"
            style={{
              width: '100%', resize: 'none', padding: '10px 12px', boxSizing: 'border-box',
              fontSize: 12, lineHeight: 1.65, color: 'var(--color-ink)',
              background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair)', borderRadius: 6,
            }}
          />
          <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
            <Btn testId="harness-save" onClick={() => void saveHarness(name)} disabled={busy}>保存</Btn>
            <Btn testId="harness-cancel" variant="secondary" onClick={() => void cancelHarnessEdit(name)} disabled={busy}>取消</Btn>
            <span style={{ ...hintStyle, marginTop: 0 }}>改动从下一个新对话开始生效</span>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto ky-scroll" style={{ padding: '12px 16px 24px' }}>
          {doc === null ? null : doc.exists ? (
            <div data-testid="harness-body" className="font-serif" style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--color-ink)' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{doc.body}</ReactMarkdown>
            </div>
          ) : (
            <div className="font-serif italic" style={{ fontSize: 13, color: 'var(--color-ink-soft)' }}>
              这份文件还不存在。点「创建」用当前模板写一份。
            </div>
          )}
        </div>
      )}
    </div>
  );
}
