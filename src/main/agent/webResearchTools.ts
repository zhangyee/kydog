import { Type } from 'typebox';
import { KydogError } from '../../shared/errors';
import type { ResearchBudget } from '../../shared/webResearch';
import type { WebResearchTaskService } from '../webResearch/taskService';

const Angle = Type.Object({ id: Type.String(), label: Type.String(), query: Type.String(),
  rationale: Type.Optional(Type.String()) });
const Budget = Type.Partial(Type.Object({
  maxCandidates: Type.Integer(), maxFetches: Type.Integer(), maxTotalBytes: Type.Integer(),
  maxBytesPerSource: Type.Integer(), maxModelCalls: Type.Integer(), maxOutputTokensPerCall: Type.Integer(),
  maxRedirectsPerSource: Type.Integer(), fetchConcurrency: Type.Integer(), modelConcurrency: Type.Integer(),
} satisfies Record<keyof ResearchBudget, ReturnType<typeof Type.Integer>>));
const Id = Type.String();
// OpenAI-compatible providers require a JSON Schema with type:"object" at the root.
// A top-level Type.Union emits only anyOf, so keep action-specific required checks in execute.
const Params = Type.Object({
  action: Type.String({ enum: ['submit', 'wait', 'inspect', 'complete', 'pause', 'resume', 'cancel'] }),
  researchRunId: Type.Optional(Id),
  originalQuestion: Type.Optional(Type.String()),
  angles: Type.Optional(Type.Array(Angle)),
  observationIds: Type.Optional(Type.Array(Id)),
  observationSelections: Type.Optional(Type.Array(Type.Object({
    observationId: Id, resultIndexes: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }),
  }, { additionalProperties: false }))),
  budget: Type.Optional(Budget),
  view: Type.Optional(Type.String({ enum: ['overview', 'sources', 'claims', 'evidence'] })),
  cursor: Type.Optional(Type.String()),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  angleId: Type.Optional(Id),
  status: Type.Optional(Type.String()),
  evidenceIds: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 4 })),
  reportMarkdown: Type.Optional(Type.String()),
  fileName: Type.Optional(Type.String()),
  unprocessedReason: Type.Optional(Type.String()),
}, { additionalProperties: false });

type TaskMethods = Pick<WebResearchTaskService, 'submit' | 'whenIdle' | 'get' | 'inspect' | 'complete' | 'control'>;
export type WebResearchToolDeps = { threadId: string; projectRoot: string;
  currentRunId: () => string | null; service: TaskMethods };
type ToolResult = { content: Array<{ type: 'text'; text: string }> };
const result = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function waitUnlessAborted(work: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return work();
  if (signal.aborted) return Promise.reject(new KydogError('agent.aborted', 'Web research wait aborted'));
  return new Promise<void>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort);
      reject(new KydogError('agent.aborted', 'Web research wait aborted')); };
    signal.addEventListener('abort', abort, { once: true });
    work().then(() => { signal.removeEventListener('abort', abort); resolve(); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** The only research-specific model tool. Browser search stays in browser_open/browser_act. */
export function createWebResearchTools(deps: WebResearchToolDeps) {
  const tool = {
    name: 'web_research_task', label: '网页研究任务',
    description: '管理一项持久网页研究：submit 提交 IAB 搜索观察并立即入队；wait 等当前队列空闲并返回最新状态，避免反复 inspect 轮询；inspect 按页查看来源、主张、证据；complete 核验引用并保存项目 Markdown 报告；pause/resume/cancel 管理队列。搜索仍用 browser_open/browser_act，研究判断与报告撰写由主会话负责。',
    promptSnippet: 'web_research_task — 提交 IAB 搜索观察、等待后台批次、检查证据、保存 Markdown 研究报告',
    parameters: Params, executionMode: 'sequential' as const,
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal): Promise<ToolResult> {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('invalid web research task input');
      const p = params as Record<string, unknown>;
      if ('threadId' in p || 'projectRoot' in p) throw new Error('threadId and projectRoot are not tool parameters');
      const action = p.action;
      if (action === 'submit') {
        const runId = deps.currentRunId();
        if (!runId) throw new KydogError('agent.aborted', 'No active run for web research');
        const submitted = await deps.service.submit({
          researchRunId: p.researchRunId as string | undefined,
          originalQuestion: p.originalQuestion as string | undefined,
          angles: p.angles as Parameters<TaskMethods['submit']>[0]['angles'],
          observationIds: p.observationIds as string[] | undefined,
          observationSelections: p.observationSelections as Parameters<TaskMethods['submit']>[0]['observationSelections'],
          budget: p.budget as Partial<ResearchBudget> | undefined,
        }, { threadId: deps.threadId, runId, projectRoot: deps.projectRoot });
        return result({ kind: 'web_research_task', action, ...submitted });
      }
      const researchRunId = p.researchRunId;
      if (typeof researchRunId !== 'string' || !researchRunId) throw new Error('researchRunId is required');
      if (action === 'wait') {
        await waitUnlessAborted(() => deps.service.whenIdle(deps.threadId, researchRunId), signal);
        const current = await deps.service.get(deps.threadId, researchRunId);
        return result({ kind: 'web_research_task', action, researchRunId,
          snapshot: current });
      }
      if (action === 'inspect') {
        if (!['overview', 'sources', 'claims', 'evidence'].includes(String(p.view))) throw new Error('invalid view');
        const inspected = await deps.service.inspect(deps.threadId, researchRunId, {
          view: p.view as 'overview' | 'sources' | 'claims' | 'evidence',
          cursor: p.cursor as string | undefined, pageSize: p.pageSize as number | undefined,
          angleId: p.angleId as string | undefined,
          status: p.status as Parameters<TaskMethods['inspect']>[2]['status'],
          evidenceIds: p.evidenceIds as string[] | undefined,
        });
        return result({ kind: 'web_research_task', action, researchRunId, ...inspected });
      }
      if (action === 'complete') {
        if (typeof p.reportMarkdown !== 'string') throw new Error('reportMarkdown is required');
        const completed = await deps.service.complete(deps.threadId, researchRunId,
          p.reportMarkdown, p.fileName as string | undefined, p.unprocessedReason as string | undefined);
        return result({ kind: 'web_research_task', action, researchRunId, ...completed });
      }
      if (action === 'pause' || action === 'resume' || action === 'cancel') {
        const controlled = await deps.service.control(deps.threadId, researchRunId, action);
        return result({ kind: 'web_research_task', action, researchRunId,
          snapshot: controlled });
      }
      throw new Error('invalid web research task action');
    },
  };
  return [tool] as const;
}
