import { readFileSync } from 'node:fs';
import { KydogError } from '../../shared/errors';
import type { ProviderId } from '../../shared/types';
import type { RpcCall } from '../../shared/protocol';
import { getProviderRegistry } from '../llm/providerRegistry';
import { buildGroupsText, buildLayoutSystemPrompt, buildTranslateSystemPrompt, buildUserText } from './translatePrompt';

// 两个入口的入参类型从 protocol.ts 现推，只此一份定义：字面结构写在那边（与其余 RPC 同样
// 风格），这里不重复写第二份——从 pdfTranslatePage.ts 引类型会把主进程模块拖进 shared。
export type LayoutPageArgs = Extract<RpcCall, { method: 'pdf.translation.layout' }>['args'];
export type TranslateGroupsArgs = Extract<RpcCall, { method: 'pdf.translation.translate' }>['args'];

/**
 * **全应用**同时在飞的上游请求上界。
 *
 * 渲染层每趟作业另有一个 PAGE_CONCURRENCY，界的是「一趟里已发出未落地的页数」；两者管的不是
 * 同一件事：文件 tab 全程挂载（MainPane 只用 display:none 隐藏），用户可以在几个 PDF 上各起
 * 一趟，只有渲染层那个常数时总在飞请求是「4 × 作业数」。
 *
 * 这不是 job 状态：它不认识作业、不认识 tab，只是一个模块级计数器，主进程仍然无 job 状态。
 */
export const MODEL_CONCURRENCY = 4;

let inFlight = 0;
const waiting: (() => void)[] = [];

export async function withPermit<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MODEL_CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    // finally 而不是 then：抛错也必须还回去，否则一次异常泄漏一个 permit，攒够 4 次之后
    // 所有翻译永久排队，而且没有任何报错——这是最难查的那种故障。
    inFlight--;
    waiting.shift()?.();
  }
}

// modelRuntime 的 getModel 只声明到 unknown（那份 shim 只钉了实际被调用的方法签名），
// 这里按 completeSimple 的入参类型收窄 —— 与 titleService.ts 同一处理。
type PiModel = Parameters<import('@earendil-works/pi-coding-agent').ModelRuntime['completeSimple']>[0];

type FixtureEntry = { text: string; stopReason: string };
let fixture: Record<string, FixtureEntry[]> | null = null;
let fixtureFrom: string | null = null;

function nextFixture(page: number): { text: string; truncated: boolean } {
  const path = process.env.KYDOG_TRANSLATE_FIXTURE!;
  if (fixtureFrom !== path) { fixture = JSON.parse(readFileSync(path, 'utf8')); fixtureFrom = path; }
  const q = fixture?.[String(page)];
  // 耗尽即报错：fixture 与用例不同步是测试 bug，静默降级成空响应只会让用例绿着却什么都没验。
  if (!q || q.length === 0) throw new KydogError('llm.invalid', `翻译 fixture 里第 ${page} 页没有（更多）响应`);
  const e = q.shift()!;
  return { text: e.text, truncated: e.stopReason === 'length' };
}

/** 第一步：版面。只回原始文本与截断标志，解析在渲染层（spec 2026-09-07 §4.2）。 */
export function layoutPage(a: LayoutPageArgs): Promise<{ text: string; truncated: boolean }> {
  return callModel(a, buildLayoutSystemPrompt({ docTitle: a.docTitle }), buildUserText(a.lines));
}
/** 第二步：翻译。同上（§4.3）。 */
export function translateGroups(a: TranslateGroupsArgs): Promise<{ text: string; truncated: boolean }> {
  return callModel(a, buildTranslateSystemPrompt(a), buildGroupsText(a.groups));
}

/** semaphore、fixture、runtimeRevision、模型存在、stopReason 分派——两个入口共用这一处。 */
async function callModel(
  a: { page: number; providerId: ProviderId; modelId: string; runtimeRevision: number },
  systemPrompt: string, userText: string,
): Promise<{ text: string; truncated: boolean }> {
  // fixture 同样走 semaphore：否则 e2e 跑的并发路径与生产不是同一条。
  return withPermit(async () => {
    if (process.env.KYDOG_TRANSLATE_FIXTURE) return nextFixture(a.page);

    const reg = getProviderRegistry();
    if (reg.runtimeRevision !== a.runtimeRevision) {
      throw new KydogError('llm.not_configured', 'provider 配置在翻译途中变了，请重新翻译');
    }
    const model = reg.modelRuntime.getModel(a.providerId, a.modelId) as PiModel | undefined;
    if (!model) throw new KydogError('llm.not_configured', `没有可用的模型 ${a.providerId}/${a.modelId}`);

    const res = await reg.modelRuntime.completeSimple(model, {
      systemPrompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }], timestamp: Date.now() }],
    }, {
      // 不传 temperature：pi 的每模型元数据里有 supportsTemperature（Claude Opus 4.7+ 拒绝
      // 非默认值），而翻译的确定性不是我们要保的不变量。
    });

    const text = res.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text).join('');

    // 逐值分派，不留「其余当正常」的口子：那样会把 toolUse 的半截输出当完整译文拿去解析。
    switch (res.stopReason) {
      case 'stop': return { text, truncated: false };
      case 'length': return { text, truncated: true };
      case 'error':
      case 'aborted':
      case 'pending':
      case 'toolUse':
        throw new KydogError('llm.invalid', `翻译第 ${a.page} 页失败（stopReason=${res.stopReason}）：${res.errorMessage ?? ''}`);
      default: {
        const never: never = res.stopReason;      // 加了新值 tsc 会在这里红
        throw new KydogError('llm.invalid', `未知的 stopReason: ${String(never)}`);
      }
    }
  });
}
