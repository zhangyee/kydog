import { describe, it, expect } from 'vitest';
import {
  TabRequestLog, describeRequestUrl, renderRequests, ZERO_REQUEST_CURSOR,
  REQUEST_BUFFER_MAX, REQUEST_REPORT_OK_MAX,
} from './requestLog';

/**
 * spec 2026-09-17-browser-request-signal-design §3.2 / §6。
 *
 * 这份东西要回答的是「点了之后，页面到底有没有发出请求、回了什么」—— 第五、六组里模型分不清
 * 「没点中」「接口拒了」「只是慢」，只能重试、按 Enter、最后自己拼地址。
 */

describe('describeRequestUrl：主机 + 路径 + 参数名，参数值一律换成 …', () => {
  it('检索接口：检索词与其余参数值都不带出去', () => {
    expect(describeRequestUrl('https://xueshu.baidu.com/search/api/search?wd=KV%E7%BC%93%E5%AD%98&skipStrategy=0'))
      .toBe('xueshu.baidu.com/search/api/search?wd=…&skipStrategy=…');
  });
  it('userinfo 里可能带凭据，不带出去；没有查询串就不加问号', () => {
    expect(describeRequestUrl('https://svc:secret@api.example.org/v1/items')).toBe('api.example.org/v1/items');
  });
  it('同名参数各列一次；解析不了的地址不原样吐出', () => {
    expect(describeRequestUrl('https://a.org/x?id=1&id=2')).toBe('a.org/x?id=…&id=…');
    expect(describeRequestUrl('not a url')).toBe('（地址解析不了）');
  });
});

describe('TabRequestLog：游标取差、容量、凭据窗口', () => {
  it('游标之后新到的才报；同一个游标取两次结果一样（不消费）', () => {
    const log = new TabRequestLog();
    log.record('GET', 'https://a.org/one', { kind: 'status', code: 200 });
    const from = log.cursor();
    log.record('GET', 'https://a.org/two', { kind: 'status', code: 200 });
    const r1 = log.since(from);
    const r2 = log.since(from);
    expect(r1.ok.map((l) => l.where)).toEqual(['a.org/two']);
    expect(r2).toEqual(r1);
  });

  it('4xx / 5xx / 网络错误算失败，2xx / 3xx 算成功', () => {
    const log = new TabRequestLog();
    log.record('GET', 'https://a.org/ok', { kind: 'status', code: 200 });
    log.record('GET', 'https://a.org/moved', { kind: 'status', code: 302 });
    log.record('POST', 'https://a.org/denied', { kind: 'status', code: 403 });
    log.record('GET', 'https://a.org/dead', { kind: 'error', error: 'net::ERR_CONNECTION_RESET' });
    const r = log.since(ZERO_REQUEST_CURSOR);
    expect(r.failed.map((l) => l.where)).toEqual(['a.org/denied', 'a.org/dead']);
    expect(r.ok.map((l) => l.where)).toEqual(['a.org/ok', 'a.org/moved']);
  });

  it('缓冲满了挤掉最早的，并如实计数', () => {
    const log = new TabRequestLog();
    for (let i = 0; i < REQUEST_BUFFER_MAX + 3; i++) log.record('GET', `https://a.org/${String(i)}`, { kind: 'status', code: 200 });
    const r = log.since(ZERO_REQUEST_CURSOR);
    expect(r.dropped).toBe(3);
    expect(r.total).toBe(REQUEST_BUFFER_MAX);
  });

  // 缓冲满了之后，每来一条新的就挤掉一条**游标之前**的旧的。那一条本来就不在这次报告的范围里，
  // 不许算成「这次报告里没能保留的」—— 否则一个请求多的标签攒满 50 条之后，每一次报告都会谎称丢了东西。
  it('被挤掉的是游标之前的旧条目时，不算进这次报告的 dropped', () => {
    const log = new TabRequestLog();
    for (let i = 0; i < REQUEST_BUFFER_MAX; i++) log.record('GET', `https://a.org/${String(i)}`, { kind: 'status', code: 200 });
    const c = log.cursor();
    log.record('GET', 'https://a.org/new', { kind: 'status', code: 200 });
    const r = log.since(c);
    expect(r.ok.map((l) => l.where)).toEqual(['a.org/new']);
    expect(r.dropped).toBe(0);
    // 正向前置在同一条里：游标之后的条目真被挤掉时照样计数。
    const c2 = log.cursor();
    for (let i = 0; i < REQUEST_BUFFER_MAX + 2; i++) log.record('GET', `https://a.org/b${String(i)}`, { kind: 'status', code: 200 });
    expect(log.since(c2).dropped).toBe(2);
  });

  it('since(from, upTo)：只取两个游标之间的那一段', () => {
    const log = new TabRequestLog();
    log.record('GET', 'https://a.org/before', { kind: 'status', code: 200 });
    const from = log.cursor();
    log.record('GET', 'https://a.org/between', { kind: 'status', code: 200 });
    log.suppress('https://a.org');
    log.record('POST', 'https://a.org/login', { kind: 'status', code: 302 });
    const upTo = log.cursor();
    log.resumeIfOriginChanged('https://b.org');
    log.record('GET', 'https://b.org/after', { kind: 'status', code: 200 });
    const r = log.since(from, upTo);
    expect(r.ok.map((l) => l.where)).toEqual(['a.org/between']);
    expect(r.suppressed).toBe(1);
    expect(r.total).toBe(1);
    // 不给 upTo 就一直取到最新：同一个 from，after 在里面。
    expect(log.since(from).ok.map((l) => l.where)).toEqual(['a.org/between', 'b.org/after']);
  });

  it('「上次报告到哪」：没报告过是 null；只往前走，不往回退', () => {
    const log = new TabRequestLog();
    expect(log.reportedCursor()).toBeNull();
    log.record('GET', 'https://a.org/1', { kind: 'status', code: 200 });
    const c1 = log.cursor();
    log.record('GET', 'https://a.org/2', { kind: 'status', code: 200 });
    const c2 = log.cursor();
    log.markReported(c2);
    expect(log.reportedCursor()).toEqual(c2);
    log.markReported(c1);
    expect(log.reportedCursor()).toEqual(c2);
  });

  it('填过凭据的文档期间只计数、不留内容；换了 origin 才恢复，同 origin 继续压着', () => {
    const log = new TabRequestLog();
    log.record('GET', 'https://idp.pku.edu.cn/before', { kind: 'status', code: 200 });
    log.suppress('https://idp.pku.edu.cn');
    log.record('POST', 'https://idp.pku.edu.cn/login?ticket=SECRET', { kind: 'status', code: 302 });
    log.resumeIfOriginChanged('https://idp.pku.edu.cn');
    log.record('GET', 'https://idp.pku.edu.cn/again', { kind: 'status', code: 200 });
    log.resumeIfOriginChanged('https://www.cnki.net');
    log.record('GET', 'https://www.cnki.net/after', { kind: 'status', code: 200 });
    const r = log.since(ZERO_REQUEST_CURSOR);
    expect(r.ok.map((l) => l.where)).toEqual(['idp.pku.edu.cn/before', 'www.cnki.net/after']);
    expect(r.suppressed).toBe(2);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});

describe('renderRequests：先失败后成功，超上限只报条数；「没发请求」只在点击 / 按键后说', () => {
  it('有请求时：失败在前、成功在后，页面给的路径框在数据标记里', () => {
    const log = new TabRequestLog();
    log.record('GET', 'https://xueshu.baidu.com/usercenter/data/collect?cmd=judge', { kind: 'status', code: 200 });
    log.record('GET', 'https://xueshu.baidu.com/search/api/search?wd=x', { kind: 'status', code: 403 });
    const text = renderRequests(log.since(ZERO_REQUEST_CURSOR), { hadInput: true }) ?? '';
    expect(text).toContain('── 这一步发出的请求（XHR / fetch）──');
    const failAt = text.indexOf('GET xueshu.baidu.com/search/api/search?wd=… → 403');
    const okAt = text.indexOf('GET xueshu.baidu.com/usercenter/data/collect?cmd=… → 200');
    expect(failAt).toBeGreaterThan(-1);
    expect(okAt).toBeGreaterThan(failAt);
    expect(text).toContain('以下是网页内容');
  });

  it('成功的超过上限只列最近的，其余报条数；失败的不因为成功的多而被挤掉', () => {
    const log = new TabRequestLog();
    log.record('GET', 'https://a.org/fail', { kind: 'error', error: 'net::ERR_FAILED' });
    for (let i = 0; i < REQUEST_REPORT_OK_MAX + 4; i++) log.record('GET', `https://a.org/ok${String(i)}`, { kind: 'status', code: 200 });
    const text = renderRequests(log.since(ZERO_REQUEST_CURSOR), { hadInput: false }) ?? '';
    expect(text).toContain('GET a.org/fail → 失败 net::ERR_FAILED');
    expect(text).toContain(`GET a.org/ok${String(REQUEST_REPORT_OK_MAX + 3)} → 200`);
    expect(text).not.toContain('GET a.org/ok0 → 200');
    expect(text).toContain('另有 4 条成功的已略');
  });

  it('「没有发出请求」：点击 / 按键之后才说；有请求时绝不说；不是输入动作时什么都不报', () => {
    // 正向前置：同一份日志，有新请求时报告里有它、没有那句「没有发出」
    const log = new TabRequestLog();
    const from = log.cursor();
    log.record('GET', 'https://a.org/x', { kind: 'status', code: 200 });
    const withReq = renderRequests(log.since(from), { hadInput: true }) ?? '';
    expect(withReq).toContain('GET a.org/x → 200');
    expect(withReq).not.toContain('没有发出任何');

    const empty = log.since(log.cursor());
    expect(renderRequests(empty, { hadInput: true })).toContain('截至这一步返回，这个标签没有发出任何 XHR / fetch 请求');
    expect(renderRequests(empty, { hadInput: false })).toBeNull();
  });

  // 上一次工具返回之后、这一步开始之前到的，单独一块、单独一个标题 —— 不混进「这一步发出的请求」。
  // 百度学术那条路上它就是关键：上一步点完返回时还没发，交给用户点了之后，那条检索请求落在这里。
  it('上一次返回之后到的单独成块，标题说清时间段；这一步什么都没发时那句「没有发出」照说', () => {
    const log = new TabRequestLog();
    const from = log.cursor();
    log.record('GET', 'https://xueshu.baidu.com/search/api/search?wd=x', { kind: 'status', code: 200 });
    const stepStart = log.cursor();
    const text = renderRequests(log.since(stepStart), { hadInput: true, late: log.since(from, stepStart) }) ?? '';
    const lateAt = text.indexOf('── 上一次工具返回之后、这一步开始之前到的请求（XHR / fetch）──');
    const stepAt = text.indexOf('── 这一步发出的请求（XHR / fetch）──');
    const lineAt = text.indexOf('GET xueshu.baidu.com/search/api/search?wd=… → 200');
    expect(lateAt).toBeGreaterThan(-1);
    expect(lineAt).toBeGreaterThan(lateAt);
    expect(stepAt).toBeGreaterThan(lineAt);
    expect(text.slice(stepAt)).toContain('没有发出任何');

    // 没有晚到的：那一块整个不出现（正向前置就是上面同一个标题串）。
    const alone = renderRequests(log.since(log.cursor()), { hadInput: true, late: log.since(log.cursor()) }) ?? '';
    expect(alone).toContain('── 这一步发出的请求（XHR / fetch）──');
    expect(alone).not.toContain('上一次工具返回之后');
  });

  it('「没有发出」那句指向的是下一次 browser_act / browser_open，不是随便哪个工具', () => {
    const log = new TabRequestLog();
    expect(renderRequests(log.since(log.cursor()), { hadInput: true })).toContain('下一次 browser_act / browser_open 的结果');
  });

  it('凭据窗口里被挡下的条数如实说出来', () => {
    const log = new TabRequestLog();
    log.suppress('https://idp.x.edu');
    log.record('POST', 'https://idp.x.edu/login', { kind: 'status', code: 302 });
    const text = renderRequests(log.since(ZERO_REQUEST_CURSOR), { hadInput: true }) ?? '';
    expect(text).toContain('1 条');
    expect(text).toContain('填过凭据');
    expect(text).not.toContain('没有发出任何');
  });
});
