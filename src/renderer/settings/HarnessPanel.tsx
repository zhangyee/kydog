import { useCallback, useEffect, useState } from 'react';
import { HARNESS_FILE_NAMES, type HarnessFileName, type HarnessFileStatus, type HarnessReadResult } from '../../shared/types';
import { HARNESS_FILE_ROLE, applyResultLine, editStateLine, templateStateLabel } from '../shared/harnessCopy';
import { useHarnessStore, isDraftDirty, toTextareaNewlines } from '../stores/harnessStore';
import { confirm } from '../stores/confirmStore';
import { AboutMarkdown } from './about/AboutMarkdown';
import { Btn, hintStyle } from './ui';

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * KyDog Harness：SOUL / USER / AGENTS 三份文件的查看、编辑、更新（spec §6.3）。
 *
 * 查看用 AboutMarkdown 渲染（不用对话里的 MarkdownBlock：它会把 [1] 标成引用上标）；
 * 编辑用纯文本框整份原样读写 —— 不用 Crepe，它会把头部的 --- 改成 ***、改写边车契约的写法。
 * 草稿存在 harnessStore 里，离开页面、切文件都不丢（spec 决策 10）。
 */
export function HarnessPanel() {
  const active = useHarnessStore((s) => s.active);
  const drafts = useHarnessStore((s) => s.drafts);
  const revision = useHarnessStore((s) => s.revision);
  const { setActive, setDraft, clearDraft } = useHarnessStore.getState();

  const [statuses, setStatuses] = useState<HarnessFileStatus[] | null>(null);
  const [doc, setDoc] = useState<{ name: HarnessFileName; result: HarnessReadResult } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (name: HarnessFileName) => {
    try {
      const [st, rd] = await Promise.all([
        window.kydog.invoke('harness.status'),
        window.kydog.invoke('harness.read', { name }),
      ]);
      setStatuses(st.files);
      setDoc({ name, result: rd });
      setLoadError(null);
    } catch (err) {
      setLoadError(errText(err));
    }
  }, []);

  useEffect(() => { void reload(active); }, [active, revision, reload]);

  const status = statuses?.find((s) => s.name === active) ?? null;
  const draft = drafts[active];
  const current = doc?.name === active ? doc.result : null;

  const pick = (name: HarnessFileName) => {
    if (name === active) return;
    setNote(null);
    setActive(name);
  };

  const startEdit = async () => {
    // 进编辑前重读一次：查看态显示的那份可能已经旧了，拿它作 expected 只会平白冲突一次。
    const name = active;
    try {
      const rd = await window.kydog.invoke('harness.read', { name });
      if (!rd.exists) { await reload(name); return; }
      setNote(null);
      setDraft(name, { base: rd.content, text: toTextareaNewlines(rd.content) });
    } catch (err) {
      setNote(`读不出这份文件：${errText(err)}`);
    }
  };

  const cancelEdit = async () => {
    if (draft && isDraftDirty(draft) && !(await confirm({
      title: '放弃未保存的修改？',
      message: `${active} 里还没保存的改动会丢掉，改回磁盘上现在的内容。`,
      confirmLabel: '放弃修改',
      cancelLabel: '继续编辑',
    }))) return;
    clearDraft(active);
    await reload(active);
  };

  const save = async () => {
    if (!draft) return;
    const name = active;
    setBusy(true);
    try {
      let expected = draft.base;
      for (;;) {
        const r = await window.kydog.invoke('harness.write', { name, content: draft.text, expected });
        if (r.ok) break;
        // 取消 = 返回编辑、什么都不动。confirm() 的 Esc 与点背景都算取消，这个键上不许挂破坏性动作。
        const overwrite = await confirm({
          title: `${name} 在你编辑期间被改过`,
          message: r.diskContent === null
            ? '磁盘上的这份文件已经不在了。可以用你的版本重新写出来，或者返回编辑。'
            : '可能是 KyDog 按你的要求改了它。覆盖会丢掉磁盘上的那些改动；返回编辑则什么都不动，想先看看磁盘上现在的内容，可以取消编辑。',
          confirmLabel: '用我的版本覆盖',
          cancelLabel: '返回编辑',
        });
        if (!overwrite) return;
        expected = r.diskContent;                    // 仍是比较后写：覆盖的是刚才看到的那一版，不是强写
      }
      clearDraft(name);
      setNote('已保存，从下一个新对话开始生效');
      await reload(name);
    } catch (err) {
      setNote(`保存失败：${errText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const update = async () => {
    if (!status) return;
    const name = active;
    const creating = status.template === 'missing';
    if (!creating && !(await confirm({
      title: `把 ${name} 更新到新模板？`,
      message: `${editStateLine(status)}。会先把现有文件备份在 ~/.kydog/ 里，再整份换成新模板。`,
      confirmLabel: '更新',
    }))) return;
    setBusy(true);
    try {
      const { results } = await window.kydog.invoke('harness.apply', { choices: [{ name, choice: 'update' }] });
      const r = results[0];
      setNote(creating && r.outcome === 'failed' ? `创建失败：${r.error}` : applyResultLine(r, 'update'));
      await reload(name);
    } catch (err) {
      setNote(`${creating ? '创建' : '更新'}失败：${errText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const exists = current?.exists === true;
  const canUpdate = status !== null && status.template !== 'latest';

  return (
    <div data-testid="harness-panel">
      <div role="tablist" className="flex font-mono" style={{ gap: 6, marginBottom: 16 }}>
        {HARNESS_FILE_NAMES.map((name) => {
          const d = drafts[name];
          const selected = name === active;
          return (
            <button
              key={name}
              type="button"
              role="tab"
              data-testid={`harness-file-${name}`}
              aria-selected={selected ? 'true' : 'false'}
              onClick={() => pick(name)}
              className="hover:bg-[color:var(--color-hover-bg)]"
              style={{
                fontSize: 11.5, padding: '4px 10px', borderRadius: 6,
                background: selected ? 'var(--color-paper-edge)' : 'transparent',
                border: `0.5px solid ${selected ? 'var(--color-ink-hair)' : 'transparent'}`,
                color: selected ? 'var(--color-ink)' : 'var(--color-ink-soft)',
              }}
            >
              {name}<span className="font-sans" style={{ marginLeft: 6, fontSize: 11 }}>{HARNESS_FILE_ROLE[name]}</span>
              {d && isDraftDirty(d) && (
                <span data-testid={`harness-dirty-${name}`} aria-label="有未保存的修改" style={{ marginLeft: 6, color: 'var(--color-accent)' }}>●</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-start" style={{ gap: 12, paddingBottom: 10, borderBottom: '0.5px solid var(--color-ink-hair-soft)' }}>
        <div className="flex-1 min-w-0">
          <div className="font-serif" style={{ fontSize: 18, color: 'var(--color-ink)' }}>
            <span className="font-mono" style={{ fontSize: 15 }}>{active}</span> · {HARNESS_FILE_ROLE[active]}
          </div>
          {exists && current.frontmatterName && (
            <div data-testid="harness-frontmatter-name" className="font-sans" style={{ fontSize: 12, color: 'var(--color-ink-soft)', marginTop: 4 }}>
              称呼：{current.frontmatterName}
            </div>
          )}
        </div>
        {status && (
          <span data-testid="harness-status" className="font-sans" style={{ fontSize: 12, color: status.template === 'latest' ? 'var(--color-ink-faint)' : 'var(--color-accent)', paddingTop: 5 }}>
            {templateStateLabel(status)}
          </span>
        )}
        {canUpdate && (
          <Btn testId="harness-update" onClick={() => void update()} disabled={busy || draft !== undefined}
            title={draft !== undefined ? '编辑中不能更新，先保存或取消' : undefined}>
            {status.template === 'missing' ? '创建' : '更新'}
          </Btn>
        )}
        {exists && draft === undefined && (
          <Btn testId="harness-edit" variant="secondary" onClick={() => void startEdit()} disabled={busy}>编辑</Btn>
        )}
      </div>

      {note && (
        <div data-testid="harness-note" className="font-sans" style={{ fontSize: 12, color: 'var(--color-ink-soft)', marginTop: 10 }}>{note}</div>
      )}
      {loadError && (
        <div data-testid="harness-load-error" className="font-sans" style={{ fontSize: 12, color: 'var(--color-accent)', marginTop: 10 }}>
          读不出这份文件：{loadError}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {draft !== undefined ? (
          <>
            <textarea
              data-testid="harness-editor"
              value={draft.text}
              onChange={(e) => setDraft(active, { ...draft, text: e.target.value })}
              spellCheck={false}
              className="font-mono ky-scroll"
              style={{
                width: '100%', minHeight: 460, resize: 'vertical', padding: '10px 12px',
                fontSize: 12, lineHeight: 1.65, color: 'var(--color-ink)',
                background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair)', borderRadius: 6,
              }}
            />
            <div className="flex items-center" style={{ gap: 8, marginTop: 10 }}>
              <Btn testId="harness-save" onClick={() => void save()} disabled={busy}>保存</Btn>
              <Btn testId="harness-cancel" variant="secondary" onClick={() => void cancelEdit()} disabled={busy}>取消</Btn>
              <span style={{ ...hintStyle, marginTop: 0 }}>改动从下一个新对话开始生效</span>
            </div>
          </>
        ) : current === null ? null : current.exists ? (
          <div data-testid="harness-body">
            <AboutMarkdown content={current.body} />
          </div>
        ) : (
          <div className="font-serif italic" style={{ fontSize: 13, color: 'var(--color-ink-soft)' }}>
            这份文件还不存在。点「创建」用当前模板写一份。
          </div>
        )}
      </div>
    </div>
  );
}
