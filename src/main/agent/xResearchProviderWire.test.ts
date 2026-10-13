import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { validateToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { fixture, post, readHtml, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import type { XResearchBrowser } from '../x/xResearchBrowser';
import { createXResearchTool } from './xResearchTool';

describe('x_research DeepSeek provider request', () => {
  it('sends an object-root function schema through the installed SDK HTTP serializer', async () => {
    const tool = createXResearchTool({
      browser: {} as XResearchBrowser, threadId: 'wire-test', sources: new Map(), currentRunId: () => 'run',
    });
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
    expect(schema).toMatchObject({
      additionalProperties: false,
      properties: {
        tabId: { type: 'string', minLength: 1 },
        search: { type: 'object', additionalProperties: false, properties: {
          objective: { type: 'string', minLength: 1 },
          queries: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false,
            required: ['id', 'query', 'purpose', 'product'], properties: {
              id: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1, maxLength: 4096 },
              purpose: { type: 'string', minLength: 1 }, product: { anyOf: [{ const: 'Top' }, { const: 'Latest' }] },
            } } },
          maxPostsPerQuery: { type: 'integer', minimum: 0, maximum: 100 },
          maxScrollsPerQuery: { type: 'integer', minimum: 0, maximum: 20 },
        }, required: ['objective', 'queries'] },
        read: { type: 'object', additionalProperties: false, properties: {
          objective: { type: 'string', minLength: 1 },
          targets: { type: 'array', minItems: 1, maxItems: 20, items: { anyOf: [
            { type: 'object', additionalProperties: false, properties: { postId: { type: 'string', pattern: '^[0-9]+$' } }, required: ['postId'] },
            { type: 'object', additionalProperties: false, properties: { url: { type: 'string', minLength: 1 } }, required: ['url'] },
          ] } },
          maxRepliesPerPost: { type: 'integer', minimum: 0, maximum: 100 },
          maxScrollsPerPost: { type: 'integer', minimum: 0, maximum: 20 },
          maxExpandActionsPerPost: { type: 'integer', minimum: 0, maximum: 20 },
        }, required: ['objective', 'targets'] },
      },
    });
    expect(Object.keys(schema)).not.toContain('anyOf');
  });

  it('keeps SDK validation and the first-line parser strict before browser activity', async () => {
    const f = fixture([searchHtml(post())]);
    const tool = createXResearchTool({browser: f.context.browser, threadId: 'thread', sources: f.context.sources, currentRunId: () => 'run'});
    const call = (arguments_: Record<string, unknown>) => validateToolCall([tool], {type: 'toolCall', id: 'sdk-call', name: tool.name, arguments: arguments_});
    expect((await tool.execute('search', call(searchInput), undefined, undefined, {} as never)).details?.operation).toBe('search');
    expect(f.open).toHaveBeenCalledTimes(1);
    const read = {tabId: 'read-tab', read: {objective: 'read', targets: [{url: 'https://x.com/bob/status/456'}], includeArticle: false, includeReplies: false}};
    // A valid read is checked through the same SDK validator before the invalid calls.
    const readFixture = fixture([readHtml(post('456', 'bob', 'read control'))]);
    const readTool = createXResearchTool({browser: readFixture.context.browser, threadId: 'thread', sources: readFixture.context.sources, currentRunId: () => 'run'});
    const validatedRead = validateToolCall([readTool], {type: 'toolCall', id: 'read-call', name: readTool.name, arguments: read});
    expect((await readTool.execute('read', validatedRead, undefined, undefined, {} as never)).details?.operation).toBe('read');
    expect(readFixture.open).toHaveBeenCalledTimes(1);
    const collected = f.collect.mock.calls.length;
    expect(collected).toBeGreaterThan(0);
    const both = {...searchInput, read: read.read};
    await expect(tool.execute('both', call(both), undefined, undefined, {} as never)).rejects.toThrow('exactly one');
    const noTab = {read: read.read};
    await expect(tool.execute('no-tab', call(noTab), undefined, undefined, {} as never)).rejects.toThrow('top-level tabId is required');
    const bothTargets = {...read, read: {...read.read, targets: [{postId: '456', url: 'https://x.com/bob/status/456'}]}};
    expect(() => call(bothTargets)).toThrow();
    await expect(tool.execute('both-targets', bothTargets as never, undefined, undefined, {} as never)).rejects.toThrow('exactly one');
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.collect).toHaveBeenCalledTimes(collected);
  });
});
