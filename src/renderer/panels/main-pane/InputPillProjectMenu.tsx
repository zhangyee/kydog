// src/renderer/panels/main-pane/InputPillProjectMenu.tsx
import { useEffect, useRef, useState } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { NavIcon } from '../../shared';
import type { Project } from '../../../shared/types';

type Props = {
  threadId: string;
  currentProjectPath: string;
  anchorRect: DOMRect;
  onClose: () => void;
};

export function InputPillProjectMenu({ threadId, currentProjectPath, anchorRect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const projects = useThreadsStore((s) => s.projects);
  const upsertThread = useThreadsStore((s) => s.upsertThread);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);

  const applySwitch = async (projectPath: string) => {
    if (projectPath === currentProjectPath) { onClose(); return; }
    try {
      const updated = await window.kydog.invoke('thread.update', { threadId, projectPath });
      upsertThread(updated);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`切换失败：${msg}`);
    }
  };

  const onOpenOther = async () => {
    try {
      const project = await window.kydog.invoke('project.open');
      useThreadsStore.setState((s) => ({
        projects: [...s.projects.filter((p) => p.path !== project.path), project],
      }));
      await applySwitch(project.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`打开失败：${msg}`);
    }
  };

  const projectName = (p: Project) => p.path.split('/').pop() ?? p.path;
  const current = projects.find((p) => p.path === currentProjectPath);
  const others = projects.filter((p) => p.path !== currentProjectPath);

  return (
    <div
      ref={ref}
      data-testid="project-menu"
      style={{
        position: 'fixed',
        left: anchorRect.left,
        bottom: window.innerHeight - anchorRect.top + 6,
        background: 'var(--color-paper)',
        border: '0.5px solid var(--color-ink-hair-soft)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        padding: '6px 0',
        minWidth: 260,
        maxHeight: 360,
        overflowY: 'auto',
        zIndex: 70,
      }}
      className="ky-scroll"
    >
      {error ? (
        <div style={{ padding: '6px 14px', color: 'var(--color-error, #c0392b)', fontSize: 11 }}>
          {error}
        </div>
      ) : null}
      {current ? (
        <button
          type="button"
          data-testid="project-item-current"
          onMouseDown={(e) => { e.preventDefault(); onClose(); }}
          className="font-serif w-full text-left"
          style={{ padding: '6px 14px', background: 'transparent', border: 'none', cursor: 'default', display: 'flex', gap: 8, alignItems: 'center' }}
        >
          <NavIcon name="check" size={12} />
          <span style={{ fontSize: 12, color: 'var(--color-ink)' }}>{projectName(current)}</span>
        </button>
      ) : null}
      {others.length > 0 ? <div style={{ borderTop: '0.5px solid var(--color-ink-hair-soft)', margin: '4px 0' }} /> : null}
      {others.map((p) => (
        <button
          key={p.path}
          type="button"
          data-testid={`project-item-${projectName(p)}`}
          onMouseDown={(e) => { e.preventDefault(); void applySwitch(p.path); }}
          className="font-serif w-full text-left"
          style={{ padding: '6px 14px', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}
        >
          <NavIcon name="folder" size={12} />
          <span style={{ fontSize: 12, color: 'var(--color-ink)' }}>{projectName(p)}</span>
        </button>
      ))}
      <div style={{ borderTop: '0.5px solid var(--color-ink-hair-soft)', margin: '4px 0' }} />
      <button
        type="button"
        data-testid="project-item-open-other"
        onMouseDown={(e) => { e.preventDefault(); void onOpenOther(); }}
        className="font-serif w-full text-left"
        style={{ padding: '6px 14px', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center', color: 'var(--color-ink-soft)' }}
      >
        <NavIcon name="folder-plus" size={12} />
        <span style={{ fontSize: 12 }}>打开其他文件夹…</span>
      </button>
    </div>
  );
}
