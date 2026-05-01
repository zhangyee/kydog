import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useSkillsStore } from '../stores/skillsStore';
import type { SkillEntry, SkillPreview, ToolEntry } from '../../shared/types';

export function SkillsAndToolsSection() {
  const { skills, tools, loading, error, setSkills, setTools, setLoading } = useSkillsStore();
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Map<string, { code: string; message: string }>>(new Map());
  const [urlInputOpen, setUrlInputOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);

  const refresh = async (opts?: { force?: boolean }) => {
    setLoading('loading');
    try {
      const [sk, tl] = await Promise.all([
        window.kydog.invoke('skill.list'),
        window.kydog.invoke('tool.list', { force: opts?.force ?? false }),
      ]);
      setSkills(sk);
      setTools(tl);
      setLoading('ready');
    } catch (err) {
      setLoading('error', String((err as Error)?.message ?? err));
    }
  };

  const onPickFolder = async () => {
    setInstallError(null); setSkipped(new Map());
    const picked = await window.kydog.invoke('skill.pickFolder');
    if (!picked) return;
    try {
      const p = await window.kydog.invoke('skill.previewFromFolder', { srcDir: picked });
      setPreview(p);
      setPicks(new Set(
        p.candidates.filter((c) => !c.alreadyInstalled && !c.nameInvalid).map((c) => c.relPath),
      ));
    } catch (e) { setInstallError(String((e as Error).message)); }
  };

  const onScan = async () => {
    setScanning(true); setInstallError(null); setSkipped(new Map());
    try {
      const p = await window.kydog.invoke('skill.previewFromUrl', { url: url.trim() });
      setPreview(p);
      setPicks(new Set(
        p.candidates.filter((c) => !c.alreadyInstalled && !c.nameInvalid).map((c) => c.relPath),
      ));
      setUrlInputOpen(false);
      setUrl('');
    } catch (e) { setInstallError(String((e as Error).message)); }
    finally { setScanning(false); }
  };

  const onCommit = async () => {
    if (!preview) return;
    setInstalling(true); setInstallError(null);
    try {
      const ps = preview.candidates
        .filter((c) => picks.has(c.relPath))
        .map((c) => ({ name: c.name, relPath: c.relPath }));
      const r = await window.kydog.invoke('skill.commitFromPreview', {
        srcKind: preview.srcKind,
        srcPath: preview.srcPath,
        picks: ps,
      });
      setSkills(r.list);
      if (r.skipped.length === 0) {
        setPreview(null); setPicks(new Set()); setSkipped(new Map());
      } else {
        const map = new Map<string, { code: string; message: string }>();
        for (const s of r.skipped) {
          const cand = preview.candidates.find((c) => c.name === s.name);
          if (cand) map.set(cand.relPath, { code: s.reason.code, message: s.reason.message });
        }
        setSkipped(map);
        const installedNames = new Set(r.installed.map((i) => i.name));
        const nextPicks = new Set<string>();
        for (const c of preview.candidates) {
          if (picks.has(c.relPath) && !installedNames.has(c.name) && !map.has(c.relPath)) {
            nextPicks.add(c.relPath);
          }
        }
        setPicks(nextPicks);
      }
    } catch (e) { setInstallError(String((e as Error).message)); }
    finally { setInstalling(false); }
  };

  const onAddExternal = async () => {
    setToolError(null);
    try {
      const next = await window.kydog.invoke('tool.addExternal');
      setTools(next);
    } catch (e) { setToolError(String((e as Error).message)); }
  };

  useEffect(() => {
    if (loading === 'idle') void refresh();
  }, []);

  if (loading === 'loading' && skills.length === 0) {
    return <div style={{ padding: 28, color: 'var(--color-ink-soft)' }}>装载中…</div>;
  }

  const builtin = skills.filter((s) => s.origin === 'builtin');
  const user = skills.filter((s) => s.origin === 'user');

  return (
    <div style={{ padding: '24px 28px 36px', maxWidth: 840 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Btn variant="secondary" onClick={() => void refresh({ force: true })}>刷新</Btn>
      </div>

      {error && (
        <div style={{ color: 'var(--color-danger, #c0392b)', marginBottom: 12 }}>{error}</div>
      )}

      <BlockHeader>技能</BlockHeader>
      <Card>
        <SubHeader title="内置" subtitle="对已打开的对话不生效，下次新建对话起生效。" />
        {builtin.length === 0 && <Empty />}
        {builtin.map((s) => <SkillRow key={s.name} skill={s} onChanged={setSkills} />)}

        <Divider />

        <SubHeader title="已安装" />
        {user.length === 0 && <Empty />}
        {user.map((s) => <SkillRow key={s.name} skill={s} onChanged={setSkills} />)}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Btn onClick={onPickFolder}>+ 从文件夹安装</Btn>
          <Btn onClick={() => setUrlInputOpen(true)}>+ 从 URL 安装</Btn>
        </div>
        {urlInputOpen && !preview && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo/tree/main/skills"
              style={{ flex: 1, fontSize: 12, padding: '4px 8px' }}
            />
            <Btn variant="primary" onClick={onScan} disabled={scanning || !url.trim()}>
              {scanning ? '扫描中…' : '扫描'}
            </Btn>
            <Btn variant="secondary" onClick={() => { setUrlInputOpen(false); setUrl(''); }}>取消</Btn>
          </div>
        )}
        {preview && (
          <PreviewBlock
            preview={preview}
            picks={picks}
            setPicks={setPicks}
            skipped={skipped}
            installing={installing}
            onCancel={() => { setPreview(null); setPicks(new Set()); setSkipped(new Map()); setInstallError(null); }}
            onCommit={onCommit}
          />
        )}
        {installError && (
          <div style={{ color: 'var(--color-danger, #c0392b)', marginTop: 8, fontSize: 12 }}>{installError}</div>
        )}
      </Card>

      <div style={{ height: 28 }} />

      <BlockHeader>工具</BlockHeader>
      <Card>
        <SubHeader subtitle="agent 可调用的捆绑 CLI" />
        {tools.length === 0 && <Empty />}
        {tools.map((t) => <ToolRow key={t.path} tool={t} onChanged={setTools} setError={setToolError} />)}

        <div style={{ marginTop: 12 }}>
          <Btn variant="primary" onClick={onAddExternal}>+ 添加外部工具</Btn>
        </div>
        {toolError && (
          <div style={{ color: 'var(--color-danger, #c0392b)', marginTop: 8, fontSize: 12 }}>{toolError}</div>
        )}
      </Card>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div style={{
      border: '0.5px solid var(--color-ink-hair)',
      borderRadius: 6,
      padding: '16px 18px',
      background: 'var(--color-paper)',
    }}>{children}</div>
  );
}

function BlockHeader({ children }: { children: ReactNode }) {
  return (
    <div className="font-serif" style={{ fontSize: 18, color: 'var(--color-ink)', marginBottom: 10 }}>
      {children}
    </div>
  );
}

function SubHeader({ title, subtitle }: { title?: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      {title && (
        <div className="font-mono uppercase" style={{ fontSize: 10, letterSpacing: 1.5, color: 'var(--color-ink-faint)' }}>
          {title}
        </div>
      )}
      {subtitle && (
        <div className="font-serif italic" style={{ fontSize: 12, color: 'var(--color-ink-soft)', marginTop: title ? 4 : 0 }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: '0.5px solid var(--color-ink-hair-soft)', margin: '16px 0' }} />;
}

function Toggle({ checked, onChange, disabled }: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={disabled ? undefined : onChange}
      disabled={disabled}
      style={{
        width: 32,
        height: 18,
        borderRadius: 999,
        background: checked ? 'var(--color-accent, #6b8e7f)' : 'var(--color-ink-faint)',
        position: 'relative',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        border: 'none',
        padding: 0,
        transition: 'background-color 120ms',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 16 : 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: 'var(--color-paper)',
          transition: 'left 120ms',
        }}
      />
    </button>
  );
}

type BtnVariant = 'primary' | 'secondary' | 'danger';

function Btn({
  variant = 'primary',
  onClick,
  disabled,
  children,
  title,
}: {
  variant?: BtnVariant;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  title?: string;
}) {
  // Base layout (font, padding, radius) stays inline; colors/borders + hover live in className
  // so :hover (which inline styles cannot express) works via Tailwind arbitrary-value classes.
  const base: CSSProperties = {
    fontFamily: 'var(--font-mono, ui-monospace)',
    fontSize: 11,
    padding: '4px 10px',
    borderRadius: 6,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'background-color 120ms, color 120ms, border-color 120ms',
  };
  const hoverClass = disabled
    ? ''
    : variant === 'primary'
      ? 'hover:bg-[color:var(--color-hover-bg)]'
      : variant === 'secondary'
        ? 'hover:bg-[color:var(--color-hover-bg)] hover:text-[color:var(--color-ink)] hover:border-[color:var(--color-ink-hair-soft)]'
        : 'hover:bg-[color:var(--color-danger-soft,rgba(192,57,43,0.08))]';
  const variantStyle: Record<BtnVariant, CSSProperties> = {
    primary: {
      background: 'var(--color-paper-edge)',
      color: 'var(--color-ink)',
      border: '0.5px solid var(--color-ink-hair)',
    },
    secondary: {
      background: 'transparent',
      color: 'var(--color-ink-soft)',
      border: '0.5px solid transparent',
    },
    danger: {
      background: 'transparent',
      color: 'var(--color-danger, #c0392b)',
      border: '0.5px solid transparent',
    },
  };
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={title}
      className={hoverClass}
      style={{ ...base, ...variantStyle[variant] }}
    >
      {children}
    </button>
  );
}

function Empty() {
  return <div style={{ color: 'var(--color-ink-faint)', fontSize: 12, padding: '4px 0' }}>（无）</div>;
}

function SkillRow({ skill, onChanged }: { skill: SkillEntry; onChanged: (next: SkillEntry[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onToggle = async () => {
    setBusy(true); setErr(null);
    try {
      const next = await window.kydog.invoke('skill.setEnabled', { name: skill.name, enabled: !skill.enabled });
      onChanged(next);
    } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); }
  };
  const onUninstall = async () => {
    setBusy(true); setErr(null);
    try {
      const next = await window.kydog.invoke('skill.uninstall', { name: skill.name });
      onChanged(next);
    } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); }
  };
  const onOpen = () => { void window.kydog.invoke('skill.openInOS', { name: skill.name }); };
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', padding: '6px 0', borderBottom: '0.5px solid var(--color-ink-hair-soft)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>
          {skill.name}
          {skill.kydogVersion && (
            <span className="font-mono" style={{ marginLeft: 8, fontSize: 10, color: 'var(--color-ink-faint)' }}>
              v{skill.kydogVersion}
            </span>
          )}
          {!skill.enabled && (
            <span className="font-serif italic" style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-ink-faint)' }}>已禁用</span>
          )}
        </div>
        <div className="truncate" style={{ fontSize: 12, color: 'var(--color-ink-soft)' }}>{skill.description}</div>
        {err && <div style={{ color: 'var(--color-danger, #c0392b)', fontSize: 11 }}>{err}</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 12 }}>
        {skill.origin === 'builtin' && (
          <Toggle checked={skill.enabled} onChange={onToggle} disabled={busy} />
        )}
        <Btn variant="primary" onClick={onOpen}>打开目录</Btn>
        {skill.origin === 'user' && (
          <Btn variant="danger" onClick={onUninstall} disabled={busy}>卸载</Btn>
        )}
      </div>
    </div>
  );
}

function ToolRow({ tool, onChanged, setError }: {
  tool: ToolEntry;
  onChanged: (next: ToolEntry[]) => void;
  setError: (msg: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const onRemove = async () => {
    setBusy(true); setError(null);
    try {
      const next = await window.kydog.invoke('tool.removeExternal', { path: tool.path });
      onChanged(next);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', padding: '6px 0', borderBottom: '0.5px solid var(--color-ink-hair-soft)' }}>
      <div style={{ width: 140, fontWeight: 500 }}>
        {tool.name}
        {tool.origin === 'external' && (
          <span className="font-mono uppercase" style={{ marginLeft: 8, fontSize: 9, color: 'var(--color-ink-faint)' }}>
            [external]
          </span>
        )}
      </div>
      <div className="font-mono" style={{ width: 80, fontSize: 11, color: 'var(--color-ink-soft)' }}>{tool.version ?? '—'}</div>
      <div className="font-mono truncate" style={{ flex: 1, fontSize: 11, color: 'var(--color-ink-faint)' }}>{tool.path}</div>
      {tool.origin === 'external' && (
        <div style={{ marginLeft: 8 }}>
          <Btn variant="danger" onClick={onRemove} disabled={busy}>卸载</Btn>
        </div>
      )}
    </div>
  );
}

function PreviewBlock(props: {
  preview: SkillPreview;
  picks: Set<string>;
  setPicks: (s: Set<string>) => void;
  skipped: Map<string, { code: string; message: string }>;
  installing: boolean;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const { preview, picks, setPicks, skipped, installing, onCancel, onCommit } = props;
  const togglePick = (relPath: string) => {
    const next = new Set(picks);
    if (next.has(relPath)) next.delete(relPath); else next.add(relPath);
    setPicks(next);
  };
  return (
    <div style={{ marginTop: 12, padding: 12, border: '0.5px solid var(--color-ink-hair-soft)', borderRadius: 6 }}>
      <div className="font-mono uppercase" style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 1.5, marginBottom: 8 }}>
        来自 {preview.srcKind === 'folder' ? '文件夹' : 'URL'}
      </div>
      {preview.candidates.map((c) => {
        const skip = skipped.get(c.relPath);
        const blockReason = c.nameInvalid
          ? c.nameInvalid
          : c.alreadyInstalled
            ? `已存在（${c.alreadyInstalled}）`
            : skip
              ? `${skip.code}：${skip.message}`
              : null;
        const blocked = blockReason !== null;
        return (
          <label key={c.relPath} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
            <input
              type="checkbox"
              disabled={blocked}
              checked={picks.has(c.relPath)}
              onChange={() => togglePick(c.relPath)}
            />
            <span style={{ fontWeight: 500 }}>{c.name}</span>
            <span className="truncate" style={{ flex: 1, fontSize: 12, color: 'var(--color-ink-soft)' }}>{c.description}</span>
            {blockReason && (
              <span className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-faint)' }}>
                {blockReason}
              </span>
            )}
          </label>
        );
      })}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
        <Btn variant="secondary" onClick={onCancel} disabled={installing}>取消</Btn>
        <Btn variant="primary" onClick={onCommit} disabled={installing || picks.size === 0}>
          {installing ? '安装中…' : `安装选中 (${picks.size})`}
        </Btn>
      </div>
    </div>
  );
}
