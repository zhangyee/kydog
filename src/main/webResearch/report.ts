import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WebResearchTaskRecord, WebResearchTaskSource } from '../../shared/webResearchTask';

export type ReportValidationError = {
  code: 'report_required' | 'no_evidence_citations' | 'malformed_citation' | 'evidence_missing' |
    'evidence_unavailable' | 'evidence_ungrounded' | 'citation_url_mismatch' | 'mixed_source_citation' |
    'unprocessed_reason_missing';
  line: number;
  column: number;
  excerpt: string;
  evidenceIds?: string[];
};

export type ReportValidationResult =
  | { ok: true; publishedMarkdown: string }
  | { ok: false; errors: ReportValidationError[] };

function reportSlug(input: string): string {
  const slug = input.trim().replace(/\.md$/i, '').replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!slug) throw new Error('invalid report file name');
  return slug;
}

function requestedReportTopic(input: string): string {
  return input.trim().replace(/\.md$/i, '').replace(/^web-research-/i, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/u, '');
}

function location(markdown: string, index: number): Pick<ReportValidationError, 'line' | 'column' | 'excerpt'> {
  const before = markdown.slice(0, index);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = markdown.indexOf('\n', index);
  const fullLine = markdown.slice(lineStart, lineEnd === -1 ? markdown.length : lineEnd);
  return { line, column: index - lineStart + 1,
    excerpt: fullLine.length <= 180 ? fullLine : `${fullLine.slice(0, 177)}…` };
}

export function evidencePublicationState(source: WebResearchTaskSource,
  evidence: NonNullable<WebResearchTaskSource['extraction']>['evidence'][number]):
{ publishable: boolean; unavailableReason?: string } {
  if (evidence.verification !== 'grounded') return { publishable: false, unavailableReason: 'evidence_unverified' };
  if (!evidence.quote) return { publishable: false, unavailableReason: 'empty_quote' };
  const passage = source.passages.find((item) => item.passageId === evidence.passageId);
  if (!passage?.text.includes(evidence.quote)) {
    return { publishable: false, unavailableReason: 'passage_missing_or_quote_mismatch' };
  }
  try {
    if (!source.finalUrl || !['http:', 'https:'].includes(new URL(source.finalUrl).protocol)) {
      return { publishable: false, unavailableReason: 'missing_final_url' };
    }
  } catch { return { publishable: false, unavailableReason: 'missing_final_url' }; }
  return { publishable: true };
}

/** Validate every draft marker and return all determinable errors in document order. */
export function validateReportCitations(sources: readonly WebResearchTaskSource[], markdown: string,
  unprocessedReason?: string): ReportValidationResult {
  const errors: ReportValidationError[] = [];
  if (!markdown.trim()) return { ok: false,
    errors: [{ code: 'report_required', ...location(markdown, 0) }] };
  const evidenceById = new Map(sources.flatMap((source) =>
    (source.extraction?.evidence ?? []).map((evidence) => [evidence.evidenceId, { evidence, source }] as const)));
  const starts = [...markdown.matchAll(/〔证据:/g)];
  const removals: Array<{ start: number; end: number }> = [];
  for (const startMatch of starts) {
    const start = startMatch.index;
    const lineEnd = markdown.indexOf('\n', start);
    const close = markdown.indexOf('〕', start + startMatch[0].length);
    const at = location(markdown, start);
    if (close === -1 || (lineEnd !== -1 && close > lineEnd)) {
      errors.push({ code: 'malformed_citation', ...at });
      continue;
    }
    removals.push({ start, end: close + 1 });
    const rawIds = markdown.slice(start + startMatch[0].length, close);
    const evidenceIds = rawIds.split(/[,，]/).map((id) => id.trim()).filter(Boolean);
    if (!evidenceIds.length || evidenceIds.some((id) => !/^[A-Za-z0-9:_-]+$/.test(id))) {
      errors.push({ code: 'malformed_citation', ...at,
        ...(evidenceIds.length ? { evidenceIds } : {}) });
      continue;
    }
    const link = markdown.slice(0, start).match(/\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\)$/);
    if (!link) {
      errors.push({ code: 'malformed_citation', ...at, evidenceIds });
      continue;
    }
    const citedUrl = link[1];
    const entries = evidenceIds.map((id) => ({ id, entry: evidenceById.get(id) }));
    for (const { id, entry } of entries) {
      if (!entry) {
        errors.push({ code: 'evidence_missing', ...at, evidenceIds: [id] });
        continue;
      }
      const state = evidencePublicationState(entry.source, entry.evidence);
      if (!state.publishable) {
        errors.push({ code: state.unavailableReason === 'passage_missing_or_quote_mismatch'
          ? 'evidence_ungrounded' : 'evidence_unavailable', ...at, evidenceIds: [id] });
      }
      if (citedUrl !== entry.source.finalUrl) {
        errors.push({ code: 'citation_url_mismatch', ...at, evidenceIds: [id] });
      }
    }
    if (new Set(entries.flatMap(({ entry }) => entry ? [entry.source.sourceId] : [])).size > 1) {
      errors.push({ code: 'mixed_source_citation', ...at, evidenceIds });
    }
  }
  if (!starts.length && [...evidenceById.values()].some(({ evidence, source }) =>
    evidencePublicationState(source, evidence).publishable)) {
    errors.push({ code: 'no_evidence_citations', ...location(markdown, 0) });
  }
  if (unprocessedReason && !markdown.includes(unprocessedReason)) {
    errors.push({ code: 'unprocessed_reason_missing', ...location(markdown, 0) });
  }
  if (errors.length) return { ok: false, errors };
  let publishedMarkdown = markdown;
  for (const removal of removals.reverse()) {
    publishedMarkdown = publishedMarkdown.slice(0, removal.start) + publishedMarkdown.slice(removal.end);
  }
  return { ok: true, publishedMarkdown };
}

export async function completeReport(task: WebResearchTaskRecord, sources: readonly WebResearchTaskSource[],
  reportMarkdown: string, fileName?: string, unprocessedReason?: string):
Promise<{ completed: true; reportPath: string } | { completed: false; validationErrors: ReportValidationError[] }> {
  const validation = validateReportCitations(sources, reportMarkdown, unprocessedReason);
  if (!validation.ok) return { completed: false, validationErrors: validation.errors };
  const root = path.resolve(task.projectRoot);
  const slug = reportSlug(fileName === undefined ? task.originalQuestion : requestedReportTopic(fileName));
  const base = `web-research-${slug}-${new Date().toISOString().slice(0, 10)}`;
  const temp = path.join(root, `.${base}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, validation.publishedMarkdown, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    for (let suffix = 0; suffix < 1000; suffix++) {
      const finalPath = path.join(root, `${base}${suffix ? `-${suffix + 1}` : ''}.md`);
      try {
        await fs.link(temp, finalPath);
        return { completed: true, reportPath: finalPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('report name space exhausted');
  } finally {
    await fs.rm(temp, { force: true });
  }
}
