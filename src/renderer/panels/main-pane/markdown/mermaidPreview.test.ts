import { describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { createMermaidPreview, MERMAID_CONFIG, type MermaidEngine } from './mermaidPreview';

const ready = (svg: string) => `<div class="kydog-mermaid-preview" data-status="ready">${svg}</div>`;
// Drain the loader/render promise chain without loading Mermaid or using wall-clock delays.
async function settle() {
  await setImmediate();
}

describe('Mermaid preview', () => {
  it('固定 strict 初始化配置，非 Mermaid 与空块不调用 loader', async () => {
    expect(MERMAID_CONFIG).toEqual({
      startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
      logLevel: 'fatal', deterministicIds: true,
      suppressErrorRendering: true,
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels'],
    });
    const loader = vi.fn(async () => ({ render: async () => ({ svg: '<svg>ok</svg>' }) }));
    const preview = createMermaidPreview(loader);
    const apply = vi.fn();
    preview('mermaid', 'graph TD; A-->B', apply);
    await settle();
    expect(apply).toHaveBeenCalledWith(ready('<svg>ok</svg>'));
    expect(loader).toHaveBeenCalledTimes(1);
    loader.mockClear();
    expect(preview('typescript', 'const x = 1', apply)).toBeNull();
    expect(preview('mermaid', ' \n\t ', apply)).toBeNull();
    await settle();
    expect(loader).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
    // A fresh instance must also avoid starting a loader for these branches.
    const unusedPreview = createMermaidPreview(loader);
    unusedPreview('typescript', 'x', apply);
    unusedPreview('mermaid', '', apply);
    await settle();
    expect(loader).not.toHaveBeenCalled();
  });

  it('成功渲染包装 ready SVG；相同源码的两块使用不同 id', async () => {
    const render = vi.fn(async (_id: string, _source: string) => ({ svg: '<svg><text>A</text></svg>' }));
    const loader = vi.fn(async () => ({ render }));
    const preview = createMermaidPreview(loader);
    const first = vi.fn();
    const second = vi.fn();
    preview('mermaid', 'graph TD; A-->B', first);
    preview('MERMAID', 'graph TD; A-->B', second);
    await settle();
    expect(first).toHaveBeenCalledWith(ready('<svg><text>A</text></svg>'));
    expect(second).toHaveBeenCalledWith(ready('<svg><text>A</text></svg>'));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(2);
    const calls = render.mock.calls;
    expect(calls[0][1]).toBe('graph TD; A-->B');
    expect(calls[1][1]).toBe('graph TD; A-->B');
    expect(calls[0][0]).toMatch(/^[a-zA-Z][\w-]*$/);
    expect(calls[1][0]).not.toBe(calls[0][0]);
  });

  it('带空白的 Mermaid 语言名仍渲染，源码保持原样', async () => {
    const render = vi.fn(async (_id: string, source: string) => ({ svg: `<svg>${source}</svg>` }));
    const preview = createMermaidPreview(async () => ({ render }));
    const first = vi.fn();
    const second = vi.fn();
    preview(' mermaid ', 'first', first);
    preview('\tMERMAID\n', 'second', second);
    await settle();
    expect(first.mock.calls).toEqual([[ready('<svg>first</svg>')]]);
    expect(second.mock.calls).toEqual([[ready('<svg>second</svg>')]]);
    expect(render.mock.calls.map((call) => call[1])).toEqual(['first', 'second']);
  });

  it.each([
    ['loader', 'null-prototype'], ['loader', 'throwing-toString'],
    ['render', 'null-prototype'], ['render', 'throwing-toString'],
  ] as const)('%s 拒绝不可转成文字的 %s 异常时仍返回中性错误预览', async (stage, kind) => {
    const reason: unknown = kind === 'null-prototype'
      ? Object.create(null)
      : { toString() { throw new Error('conversion failed'); } };
    const preview = createMermaidPreview(async () => {
      if (stage === 'loader') throw reason;
      return { render: async () => { throw reason; } };
    });
    const apply = vi.fn();
    preview('mermaid', 'invalid', apply);
    await settle();
    expect(apply.mock.calls).toEqual([[
      '<div class="kydog-mermaid-preview" data-status="error" role="status">Mermaid preview failed</div>',
    ]]);
  });

  it('加载失败和渲染失败包装 error，异常文字被 HTML 转义且没有 stack', async () => {
    const apply = vi.fn();
    const working = createMermaidPreview(async () => ({ render: async () => ({ svg: '<svg>stack-visible</svg>' }) }));
    working('mermaid', 'valid', apply);
    await settle();
    expect(apply).toHaveBeenLastCalledWith(ready('<svg>stack-visible</svg>'));
    for (const loader of [
      async (): Promise<MermaidEngine> => { throw new Error('<load> & "bad" \'quote\'\nstack-hidden'); },
      async (): Promise<MermaidEngine> => ({ render: async () => { throw new Error('<render> & "bad" \'quote\'\nstack-hidden'); } }),
    ]) {
      createMermaidPreview(loader)('mermaid', 'invalid', apply);
      await settle();
      const html = apply.mock.lastCall![0] as string;
      expect(html).toContain('class="kydog-mermaid-preview"');
      expect(html).toContain('data-status="error"');
      expect(html).toContain('role="status"');
      expect(html).toMatch(/&lt;(load|render)&gt; &amp; &quot;bad&quot; &#39;quote&#39;/);
      expect(html).not.toContain('stack-hidden');
      expect(html).not.toContain('<load>');
      expect(html).not.toContain('<render>');
    }
  });

});
