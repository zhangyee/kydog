import { useCallback, useEffect, useRef, useState } from 'react';
import { useUiStore, type FileTab } from '../../../stores/uiStore';
import { CrepeEditor, type CrepeEditorHandle } from './CrepeEditor';
import { registerSaver, unregisterSaver } from './saveRegistry';

export function MarkdownFileTab({ tab, isActive }: { tab: FileTab; isActive: boolean }) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const editorRef = useRef<CrepeEditorHandle>(null);
  const diskContentRef = useRef<string | null>(tab.diskContent);
  diskContentRef.current = tab.diskContent;

  const setFileTabStatus = useUiStore((s) => s.setFileTabStatus);
  const setFileTabDirty = useUiStore((s) => s.setFileTabDirty);
  const setFileTabDiskContent = useUiStore((s) => s.setFileTabDiskContent);

  // 加载：status 为 loading 时拉文件内容
  useEffect(() => {
    if (tab.status !== 'loading') return;
    let cancelled = false;
    window.kydog.invoke('file.readText', { path: tab.path })
      .then(({ content }) => {
        if (!cancelled) setFileTabStatus(tab.id, { status: 'ready', diskContent: content });
      })
      .catch((err: Error) => {
        if (!cancelled) setFileTabStatus(tab.id, { status: 'error', errorMessage: err.message });
      });
    return () => { cancelled = true; };
  }, [tab.id, tab.path, tab.status, setFileTabStatus]);

  // 保存：返回 true 表示成功
  const save = useCallback(async (): Promise<boolean> => {
    const md = editorRef.current?.getMarkdown() ?? '';
    try {
      await window.kydog.invoke('file.writeText', { path: tab.path, content: md });
      setFileTabDiskContent(tab.id, md);
      setSaveError(null);
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [tab.id, tab.path, setFileTabDiskContent, setSaveError]);

  // 向 saveRegistry 注册，供关闭确认框触发
  useEffect(() => {
    registerSaver(tab.id, save);
    return () => unregisterSaver(tab.id);
  }, [tab.id, save]);

  // ⌘S / Ctrl+S —— 仅激活 tab 响应
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive, save]);

  if (tab.status === 'loading') {
    return (
      <div className="font-mono" style={{ padding: '14px 18px', fontSize: 12, color: 'var(--color-ink-soft)' }}>
        加载中…
      </div>
    );
  }
  if (tab.status === 'error') {
    return (
      <div className="font-mono" style={{ padding: '14px 18px', fontSize: 12, color: 'var(--color-accent)' }}>
        无法打开文件：{tab.errorMessage}
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col min-h-0">
      {saveError && (
        <div
          data-testid="save-error"
          className="font-mono shrink-0"
          style={{
            padding: '6px 14px', fontSize: 11, color: 'var(--color-paper)',
            background: 'var(--color-accent)',
          }}
        >保存失败：{saveError}</div>
      )}
      <div className="flex-1 min-h-0">
        <CrepeEditor
          ref={editorRef}
          initialMarkdown={tab.diskContent ?? ''}
          onChange={(md) => setFileTabDirty(tab.id, md !== diskContentRef.current)}
        />
      </div>
    </div>
  );
}
