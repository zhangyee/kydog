import { useCallback, useEffect, useRef, useState } from 'react';
import { useUiStore, type FileTab } from '../../../stores/uiStore';
import { CrepeEditor, type CrepeEditorHandle } from './CrepeEditor';
import { registerSaver, unregisterSaver } from './saveRegistry';

export function MarkdownFileTab({ tab, isActive }: { tab: FileTab; isActive: boolean }) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const editorRef = useRef<CrepeEditorHandle>(null);
  // 脏判定基准：编辑器加载后的序列化结果（而非磁盘原文字节）。
  // Crepe 会规范化语法（- → *、--- → ***、表格补空格等），拿磁盘字节比会"开档即脏"。
  const baselineRef = useRef<string | null>(null);
  const readyRef = useRef(false);

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
      baselineRef.current = md; // 保存后以落盘内容为新基准
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
          onReady={(initialMd) => {
            baselineRef.current = initialMd;
            readyRef.current = true;
            setFileTabDirty(tab.id, false);
          }}
          onChange={(md) => {
            // 加载期的规范化 markdownUpdated：持续刷新基准，不算脏。
            if (!readyRef.current) {
              baselineRef.current = md;
              return;
            }
            setFileTabDirty(tab.id, md !== baselineRef.current);
          }}
        />
      </div>
    </div>
  );
}
