import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * read_docx / read_pdf_figure 现在按 session 的 cwd 补全相对路径
 * （docs/superpowers/reviews/2026-09-21-composer-attachments-comments/relpath-brief.md）。
 * 这条能力全靠 sessionFactory 把 opts.cwd 塞进两个工厂函数的 deps —— 漏传不会有任何
 * 编译或 lint 报错，只会让相对路径在运行时照旧被拒，模型多试一轮才发现。
 *
 * 这里替身掉两个工具模块本身，直接截下工厂函数收到的 deps，而不是像
 * sessionFactory.browserTools.test.ts 那样从行为反推——这一条只关心「cwd 有没有传进去」
 * 这一件事，截参数比走完整的工具执行链更直接、也更不会跟工具自身的用例重复。
 */
const H = vi.hoisted(() => ({
  docxDeps: null as Record<string, unknown> | null,
  pdfFigureDeps: null as Record<string, unknown> | null,
}));

vi.mock('./readDocxTool', () => ({
  createReadDocxTool: (deps: Record<string, unknown> = {}) => {
    H.docxDeps = deps;
    return { name: 'read_docx' };
  },
}));

vi.mock('./readPdfFigureTool', () => ({
  createReadPdfFigureTool: (deps: Record<string, unknown>) => {
    H.pdfFigureDeps = deps;
    return { name: 'read_pdf_figure' };
  },
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({
    session: { prompt: async () => {}, abort: () => {}, subscribe: () => () => {} },
  }),
  SessionManager: { open: () => ({}) },
  createReadToolDefinition: () => ({ name: 'read' }),
  createWriteToolDefinition: () => ({ name: 'write', execute: async () => ({ content: [] }) }),
  createEditToolDefinition: () => ({ name: 'edit', execute: async () => ({ content: [] }) }),
}));

vi.mock('../skills/skillResourceLoader', () => ({
  createKydogResourceLoader: async () => ({ reload: async () => {} }),
}));

vi.mock('../llm/providerRegistry', () => ({
  getProviderRegistry: () => ({ modelRuntime: { getModel: () => ({ id: 'm' }) } }),
}));

vi.mock('../settings/settingsService', () => ({
  settingsService: { get: async () => ({ ui: { locale: 'zh' }, institution: null }) },
  toInstitutionPublic: () => null,
}));

// createBrowserTools 会 import 它们（真的用 electron 的 WebContentsView / safeStorage），
// 与 sessionFactory.browserTools.test.ts / sessionFactory.sessionCwd.test.ts 同一套替身。
vi.mock('../browser/browserService', () => ({ browserService: {} }));
vi.mock('../browser/loginFlow', () => ({ loginFlow: { noteFor: () => null } }));

const { createSession } = await import('./sessionFactory');

const noopAskShared = { onOpened: () => {}, onClosed: () => {} };

beforeEach(() => {
  delete process.env.KYDOG_AGENT_FIXTURE;
  H.docxDeps = null;
  H.pdfFigureDeps = null;
});

describe('read_docx / read_pdf_figure 的 cwd 依赖', () => {
  it('两个工厂函数都收到了这条 session 的 cwd', async () => {
    const cwd = '/proj/xyz';
    await createSession({
      cwd, sessionId: 't1', sessionsDir: '/proj/xyz/sessions',
      providerId: 'anthropic', modelId: 'claude',
      askShared: noopAskShared,
    });
    // 正向前置：先证明确实截到了 deps（否则下面两条按属性访问会在 undefined 上悄悄过 —— 不会，
    // 但显式钉住「造过」比只查字段更不容易在工厂签名变化时假绿）。
    expect(H.docxDeps).not.toBeNull();
    expect(H.pdfFigureDeps).not.toBeNull();
    expect(H.docxDeps?.cwd).toBe(cwd);
    expect(H.pdfFigureDeps?.cwd).toBe(cwd);
  });

  it('换一条 cwd，两边跟着换——不是恰好撞对了上一条用例的值', async () => {
    const cwd = '/other/project';
    await createSession({
      cwd, sessionId: 't2', sessionsDir: '/other/project/sessions',
      providerId: 'anthropic', modelId: 'claude',
      askShared: noopAskShared,
    });
    expect(H.docxDeps?.cwd).toBe(cwd);
    expect(H.pdfFigureDeps?.cwd).toBe(cwd);
  });
});
