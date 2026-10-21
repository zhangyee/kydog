// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { auditMermaidSvg } from './mermaidSvgAudit';

const svg = (content: string) => `<svg xmlns="http://www.w3.org/2000/svg" id="diagram">${content}</svg>`;
const safe = '<defs><marker id="arrow"><path d="M0 0L1 1"/></marker></defs><style>.line {stroke: #333; marker-end: url(#arrow); border-image-source:initial}</style><path class="line" d="M0 0L10 10"/>';

describe('Mermaid SVG output resource audit', () => {
  it('preserves ordinary SVG and same-document marker references', () => {
    expect(auditMermaidSvg(svg(safe))).toMatch(/url\(["']?#arrow/);
  });
  it('removes unresolved local filters instead of letting them bind to the parent document', () => {
    expect(auditMermaidSvg(svg('<style>.unused {filter:url(#missing)}</style>'))).toContain('filter: none');
  });
  it.each([
    '<image href="https://example.invalid/x.png"/>',
    '<use href="https://example.invalid/x.svg#shape"/>',
    '<use href="relative.svg#shape"/>',
    '<g xml:base="https://example.invalid/"><use href="#diagram"/></g>',
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">HTML</div></foreignObject>',
    '<animate attributeName="href" to="https://example.invalid/x.svg"/>',
    '<style>.unused {fill: url(https://example.invalid/paint.svg)}</style>',
    '<style>.unused { &amp; { fill: url(https://example.invalid/nested.svg) } }</style>',
    '<style>.unused {background-image: url("https://example.invalid/x.png")}</style>',
    '<style>.unused {filter: url(relative.svg#filter)}</style>',
    '<style>.unused {--paint: url(https://example.invalid/x); fill: var(--paint)}</style>',
    '<style>@font-face {font-family: remote; src: url(https://example.invalid/font.woff)}</style>',
    '<style>@import url(https://example.invalid/style.css);</style>',
    '<path style="fill:url(https://example.invalid/x)"/>',
    '<path fill="url(https://example.invalid/x)"/>',
    '<path fill="url(&quot;#a&quot;) url(&quot;https://example.invalid/x&quot;)"/>',
    '<path fill="var(--parent-paint)"/>',
    '<use href="#parent-owned-element"/>',
    '<path onload="alert(1)"/>',
  ])('rejects resource-bearing DOM/CSSOM before parent insertion: %s', (content) => {
    expect(auditMermaidSvg(svg(safe))).toContain('marker');
    expect(() => auditMermaidSvg(svg(content))).toThrow(/Unsupported Mermaid/);
  });
});
