// src/main/agent/browserTools.ts
import { Type } from 'typebox';
import { KydogError } from '../../shared/errors';
import type { NavigationObservation } from '../../shared/types';
import { browserService, WALKER_WORLD_ID } from '../browser/browserService';
import { renderDiff, renderSnapshot, wrapPageContent, type AxSnapshot } from '../browser/snapshot';
import {
  validateBatch, flattenActions, resolveTarget, assertTypeAllowed, keyEventsFor,
  type Action,
} from '../browser/actions';
import {
  compileExtractPlan, extractExpression, describeExtractResult, type ExtractResult,
} from '../browser/extract';

type ToolContent = { type: string; [k: string]: unknown };
type ToolResult = { content: ToolContent[]; details?: unknown };

const text = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }] });

/**
 * 标签清单一行，挂在**每个**浏览器工具结果的头部。
 * 这样就不需要一个单独的 browser_tabs 工具 —— 清单总是准的，也不占一个工具位。
 */
function tabsLine(activeId?: string): string {
  const s = browserService.getState();
  if (s.tabs.length === 0) return '标签页: （无）';
  const cur = activeId ?? s.activeTabId;
  return '标签页: ' + s.tabs.map((t) => {
    const host = (() => { try { return new URL(t.url).host; } catch { return t.url || 'about:blank'; } })();
    return `[${t.id}]${t.id === cur ? '*' : ''} ${host}`;
  }).join(' · ');
}

/** 导航结果说人话。三种终态措辞不同，因为模型对它们的处置不同。 */
function describeNav(nav: NavigationObservation): string {
  const o = nav.outcome;
  switch (o.kind) {
    case 'ok':
      return o.httpStatusCode >= 400
        // 403/404 是一次**成功**的导航，页面确实到了、只是内容是拦截页或错误页。
        // 说清状态码，让 skill 的换源规则有协议层依据，而不是去猜页面文案。
        ? `已打开 ${o.finalUrl}，但服务器返回 HTTP ${o.httpStatusCode} —— 页面到了，内容多半是拦截页或错误页。`
        : `已打开 ${o.finalUrl}（HTTP ${o.httpStatusCode}）。`;
    case 'failed':
      return `打不开：${o.errorDesc}（错误码 ${o.errorCode}）。这是网络层的明确拒绝。`;
    case 'download':
      return `这个地址是一个文件（${o.mimeType}，${o.filename}），不是网页。`
        + '本期浏览器不下载文件，已按策略取消。'
        + '如果它是 arXiv / PMC / DOI，把标识符交给 fastpaper download；否则把链接报给用户。';
    case 'timeout':
      return '到时限仍没有明确结果，已停止这次导航。**这与「打不开」不是一回事** —— 我们不知道发生了什么，别据此断定这个源不可用。';
  }
}

// ── browser_open ────────────────────────────────────────────────────────────

const OpenParams = Type.Object({
  url: Type.String({ description: '要打开的网址，必须是 http/https' }),
  tabId: Type.Optional(Type.String({ description: '给了就在这个标签里导航；不给就新开一个' })),
});

const OPEN_DESC = [
  '在内置浏览器里打开一个网址，返回页面快照。',
  '',
  '**同一个源的连续页面请复用一个标签**（把上一次返回的 tabId 传回来），',
  '不要每篇论文都新开一个 —— 标签有上限，而且开多了你自己也理不清。',
  '',
  '返回的快照里每个元素带一个编号。那个编号**只在这一份快照里有效**，',
  '页面一变就全部作废；browser_act 里用它必须同时带上 snapshotId。',
].join('\n');

// ── browser_act ─────────────────────────────────────────────────────────────

const TargetProps = {
  selector: Type.Optional(Type.String({ description: 'CSS 选择器。已探明的剧本用这个' })),
  index: Type.Optional(Type.Number({ description: '快照里的编号。探索时用这个，必须同时给 snapshotId' })),
  snapshotId: Type.Optional(Type.String()),
};

const ActionSchema = Type.Object({
  kind: Type.String({ description: 'click / type / key / scroll / hover / select / extract / wait / repeat' }),
  ...TargetProps,
  text: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  key: Type.Optional(Type.String({ description: 'Enter / Tab / Escape / ArrowDown …' })),
  direction: Type.Optional(Type.String()),
  selectors: Type.Optional(Type.Record(Type.String(), Type.String())),
  until: Type.Optional(Type.Any()),
  timeoutMs: Type.Optional(Type.Number()),
  times: Type.Optional(Type.Number()),
  actions: Type.Optional(Type.Array(Type.Any())),
});

const ActParams = Type.Object({
  tabId: Type.String(),
  actions: Type.Array(ActionSchema, { description: '按顺序执行，出错即停' }),
});

const ACT_DESC = [
  '在一个标签里执行一串动作，自动附带页面变化。',
  '',
  '**一次调用装一串动作**，别一个动作发一次 —— 那是四倍的代价。',
  '典型的检索是：click 搜索框 → type 检索词 → click 提交按钮。',
  '',
  '语义是「尽力顺序执行 + 出错即停」：第 k 个动作失败时，前 k-1 个已经生效了，',
  '返回值会说清停在哪、为什么、页面现在什么样。网页本来就不可回滚。',
  '',
  '定位两种：已探明的剧本用 selector；探索时用 index，且必须带产生它的 snapshotId。',
  '',
  '注意 **Enter 不一定能提交表单**，很多站点要点提交按钮。',
].join('\n');

// ── browser_read ────────────────────────────────────────────────────────────

const ReadParams = Type.Object({ tabId: Type.String() });

const READ_DESC = [
  '读当前页面的正文文本。',
  '',
  '结构化抽取**不在这里** —— 那是 browser_act 的 extract 动作（它能取 href，正文抽取取不到）。',
  '这个工具是给「我要读这篇文章说了什么」用的，不是给「我要这一页 20 条结果的链接」用的。',
].join('\n');

// ── 工厂 ────────────────────────────────────────────────────────────────────

/** run 上下文由 sessionFactory 闭包注入 —— pi 的 ctx 里只有 cwd，没有 KyDog 的 runId。 */
export type BrowserToolDeps = { currentRunId: () => string | null };

export function createBrowserTools(deps: BrowserToolDeps) {
  const withTabs = (body: string, tabId?: string) => text(`${tabsLine(tabId)}\n\n${body}`);

  const openTool = {
    name: 'browser_open',
    label: '打开网页',
    description: OPEN_DESC,
    promptSnippet: 'browser_open — 在内置浏览器里打开一个网址并返回页面快照',
    parameters: OpenParams,
    executionMode: 'sequential' as const,
    async execute(_id: string, params: { url: string; tabId?: string }): Promise<ToolResult> {
      const { tabId, nav } = await browserService.open({
        url: params.url, tabId: params.tabId, ownerRunId: deps.currentRunId(),
      });
      const parts = [describeNav(nav)];
      // 只有真的到了一个页面才取快照。拿不到内容的时候硬取，只会给一份空快照，
      // 让模型以为「这个页面什么都没有」——而事实是它压根没打开。
      if (nav.outcome.kind === 'ok') {
        const snap = await browserService.snapshot(tabId);
        const r = renderSnapshot(snap);
        parts.push('', `快照 ${snap.snapshotId} · ${snap.title}`, r.text);
      }
      return { ...withTabs(parts.join('\n'), tabId), details: { tabId, nav } };
    },
  };

  const actTool = {
    name: 'browser_act',
    label: '操作网页',
    description: ACT_DESC,
    promptSnippet: 'browser_act — 在网页上执行一串动作（点击/输入/翻页/抽取），自动附带页面变化',
    parameters: ActParams,
    executionMode: 'sequential' as const,
    async execute(_id: string, params: { tabId: string; actions: Action[] }, signal?: AbortSignal): Promise<ToolResult> {
      const before: AxSnapshot | null = browserService.getSnapshot(params.tabId);
      validateBatch(params.actions);
      const steps = flattenActions(params.actions);

      const rows: string[] = [];
      const collected: unknown[] = [];
      let stoppedAt: string | null = null;

      for (const step of steps) {
        if (signal?.aborted) { stoppedAt = `${step.label}：用户中止`; break; }
        try {
          const line = await runStep(params.tabId, step.action, collected);
          rows.push(`${step.label}：${line}`);
        } catch (err) {
          const msg = err instanceof KydogError ? err.message : String(err);
          stoppedAt = `${step.label}失败：${msg}`;
          break;
        }
      }

      const after = await browserService.snapshot(params.tabId);
      const diff = renderDiff(before, after);
      const parts = [...rows];
      // 出错即停，但**已经抽到的数据全部返回** —— 翻到最后一页时 click 找不到「下一页」
      // 是预期行为，前几轮的结果不该跟着一起丢。
      if (stoppedAt) parts.push('', `⚠ ${stoppedAt}`, '（此前的动作已经生效，网页不可回滚）');
      if (collected.length) {
        parts.push('', `抽到 ${collected.length} 条：`, wrapPageContent(JSON.stringify(collected, null, 1)));
      }
      parts.push('', `── 页面变化（快照 ${after.snapshotId}）──`, diff.text);
      return { ...withTabs(parts.join('\n'), params.tabId), details: { snapshotId: after.snapshotId, stopped: stoppedAt } };
    },
  };

  const readTool = {
    name: 'browser_read',
    label: '读网页正文',
    description: READ_DESC,
    promptSnippet: 'browser_read — 读当前网页的正文文本',
    parameters: ReadParams,
    executionMode: 'sequential' as const,
    async execute(_id: string, params: { tabId: string }): Promise<ToolResult> {
      const wc = browserService.webContentsOf(params.tabId);
      if (!wc) throw new KydogError('browser.no_tab', `没有这个标签页：${params.tabId}`);
      const body = await wc.executeJavaScript(
        '(() => { const m = document.querySelector("main,article"); '
        + 'return (m || document.body).innerText.slice(0, 20000); })()',
      ) as string;
      return withTabs(wrapPageContent(body), params.tabId);
    },
  };

  return [openTool, actTool, readTool];
}

/** 执行一个动作，返回一句给模型看的说明。真正碰页面的部分都在这里。 */
async function runStep(tabId: string, action: Action, collected: unknown[]): Promise<string> {
  const wc = browserService.webContentsOf(tabId);
  if (!wc) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);

  switch (action.kind) {
    case 'key': {
      for (const ev of keyEventsFor(action.key)) {
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', ev);
      }
      return `按下 ${action.key}`;
    }
    case 'extract': {
      const plan = compileExtractPlan(action.selectors);
      // 跑在 walker 那个**隔离世界**里，不是主世界：页面覆写 `document.querySelectorAll`
      // 骗得到主世界、骗不到这里（2026-09-08 spike 实测）。抽取结果是结构化的、
      // 模型会当事实用 —— 一份伪造的「20 条论文」比一份伪造的快照更难被察觉。
      const res = await wc.executeJavaScriptInIsolatedWorld(
        WALKER_WORLD_ID, [{ code: extractExpression(plan) }],
      ) as ExtractResult;
      collected.push(...res.rows);
      return describeExtractResult(res);
    }
    default: {
      const target = resolveTarget(action as never, browserService.getSnapshot(tabId));
      if (action.kind === 'type') assertTypeAllowed(target);
      return `${action.kind} → ${target.kind === 'selector' ? target.selector : `#${target.nodeId}`}`;
    }
  }
}
