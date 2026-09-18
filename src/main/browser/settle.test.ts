import { describe, it, expect } from 'vitest';
import { NavigationTracker } from './settle';
import { checkUrl } from './urlGuard';

const t = (id = 'n1', target: string | null = null) => new NavigationTracker(id, target);

/** 收尾用的 stop 计数器。被取代的观测**绝不能**执行它 —— 那会掐掉接替它的那一次导航。 */
function stopSpy(): { fn: () => void; calls: number } {
  const s = { fn: () => { s.calls += 1; }, calls: 0 };
  return s;
}

describe('导航观测：403 是一次成功的导航', () => {
  // 这条是 2026-09-07 侦察逼出来的：Google Scholar 的搜索端点返回 403，
  // did-fail-load 根本不触发，只有 did-navigate 的 httpResponseCode 看得见它。
  // 报成 failed 或 timeout 都会让 skill 的换源规则拿错依据。
  it('did-navigate 带 403 → ok + httpStatusCode 403', () => {
    const n = t();
    n.onDidNavigate('https://scholar.google.com/scholar?q=x', 403);
    expect(n.observation()).toEqual({
      navigationId: 'n1',
      outcome: { kind: 'ok', finalUrl: 'https://scholar.google.com/scholar?q=x', httpStatusCode: 403 },
    });
  });

  it('did-navigate 带 200 → ok + 200', () => {
    const n = t();
    n.onDidNavigate('https://example.com/', 200);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok', httpStatusCode: 200 });
  });
});

describe('导航观测：failed 与 timeout 不合并', () => {
  it('主 frame 的 did-fail-load → failed，errorCode 是 number', () => {
    const n = t();
    n.onDidFailLoad(-105, 'ERR_NAME_NOT_RESOLVED', true);
    expect(n.observation()!.outcome).toEqual({ kind: 'failed', errorCode: -105, errorDesc: 'ERR_NAME_NOT_RESOLVED' });
  });

  // 子 frame 失败是常态（广告位、统计脚本），拿它当整页失败会让 agent 无谓换源。
  it('子 frame 的 did-fail-load 被忽略', () => {
    const n = t();
    n.onDidFailLoad(-105, 'ERR_NAME_NOT_RESOLVED', false);
    expect(n.observation()).toBeNull();
  });

  it('超时 → timeout，不是 failed', () => {
    const n = t();
    n.onTimeout(stopSpy().fn);
    expect(n.observation()!.outcome).toEqual({ kind: 'timeout', abortObserved: false });
  });

  it('超时之后迟到的 did-navigate 一律丢弃 —— 否则会覆盖已经上报的结论', () => {
    const n = t();
    n.onTimeout(stopSpy().fn);
    n.onDidNavigate('https://late.example/', 200);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'timeout' });
  });

  it('已经定了的观测不会被后续事件改写', () => {
    const n = t();
    n.onDidNavigate('https://a/', 200);
    n.onDidFailLoad(-105, 'X', true);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok' });
  });
});

// ── A · 同页导航（hash / pushState）一个 did-navigate 都不来 ────────────────
describe('导航观测：同文档导航是一个明确的成功终态', () => {
  it('活目标上的默认链接意图在输入前留下事实，并按同/跨文档分别收敛', () => {
    const cross = t();
    expect(cross.inputNavigationExpected).toBe(false);
    cross.onInputNavigationCandidate('https://x.example/next', false);
    expect(cross.inputNavigationExpected).toBe(true);
    expect(cross.mainFrameNavigationStarted).toBe(true);
    cross.onDidNavigate('https://x.example/next', 200);
    expect(cross.observation()?.outcome).toMatchObject({ kind: 'ok' });

    const same = t();
    same.onInputNavigationCandidate('https://x.example/p#sec2', true);
    same.onDidNavigateInPage('https://x.example/p#sec2', true);
    expect(same.observation()?.outcome).toMatchObject({ kind: 'ok_same_document' });
  });

  it('主 frame 的导航启动会留下明确事实；子 frame 不会冒充', () => {
    const n = t();
    expect(n.mainFrameNavigationStarted).toBe(false);
    n.onDidStartNavigation('https://frame.example/', false, false);
    expect(n.mainFrameNavigationStarted).toBe(false);
    n.onDidStartNavigation('https://x.example/p#sec2', true, true);
    expect(n.mainFrameNavigationStarted).toBe(true);
  });

  it('will-navigate 在 did-start 之前就留下主 frame 导航事实；子 frame 不会冒充', () => {
    const n = t();
    n.onWillNavigate('https://frame.example/', false);
    expect(n.mainFrameNavigationStarted).toBe(false);
    n.onWillNavigate('https://x.example/next', true);
    expect(n.mainFrameNavigationStarted).toBe(true);
    n.onWillDownload('https://x.example/next', 'application/pdf', 'next.pdf');
    expect(n.observation()?.outcome).toMatchObject({ kind: 'download', filename: 'next.pdf' });
  });

  // 同文档导航既不触发 did-navigate 也不触发 did-fail-load。没有这个输入，
  // browser_open('https://x/p#sec2') 会跑满整个超时窗口再报 timeout ——
  // 而那次导航其实瞬间就成了。SPA 路由跳转（CNKI 站内大量如此）同样落这条。
  it('did-navigate-in-page → ok_same_document，不是 timeout', () => {
    const n = t();
    n.onDidNavigateInPage('https://x.example/p#sec2', true);
    expect(n.observation()).toEqual({
      navigationId: 'n1',
      outcome: { kind: 'ok_same_document', finalUrl: 'https://x.example/p#sec2' },
    });
  });

  // 跨文档与同文档对下游不是一回事：跨文档 DOM 全换、快照身份要重发号，
  // 同文档 DOM 大体还在。抹平成同一个 kind 就等于把这个协议事实丢了。
  it('同文档终态与跨文档终态不是同一个 kind', () => {
    const cross = t(); cross.onDidNavigate('https://x.example/p', 200);
    const same = t(); same.onDidNavigateInPage('https://x.example/p#sec2', true);
    expect(same.observation()!.outcome.kind).not.toBe(cross.observation()!.outcome.kind);
  });

  // did-navigate-in-page 也会为子 frame 触发（广告位里的 hash 跳转）。
  // 按 did-fail-load 那条的做法挡掉，否则一个广告 frame 就能替整页定论。
  it('子 frame 的 did-navigate-in-page 被忽略', () => {
    const n = t();
    n.onDidNavigateInPage('https://ads.example/x#y', false);
    expect(n.observation()).toBeNull();
  });

  it('同文档定论之后迟到的 did-navigate 不改写结论', () => {
    const n = t();
    n.onDidNavigateInPage('https://x.example/p#sec2', true);
    n.onDidNavigate('https://late.example/', 200);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok_same_document' });
  });
});

// ── A（续）· 跨文档导航在途时到达的同文档事件属于**旧文档** ────────────────
//
// 失败序列（全在主 frame）：browser_open 打 publisher/article →
// did-start-navigation(publisher/article, isSameDocument=false) → 新文档还没 commit，
// 旧文档跑了一次 replaceState → did-navigate-in-page(old.example/list) →
// 定论成 ok_same_document，地址是**旧页面**的、「文档换没换」的判断还是反的。
// 随后真正的 did-navigate 被先到先得丢弃。
//
// 判据不是 URL 相等（点击发起的同文档导航根本没有已知目标），而是
// did-start-navigation 自带的 isSameDocument —— 协议层现成的信号。
describe('导航观测：跨文档导航在途时，同文档事件不定论', () => {
  it('跨文档在途时到达的 did-navigate-in-page 不定论，真正的 did-navigate 照常收敛', () => {
    const n = t('n1', 'https://publisher.example/article');
    n.onDidStartNavigation('https://publisher.example/article', true, false);
    n.onDidNavigateInPage('https://old.example/list?utm_source=x', true);
    expect(n.observation()).toBeNull();
    n.onDidNavigate('https://publisher.example/article', 200);
    expect(n.observation()!.outcome).toEqual({
      kind: 'ok', finalUrl: 'https://publisher.example/article', httpStatusCode: 200,
    });
  });

  // 挡的是「跨文档在途」这个窗口，不是「同文档」这件事本身：目标就是 #sec2 那种
  // 同文档导航时 isSameDocument 为 true，一个事件都不会被挡掉。
  it('目标本身就是同文档导航时照常定论 —— 最常见的那条路不受影响', () => {
    const n = t('n1', 'https://x.example/p#sec2');
    n.onDidStartNavigation('https://x.example/p#sec2', true, true);
    n.onDidNavigateInPage('https://x.example/p#sec2', true);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok_same_document' });
  });

  // 点击发起的同文档导航（站内路由）压根没有 did-start-navigation 先到的保证，
  // 没观测到跨文档在途就不许拿它去挡 —— 那会把最常见的那条路重新推回超时。
  it('没有观测到跨文档在途时，同文档事件照常定论', () => {
    const n = t('n1', null);
    n.onDidNavigateInPage('https://x.example/p#sec2', true);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok_same_document' });
  });

  it('子 frame 的跨文档 did-start-navigation 不构成「本次导航在途」', () => {
    const n = t('n1', null);
    n.onDidStartNavigation('https://ads.example/x', false, false);
    n.onDidNavigateInPage('https://x.example/p#sec2', true);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok_same_document' });
  });

  // 旧文档可以连着改好几次 history —— 挡的是整个在途窗口，不是只挡第一次。
  it('跨文档在途时旧文档连续多次同文档跳转都不定论', () => {
    const n = t('n1', 'https://publisher.example/article');
    n.onDidStartNavigation('https://publisher.example/article', true, false);
    n.onDidNavigateInPage('https://old.example/list?p=1', true);
    n.onDidNavigateInPage('https://old.example/list?p=2', true);
    expect(n.observation()).toBeNull();
  });

  // 上面几条用的都是简化序列（只有 did-navigate-in-page）。**真实的 pushState 必然
  // 先发一个同文档的 did-start-navigation**，再发 did-navigate-in-page —— 少了这一步，
  // 「crossDocumentPending 不清零」这个不变式就没有任何用例钉住：把同文档那一支改成
  // 顺手清零，上面几条照样全绿，而它正是「旧文档的 replaceState 冒充本次导航结果」
  // 那条 Critical 的守卫。守卫本身没人守，等于那条 Critical 随时可以悄悄回来。
  it('跨文档在途时，旧文档一次完整的 pushState（同文档 did-start-navigation + did-navigate-in-page）仍不定论', () => {
    const n = t('n1', 'https://publisher.example/article');
    n.onDidStartNavigation('https://publisher.example/article', true, false);
    n.onDidStartNavigation('https://old.example/list?p=2', true, true);
    n.onDidNavigateInPage('https://old.example/list?p=2', true);
    expect(n.observation()).toBeNull();
    // 而本次跨文档导航自己的结果照常收敛，指向的是新地址不是旧文档那个
    n.onDidNavigate('https://publisher.example/article', 200);
    expect(n.observation()!.outcome).toEqual({
      kind: 'ok', finalUrl: 'https://publisher.example/article', httpStatusCode: 200,
    });
  });

  // 旧文档的 pushState 也不该把本次导航真正的失败盖掉。
  it('跨文档在途时旧文档的同文档跳转之后，本次导航的失败仍然报得出来', () => {
    const n = t('n1', 'https://publisher.example/article');
    n.onDidStartNavigation('https://publisher.example/article', true, false);
    n.onDidNavigateInPage('https://old.example/list', true);
    n.onDidFailLoad(-105, 'ERR_NAME_NOT_RESOLVED', true);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'failed', errorCode: -105 });
  });
});

// ── B · 被另一次导航取代 ───────────────────────────────────────────────────
describe('导航观测：被取代的观测说得清，而且绝不 stop', () => {
  it('onSuperseded → superseded，不是 timeout', () => {
    const n = t();
    n.onSuperseded();
    expect(n.observation()).toEqual({ navigationId: 'n1', outcome: { kind: 'superseded' } });
  });

  // 这条是 B 的核心：旧 tracker 到点收尾时若还去 stop()，掐掉的是**接替它的
  // 那一次导航**（用户点的刷新）。两次导航都错，日志里还看不出原因。
  it('被取代之后的超时收尾不执行 stop', () => {
    const n = t();
    const s = stopSpy();
    n.onSuperseded();
    n.onTimeout(s.fn);
    expect(s.calls).toBe(0);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'superseded' });
  });

  it('未定论时的超时收尾执行 stop 恰好一次，并定论为 timeout', () => {
    const n = t();
    const s = stopSpy();
    n.onTimeout(s.fn);
    expect(s.calls).toBe(1);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'timeout' });
  });

  // 已经成了的导航更不能 stop：那会打断还在加载的子资源。
  it('已定论为 ok 之后的超时收尾也不执行 stop', () => {
    const n = t();
    const s = stopSpy();
    n.onDidNavigate('https://a/', 200);
    n.onTimeout(s.fn);
    expect(s.calls).toBe(0);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok' });
  });

  it('被取代之后迟到的事件不改写结论', () => {
    const n = t();
    n.onSuperseded();
    n.onDidFailLoad(-3, 'ERR_ABORTED', true);
    n.onDidNavigate('https://late/', 200);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'superseded' });
  });

  // 反向也要守：第六批是在同一个标签上换 tracker 时调 onSuperseded 的，那时旧的
  // 可能**已经成了**。让「被取代」盖掉一个已经拿到的 ok，等于把成功的导航报成没结果。
  it('已定论的观测不会被 onSuperseded 改写', () => {
    const n = t();
    n.onDidNavigate('https://a/', 200);
    n.onSuperseded();
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok' });
  });

  it('superseded 也兑现 settledPromise —— 调用方不必等满时限', async () => {
    const n = t();
    let done = false;
    void n.settledPromise.then(() => { done = true; });
    n.onSuperseded();
    await n.settledPromise;
    expect(done).toBe(true);
  });
});

// ── B（续）· 「被取消」：标签在观测在途时被销毁 ─────────────────────────────
//
// 与「被取代」是同一个形状：我们**明确知道**发生了什么（标签被关了 / run 的浏览器
// 被回收），却只能白等满一个时限，再给出「我们不知道发生了什么」这个错的四分类。
// 语义上不复用 superseded —— 那是「被另一次导航接替了，页面状态由那一次决定」，
// 而这里根本没有页面了。
describe('导航观测：标签被销毁是一个明确的终态', () => {
  it('onCancelled → cancelled，不是 timeout', () => {
    const n = t();
    n.onCancelled();
    expect(n.observation()).toEqual({ navigationId: 'n1', outcome: { kind: 'cancelled' } });
  });

  it('被取消与被取代不是同一个 kind', () => {
    const a = t(); a.onCancelled();
    const b = t(); b.onSuperseded();
    expect(a.observation()!.outcome.kind).not.toBe(b.observation()!.outcome.kind);
  });

  // webContents 已经销毁了，stop 无从谈起；更要紧的是它不该被当成「还要收尾」。
  it('被取消之后的超时收尾不执行 stop', () => {
    const n = t();
    const s = stopSpy();
    n.onCancelled();
    n.onTimeout(s.fn);
    expect(s.calls).toBe(0);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'cancelled' });
  });

  it('已定论的观测不会被 onCancelled 改写', () => {
    const n = t();
    n.onDidNavigate('https://a/', 200);
    n.onCancelled();
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok' });
  });

  it('cancelled 也兑现 settledPromise —— 调用方不必等满时限', async () => {
    const n = t();
    let done = false;
    void n.settledPromise.then(() => { done = true; });
    n.onCancelled();
    await n.settledPromise;
    expect(done).toBe(true);
  });
});

// ── C · 被我们自己的 URL 闸拦下 ────────────────────────────────────────────
describe('导航观测：被 URL 闸拦下是一个明确的终态', () => {
  // 我们明确知道发生了什么：是我们自己按 §5.1 挡的。报 timeout 等于让 agent
  // 白等一个超时窗口，还拿到「不知道发生了什么」这个错的四分类。
  it('onBlocked → blocked + 闸给的理由，不是 timeout', () => {
    const v = checkUrl('http://192.168.1.1/admin');
    expect(v.ok).toBe(false);
    if (v.ok) return;
    const n = t();
    n.onBlocked(v, true);
    expect(n.observation()!.outcome).toEqual({ kind: 'blocked', reason: v.reason });
  });

  // 广告 iframe 302 到内网地址被闸拦下，是**子 frame** 的事。让它替整页定论，
  // 模型收到的是「不是源不可用，换一个公网地址再试」，而文章其实已经整篇在屏幕上了。
  // did-fail-load / did-navigate-in-page / did-start-navigation 三条都有这个挡截，
  // 这条不能只写在注释里指望调用方记得。
  it('子 frame 被闸拦下不能替整页定论', () => {
    const v = checkUrl('http://10.0.0.5/px');
    expect(v.ok).toBe(false);
    if (v.ok) return;
    const n = t('n1', 'https://publisher.example/article');
    n.onBlocked(v, false);
    expect(n.observation()).toBeNull();
    n.onDidNavigate('https://publisher.example/article', 200);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok', httpStatusCode: 200 });
  });

  // 第二批的约定：含凭据的原始 URL 不进日志也不进模型上下文。这里只收 urlGuard
  // 给的 verdict（它的 reason 只带主机名，从不回显原串），不收调用方自拼的字符串。
  it('拦下的理由里不含原始网址的路径与查询串', () => {
    const v = checkUrl('https://10.0.0.1/secret-path?token=SECRET');
    expect(v.ok).toBe(false);
    if (v.ok) return;
    const n = t();
    n.onBlocked(v, true);
    const dumped = JSON.stringify(n.observation());
    expect(dumped).not.toContain('SECRET');
    expect(dumped).not.toContain('secret-path');
    expect(dumped).toContain('10.0.0.1');
  });

  // 反方向也要守：闸装在每一条入口上，一次导航成了之后页面自己再发起的请求
  // 照样会过 checkUrl。让迟到的 blocked 盖掉一个已经拿到的 ok，等于把一次
  // 成功的导航报成「被我们自己挡下了」。
  it('已定论的观测不会被 onBlocked 改写', () => {
    const v = checkUrl('http://10.0.0.5/px');
    if (v.ok) return;
    const n = t();
    n.onDidNavigate('https://publisher.example/article', 200);
    n.onBlocked(v, true);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok' });
  });

  // preventDefault 之后主 frame 会收到 ERR_ABORTED。先到的 blocked 说得更清楚。
  it('拦下之后到达的 ERR_ABORTED 不改写结论', () => {
    const v = checkUrl('http://127.0.0.1:8080/');
    if (v.ok) return;
    const n = t();
    n.onBlocked(v, true);
    n.onDidFailLoad(-3, 'ERR_ABORTED', true);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'blocked' });
  });
});

// ── E · 崩溃不再借用 ERR_FAILED(-2) ────────────────────────────────────────
describe('导航观测：崩溃与网络失败是两个终态', () => {
  it('render-process-gone → crashed + reason', () => {
    const n = t();
    n.onCrashed('oom');
    expect(n.observation()!.outcome).toEqual({ kind: 'crashed', reason: 'oom' });
  });

  // 借 -2 的话，「渲染进程崩了、重试一次可能就好」与「网络层 ERR_FAILED、该换源」
  // 只能靠 errorDesc 里的中文前缀区分 —— 那是拿文案当协议事实。
  it('崩溃与真正的 ERR_FAILED(-2) 不是同一个 kind', () => {
    const crash = t(); crash.onCrashed('crashed');
    const failed = t(); failed.onDidFailLoad(-2, 'ERR_FAILED', true);
    expect(crash.observation()!.outcome.kind).toBe('crashed');
    expect(failed.observation()!.outcome).toEqual({ kind: 'failed', errorCode: -2, errorDesc: 'ERR_FAILED' });
    expect(crash.observation()!.outcome.kind).not.toBe(failed.observation()!.outcome.kind);
  });

  it('崩溃当场定论，不挂满超时窗口', () => {
    const n = t();
    n.onCrashed('killed');
    expect(n.settled).toBe(true);
  });

  it('已定论后再崩溃不改写结论', () => {
    const n = t();
    n.onDidNavigate('https://a/', 200);
    n.onCrashed('oom');
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok' });
  });
});

// ── F · 下载必须与「这一次导航」对得上 ─────────────────────────────────────
describe('导航观测：变成下载', () => {
  // 一期一律取消下载，但必须如实报成 download。不然打一个 PDF 直链只会得到
  // timeout，agent 会据此判断源不可达并换源 —— 而它其实找到了文件。
  it('下载 URL 与本次导航的目标一致 → download，并标明是被策略取消的', () => {
    const n = t('n1', 'https://arxiv.org/pdf/2210.02747');
    n.onWillDownload('https://arxiv.org/pdf/2210.02747', 'application/pdf', '2210.02747.pdf', ['https://arxiv.org/pdf/2210.02747']);
    expect(n.observation()!.outcome).toEqual({
      kind: 'download', url: 'https://arxiv.org/pdf/2210.02747',
      mimeType: 'application/pdf', filename: '2210.02747.pdf', cancelled: 'policy',
    });
  });

  // 会话级的 will-download 与「这一次导航」本来没有任何关联：页面 JS 或一个广告
  // frame 自发拉起的下载会把观测锁成 download，随后真正的 did-navigate 被先到先得
  // 丢弃 —— 模型于是把一个广告文件名当成论文 PDF 报给用户。
  it('与本次导航对不上的下载不定论，真正的 did-navigate 照常收敛', () => {
    const n = t('n1', 'https://cnki.net/article/1');
    n.onWillDownload('https://ads.example/ad.pdf', 'application/pdf', 'ad.pdf', ['https://ads.example/ad.pdf']);
    expect(n.observation()).toBeNull();
    n.onDidNavigate('https://cnki.net/article/1', 200);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok' });
  });

  // 重定向：download 的 URL 链含最初请求的那个（chain[0]），对上就是本次导航。
  it('经重定向落到别处的下载，靠 URL 链对上本次导航', () => {
    const n = t('n1', 'https://doi.org/10.1/x');
    n.onWillDownload('https://publisher.example/f.pdf', 'application/pdf', 'f.pdf', ['https://doi.org/10.1/x', 'https://publisher.example/f.pdf']);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'download', filename: 'f.pdf' });
  });

  // 目标是点击出来的（browser_act 点 Scholar 的 [PDF]），构造时压根不知道要去哪 ——
  // did-start-navigation 是主 frame 真正请求了哪个 URL 的协议事实。
  it('点击发起的导航靠 did-start-navigation 对上下载', () => {
    const n = t('n1', null);
    n.onDidStartNavigation('https://x.example/paper.pdf', true, false);
    n.onWillDownload('https://x.example/paper.pdf', 'application/pdf', 'paper.pdf', ['https://x.example/paper.pdf']);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'download', filename: 'paper.pdf' });
  });

  // 子 frame 的 did-start-navigation 不进关联集合：否则一个广告 iframe 只要先
  // 导航到某个 URL，它自己拉起的下载就能冒充本次导航的终态。
  it('子 frame 的 did-start-navigation 不能让下载对上', () => {
    const n = t('n1', null);
    n.onDidStartNavigation('https://ads.example/ad.pdf', false, false);
    n.onWillDownload('https://ads.example/ad.pdf', 'application/pdf', 'ad.pdf', ['https://ads.example/ad.pdf']);
    expect(n.observation()).toBeNull();
  });

  // 一点关联依据都没有（既没给目标，也没有 did-start-navigation）时不许定论 ——
  // 猜错的代价是把一个无关文件报成「这个地址是一个文件」。
  it('没有任何关联依据时下载不定论', () => {
    const n = t('n1', null);
    n.onWillDownload('https://x/f.pdf', 'application/pdf', 'f.pdf', ['https://x/f.pdf']);
    expect(n.observation()).toBeNull();
  });

  // fragment 不上网 —— DownloadItem 的 getURL() / getURLChain() 一律不带它。
  // 目标带 fragment 就永远对不上自己的下载，白等一个时限。去掉 fragment 是
  // URL 标准定义的等价规范化的一部分，不是近似匹配。
  it('目标带 fragment 时仍与自己的下载对得上', () => {
    const n = t('n1', 'https://x.example/paper.pdf#page=3');
    n.onWillDownload('https://x.example/paper.pdf', 'application/pdf', 'paper.pdf', ['https://x.example/paper.pdf']);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'download', filename: 'paper.pdf' });
  });

  // 同文档导航压根不发请求，它的 URL 不该进「本次导航请求过的 URL」——
  // 否则一次 pushState 到 /f.pdf 就能让一个无关下载冒充本次导航的终态。
  it('同文档的 did-start-navigation 不能让下载对上', () => {
    const n = t('n1', null);
    n.onDidStartNavigation('https://x.example/f.pdf', true, true);
    n.onWillDownload('https://x.example/f.pdf', 'application/pdf', 'f.pdf', ['https://x.example/f.pdf']);
    expect(n.observation()).toBeNull();
  });

  // 大小写、默认端口这类差异是 WHATWG 规范化定义的**等价**，不是近似匹配。
  it('URL 只在规范化层面不同（主机大小写 / 默认端口）仍然对得上', () => {
    const n = t('n1', 'https://X.EXAMPLE:443/f.pdf');
    n.onWillDownload('https://x.example/f.pdf', 'application/pdf', 'f.pdf', ['https://x.example/f.pdf']);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'download' });
  });

  // 第六批接线之前的旧调用点只给三个参数（没有 URL 链）。那种形状下只比 url 本身，
  // 不许因为少了一个参数就整条路不定论。
  it('不给 urlChain 时只比 url 本身', () => {
    const n = t('n1', 'https://x/f.pdf');
    n.onWillDownload('https://x/f.pdf', 'application/pdf', 'f.pdf');
    expect(n.observation()!.outcome).toMatchObject({ kind: 'download' });
  });

  // Chromium 在导航被下载接管时会给主 frame 发一个 ERR_ABORTED(-3)。
  // 它先到、后到都不该改写结论。
  it('下载之后到达的 ERR_ABORTED 不会把它改写成 failed', () => {
    const n = t('n1', 'https://x/f.pdf');
    n.onWillDownload('https://x/f.pdf', 'application/pdf', 'f.pdf', ['https://x/f.pdf']);
    n.onDidFailLoad(-3, 'ERR_ABORTED', true);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'download' });
  });

  // 反过来：-3 先到、下载后到，结论也该是 download。ERR_ABORTED 本身信息量极低
  // （用户点了停止、被下载接管、被新导航取代都会给它），单独看它不该定论。
  it('ERR_ABORTED 先到、下载后到，结论仍是 download', () => {
    const n = t('n1', 'https://x/f.pdf');
    n.onDidFailLoad(-3, 'ERR_ABORTED', true);
    expect(n.observation()).toBeNull();
    n.onWillDownload('https://x/f.pdf', 'application/pdf', 'f.pdf', ['https://x/f.pdf']);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'download' });
  });
});

// ── D · 观测到的 ERR_ABORTED 不再被丢掉 ────────────────────────────────────
describe('导航观测：超时如实带上观测到的中断', () => {
  // 从前 onTimeout 把观测到的 ERR_ABORTED 整个丢掉，工具最后只说「不知道发生了
  // 什么」。「主 frame 被中断过一次」是协议事实，收尾时要带上。
  it('只有主 frame 的 ERR_ABORTED → 超时定论 timeout + abortObserved true', () => {
    const n = t();
    n.onDidFailLoad(-3, 'ERR_ABORTED', true);
    expect(n.observation()).toBeNull();
    n.onTimeout(stopSpy().fn);
    expect(n.observation()!.outcome).toEqual({ kind: 'timeout', abortObserved: true });
  });

  it('什么都没来的超时 → abortObserved false', () => {
    const n = t();
    n.onTimeout(stopSpy().fn);
    expect(n.observation()!.outcome).toEqual({ kind: 'timeout', abortObserved: false });
  });

  // 「该不该 stop」的判断收进了 onTimeout，那 stop 本身就必须是**必填**的：
  // 可选参数会让「调用方忘了传」变成一次静默失效 —— 一次真超时的导航永远不被停止，
  // 页面继续加载，而工具已经报了 timeout 让 agent 换源。这条约束靠类型守，
  // 不靠注释：下面这行少一个参数就是 TS2554，`npx tsc --noEmit` 会红。
  it('onTimeout 的 stop 是必填 —— 忘传是编译错误，不是静默失效', () => {
    // 这个闭包**不执行**，它钉的是类型：@ts-expect-error 要求这一行真的编译错误，
    // 参数一旦改回可选，`npx tsc --noEmit` 立刻红（TS2578：未使用的抑制注释）。
    const forgetsStop = () => {
      // @ts-expect-error onTimeout 的 stop 是必填参数
      t().onTimeout();
    };
    expect(typeof forgetsStop).toBe('function');

    const n = t();
    const s = stopSpy();
    n.onTimeout(s.fn);
    expect(s.calls).toBe(1);
    expect(n.observation()!.outcome).toEqual({ kind: 'timeout', abortObserved: false });
  });

  it('子 frame 的 ERR_ABORTED 不算作观测到中断', () => {
    const n = t();
    n.onDidFailLoad(-3, 'ERR_ABORTED', false);
    n.onTimeout(stopSpy().fn);
    expect(n.observation()!.outcome).toEqual({ kind: 'timeout', abortObserved: false });
  });
});

// ── G · 「根本不来事件」这一类 ─────────────────────────────────────────────
describe('导航观测：一个终态事件都不来', () => {
  it('只有 did-start-navigation：停在未定论，超时收尾报 timeout 并 stop 一次', () => {
    const n = t('n1', 'https://slow.example/');
    const s = stopSpy();
    n.onDidStartNavigation('https://slow.example/', true, false);
    expect(n.observation()).toBeNull();
    expect(n.settled).toBe(false);
    n.onTimeout(s.fn);
    expect(s.calls).toBe(1);
    expect(n.observation()).toEqual({ navigationId: 'n1', outcome: { kind: 'timeout', abortObserved: false } });
  });

  it('全程只有子 frame 的事件：停在未定论', () => {
    const n = t('n1', 'https://slow.example/');
    n.onDidStartNavigation('https://ads.example/', false, false);
    n.onDidNavigateInPage('https://ads.example/#x', false);
    n.onDidFailLoad(-105, 'ERR_NAME_NOT_RESOLVED', false);
    expect(n.observation()).toBeNull();
  });

  it('只有一个对不上的下载：停在未定论', () => {
    const n = t('n1', 'https://slow.example/');
    n.onWillDownload('https://ads.example/ad.pdf', 'application/pdf', 'ad.pdf', ['https://ads.example/ad.pdf']);
    expect(n.observation()).toBeNull();
    expect(n.settled).toBe(false);
  });
});

describe('settled 标志', () => {
  it('未定论时 settled 为 false', () => {
    expect(t().settled).toBe(false);
  });
  it('定论后 settled 为 true', () => {
    const n = t(); n.onDidNavigate('https://a/', 200);
    expect(n.settled).toBe(true);
  });
  it('settledPromise 在定论时兑现 —— 调用方等它而不是轮询', async () => {
    const n = t();
    let done = false;
    void n.settledPromise.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    n.onDidNavigate('https://a/', 200);
    await n.settledPromise;
    expect(done).toBe(true);
  });
});
