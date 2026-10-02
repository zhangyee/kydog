// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { createCrepe } from './crepeSetup';

const pending = vi.hoisted(() => new Map<string, {
  resolve: (value: { svg: string }) => void; reject: (reason: unknown) => void;
}>());
vi.mock('./mermaidPreview', async (original) => {
  const actual = await original<typeof import('./mermaidPreview')>();
  return { ...actual, mermaidPreview: actual.createMermaidPreview(async () => ({
    render: (_id, source) => new Promise((resolve, reject) => pending.set(source, { resolve, reject })),
  })) };
});

let crepe: ReturnType<typeof createCrepe>;
let root: HTMLDivElement;
let view: EditorView;
beforeEach(async () => {
  pending.clear();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void) {}
    observe(target: Element) {
      queueMicrotask(() => this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  root = document.createElement('div');
  document.body.append(root);
  crepe = createCrepe({ mode: 'print', root, markdown: '```mermaid\ncontrol\n```\n\n```mermaid\nindependent\n```', mdPath: '/p/a.md' });
  await crepe.create();
  crepe.editor.action((ctx) => { view = ctx.get(editorViewCtx); });
  await vi.waitFor(() => expect(pending.has('control') && pending.has('independent')).toBe(true));
});
afterEach(async () => {
  await crepe?.destroy();
  root?.remove();
  vi.unstubAllGlobals();
});

function replaceFirst(language: string, text: string) {
  const first = view.state.doc.firstChild!;
  const replacement = first.type.create({ ...first.attrs, language }, text ? view.state.schema.text(text) : undefined);
  view.dispatch(view.state.tr.replaceWith(0, first.nodeSize, replacement));
}
async function complete(source: string) {
  pending.get(source)!.resolve({ svg: `<svg><text>${source}</text></svg>` });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

describe('actual Crepe NodeView preview lifecycle', () => {
  it.each(['mermaid', ' MeRmAiD '])('initial %s in edit mode hides only Mermaid source and preserves the toggle choice', async (language) => {
    await crepe.destroy();
    root.replaceChildren();
    pending.clear();
    crepe = createCrepe({ mode: 'edit', root,
      markdown: `\`\`\`${language}\ncontrol\n\`\`\`\n\n\`\`\`javascript\nconst ordinary = 42;\n\`\`\``,
      mdPath: '/p/a.md', platform: 'darwin', onCommentClick: () => {} });
    await crepe.create();
    crepe.editor.action((ctx) => { view = ctx.get(editorViewCtx); });
    await vi.waitFor(() => expect(pending.has('control')).toBe(true));
    await complete('control');
    await vi.waitFor(() => expect(root.querySelector('.kydog-mermaid-preview')?.textContent).toBe('control'));
    const blocks = root.querySelectorAll('.milkdown-code-block');
    expect(blocks).toHaveLength(2);
    const source = blocks[0].querySelector('.codemirror-host')!;
    const ordinarySource = blocks[1].querySelector('.codemirror-host')!;
    const toggle = blocks[0].querySelector('.preview-toggle-button') as HTMLElement;
    expect(ordinarySource.textContent).toContain('const ordinary = 42;');
    expect(source.classList.contains('hidden')).toBe(true);
    expect(ordinarySource.classList.contains('hidden')).toBe(false);
    expect(toggle.textContent).toContain('Edit');
    toggle.click();
    await vi.waitFor(() => expect(source.classList.contains('hidden')).toBe(false));
    expect(toggle.textContent).toContain('Hide');
    replaceFirst('javascript', 'changed');
    replaceFirst('mermaid', 'returned');
    await vi.waitFor(() => expect(pending.has('returned')).toBe(true));
    await complete('returned');
    await vi.waitFor(() => expect(root.querySelector('.kydog-mermaid-preview')?.textContent).toBe('returned'));
    expect(source.classList.contains('hidden')).toBe(false);
    expect(toggle.textContent).toContain('Hide');
    toggle.click();
    await vi.waitFor(() => expect(source.classList.contains('hidden')).toBe(true));
    expect(toggle.textContent).toContain('Edit');
  });

  it('discards a stale error after the actual LaTeX wrapper takes over', async () => {
    await complete('control');
    await vi.waitFor(() => expect(root.querySelector('.kydog-mermaid-preview')?.textContent).toBe('control'));
    replaceFirst('mermaid', 'failing');
    await vi.waitFor(() => expect(pending.has('failing')).toBe(true));
    replaceFirst('latex', 'y^2');
    await vi.waitFor(() => expect(root.querySelector('.katex')).toBeTruthy());
    pending.get('failing')!.reject(new Error('obsolete parse error'));
    await complete('independent');
    expect([...root.querySelectorAll('.kydog-mermaid-preview')].map((p) => p.textContent)).toEqual(['independent']);
    expect(root.querySelector('.katex')).toBeTruthy();
  });
  it('destroy invalidates pending work without cancelling the surviving block', async () => {
    await complete('control');
    await vi.waitFor(() => expect(root.querySelector('.kydog-mermaid-preview')?.textContent).toBe('control'));
    replaceFirst('mermaid', 'removed');
    await vi.waitFor(() => expect(pending.has('removed')).toBe(true));
    view.dispatch(view.state.tr.delete(0, view.state.doc.firstChild!.nodeSize));
    await complete('independent');
    await complete('removed');
    expect([...root.querySelectorAll('.kydog-mermaid-preview')].map((p) => p.textContent)).toEqual(['independent']);
  });

  it.each([
    ['mermaid', 'latest'], ['javascript', 'ordinary'], ['mermaid', ''], ['latex', 'x^2'],
  ])('invalidates pending Mermaid across fresh callbacks and %s/%s transitions', async (language, text) => {
    await complete('control');
    await vi.waitFor(() => expect(root.querySelector('.kydog-mermaid-preview')?.textContent).toBe('control'));
    replaceFirst('mermaid', 'obsolete');
    await vi.waitFor(() => expect(pending.has('obsolete')).toBe(true));
    replaceFirst(language, text);
    if (language === 'mermaid' && text) {
      await vi.waitFor(() => expect(pending.has('latest')).toBe(true));
      await complete('latest');
    } else if (language === 'latex') {
      await vi.waitFor(() => expect(root.querySelector('.katex')).toBeTruthy());
    } else {
      await vi.waitFor(() => expect(root.querySelector('.kydog-mermaid-preview')).toBeNull());
    }
    await complete('independent');
    await complete('obsolete');
    const previews = [...root.querySelectorAll('.kydog-mermaid-preview')].map((p) => p.textContent);
    expect(previews).toEqual(language === 'mermaid' && text ? ['latest', 'independent'] : ['independent']);
    if (language === 'latex') expect(root.querySelector('.katex')).toBeTruthy();
  });
});
