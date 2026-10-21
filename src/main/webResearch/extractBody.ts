import { createHash } from 'node:crypto';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import type { Passage } from '../../shared/webResearch';
import type { BodyResult } from './researchRun';

export type ExtractBodyInput = {
  bytes: Uint8Array;
  contentType?: string;
  finalUrl: string;
  sourceId: string;
  truncated?: boolean;
};
export type ExtractBodyResult = BodyResult & { title?: string; publishedAt?: string };

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const blockSelector = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,th';
const removedSelector = 'script,style,noscript,nav,aside,form,iframe,[role="navigation"]';
const challengeSelector = 'input[name="captcha"],.g-recaptcha,.h-captcha,iframe[src*="recaptcha"],iframe[src*="hcaptcha"]';

function mimeType(header?: string): string { return header?.split(';', 1)[0].trim().toLowerCase() ?? ''; }
function isPdf(bytes: Uint8Array): boolean { return PDF_MAGIC.every((value, index) => bytes[index] === value); }
function decode(bytes: Uint8Array, contentType?: string): string {
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType ?? '')?.[1] ?? 'utf-8';
  try { return new TextDecoder(charset).decode(bytes); }
  catch { return new TextDecoder().decode(bytes); }
}
function compact(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

function declaredSiteIcon(document: Document, baseUrl: string): string | undefined {
  for (const link of document.querySelectorAll('link[href]')) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('icon')) continue;
    try {
      const url = new URL(link.getAttribute('href')!, baseUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch { /* malformed or unsupported icon metadata */ }
  }
  return undefined;
}

function textWithLinks(element: Element, baseUrl: string): string {
  const clone = element.cloneNode(true) as Element;
  for (const link of clone.querySelectorAll('a[href]')) {
    const label = compact(link.textContent ?? '');
    const href = link.getAttribute('href');
    if (!href) continue;
    try {
      const target = new URL(href, baseUrl);
      if (target.protocol === 'http:' || target.protocol === 'https:') {
        link.textContent = label ? `${label} (${target.href})` : target.href;
      }
    } catch { /* malformed link is text only */ }
  }
  return element.tagName.toLowerCase() === 'pre'
    ? (clone.textContent ?? '').trim() : compact(clone.textContent ?? '');
}

function passagesFrom(root: Element, sourceId: string, baseUrl: string, initialHeading?: string): Passage[] {
  const passages: Passage[] = [];
  let heading: string | undefined = initialHeading;
  const visit = (element: Element): void => {
    if (element.matches(blockSelector)) {
      const value = textWithLinks(element, baseUrl);
      if (value) {
        if (/^h[1-6]$/i.test(element.tagName)) heading = value;
        const ordinal = passages.length + 1;
        passages.push({ sourceId, passageId: `${sourceId}:p${ordinal}`, ordinal, text: value, heading });
      }
      return;
    }
    for (const child of element.children) visit(child);
  };
  visit(root);
  if (!passages.length) {
    const text = textWithLinks(root, baseUrl);
    if (text) passages.push({ sourceId, passageId: `${sourceId}:p1`, ordinal: 1, text });
  }
  return passages;
}

function hashPassages(passages: readonly Passage[]): string {
  return createHash('sha256').update(JSON.stringify(passages.map((p) => [p.heading ?? '', p.text]))).digest('hex');
}

/** Read only HTML/plain-text source bytes; PDF is an unsupported source, never a parser input. */
export async function extractBody(input: ExtractBodyInput): Promise<ExtractBodyResult> {
  const unsupported = (reason: string): ExtractBodyResult => ({ status: 'unsupported_media', reason,
    passages: [], completeness: 'unknown' });
  const mime = mimeType(input.contentType);
  if (mime === 'application/pdf' || isPdf(input.bytes)) return unsupported('pdf_not_supported');
  if (mime && mime !== 'text/html' && mime !== 'application/xhtml+xml' &&
    mime !== 'text/plain') return unsupported('unsupported_media');
  const raw = decode(input.bytes, input.contentType);
  const completeness = input.truncated ? 'truncated' : 'complete';
  const looksHtml = mime === 'text/html' || mime === 'application/xhtml+xml' ||
    (!mime && /^\s*(?:<!doctype\s+html|<html\b)/i.test(raw));
  if (!looksHtml) {
    const passages = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      .map((text, index) => ({ sourceId: input.sourceId, passageId: `${input.sourceId}:p${index + 1}`,
        ordinal: index + 1, text }));
    return passages.length ? { status: 'readable', passages, completeness,
      contentHash: hashPassages(passages) } : { status: 'unreadable', reason: 'empty_body',
      passages: [], completeness: 'unknown' };
  }
  const dom = new JSDOM(raw, { url: input.finalUrl, contentType: 'text/html' });
  try {
    const document = dom.window.document;
    if (document.querySelector(challengeSelector)) return { status: 'needs_browser',
      reason: 'verification_widget', passages: [], completeness: 'unknown' };
    const hadScript = document.querySelector('script') !== null;
    const siteIconUrl = declaredSiteIcon(document, input.finalUrl);
    for (const node of document.querySelectorAll(removedSelector)) node.remove();
    const fallback = document.querySelector('main,article')?.outerHTML;
    const pageTitle = compact(document.title || document.querySelector('h1')?.textContent || '');
    const publishedAt = document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ??
      document.querySelector('time[datetime]')?.getAttribute('datetime') ?? undefined;
    const parsed = new Readability(document.cloneNode(true) as Document).parse();
    const chosen = parsed?.content || fallback;
    if (!chosen) return { status: hadScript ? 'needs_browser' : 'unreadable',
      reason: hadScript ? 'script_only_or_no_article' : 'no_article', passages: [], completeness: 'unknown' };
    const content = new JSDOM(chosen, { url: input.finalUrl, contentType: 'text/html' });
    try {
      for (const node of content.window.document.querySelectorAll(removedSelector)) node.remove();
      const title = parsed?.title || pageTitle || undefined;
      let passages = passagesFrom(content.window.document.body, input.sourceId, input.finalUrl, title);
      // Readability commonly removes an H1 when it duplicates the document title. Keep it as
      // a position-bearing passage so the worker sees the source's heading, not only metadata.
      if (title && passages.length && !passages.some((passage) => passage.text === title)) {
        passages = [{ sourceId: input.sourceId, passageId: '', ordinal: 0, text: title, heading: title },
          ...passages].map((passage, index) => ({ ...passage, ordinal: index + 1,
          passageId: `${input.sourceId}:p${index + 1}` }));
      }
      if (!passages.length) return { status: hadScript ? 'needs_browser' : 'unreadable',
        reason: 'empty_article', passages: [], completeness: 'unknown' };
      return { status: 'readable', passages, completeness, contentHash: hashPassages(passages),
        title,
        publishedAt: parsed?.publishedTime || publishedAt,
        siteIconUrl };
    } finally { content.window.close(); }
  } finally { dom.window.close(); }
}
