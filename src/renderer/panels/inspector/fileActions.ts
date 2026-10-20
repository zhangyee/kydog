import type { TrashFilesResult } from '../../../shared/files';
import { confirm } from '../../stores/confirmStore';
import { useUiStore } from '../../stores/uiStore';
import { loadDir } from '../../fsWatch';

export async function deleteProjectFiles(
  projectPath: string,
  targets: ReadonlyArray<{ path: string; parentPath: string }>,
): Promise<TrashFilesResult | null> {
  // Capture identities and parents before the confirmation awaits any user interaction.
  const snapshot = [...new Map(targets.map(t => [t.path, { ...t }])).values()];
  if (!snapshot.length) return null;
  const paths = snapshot.map(t => t.path);
  const name = (path: string) => path.split(/[\\/]/).pop() ?? path;
  const dirty = useUiStore.getState().openFileTabs.filter(t => paths.includes(t.path) && t.kind === 'md' && t.dirty);
  const message = `将 ${snapshot.map(t => name(t.path)).join('、')} 移至系统废纸篓。${dirty.length ? `\n${dirty.map(t => name(t.path)).join('、')}：未保存修改将丢失。` : ''}`;
  if (!(await confirm({ title: `删除 ${snapshot.length} 个文件？`, message, confirmLabel: '移至废纸篓' }))) return null;
  const result = await window.kydog.invoke('file.trash', { projectPath, paths });
  const trashed = new Set(result.trashed);
  for (const path of trashed) useUiStore.getState().closeFileTab(path);
  const parents = new Set(snapshot.filter(t => trashed.has(t.path)).map(t => t.parentPath));
  await Promise.all([...parents].map(loadDir));
  return result;
}
