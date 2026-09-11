import { describe, it, expect } from 'vitest';
import {
  TabConsoleLog, renderConsole, ZERO_CURSOR,
  CONSOLE_BUFFER_MAX, CONSOLE_REPORT_MAX, CONSOLE_LINE_MAX,
} from './consoleLog';
import { PAGE_CONTENT_OPEN } from './snapshot';

const err = (log: TabConsoleLog, msg: string, src = 'https://a.example/app.js'): void =>
  log.record('error', msg, src, 1);

describe('只收 error 那一档', () => {
  it('error 收下，info / warning / debug 一律不收', () => {
    const log = new TabConsoleLog();
    err(log, 'Uncaught TypeError: x is not a function');
    // 正向前置：先证明 error 确实会进来，下面三条的空结果说的才是
    // 「被这一档滤掉了」，不是「record 整个坏了」。
    expect(log.since(ZERO_CURSOR).lines).toHaveLength(1);
    log.record('info', 'hello', 's', 1);
    log.record('warning', 'careful', 's', 1);
    log.record('debug', 'noisy', 's', 1);
    expect(log.since(ZERO_CURSOR).lines).toHaveLength(1);
  });
});

describe('游标：只报「这次调用开始之后」的那些', () => {
  it('游标之前的不重复报', () => {
    const log = new TabConsoleLog();
    err(log, '第一条');
    const c = log.cursor();
    err(log, '第二条');
    const r = log.since(c);
    expect(r.lines.map((l) => l.text)).toEqual(['第二条']);
  });

  it('同一个游标取两次结果一样 —— since 不消费', () => {
    const log = new TabConsoleLog();
    const c = log.cursor();
    err(log, 'x');
    expect(log.since(c).lines).toHaveLength(1);
    expect(log.since(c).lines).toHaveLength(1);
  });
});

describe('凭据窗口：填过凭据的文档，内容一个字都不采集', () => {
  it('suppress 之前照常采集，之后只计数、不留内容（连渲染出来的字符串里也不许有）', () => {
    const log = new TabConsoleLog();
    const c = log.cursor();
    // 正向前置：证明这个标签本来是会采的，suppress 之后的空结果说的
    // 才是「被挡住了」，不是「本来就不采」。
    err(log, '正常的错误');
    log.suppress();
    err(log, 'password=hunter2 leaked to console');
    const r = log.since(c);
    expect(r.lines.map((l) => l.text)).toEqual(['正常的错误']);
    expect(r.suppressed).toBe(1);
    // 内容一个字都不许留在报告里 —— 连渲染出来的那段也不许。
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });

  it('导航到新文档之后恢复采集 —— 凭据跟着旧文档一起走了', () => {
    const log = new TabConsoleLog();
    log.suppress();
    log.resumeOnNewDocument();
    const c = log.cursor();
    err(log, '新页面上的错误');
    expect(log.since(c).lines).toHaveLength(1);
  });
});

describe('上限：丢了多少必须说出来', () => {
  it('缓冲满了之后丢的是最早的，且丢了几条报得出来', () => {
    const log = new TabConsoleLog();
    const c = log.cursor();
    // 推 CONSOLE_BUFFER_MAX + 5 条（e0..e54，共 55 条）。
    // 缓冲只留最近 CONSOLE_BUFFER_MAX 条 → 丢掉最早的 5 条（e0..e4），
    // 缓冲里剩 e5..e54；报告再取最近 CONSOLE_REPORT_MAX 条，
    // 即下标 [total-CONSOLE_REPORT_MAX, total-1] → e35..e54。
    // 断具体幸存内容而不是「e0 不在」——「e0 不在」这个事实在缓冲丢最新一头时
    // 一样成立（报告本来就只截最近 20 条），抓不住方向反了的实现。
    const total = CONSOLE_BUFFER_MAX + 5;
    for (let i = 0; i < total; i += 1) err(log, `e${i}`);
    const r = log.since(c);
    expect(r.dropped).toBe(5);
    expect(r.lines[0].text).toBe(`e${total - CONSOLE_REPORT_MAX}`);
    expect(r.lines[r.lines.length - 1].text).toBe(`e${total - 1}`);
  });

  it('一次报告最多 CONSOLE_REPORT_MAX 条，留最近的，略过几条报得出来', () => {
    const log = new TabConsoleLog();
    const c = log.cursor();
    for (let i = 0; i < CONSOLE_REPORT_MAX + 3; i += 1) err(log, `e${i}`);
    const r = log.since(c);
    expect(r.lines).toHaveLength(CONSOLE_REPORT_MAX);
    expect(r.omitted).toBe(3);
    // 留的是最近的，不是最早的。
    expect(r.lines[r.lines.length - 1].text).toBe(`e${CONSOLE_REPORT_MAX + 2}`);
  });

  it('单条过长就截断，并在那一条上留下截断记号', () => {
    const log = new TabConsoleLog();
    const c = log.cursor();
    err(log, 'x'.repeat(CONSOLE_LINE_MAX + 50));
    const t = log.since(c).lines[0].text;
    expect(t.length).toBeLessThanOrEqual(CONSOLE_LINE_MAX + 1);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('renderConsole', () => {
  it('有内容时回字符串，什么都没有时回 null —— 不给每次工具调用添一段空噪声', () => {
    // 正向前置：先证明有实际内容时 renderConsole 确实会给出字符串，
    // 下面的 null 结果说的才是「什么都没有时才不给」，不是「renderConsole 总是 null」。
    const withContent = renderConsole({
      lines: [{ seq: 1, text: 'boom', source: 's' }],
      omitted: 0, dropped: 0, suppressed: 0,
    });
    expect(withContent).not.toBeNull();
    expect(renderConsole({ lines: [], omitted: 0, dropped: 0, suppressed: 0 })).toBeNull();
  });

  it('只有被挡下的计数、没有内容时，也要说出来', () => {
    const s = renderConsole({ lines: [], omitted: 0, dropped: 0, suppressed: 3 });
    expect(s).not.toBeNull();
    expect(s).toContain('3');
    expect(s).toContain('凭据');
  });

  it('页面的错误被边界标记框起来 —— 它是页面写的字，不是 KyDog 说的话', () => {
    const s = renderConsole({
      lines: [{ seq: 1, text: 'Uncaught Error: boom', source: 'https://a/app.js' }],
      omitted: 0, dropped: 0, suppressed: 0,
    }) as string;
    expect(s).toContain(PAGE_CONTENT_OPEN);
  });

  it('丢掉与略过的条数都出现在文字里，且各自挂对了原因', () => {
    const s = renderConsole({
      lines: [{ seq: 9, text: 'boom', source: 's' }],
      omitted: 7, dropped: 4, suppressed: 0,
    }) as string;
    // 断具体短语把数字和原因绑在一起 —— 只断「7」「4」都出现的话，
    // 两句 notes.push 用错变量（omitted 与 dropped 对调）也会两个数字都在，
    // 只是挂错了原因，测试却看不出来。
    expect(s).toContain('4 条因为缓冲已满');
    expect(s).toContain('7 条因为一次最多报');
  });
});
