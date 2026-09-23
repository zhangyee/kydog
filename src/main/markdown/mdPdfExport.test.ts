import { describe, it, expect, vi, afterEach } from 'vitest';

/** 假打印窗口：记下构造参数；printToPDF 默认立即兑现，个别用例换成手动兑现。 */
const h = vi.hoisted(() => {
  const onTime = (): Promise<Buffer> => Promise.resolve(Buffer.from('%PDF-fake'));
  const state = { created: [] as Array<Record<string, unknown>>, printToPDF: onTime, onTime };
  class FakeWindow {
    private destroyed = false;
    readonly webContents = {
      on: () => {},
      setWindowOpenHandler: () => {},
      executeJavaScript: async () => undefined,
      printToPDF: () => state.printToPDF(),
    };
    constructor(opts: Record<string, unknown>) { state.created.push(opts); }
    loadURL = async () => {};
    loadFile = async () => {};
    isDestroyed = () => this.destroyed;
    destroy = () => { this.destroyed = true; };
  }
  return { state, FakeWindow, atomicWriteBytes: vi.fn(async (_p: string, _b: Buffer) => {}) };
});

vi.mock('electron', () => ({ BrowserWindow: h.FakeWindow }));
vi.mock('../persist/atomicWrite', () => ({ atomicWriteBytes: h.atomicWriteBytes }));
vi.mock('../log', () => ({ logger: { info: () => {}, warn: () => {} } }));
vi.mock('../settings/settingsService', () => ({ settingsService: { get: async () => ({ ui: { readingFontSize: 'medium' } }) } }));
// vite 在构建时注入的常量；打包路径那一支要读它
vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');

const { validateExportArgs, exportMarkdownPdf } = await import('./mdPdfExport');

const good = { mdPath: '/p/a.md', markdown: '# x', outPath: '/p/a.pdf', options: { paper: 'a4', margin: 'standard', pageNumbers: true } };

describe('validateExportArgs', () => {
  it('合法参数原样通过', () => {
    expect(validateExportArgs(good)).toEqual(good);
  });
  it('路径必须是非空绝对路径、不含 NUL', () => {
    for (const k of ['mdPath', 'outPath'] as const) {
      for (const bad of ['', 'a.pdf', '/p/a\0.pdf', 42]) {
        expect(() => validateExportArgs({ ...good, [k]: bad }), `${k}=${String(bad)}`).toThrow();
      }
    }
  });
  it('markdown 必须是字符串（空串可以：导出一页空白）', () => {
    expect(validateExportArgs({ ...good, markdown: '' }).markdown).toBe('');
    expect(() => validateExportArgs({ ...good, markdown: null })).toThrow();
  });
  it('options 取值不认识就拒绝（不是悄悄换成默认值）', () => {
    expect(() => validateExportArgs({ ...good, options: { ...good.options, paper: 'a3' } })).toThrow();
    expect(() => validateExportArgs({ ...good, options: { ...good.options, pageNumbers: 'yes' } })).toThrow();
    expect(() => validateExportArgs({ ...good, options: undefined })).toThrow();
  });
  it('整体不是对象也拒绝', () => {
    for (const bad of [null, undefined, 'x', []]) expect(() => validateExportArgs(bad), String(bad)).toThrow();
  });
});

describe('exportMarkdownPdf', () => {
  afterEach(() => {
    vi.useRealTimers();
    h.state.printToPDF = h.state.onTime;
    h.state.created.length = 0;
    h.atomicWriteBytes.mockClear();
  });

  it('打印窗口的内容宽是这次导出的版心宽（不含窗框）；选项翻面，宽度跟着变', async () => {
    await exportMarkdownPdf(good);   // A4 / 标准
    await exportMarkdownPdf({ ...good, options: { paper: 'letter', margin: 'narrow', pageNumbers: false } });
    expect(h.state.created.map((o) => [o.width, o.useContentSize])).toEqual([[602, true], [720, true]]);
  });

  it('printToPDF 在超时之后才兑现：报超时、不写盘；按时兑现的那次照常写', async () => {
    // 只假 setTimeout：下面靠真的 setImmediate 把晚到那一支的微任务链跑完
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // 正向：同一套假窗口，按时兑现就写到存储框给的路径
    await exportMarkdownPdf(good);
    expect(h.atomicWriteBytes).toHaveBeenCalledWith('/p/a.pdf', expect.any(Buffer));
    h.atomicWriteBytes.mockClear();

    let release!: (pdf: Buffer) => void;
    h.state.printToPDF = () => new Promise<Buffer>((r) => { release = r; });
    const settled = exportMarkdownPdf(good).then(() => 'resolved', (e: unknown) => String(e));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled).toContain('导出超时');
    release(Buffer.from('%PDF-late'));
    await new Promise((r) => setImmediate(r));
    expect(h.atomicWriteBytes).not.toHaveBeenCalled();
  });
});
