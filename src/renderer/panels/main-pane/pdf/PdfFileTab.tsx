import { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { useUiStore, type FileTab } from '../../../stores/uiStore';

// pdf.js worker —— Vite 的 new URL 资产模式在 dev(http) 与 packaged(file://) 下均能解析
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const ZOOM_SENSITIVITY = 0.0025; // 每单位 deltaY 的缩放系数

export function PdfFileTab({ tab }: { tab: FileTab }) {
  const setFileTabStatus = useUiStore((s) => s.setFileTabStatus);
  const [bytes, setBytes] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const pendingScale = useRef(1);

  // 加载 PDF 字节
  useEffect(() => {
    if (tab.status !== 'loading') return;
    let cancelled = false;
    window.kydog.invoke('file.readBytes', { path: tab.path })
      .then(({ bytes }) => {
        if (cancelled) return;
        setBytes(bytes);
        setFileTabStatus(tab.id, { status: 'ready' });
      })
      .catch((err: Error) => {
        if (!cancelled) setFileTabStatus(tab.id, { status: 'error', errorMessage: err.message });
      });
    return () => { cancelled = true; };
  }, [tab.id, tab.path, tab.status, setFileTabStatus]);

  // 字节 → Blob URL：避免 react-pdf 把 ArrayBuffer 转交 worker 后 detach
  // 导致的 StrictMode/重挂载报错；URL 在卸载时回收
  const fileUrl = useMemo(() => {
    if (!bytes) return null;
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  }, [bytes]);
  useEffect(() => () => {
    if (fileUrl) URL.revokeObjectURL(fileUrl);
  }, [fileUrl]);

  // 触摸板捏合缩放：Chromium 把捏合转成 ctrl+wheel
  useEffect(() => {
    if (tab.status !== 'ready') return;
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // 非捏合的滚轮 → 走默认滚动（连续翻页）
      e.preventDefault();
      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, pendingScale.current * (1 - e.deltaY * ZOOM_SENSITIVITY)),
      );
      pendingScale.current = next;
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          setScale(pendingScale.current);
        });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [tab.status]);

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
    <div
      ref={scrollRef}
      data-testid={`pdf-scroll-${tab.id}`}
      className="ky-scroll h-full overflow-auto"
      style={{ background: 'var(--color-paper-deep)' }}
    >
      {fileUrl && (
        <Document
          file={fileUrl}
          className="flex flex-col items-center gap-4 py-6"
          loading={null}
          error={null}
          onLoadSuccess={(pdf) => setNumPages(pdf.numPages)}
          onLoadError={(err) =>
            setFileTabStatus(tab.id, { status: 'error', errorMessage: err.message })
          }
        >
          {Array.from({ length: numPages }, (_, i) => (
            <Page
              key={i + 1}
              pageNumber={i + 1}
              scale={scale}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              className="shadow-md"
            />
          ))}
        </Document>
      )}
    </div>
  );
}
