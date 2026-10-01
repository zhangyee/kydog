import type { MermaidConfig } from 'mermaid';

export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
  logLevel: 'fatal',
  deterministicIds: true,
} satisfies MermaidConfig;

export type MermaidEngine = { render(id: string, source: string): Promise<{ svg: string }> };
export type MermaidLoader = () => Promise<MermaidEngine>;
export type CodePreviewRenderer = (
  language: string,
  content: string,
  applyPreview: (value: null | string | HTMLElement) => void,
) => void | null | string | HTMLElement;

let defaultEngine: Promise<MermaidEngine> | undefined;
const loadMermaid: MermaidLoader = () => defaultEngine ??= import('mermaid').then(({ default: mermaid }) => {
  mermaid.initialize(MERMAID_CONFIG);
  return { render: (id, source) => mermaid.render(id, source) };
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function errorPreview(error: unknown): string {
  const summary = (error instanceof Error ? error.message : String(error)).split(/\r\n|\r|\n/, 1)[0];
  return `<div class="kydog-mermaid-preview" data-status="error" role="status">${escapeHtml(summary)}</div>`;
}

export function createMermaidPreview(loader: MermaidLoader = loadMermaid): CodePreviewRenderer {
  let engine: Promise<MermaidEngine> | undefined;
  let renderId = 0;
  const generations = new WeakMap<(value: null | string | HTMLElement) => void, number>();
  return (language, content, applyPreview) => {
    const generation = (generations.get(applyPreview) ?? 0) + 1;
    generations.set(applyPreview, generation);
    if (language.toLowerCase() !== 'mermaid' || !content.trim()) return null;

    const id = `kydog-mermaid-${++renderId}`;
    // Defer the loader so synchronous loader failures follow the same error protocol.
    engine ??= Promise.resolve().then(loader);
    void engine.then((mermaid) => mermaid.render(id, content)).then(
      ({ svg }) => {
        if (generations.get(applyPreview) === generation) {
          applyPreview(`<div class="kydog-mermaid-preview" data-status="ready">${svg}</div>`);
        }
      },
      (error: unknown) => {
        if (generations.get(applyPreview) === generation) applyPreview(errorPreview(error));
      },
    );
  };
}

export const mermaidPreview: CodePreviewRenderer = createMermaidPreview();
