import { Type } from 'typebox';
import { KydogError } from '../../shared/errors';
import { SEARCH_ENGINE_IDS, validateCollectInput, type ResearchBudget } from '../../shared/webResearch';
import type { CollectOwner, CollectResult, Progress } from '../webResearch/researchRun';
import type { ResearchRunRecord, SavedSource } from '../webResearch/runStore';
import { readEvidence } from '../webResearch/evidenceReader';

const Engine = Type.Union(SEARCH_ENGINE_IDS.map((id) => Type.Literal(id)));
const Angle = Type.Object({ id: Type.String(), label: Type.String(), query: Type.String(),
  rationale: Type.Optional(Type.String()) });
const Attempt = Type.Object({ attemptId: Type.String(), angleIds: Type.Array(Type.String()),
  engineId: Engine, query: Type.String(), searchPageUrl: Type.Optional(Type.String()),
  status: Type.Union(['results', 'explicit_empty', 'blocked', 'navigation_error', 'extraction_error']
    .map((status) => Type.Literal(status))), reason: Type.Optional(Type.String()) });
const Discovery = Type.Object({ attemptId: Type.String(), angleId: Type.String(), engineId: Engine,
  query: Type.String(), resultUrl: Type.String(), title: Type.Optional(Type.String()),
  snippet: Type.Optional(Type.String()), searchPageUrl: Type.String() });
const Budget = Type.Partial(Type.Object({
  maxCandidates: Type.Integer(), maxFetches: Type.Integer(), maxTotalBytes: Type.Integer(),
  maxBytesPerSource: Type.Integer(), maxModelCalls: Type.Integer(), maxOutputTokensPerCall: Type.Integer(),
  maxRedirectsPerSource: Type.Integer(), fetchConcurrency: Type.Integer(), modelConcurrency: Type.Integer(),
} satisfies Record<keyof ResearchBudget, ReturnType<typeof Type.Integer>>));
const CollectParams = Type.Object({
  researchRunId: Type.Optional(Type.String()), originalQuestion: Type.String(),
  angles: Type.Array(Angle), enabledEngines: Type.Array(Engine),
  attempts: Type.Array(Attempt), discoveries: Type.Array(Discovery),
  budget: Type.Optional(Budget), refresh: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const EvidenceParams = Type.Object({ researchRunId: Type.String(),
  evidenceIds: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }) }, { additionalProperties: false });

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
const asText = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

export type WebResearchToolDeps = {
  threadId: string;
  currentRunId: () => string | null;
  onProgress: (progress: Progress & { runId: string; toolCallId: string }) => void;
  collect: (input: ReturnType<typeof validateCollectInput>, owner: CollectOwner,
    progress: (event: Progress) => void) => Promise<CollectResult>;
  loadRun: (threadId: string, researchRunId: string) => Promise<ResearchRunRecord>;
  loadSource?: (run: ResearchRunRecord, sourceId: string) => Promise<SavedSource>;
};

export function renderCompactResult(result: CollectResult): string {
  const angles = result.angles.map((angle) => ({ ...angle, claims: angle.claims.slice(0, 24),
    omittedClaims: Math.max(0, angle.claims.length - 24) }));
  return JSON.stringify({ ...result, angles });
}

/** Neither tool accepts a thread ID; identity comes only from the session closure. */
export function createWebResearchTools(deps: WebResearchToolDeps) {
  const collectTool = {
    name: 'web_research_collect', label: '网页研究采集',
    description: '接收内置浏览器已发现的搜索记录和目标 URL，按预算抓取、抽取并返回证据 ID。搜索仍使用 browser_open/browser_act。',
    promptSnippet: 'web_research_collect — 采集已发现的 URL，返回可回溯证据和研究缺口',
    parameters: CollectParams, executionMode: 'sequential' as const,
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<ToolResult> {
      if (params && typeof params === 'object' && 'threadId' in params) throw new Error('threadId is not a tool parameter');
      const input = validateCollectInput(params);
      const runId = deps.currentRunId();
      if (!runId) throw new KydogError('agent.aborted', 'No active run for web research');
      const owner = { threadId: deps.threadId, runId, toolCallId,
        signal: signal ?? new AbortController().signal };
      const result = await deps.collect(input, owner, (progress) => {
        // Ignore a late completion from a previous turn before it reaches AgentService's journal.
        if (deps.currentRunId() === runId) deps.onProgress({ ...progress, runId, toolCallId });
      });
      return { content: [{ type: 'text', text: renderCompactResult(result) }] };
    },
  };
  const evidenceTool = {
    name: 'web_research_evidence', label: '读取网页研究证据',
    description: '按证据 ID 读取已保存的少量原文片段与最终 URL，用于核对研究报告引用。',
    promptSnippet: 'web_research_evidence — 按证据 ID 核对引文和最终 URL',
    parameters: EvidenceParams, executionMode: 'sequential' as const,
    async execute(_toolCallId: string, params: unknown, _signal?: AbortSignal): Promise<ToolResult> {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('invalid evidence request');
      const request = params as Record<string, unknown>;
      if ('threadId' in request || typeof request.researchRunId !== 'string' ||
        !Array.isArray(request.evidenceIds) || request.evidenceIds.length < 1 || request.evidenceIds.length > 4 ||
        request.evidenceIds.some((id) => typeof id !== 'string' || !id)) throw new Error('invalid evidence request');
      const run = await deps.loadRun(deps.threadId, request.researchRunId);
      if (!deps.loadSource) throw new Error('source reader unavailable');
      const evidence = [];
      for (const evidenceId of request.evidenceIds as string[]) {
        evidence.push(await readEvidence(run, evidenceId, deps.loadSource));
      }
      return asText({ researchRunId: run.researchRunId, evidence });
    },
  };
  return [collectTool, evidenceTool] as const;
}
