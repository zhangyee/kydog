import { describe, it, expect } from 'vitest';
import { NavigationTracker } from './settle';

const t = (id = 'n1') => new NavigationTracker(id);

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
    n.onTimeout();
    expect(n.observation()!.outcome).toEqual({ kind: 'timeout' });
  });

  it('超时之后迟到的 did-navigate 一律丢弃 —— 否则会覆盖已经上报的结论', () => {
    const n = t();
    n.onTimeout();
    n.onDidNavigate('https://late.example/', 200);
    expect(n.observation()!.outcome).toEqual({ kind: 'timeout' });
  });

  it('已经定了的观测不会被后续事件改写', () => {
    const n = t();
    n.onDidNavigate('https://a/', 200);
    n.onDidFailLoad(-105, 'X', true);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok' });
  });
});

describe('导航观测：变成下载', () => {
  // 一期一律取消下载，但必须如实报成 download。不然打一个 PDF 直链只会得到
  // timeout，agent 会据此判断源不可达并换源 —— 而它其实找到了文件。
  it('will-download → download，并标明是被策略取消的', () => {
    const n = t();
    n.onWillDownload('https://arxiv.org/pdf/2210.02747', 'application/pdf', '2210.02747.pdf');
    expect(n.observation()!.outcome).toEqual({
      kind: 'download', url: 'https://arxiv.org/pdf/2210.02747',
      mimeType: 'application/pdf', filename: '2210.02747.pdf', cancelled: 'policy',
    });
  });

  // Chromium 在导航被下载接管时会给主 frame 发一个 ERR_ABORTED(-3)。
  // 不特判的话，一个成功识别出的下载会被后到的 -3 改写成 failed。
  it('下载之后到达的 ERR_ABORTED 不会把它改写成 failed', () => {
    const n = t();
    n.onWillDownload('https://x/f.pdf', 'application/pdf', 'f.pdf');
    n.onDidFailLoad(-3, 'ERR_ABORTED', true);
    expect(n.observation()!.outcome).toMatchObject({ kind: 'download' });
  });

  // 反过来：-3 先到、下载后到，结论也该是 download。ERR_ABORTED 本身信息量极低
  // （用户点了停止、被下载接管、被新导航取代都会给它），单独看它不该定论。
  it('ERR_ABORTED 先到、下载后到，结论仍是 download', () => {
    const n = t();
    n.onDidFailLoad(-3, 'ERR_ABORTED', true);
    n.onWillDownload('https://x/f.pdf', 'application/pdf', 'f.pdf');
    expect(n.observation()!.outcome).toMatchObject({ kind: 'download' });
  });

  it('只有 ERR_ABORTED 且始终没有下载 → 到超时才定论为 timeout', () => {
    const n = t();
    n.onDidFailLoad(-3, 'ERR_ABORTED', true);
    expect(n.observation()).toBeNull();
    n.onTimeout();
    expect(n.observation()!.outcome).toEqual({ kind: 'timeout' });
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
});

describe('崩溃与等待', () => {
  it('渲染进程崩溃当场定论为 failed，不挂满超时窗口', () => {
    const n = t();
    n.onCrashed('crashed');
    expect(n.observation()!.outcome).toMatchObject({ kind: 'failed', errorCode: -2 });
    expect((n.observation()!.outcome as { errorDesc: string }).errorDesc).toContain('crashed');
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

  it('已定论后再崩溃不改写结论', () => {
    const n = t();
    n.onDidNavigate('https://a/', 200);
    n.onCrashed('oom');
    expect(n.observation()!.outcome).toMatchObject({ kind: 'ok' });
  });
});
