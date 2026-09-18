import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HarnessApplyResult, HarnessChoice, HarnessFileName, HarnessFileStatus } from '../../shared/types';
import { HARNESS_FILE_ROLE, applyResultLine, editStateLine } from '../shared/harnessCopy';
import { useHarnessStore } from '../stores/harnessStore';

type Phase =
  | { kind: 'checking' }
  | { kind: 'idle' }                                            // 不用问，或查询失败
  | { kind: 'asking'; files: HarnessFileStatus[] }
  | { kind: 'applying'; files: HarnessFileStatus[] }
  | { kind: 'done'; results: HarnessApplyResult[]; choices: Partial<Record<HarnessFileName, HarnessChoice['choice']>> };

/**
 * 启动时问一次：哪几份 harness 文件的模板更新了，逐份选「更新」或「保持」（spec §4 / §6.1）。
 *
 * 状态由这里挂载时主动去查，不等主进程推送 —— 推送会有「主进程先发、界面还没订阅」的竞态。
 * 查询落定就调 onSettled（查成了 ok = true，查失败 false）：AppShell 据此在根节点挂
 * data-harness-check="done" | "failed"。e2e 断「对话框不在」之前先等 done —— 不等的话查询还没回来
 * 断言就通过了；查失败也记成 done 的话，「状态坏了所以没弹框」会被当成「不用问」。
 */
export function HarnessUpdateDialog({ onSettled }: { onSettled: (ok: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [choices, setChoices] = useState<Partial<Record<HarnessFileName, HarnessChoice['choice']>>>({});

  useEffect(() => {
    let alive = true;
    window.kydog.invoke('harness.status')
      .then(({ files }) => {
        if (!alive) return;
        const available = files.filter((f) => f.template === 'available');
        setPhase(available.length > 0 ? { kind: 'asking', files: available } : { kind: 'idle' });
        onSettled(true);
      })
      .catch((err) => {
        console.error('harness.status failed', err);
        if (!alive) return;
        setPhase({ kind: 'idle' });
        onSettled(false);
      });
    return () => { alive = false; };
  }, [onSettled]);

  // 「稍后再说」什么都不记，下次启动再问（spec §5.4）。
  const close = () => setPhase({ kind: 'idle' });

  useEffect(() => {
    if (phase.kind !== 'asking' && phase.kind !== 'done') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setPhase({ kind: 'idle' }); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase.kind]);

  if (phase.kind === 'checking' || phase.kind === 'idle') return null;

  const onConfirm = async () => {
    if (phase.kind !== 'asking') return;
    const picked = phase.files.map((f) => ({ name: f.name, choice: choices[f.name]! }));
    setPhase({ kind: 'applying', files: phase.files });
    let results: HarnessApplyResult[];
    try {
      results = (await window.kydog.invoke('harness.apply', { choices: picked, source: 'startup-dialog' })).results;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results = picked.map(({ name }) => ({ name, outcome: 'failed', error }));
    }
    useHarnessStore.getState().bumpRevision();
    setPhase({ kind: 'done', results, choices });
  };

  const files = phase.kind === 'done' ? [] : phase.files;
  const allPicked = files.every((f) => choices[f.name] !== undefined);

  return createPortal(
    <div
      data-testid="harness-update-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'oklch(0 0 0 / 0.32)' }}
    >
      <div
        className="flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="harness-update-title"
        style={{
          width: 460, maxWidth: 'calc(100vw - 32px)', padding: '20px 22px', borderRadius: 4,
          background: 'var(--color-paper)',
          border: '0.5px solid var(--color-ink-hair)',
          boxShadow: '0 8px 28px oklch(0 0 0 / 0.22)',
        }}
      >
        <div id="harness-update-title" className="font-serif" style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 6 }}>
          {phase.kind === 'done' ? '工作区文件已处理' : '工作区文件有新版本'}
        </div>

        {phase.kind === 'done' ? (
          <div className="flex flex-col gap-2" style={{ marginBottom: 18 }}>
            {phase.results.map((r) => (
              <div key={r.name} data-testid={`harness-update-result-${r.name}`} className="font-sans" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                {/* 文件名与结果分两行：结果里的备份路径长，同一行会在日期的连字符处折断 */}
                <div className="font-mono" style={{ color: 'var(--color-ink)' }}>{r.name}</div>
                <div style={{ color: 'var(--color-ink-soft)' }}>{applyResultLine(r, phase.choices[r.name] ?? 'update')}</div>
              </div>
            ))}
            <div className="font-serif italic" style={{ fontSize: 11.5, color: 'var(--color-ink-faint)', lineHeight: 1.6 }}>
              从下一个新对话开始生效。
            </div>
          </div>
        ) : (
          <>
            <div className="font-sans" style={{ fontSize: 12.5, color: 'var(--color-ink-soft)', marginBottom: 14, lineHeight: 1.6 }}>
              KyDog 更新了下面这些文件的模板。选「更新」会先备份现有文件，再换成新模板；
              选「保持」不动文件，这一版不再询问，以后可以在侧栏「长期记忆 → Harness」里查看和更新。
            </div>
            <div className="flex flex-col" style={{ gap: 12, marginBottom: 18 }}>
              {files.map((f) => (
                <div key={f.name} data-testid={`harness-update-row-${f.name}`} role="radiogroup" aria-label={f.name}>
                  <div className="font-sans" style={{ fontSize: 13, color: 'var(--color-ink)', fontWeight: 500 }}>
                    <span className="font-mono">{f.name}</span> · {HARNESS_FILE_ROLE[f.name]}
                  </div>
                  <div data-testid={`harness-update-edit-${f.name}`} className="font-sans" style={{ fontSize: 12, color: 'var(--color-ink-soft)', lineHeight: 1.6, margin: '2px 0 4px' }}>
                    {editStateLine(f)}
                  </div>
                  <div className="flex font-sans" style={{ gap: 18, fontSize: 12.5, color: 'var(--color-ink)' }}>
                    {(['update', 'keep'] as const).map((c) => (
                      <label key={c} className="inline-flex items-center" style={{ gap: 5, cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name={`harness-choice-${f.name}`}
                          data-testid={`harness-choice-${f.name}-${c}`}
                          checked={choices[f.name] === c}
                          disabled={phase.kind === 'applying'}
                          onChange={() => setChoices((prev) => ({ ...prev, [f.name]: c }))}
                          style={{ accentColor: 'var(--color-accent)' }}
                        />
                        {c === 'update' ? '更新' : '保持'}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="flex justify-end gap-2">
          {phase.kind === 'done' ? (
            <button type="button" data-testid="harness-update-done" onClick={close} className="font-sans" style={primaryBtn(false)}>完成</button>
          ) : (
            <>
              <button
                type="button"
                data-testid="harness-update-later"
                onClick={close}
                disabled={phase.kind === 'applying'}
                className="font-sans"
                style={{ fontSize: 12, padding: '5px 12px', color: 'var(--color-ink-soft)' }}
              >稍后再说</button>
              <button
                type="button"
                data-testid="harness-update-confirm"
                onClick={() => void onConfirm()}
                disabled={!allPicked || phase.kind === 'applying'}
                className="font-sans"
                style={primaryBtn(!allPicked || phase.kind === 'applying')}
              >{phase.kind === 'applying' ? '处理中…' : '确定'}</button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body);
}

const primaryBtn = (disabled: boolean) => ({
  fontSize: 12, padding: '5px 14px', borderRadius: 3,
  background: 'var(--color-accent)', color: 'var(--color-paper)', fontWeight: 500,
  opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer',
});
