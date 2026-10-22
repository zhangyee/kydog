import type { ResearchDocumentFacts } from '../../shared/webResearchTask';

export type { ResearchDocumentFacts, ResearchDocumentIdentity } from '../../shared/webResearchTask';
export type BrowserSourceKey = { threadId: string; researchRunId: string; sourceId: string };
export type BrowserAttemptOwner = BrowserSourceKey & { attemptId: string };
export type ResearchDocumentSnapshot = ResearchDocumentFacts & { html: string };
export type BrowserReadInput = BrowserAttemptOwner & {
  requestedUrl: string;
  mode: 'navigate' | 'capture_existing';
  signal: AbortSignal;
  /** Reserve and durably save before navigation; a rejection prevents the effect. */
  beforeNavigate: () => Promise<void>;
  remainingDomBytes: () => Promise<number>;
  onDocument: (doc: ResearchDocumentSnapshot) => Promise<'accepted' | 'continue'>;
};
export type BrowserReadResult =
  | { status: 'readable'; document: ResearchDocumentFacts }
  | { status: 'waiting_user' | 'failed' | 'budget_blocked'; reason: string };
export interface BrowserReader {
  read(input: BrowserReadInput): Promise<BrowserReadResult>;
  openForUser(input: BrowserSourceKey & {
    requestedUrl: string; signal: AbortSignal; beforeNavigate: () => Promise<void>;
  }): Promise<{ tabId: string }>;
  currentTab(key: BrowserSourceKey): string | undefined;
  release(key: BrowserSourceKey, options: { closeOwned: boolean }): Promise<void>;
  dispose(): Promise<void>;
}
