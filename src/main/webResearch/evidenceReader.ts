import { KydogError } from '../../shared/errors';
import type { ResearchEvidenceExcerpt } from '../../shared/webResearch';
import type { ResearchRunRecord, SavedSource } from './runStore';

export async function readEvidence(run: ResearchRunRecord, evidenceId: string,
  loadSource: (run: ResearchRunRecord, sourceId: string) => Promise<SavedSource>): Promise<ResearchEvidenceExcerpt> {
  const sourceIndex = run.sources.find((source) => source.evidenceIds?.includes(evidenceId));
  if (!sourceIndex) throw new KydogError('research.not_found', 'Evidence not found');
  const source = await loadSource(run, sourceIndex.sourceId);
  const item = source.extraction?.evidence.find((candidate) => candidate.evidenceId === evidenceId);
  const passage = source.passages.find((candidate) => candidate.passageId === item?.passageId);
  if (!item || !passage || !source.finalUrl) throw new KydogError('research.not_found', 'Evidence not found');
  const excerpt = passage.text.length > 1600 ? `${passage.text.slice(0, 1600)}…` : passage.text;
  return { evidenceId, sourceId: source.sourceId, finalUrl: source.finalUrl,
    passageId: passage.passageId, heading: passage.heading, pageNumber: passage.pageNumber,
    quote: item.quote, relation: item.relation, verification: item.verification,
    excerpt, excerptTruncated: passage.text.length > 1600 };
}
