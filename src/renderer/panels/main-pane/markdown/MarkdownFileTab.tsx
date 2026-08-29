import { useCallback, useEffect, useRef, useState } from 'react';
import { useUiStore, type FileTab } from '../../../stores/uiStore';
import { confirm } from '../../../stores/confirmStore';
import { CrepeEditor, type CrepeEditorHandle } from './CrepeEditor';
import { registerSaver, unregisterSaver } from './saveRegistry';

export function MarkdownFileTab({ tab, isActive }: { tab: FileTab; isActive: boolean }) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const editorRef = useRef<CrepeEditorHandle>(null);
  // 脏判定基准：编辑器加载后的序列化结果（而非磁盘原文字节）。
  // Crepe 会规范化语法（- → *、--- → ***、表格补空格等），拿磁盘字节比会"开档即脏"。
  const baselineRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  // Crepe 建立后由它自管内容（见 CrepeEditor 末尾那条注释），换内容只能整个重建。
  // 这个计数只在真正要用磁盘新内容顶掉编辑器时 +1 —— ⌘S 之后 diskContent 也会变，
  // 但那次不该重建，否则每存一次盘光标就跳回开头。
  const [editorGeneration, setEditorGeneration] = useState(0);
  // 本地有未保存修改时，外部新内容先扣在这里，等用户点「重新加载」再落地。
  const [externalContent, setExternalContent] = useState<string | null>(null);

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

  const applyExternal = useCallback((content: string) => {
    readyRef.current = false;          // 新编辑器实例会重新走一遍 onReady 定基准
    baselineRef.current = null;
    setFileTabDiskContent(tab.id, content);
    setExternalContent(null);
    setEditorGeneration((g) => g + 1);
  }, [tab.id, setFileTabDiskContent]);

  // 外部改动：reloadNonce 变化时去看一眼磁盘。effect 里要用的 diskContent / dirty
  // 都从最新一次渲染的 props 闭包里取，所以不放进依赖 —— 它们变了不该重新读盘。
  const latest = useRef({ diskContent: tab.diskContent, dirty: tab.dirty });
  latest.current = { diskContent: tab.diskContent, dirty: tab.dirty };
  useEffect(() => {
    if (tab.status !== 'ready' || tab.reloadNonce === 0) return;
    let cancelled = false;
    window.kydog.invoke('file.readText', { path: tab.path })
      .then(({ content }) => {
        if (cancelled) return;
        // 与「上次落盘内容」逐字节比。相等就是自己那次 ⌘S 打回来的回声，不是别人改的
        // —— 用内容判定而不是「刚存过盘的 N 毫秒内忽略」，回声一条不漏也一条不误杀。
        if (content === latest.current.diskContent) return;
        if (latest.current.dirty) { setExternalContent(content); return; }
        applyExternal(content);
      })
      .catch((err: Error) => {
        // 读不到（被删 / 被改名）不该把已经打开的内容清空，留在编辑器里等用户处置。
        console.warn('reload markdown after external change failed', tab.path, err);
      });
    return () => { cancelled = true; };
  }, [tab.id, tab.path, tab.status, tab.reloadNonce, applyExternal]);

  // 保存：返回 true 表示成功
  const save = useCallback(async (): Promise<boolean> => {
    const md = editorRef.current?.getMarkdown() ?? '';
    try {
      await window.kydog.invoke('file.writeText', { path: tab.path, content: md });
      baselineRef.current = md; // 保存后以落盘内容为新基准
      setFileTabDiskContent(tab.id, md);
      // 用户选择了自己的版本，扣着的那份外部内容已经被这次写盘覆盖，不再是可选项。
      setExternalContent(null);
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

  const onReloadClick = async () => {
    if (externalContent === null) return;
    const ok = await confirm({
      title: '放弃本地未保存的修改，加载外部版本？',
      message: '编辑器里未保存的改动会丢失，磁盘上的文件不受影响。',
      confirmLabel: '重新加载',
    });
    if (!ok) return;
    // 等确认的这段时间文件可能又变了，落地前再读一次，别用扣着的旧快照。
    try {
      const { content } = await window.kydog.invoke('file.readText', { path: tab.path });
      applyExternal(content);
    } catch (err) {
      console.warn('reload markdown on demand failed', tab.path, err);
      applyExternal(externalContent);
    }
  };

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
      {externalContent !== null && (
        <div
          data-testid="external-change-banner"
          className="shrink-0 flex items-center"
          style={{
            gap: 10, padding: '5px 14px',
            borderBottom: '0.5px solid var(--color-ink-hair-soft)',
            background: 'var(--color-paper-edge)', color: 'var(--color-ink-soft)',
            fontSize: 12, lineHeight: 1.5,
          }}
        >
          <span className="font-serif">文件已被外部修改，你这里还有未保存的改动</span>
          {/* 实心按钮而非文字链：横幅是被动出现的，用户没在找它，得自己撑起存在感。
              取 ConfirmDialog 主按钮那一套，别在设计系统之外另发明一种强调。 */}
          <button
            type="button"
            data-testid="external-change-reload"
            onClick={() => void onReloadClick()}
            className="font-sans"
            style={{
              fontSize: 12, fontWeight: 500, padding: '3px 12px', borderRadius: 3,
              background: 'var(--color-accent)', color: 'var(--color-paper)',
              cursor: 'pointer',
            }}
          >
            重新加载
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <CrepeEditor
          key={editorGeneration}
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
