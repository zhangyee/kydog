import { useState } from 'react';
import type { SkillSyncStatus, PendingSkillConflict } from '../../shared/types';

interface Props {
  status: SkillSyncStatus;
  onApply: (ops: { skill: string; files: string[] }[]) => Promise<void>;
  onDismiss: () => void;
}

export function SkillSyncModal({ status, onApply, onDismiss }: Props) {
  const [selected, setSelected] = useState<Record<string, Set<string>>>(() => ({}));
  const [busy, setBusy] = useState(false);

  if (status.pendingConflicts.length === 0) return null;

  function toggle(skill: string, file: string) {
    setSelected((prev) => {
      const set = new Set(prev[skill] ?? []);
      if (set.has(file)) set.delete(file); else set.add(file);
      return { ...prev, [skill]: set };
    });
  }

  async function apply() {
    setBusy(true);
    try {
      const ops = Object.entries(selected)
        .filter(([, set]) => set.size > 0)
        .map(([skill, set]) => ({ skill, files: [...set] }));
      await onApply(ops);
      onDismiss();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-xl w-[640px] max-h-[80vh] overflow-auto p-6">
        <h2 className="text-lg font-semibold mb-2">内置 Skill 升级冲突</h2>
        <p className="text-sm text-gray-600 mb-4">
          KyDog 升级包含 {status.pendingConflicts.length} 个有改动的 skill。
          你修改过这些文件，新版也变了。勾选要用 KyDog 新版覆盖的项。不勾选 = 保留你的改动。
        </p>
        {status.pendingConflicts.map((c) => (
          <SkillBlock key={c.skill} c={c} selected={selected[c.skill] ?? new Set()} onToggle={(f) => toggle(c.skill, f)} />
        ))}
        {status.userSkills.length > 0 && (
          <p className="text-xs text-gray-500 mt-4">
            另外 {status.userSkills.length} 个你自定义的 skill 不会被动：{status.userSkills.join(', ')}
          </p>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onDismiss} disabled={busy} className="px-3 py-1 text-sm">稍后</button>
          <button onClick={apply} disabled={busy} className="px-3 py-1 text-sm bg-blue-600 text-white rounded">
            {busy ? '应用中…' : '应用变更'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillBlock({ c, selected, onToggle }: { c: PendingSkillConflict; selected: Set<string>; onToggle: (f: string) => void }) {
  return (
    <div className="border rounded p-3 mb-2">
      <div className="font-medium">{c.skill} <span className="text-gray-400 text-xs">({c.conflicts.length} 个文件冲突)</span></div>
      <ul className="mt-1">
        {c.conflicts.map((f) => (
          <li key={f.relPath} className="text-sm">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={selected.has(f.relPath)} onChange={() => onToggle(f.relPath)} />
              <span className="font-mono">{f.relPath}</span>
              <span className="text-xs text-gray-400">disk {f.diskSha.slice(0,7)} → ship {f.shippedSha.slice(0,7)}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
