import { useEffect } from 'react';
import { useSkillsStore } from '../stores/skillsStore';
import type { SkillEntry, ToolEntry } from '../../shared/types';

export function SkillsAndToolsSection() {
  const { skills, tools, loading, error, setSkills, setTools, setLoading } = useSkillsStore();

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
      {builtin.map((s) => <SkillRow key={s.name} skill={s} />)}

      <SectionHeader title="技能 · 已安装" />
      {user.length === 0 && <Empty />}
      {user.map((s) => <SkillRow key={s.name} skill={s} />)}

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

function SkillRow({ skill }: { skill: SkillEntry }) {
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
