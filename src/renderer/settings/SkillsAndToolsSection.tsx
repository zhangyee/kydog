import { useEffect, useState } from 'react';
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
        <button
          onClick={() => void refresh({ force: true })}
          className="font-mono"
          style={{ fontSize: 11, color: 'var(--color-ink-soft)' }}
        >
          刷新
        </button>
      </div>

      {error && (
        <div style={{ color: 'var(--color-danger, #c0392b)', marginBottom: 12 }}>{error}</div>
      )}

      <SectionHeader title="技能 · 内置" subtitle="对已打开的对话不生效，下次新建对话起生效。" />
      {builtin.length === 0 && <Empty />}
      {builtin.map((s) => <SkillRow key={s.name} skill={s} onChanged={setSkills} />)}

      <SectionHeader title="技能 · 已安装" />
      {user.length === 0 && <Empty />}
      {user.map((s) => <SkillRow key={s.name} skill={s} onChanged={setSkills} />)}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={onPickFolder} className="font-mono" style={{ fontSize: 11 }}>+ 从文件夹安装</button>
        <button onClick={() => setUrlInputOpen(true)} className="font-mono" style={{ fontSize: 11 }}>+ 从 URL 安装</button>
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
          <button onClick={onScan} disabled={scanning || !url.trim()}>{scanning ? '扫描中…' : '扫描'}</button>
          <button onClick={() => { setUrlInputOpen(false); setUrl(''); }}>取消</button>
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

      <SectionHeader title="工具" subtitle="agent 可调用的捆绑 CLI" />
      {tools.length === 0 && <Empty />}
      {tools.map((t) => <ToolRow key={t.name} tool={t} />)}
      <div style={{ marginTop: 8 }}>
        <button
          disabled
          title="即将开放"
          className="font-mono"
          style={{ fontSize: 11, opacity: 0.5, cursor: 'default' }}
        >
          + 添加外部工具
        </button>
      </div>
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginTop: 24, marginBottom: 8 }}>
      <div className="font-mono uppercase" style={{ fontSize: 10, letterSpacing: 1.5, color: 'var(--color-ink-faint)' }}>
        {title}
      </div>
      {subtitle && (
        <div className="font-serif italic" style={{ fontSize: 12, color: 'var(--color-ink-soft)', marginTop: 4 }}>
          {subtitle}
        </div>
      )}
    </div>
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
          <button onClick={onToggle} disabled={busy} className="font-mono" style={{ fontSize: 11 }}>
            {skill.enabled ? '禁用' : '启用'}
          </button>
        )}
        <button onClick={onOpen} className="font-mono" style={{ fontSize: 11, color: 'var(--color-ink-soft)' }}>打开目录↗</button>
        {skill.origin === 'user' && (
          <button onClick={onUninstall} disabled={busy} className="font-mono" style={{ fontSize: 11, color: 'var(--color-danger, #c0392b)' }}>
            卸载
          </button>
        )}
      </div>
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolEntry }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', padding: '6px 0', borderBottom: '0.5px solid var(--color-ink-hair-soft)' }}>
      <div style={{ width: 140, fontWeight: 500 }}>{tool.name}</div>
      <div className="font-mono" style={{ width: 80, fontSize: 11, color: 'var(--color-ink-soft)' }}>{tool.version ?? '—'}</div>
      <div className="font-mono truncate" style={{ flex: 1, fontSize: 11, color: 'var(--color-ink-faint)' }}>{tool.path}</div>
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
        <button onClick={onCancel} disabled={installing}>取消</button>
        <button onClick={onCommit} disabled={installing || picks.size === 0}>
          {installing ? '安装中…' : `安装选中 (${picks.size})`}
        </button>
      </div>
    </div>
  );
}
