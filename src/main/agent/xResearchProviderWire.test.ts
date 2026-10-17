// 新动作面的 SDK 边界：装好的 SDK 真的把 `action` 这套对象根 schema 发出去，而**碰浏览器之前**
// 参数就已经被挡下（旧工具那条用例的移植：判据一处不少，只是入口换成了 `submit`）。
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { validateToolCall } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture, post, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { createXResearchRunner } from '../x/xResearchRunner';
import { XResearchScopeLedger } from '../x/xResearchScopeFacts';
import { XResearchTaskService } from '../x/xResearchTaskService';
import { XResearchTaskStore } from '../x/xResearchTaskStore';
import { createXResearchTools } from './xResearchTools';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'x-wire-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Fixture = ReturnType<typeof fixture>;
function harness(f: Fixture) {
  const threadId = randomUUID();
  const ledger = new XResearchScopeLedger();
  const service = new XResearchTaskService({
    store: new XResearchTaskStore(root()),
    runWork: createXResearchRunner({
      browserFor: () => f.context.browser,
      contextFor: () => ({
        sources: f.context.sources,
        scopePrior: (runId) => ledger.prior(runId),
        currentRunId: () => 'run',
      }),
      artifacts: () => tempXArtifactStore(),
    }),
    onUpdate: () => undefined,
    artifacts: () => tempXArtifactStore(),
  });
  const tool = createXResearchTools({
    service, threadId, projectRoot: '/projects/x', currentRunId: () => 'run',
    observeDelivery: () => undefined,
  });
  return { tool, service, threadId };
}
type Tool = ReturnType<typeof harness>['tool'];
function execute(tool: Tool, raw: Record<string, unknown>, callId = 'call') {
  return tool.execute(callId, raw as never, undefined, undefined, {} as never);
}

describe('x_research DeepSeek provider request', () => {
  it('sends an object-root function schema through the installed SDK HTTP serializer', async () => {
    const { tool } = harness(fixture([searchHtml(post())]));
    const model = getBuiltinModel('deepseek', 'deepseek-v4-flash');
    expect(model.api).toBe('openai-completions');
    const requests: { url: string; body: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: JSON.parse(await request.text()) });
      const chunk = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1,
        model: model.id, choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    };
    const events = [];
    const stream = streamSimple(model, {
      messages: [{ role: 'user', content: 'research X', timestamp: 1 }],
      tools: [{ name: tool.name, description: tool.description, parameters: tool.parameters }],
    }, { apiKey: 'test-only-dummy-key', fetch });
    for await (const event of stream) events.push(event.type);
    expect((await stream.result()).stopReason).toBe('stop');
    expect(events).toContain('done');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.deepseek.com/chat/completions');
    const body = requests[0].body as { model: string; tools: { type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }[] };
    expect(body.model).toBe(model.id);
    expect(body.tools).toHaveLength(1);
    const sent = body.tools[0];
    expect(sent.type).toBe('function');
    expect(sent.function.name).toBe('x_research');
    const schema = sent.function.parameters;
    expect(schema.type).toBe('object');
    expect(sent.function.description).toContain('exactly one');
    // 工作键的形状与改造前**一字不差**：换掉的只是外层（`action` + 动作专属键）。
    expect(schema).toMatchObject({
      additionalProperties: false,
      properties: {
        action: { anyOf: [
          { const: 'submit' }, { const: 'wait' }, { const: 'inspect' }, { const: 'cancel' },
        ] },
        tabId: { type: 'string', minLength: 1 },
        search: { type: 'object', additionalProperties: false, properties: {
          objective: { type: 'string', minLength: 1 },
          queries: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false,
            required: ['id', 'query', 'purpose', 'product'], properties: {
              id: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1, maxLength: 4096 },
              purpose: { type: 'string', minLength: 1 }, product: { anyOf: [{ const: 'Top' }, { const: 'Latest' }] },
            } } },
          maxPostsPerQuery: { type: 'integer', minimum: 0, maximum: 1000 },
          maxScrollsPerQuery: { type: 'integer', minimum: 0, maximum: 1000 },
        }, required: ['objective', 'queries'] },
        read: { type: 'object', additionalProperties: false, properties: {
          objective: { type: 'string', minLength: 1 },
          targets: { type: 'array', minItems: 1, maxItems: 20, items: { anyOf: [
            { type: 'object', additionalProperties: false, properties: { postId: { type: 'string', pattern: '^[0-9]+$' } }, required: ['postId'] },
            { type: 'object', additionalProperties: false, properties: { url: { type: 'string', minLength: 1 } }, required: ['url'] },
          ] } },
          maxRepliesPerPost: { type: 'integer', minimum: 0, maximum: 1000 },
          maxScrollsPerPost: { type: 'integer', minimum: 0, maximum: 1000 },
          maxExpandActionsPerPost: { type: 'integer', minimum: 0, maximum: 1000 },
        }, required: ['objective', 'targets'] },
      },
    });
    expect(Object.keys(schema)).not.toContain('anyOf');
  });

  it('keeps SDK validation and the submit parser strict before browser or task activity', async () => {
    const f = fixture([searchHtml(post())]);
    const { tool, service, threadId } = harness(f);
    const call = (arguments_: Record<string, unknown>) => validateToolCall(
      [tool], { type: 'toolCall', id: 'sdk-call', name: tool.name, arguments: arguments_ });
    // 合法的一次 submit 走同一个 SDK 校验器；submit 立即返回，采集在队列上真的开了浏览器。
    const submitted = await execute(tool, call({ action: 'submit', ...searchInput }));
    expect((submitted.details as { action?: string }).action).toBe('submit');
    await service.whenIdle(threadId, (submitted.details as { researchRunId: string }).researchRunId);
    expect(f.open).toHaveBeenCalledTimes(1);
    const opened = f.open.mock.calls.length;
    // 下面这些都必须在碰浏览器、建任务之前被挡下：一个都不许留下「已排上」的研究。
    await expect(execute(tool, call({ action: 'submit', ...searchInput, read: { objective: 'read', targets: [{ url: 'https://x.com/bob/status/456' }] } })))
      .rejects.toThrow('exactly one');
    await expect(execute(tool, call({ action: 'submit' }))).rejects.toThrow('exactly one');
    // 动作专属键走错动作：TypeBox 认（不在 schema 里就过不去的那一条由 SDK 挡），
    // 直接调 execute 的那条路由工具自己挡。
    await expect(execute(tool, { action: 'wait', search: searchInput.search })).rejects.toThrow('unknown field search');
    // read 不再要求顶层 tabId（任务持有标签页）—— 这是动作面与旧工具**唯一**的请求面变化。
    const read = await execute(tool, call({
      action: 'submit',
      read: { objective: 'read', targets: [{ url: 'https://x.com/bob/status/456' }], includeArticle: false, includeReplies: false },
    }), 'read-call');
    expect((read.details as { action?: string }).action).toBe('submit');
    await service.whenIdle(threadId, (read.details as { researchRunId: string }).researchRunId);
    expect(f.open).toHaveBeenCalledTimes(opened + 1);
    // 两次合法提交 → 盘上恰好两条研究：被拒的几次一条都没建。
    expect((await service.list(threadId)).map((snapshot) => snapshot.counts.submissions))
      .toEqual([1, 1]);
  });
});
