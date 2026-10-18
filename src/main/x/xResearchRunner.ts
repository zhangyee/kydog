// `x_research` 的工作体（spec §4.3、§5.5）：**一个提交跑一次**，产物是那一份 canonical 结果。
//
// 它搬到 `src/main/x/` 的是旧 `src/main/agent/xResearchTool.ts` 里 `execute` 的主体 —— 只搬
// 「跑完一次提交」这件事：构造采集上下文 → `searchX` / `readX` → 补齐 `collectionStop` →
// 同步任务的标签页 → 序列化 → 工件落盘。以下这些都留在别处：队列与状态（service）、
// 交付（Task 5）、证据账本（交付时喂，spec §4.5）。
import { finalizeXResearchCollection } from './xResearchCanonical';
import { XResearchArtifactError, type XResearchArtifactStore } from './xResearchArtifacts';
import { assertXRequestWithinBounds } from './xResearchBounds';
import type { XResearchScopePrior } from './xResearchScopeFacts';
import { assertXRequestFits, serializeXResearchResult } from './xResearchOutput';
import { readResult, readX } from './xResearchRead';
import { searchResult, searchX, type XResearchContext } from './xResearchSearch';
import type { XResearchBrowser } from './xResearchBrowser';
import type { XResearchRunWork } from './xResearchTaskService';
import type { XResearchInput, XResearchResult, XSourceReference } from './xResearchTypes';

export type XResearchRunnerDeps = {
  /** 这一轮碰的浏览器（per-thread）：标签页归属的判据在它里面。 */
  browserFor(threadId: string): XResearchBrowser;
  /** 采集层要的证据表与范围账本：按 threadId 现取，不在这里缓存。 */
  contextFor(threadId: string): {
    sources: Map<string, XSourceReference[]>;
    scopePrior(runId: string): XResearchScopePrior;
    /** 提交那一轮的 runId（留给提交路径用）：工作体不拿它做门闸 —— 提交时冻结的 `ctx.runId`
     *  才是这份工作的身份，而排到队尾的工作完全可能在该轮结束之后才跑。 */
    currentRunId(): string | null;
  };
  /** 工件根由调用方决定（Task 7 换双根）：runner 只拿一个已经建好的 store。 */
  artifacts(threadId: string, researchRunId: string): XResearchArtifactStore;
};

/** 这一批是不是「一行导航都没提交过、每行都只说 browser.no_tab」：只有这种批允许忘掉死页重跑一次。
 *  两个条件都是必需的：`no_tab` 说的是「这张页不在了」，而「没有已提交的导航」说的是「重放不会
 *  重做任何已经产出的工作」。`foreign` 不是这一类（那张页还在，只是不归这个对话）—— 重试也逃不掉。 */
function recoverableDeadTab(result: XResearchResult): boolean {
  if (result.operation === 'search') {
    return !result.queries.some((row) => row.location?.committedNavigationOutcome)
      && result.queries.every((row) => row.barrier?.reason.endsWith(':browser.no_tab') === true);
  }
  return !result.targets.some((row) => row.location?.committedNavigationOutcome)
    && result.targets.every((row) => row.reason?.endsWith(':browser.no_tab') === true);
}

export function createXResearchRunner(deps: XResearchRunnerDeps): XResearchRunWork {
  return async (work, ctx) => {
    // 与 `assertXRequestFits` 同一类前置拒绝，但排在 `browserFor` 之前：一行都不许导航。
    assertXRequestWithinBounds(work);
    const browser = deps.browserFor(ctx.threadId);
    const session = deps.contextFor(ctx.threadId);
    // prior 与序列化都用**提交那一轮**的 runId：`withCurrent` 发现不属于同一个 run 会当场抛。
    const scopePrior = session.scopePrior(ctx.runId);
    const context: XResearchContext = {
      browser, threadId: ctx.threadId, sources: session.sources,
      runId: ctx.runId, callId: ctx.submitCallId, batchId: ctx.batchId,
      ...(work.budgetPolicy ? { budgetPolicy: work.budgetPolicy } : {}),
      signal: ctx.signal,
      // 进度只是内存事实（R12）：这里收到什么就往上传，绝不因此落盘任何东西。
      onProgress: ctx.onProgress,
    };
    // 一次采集尝试。R81f 让它在「绑定的页已经死了」时再跑一次，所以这两项跟着返回值一起交出去：
    // 后面记标签页时读的必须是**最后那次**尝试的事实。
    const attempt = async (): Promise<{
      result: XResearchResult;
      tabStatus: 'available' | 'foreign' | 'missing' | undefined;
      boundTabId: string | undefined;
    }> => {
      // 任务的标签页（spec §4.3）：读写都落在 `record.browserTabId` 上，于是下一次提交复用同一页。
      const boundTabId = ctx.tabBinding.get();
      const tabStatus = boundTabId === undefined ? undefined : browser.tabStatus?.(boundTabId);
      const input: XResearchInput = 'search' in work
        ? { ...(boundTabId === undefined ? {} : { tabId: boundTabId }), search: work.search }
        // read 的输入类型要求一个 tabId 字符串，而「任务还没有标签页」是真实状态：`''` 是采集层
        // 既有的「没有标签页」写法（`searchResult` 的 `browserTabId: input.tabId ?? ''`，
        // `browser.open` 把空值当作「自己开一个」）。改成前置失败会把「还没开过页」说成源侧失败。
        : { tabId: boundTabId ?? '', read: work.read };
      // 一次放不下的请求在碰浏览器之前就拒绝（旧工具同一处前置校验，也排在标签页判据之前）。
      assertXRequestFits(input.search ? searchResult(input, context) : readResult(input, context), scopePrior);
      if (tabStatus === 'foreign') throw new Error('X research tab belongs to another thread');
      // 标签页在这一轮开始前就没了：不重放一次注定失败的导航，让每一行说清「一次导航都没发生」。
      // 这一批随后会被 `recoverableDeadTab` 认出并重跑一次（见下）。
      const result = tabStatus === 'missing'
        ? input.search ? searchResult(input, context) : readResult(input, context)
        : input.search ? await searchX(input, context) : await readX(input, context);
      if (tabStatus === 'missing') {
        result.status = 'failed';
        for (const row of result.operation === 'search' ? result.queries : result.targets) {
          row.status = 'failed';
          row.stopReason = 'navigation_failed';
          row.barrier = { status: 'failed', reason: 'navigation_failed:browser.no_tab', observationId: null };
          if ('reason' in row) row.reason = 'navigation_failed:browser.no_tab';
        }
      }
      return { result, tabStatus, boundTabId };
    };
    let collected = await attempt();
    // 绑定的标签页死了时恢复旧行为（R81f）：忘掉它，用新页重跑**一次**。判据是「这一批一行导航都没
    // 提交过、而且每一行都只说 browser.no_tab」—— 只有这种批能证明重试只重做那些什么都没产出的工作。
    // `foreign` 不走这条路（那是硬错误，重试也逃不掉），有已提交导航的批也不走（重放会把已经观察到的
    // 事实重新采集一遍）。这就是 R11 删掉、用户现场踩到的那一次恢复：不恢复的话，绑定的页一死，整批
    // 从「13 行成功」变成「13 行全灭」，而采集层完全有能力自己开一张页。
    if (recoverableDeadTab(collected.result)) {
      ctx.tabBinding.set(undefined);
      collected = await attempt();
    }
    const { result, tabStatus, boundTabId } = collected;
    const rows = result.operation === 'search' ? result.queries : result.targets;
    // 每一行都要有结论：序列化靠 `collectionStop` 分辨「采集收尾过」与「中途被砍」。
    for (const row of rows) {
      row.collectionStop ??= {
        status: row.status, stopReason: row.stopReason,
        reason: 'reason' in row ? row.reason : row.barrier?.reason ?? null,
      };
    }
    // 只有真导航过才记标签页：前置失败的那一轮没有标签页可记。
    let tabId = tabStatus === 'missing' ? undefined : boundTabId;
    if (result.browserTabId && rows.some((row) => row.location?.committedNavigationOutcome)) {
      tabId = result.browserTabId;
    }
    const destroyed = result.operation === 'search'
      ? result.queries.some((row) => row.barrier?.reason.endsWith(':browser.no_tab'))
      : result.targets.some((row) => row.reason?.endsWith(':browser.no_tab'));
    if (destroyed && result.browserTabId === tabId) tabId = undefined;
    // 崩溃不是销毁：活注册表才分得清。
    if (tabId && browser.tabStatus?.(tabId) === 'missing') tabId = undefined;
    ctx.tabBinding.set(tabId);
    const canonical = finalizeXResearchCollection(result);
    const delivery = structuredClone(canonical);
    const artifacts = deps.artifacts(ctx.threadId, ctx.researchRunId);
    try {
      delivery.artifact = await artifacts.write(canonical);
      delivery.delivery = {
        truncated: false, omittedObservations: 0, omittedFields: [],
        // 模型会照这个路径去读文件：定位走双根（读得到旧根里的那一份），不能用 `displayPath`。
        artifactPath: await artifacts.locate(delivery.artifact), persistence: 'saved',
      };
    } catch (error) {
      // 落盘失败不改变「读到的东西」：结果照发，只是没有可解析的工件引用（旧工具同一处判据）。
      delete delivery.artifact;
      delivery.delivery = {
        truncated: false, omittedObservations: 0, omittedFields: [],
        artifactPath: null, persistence: 'failed',
        failureCode: error instanceof XResearchArtifactError ? error.code : 'write',
      };
    }
    // 交付出去的就是这一份（旧工具的 `details`，1 MiB 裁剪不变）；工件里留的是完整 canonical。
    return serializeXResearchResult(delivery, scopePrior).result;
  };
}
