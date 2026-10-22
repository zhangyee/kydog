import { expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { newThread } from '../../helpers';

export type Call = { toolCallId: string; name: string; args: Record<string, unknown> };
function script(calls: Call[]) {
  return { events: [
    { after_ms: 5, type: 'agent_start' },
    { after_ms: 5, type: 'message_start', messageId: 'm1' },
    ...calls.map((call) => ({ after_ms: 5, type: 'tool', ...call })),
    { after_ms: 5, type: 'message_end', messageId: 'm1',
      toolCallIds: calls.map((call) => call.toolCallId), toolNames: calls.map((call) => call.name) },
    { after_ms: 5, type: 'agent_end', reason: 'completed' },
  ] };
}

export async function runCalls(page: Page, fixturePath: string, calls: Call[], createThread = true) {
  await fs.writeFile(fixturePath, JSON.stringify(script(calls)));
  await page.evaluate(() => {
    const box = { chunks: [] as Array<{ toolCallId: string; chunk: string }>,
      ends: [] as Array<{ toolCallId: string; status: string }>, ended: null as null | string };
    (window as unknown as { __webResearchRun: typeof box }).__webResearchRun = box;
    const off = [
      window.kydog.on('run.tool_call_chunk', (event) => box.chunks.push({ toolCallId: event.toolCallId, chunk: event.chunk })),
      window.kydog.on('run.tool_call_end', (event) => box.ends.push({ toolCallId: event.toolCallId, status: event.status })),
      window.kydog.on('run.ended', (event) => { box.ended = event.reason; }),
    ];
    (window as unknown as { __webResearchRunDispose: () => void }).__webResearchRunDispose = () => off.forEach(dispose => dispose());
  });
  try {
    if (createThread) await newThread(page);
    const composer = page.getByTestId('composer-input');
    await expect.poll(async () => { await composer.fill('按夹具执行网页研究'); return composer.textContent(); })
      .toBe('按夹具执行网页研究');
    await page.getByTestId('send-button').click();
    const read = () => page.evaluate(() => (window as unknown as { __webResearchRun: {
      chunks: Array<{ toolCallId: string; chunk: string }>;
      ends: Array<{ toolCallId: string; status: string }>;
      ended: null | string;
    } }).__webResearchRun);
    await expect.poll(async () => (await read()).ended, { timeout: 60_000 }).toBe('completed');
    const box = await read();
    return new Map(calls.map((call) => {
      const end = box.ends.find((item) => item.toolCallId === call.toolCallId);
      expect(end, `${call.name} must emit run.tool_call_end`).toBeTruthy();
      return [call.toolCallId, { status: end!.status,
        text: box.chunks.filter((item) => item.toolCallId === call.toolCallId)
          .map((item) => item.chunk).join('') }] as const;
    }));
  } finally {
    await page.evaluate(() => {
      const state = window as unknown as { __webResearchRunDispose?: () => void };
      state.__webResearchRunDispose?.();
      delete state.__webResearchRunDispose;
    });
  }
}
