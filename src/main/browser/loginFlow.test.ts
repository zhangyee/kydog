import { describe, it, expect, beforeEach } from 'vitest';
import type { OnBeforeRequestListenerDetails } from 'electron';
import { LoginFlow, loginRefusalError, type LoginFlowPorts } from './loginFlow';
import { createWebRequestHub, type WebRequestPort } from './webRequestHub';
import { KydogError } from '../../shared/errors';
import type { AxSnapshot } from './snapshot';
import type { SettingsFile } from '../../shared/types';

/**
 * `loginFlow` 的单测。**这是整个特性安全上最关键的一层** —— 它把用户的校园密码
 * 填进一个真实网页，所以这里守的四件事各自都有独立的一组：
 *
 *  1. **域判据 + TOCTOU 重判**：确认框是一次跨进程悬挂，页面可以在这中间自己跳走。
 *  2. **同一轮 run 失败一次就停手**（spec §4.6）：那张表的写入点与清除点。
 *  3. **观测者挂在标签上**：三个拆点，以及 `webContentsId` 归属。
 *  4. **密码只往一个方向流**：除了注进页面那一次，任何返回值 / 错误里都不许有它。
 */

const ENTITY = 'https://iaaa.pku.edu.cn/idp/shibboleth';
const IDP_URL = 'https://iaaa.pku.edu.cn/iaaa/oauth.jsp?a=1';
const PW = 'SECRET-CAMPUS-PW';

type Reply = Record<string, unknown>;

/** Electron 那份 details 里我们用得上的部分。 */
const req = (over: Partial<OnBeforeRequestListenerDetails> & { body?: string } = {}) => {
  const { body, ...rest } = over;
  return {
    id: 1,
    url: 'https://fsso.cnki.net/Shibboleth.sso/SAML2/POST',
    method: 'POST',
    webContentsId: 7,
    resourceType: 'mainFrame' as const,
    referrer: '',
    timestamp: 0,
    uploadData: [{ bytes: Buffer.from(body ?? 'RelayState=x&SAMLResponse=abc') }],
    ...rest,
  } as unknown as OnBeforeRequestListenerDetails;
};

function harness(over: {
  institution?: SettingsFile['institution'];
  url?: string | null;
  webContentsId?: number | null;
  snapshot?: AxSnapshot | null;
  confirmLoginResult?: boolean;
  password?: string;
  reply?: Reply | (() => Reply | Promise<Reply>);
  evalThrows?: unknown;
  /** 第一次 `reveal()` 挂住不返回，直到用例调 `releaseReveal()`（考队列内那一判）。 */
  holdReveal?: boolean;
} = {}) {
  const wr: WebRequestPort & { current: unknown; sets: number } = {
    current: null,
    sets: 0,
    onBeforeRequest(listener) { this.sets += 1; this.current = listener; },
  };
  const hub = createWebRequestHub(wr);
  const fire = (d: OnBeforeRequestListenerDetails): void => {
    const l = wr.current as ((d: unknown, cb: (r: unknown) => void) => void) | null;
    if (l) l(d, () => {});
  };

  const state = {
    institution: over.institution === undefined
      ? {
        name: '北京大学', entityID: ENTITY, username: 'u2100011000',
        passwordEnc: 'enc', confirmedLogin: null,
      }
      : over.institution,
    url: over.url === undefined ? IDP_URL : over.url,
    webContentsId: over.webContentsId === undefined ? 7 : over.webContentsId,
    password: over.password ?? PW,
    confirmLoginResult: over.confirmLoginResult ?? true,
  };

  /** 每个标签一条队列，照真身。 */
  const queues = new Map<string, Promise<unknown>>();
  let holdNextReveal = over.holdReveal === true;
  let revealGate: (() => void) | null = null;

  const log = {
    order: [] as string[],
    injected: [] as string[],
    confirmed: [] as Array<{ entityID: string; origin: string }>,
    asked: [] as Array<{ host: string; username: string; institutionName: string }>,
    destroyHooks: [] as Array<(tabId: string) => void>,
    reveals: 0,
  };

  const ports: LoginFlowPorts = {
    browser: {
      currentUrlOf: () => state.url,
      webContentsIdOf: () => state.webContentsId,
      getSnapshot: () => over.snapshot ?? null,
      enqueue: (tabId, fn) => {
        log.order.push(`enqueue:${tabId}`);
        // **照真身 `browserService.enqueue` 真的按标签串行**（队尾那一句把 rejection
        // 吞掉，于是一次失败不会卡住这个标签的队列）。早先这里是 `return fn()`
        // 立刻执行 —— 那样两次填充在队列里根本重叠不起来，`fillInQueue` 开头那道
        // 「队列内的 assertNoPriorAttempt」就永远走不到（评审 I4：整句删掉全绿）。
        const prev = queues.get(tabId) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        queues.set(tabId, next.then(() => {}, () => {}));
        return next;
      },
      withAgentDriving: (tabId, runId, fn) => { log.order.push(`driving:${tabId}:${String(runId)}`); return fn(); },
      suppressConsoleForCredentials: () => { log.order.push('suppressConsole'); },
      evalInPage: async (_tabId, code) => {
        log.order.push('evalInPage');
        log.injected.push(typeof code === 'string' ? code : code(Date.now() + 20_000));
        if (over.evalThrows) throw over.evalThrows;
        const r = over.reply ?? { ok: true, wrote: true, field: 'input#un', source: 'structure', submitted: false, submitHow: null };
        return typeof r === 'function' ? r() : r;
      },
      onTabDestroyed: (fn) => { log.destroyHooks.push(fn); return () => {}; },
    },
    settings: {
      get: async () => ({ institution: state.institution } as unknown as SettingsFile),
      confirmLogin: async (entityID, origin) => {
        log.order.push('confirmLogin');
        log.confirmed.push({ entityID, origin });
        if (!state.confirmLoginResult) return false;
        // 照真身的语义落盘：`settingsService.confirmLogin` 是一次锁内的
        // read-modify-write，写完之后 `get()` 读得到它。不演这一步的话，
        // 紧接着的 TOCTOU 重判会拿到一份「还没确认」的记录 —— 那是替身在骗人。
        if (state.institution && state.institution.entityID === entityID) {
          state.institution = { ...state.institution, confirmedLogin: { entityID, origin } };
        }
        return true;
      },
    },
    institution: {
      reveal: async () => {
        log.reveals += 1;
        log.order.push('reveal');
        if (holdNextReveal) {
          holdNextReveal = false;
          await new Promise<void>((res) => { revealGate = res; });
        }
        return { password: state.password };
      },
    },
    hub: () => hub,
  };

  const flow = new LoginFlow(ports);
  const ask = async (a: { host: string; username: string; institutionName: string }): Promise<boolean> => {
    log.order.push('ask');
    log.asked.push(a);
    return askAnswer;
  };
  let askAnswer = true;

  return {
    flow, log, state, fire, wr,
    setAsk: (v: boolean) => { askAnswer = v; },
    fill: (opts: Partial<Parameters<LoginFlow['fill']>[1]> = {}) =>
      flow.fill('t1', { runId: 'run-1', submit: false, ask, ...opts }),
    /** 同一个 flow、换一个标签 —— 「停手」的作用域是 run，考的就是这个。 */
    fillOn: (tabId: string, opts: Partial<Parameters<LoginFlow['fill']>[1]> = {}) =>
      flow.fill(tabId, { runId: 'run-1', submit: false, ask, ...opts }),
    releaseReveal: () => { revealGate?.(); },
    destroy: (tabId: string) => { for (const h of log.destroyHooks) h(tabId); },
  };
}

const codeOf = async (p: Promise<unknown>): Promise<never> => { await p; throw new Error('应该抛'); };
const errOf = async (p: Promise<unknown>): Promise<KydogError> => {
  try { await p; } catch (e) { return e as KydogError; }
  throw new Error('应该抛，但没有');
};
void codeOf;

// ── why → 错误码 ────────────────────────────────────────────────────────────

/**
 * 分组判据是「用户/模型下一步该做什么」，与 Task 5 的 `institution.idp_list_*`
 * 那一对同一条规矩。五种「当前页面不合格」共用一个码；`entity-has-no-host` 单列
 * —— 那条记录**永远**自动登不了，换一页再试一百次也一样。
 */
describe('why → 错误码：按「下一步该做什么」分组，不新增码', () => {
  const CASES = [
    ['unparsable', 'browser.idp_host_mismatch'],
    ['no-host', 'browser.idp_host_mismatch'],
    ['not-https', 'browser.idp_host_mismatch'],
    ['bare-ip', 'browser.idp_host_mismatch'],
    ['local-host', 'browser.idp_host_mismatch'],
    ['entity-has-no-host', 'settings.invalid'],
  ] as const;

  for (const [why, code] of CASES) {
    it(`${why} → ${code}`, () => {
      expect(loginRefusalError({ kind: 'refuse', reason: '理由', why }).code).toBe(code);
    });
  }

  it('五种「页面不合格」的下一步一致：先导到机构登录页；而 entity-has-no-host 是「改人工」', () => {
    const page = CASES.filter(([, c]) => c === 'browser.idp_host_mismatch')
      .map(([why]) => loginRefusalError({ kind: 'refuse', reason: 'r', why }).message);
    for (const m of page) expect(m).toContain('统一身份认证页');
    const urn = loginRefusalError({ kind: 'refuse', reason: 'r', why: 'entity-has-no-host' }).message;
    expect(urn).toContain('手动登录');
    // 两组的下一步不许长得一样 —— 一组「换一页再试」，另一组「重试也没用」。
    expect(urn).toContain('换一页再试也一样');
  });

  it('理由原文进消息（它是给人看的中文，且刻意不含原始 URL）', () => {
    const e = loginRefusalError({ kind: 'refuse', reason: '当前标签是 http，机构登录只在 https 上填', why: 'not-https' });
    expect(e.message).toContain('机构登录只在 https 上填');
  });
});

// ── 真正走一遍 ──────────────────────────────────────────────────────────────

describe('entityID host 精确相等就直接填', () => {
  it('走 enqueue + withAgentDriving，且顺序是 排队 → 驱动 → 取密码 → 关控制台 → 注入', async () => {
    const h = harness();
    const r = await h.fill();
    expect(r.host).toBe('iaaa.pku.edu.cn');
    expect(r.entityID).toBe(ENTITY);
    expect(r.institutionName).toBe('北京大学');
    expect(r.askedUser).toBe(false);
    expect(h.log.order).toEqual(['enqueue:t1', 'driving:t1:run-1', 'reveal', 'suppressConsole', 'evalInPage']);
    expect(h.log.asked).toEqual([]);
  });

  it('注进去的那一份带着 expectOrigin、账号、密码与 notAfter', async () => {
    const h = harness();
    await h.fill();
    const code = h.log.injected[0];
    expect(code).toContain('"expectOrigin":"https://iaaa.pku.edu.cn"');
    expect(code).toContain('"username":"u2100011000"');
    expect(code).toContain(`"password":"${PW}"`);
    expect(code).toContain('"notAfter":');
  });

  it('submit 原样传下去', async () => {
    const h = harness({ reply: { ok: true, wrote: true, field: 'f', source: 'structure', submitted: true, submitHow: 'requestSubmit' } });
    const r = await h.fill({ submit: true });
    expect(h.log.injected[0]).toContain('"submit":true');
    expect(r.submitted).toBe(true);
    expect(r.submitHow).toBe('requestSubmit');
  });
});

describe('填凭据之前先关掉控制台采集（Task 4）', () => {
  it('关采集排在注入之前 —— 密码是在注入那一刻才进页面的', async () => {
    const h = harness();
    await h.fill();
    const off = h.log.order.indexOf('suppressConsole');
    const inject = h.log.order.indexOf('evalInPage');
    expect(off).toBeGreaterThanOrEqual(0);
    expect(off).toBeLessThan(inject);
  });

  // 正向前置：证明这条断言看的是真的顺序，而不是「evalInPage 压根没发生」。
  it('注入确实发生了 —— 上面那条比的是两件都发生过的事', async () => {
    const h = harness();
    await h.fill();
    expect(h.log.order).toContain('evalInPage');
  });
});

// ── 首次确认 ────────────────────────────────────────────────────────────────

describe('首次确认：在标签队列之外问，确认后才排队', () => {
  const other = () => harness({ url: 'https://sso.pku.edu.cn/login' });

  /** 裁决 4：占着标签队列几十秒会把这个标签上的一切都堵住。 */
  it('问的那一下排在 enqueue 之前', async () => {
    const h = other();
    await h.fill();
    expect(h.log.order[0]).toBe('ask');
    expect(h.log.order.indexOf('ask')).toBeLessThan(h.log.order.indexOf('enqueue:t1'));
  });

  it('确认之后经 settingsService.confirmLogin 记下 origin（含 scheme）', async () => {
    const h = other();
    await h.fill();
    expect(h.log.confirmed).toEqual([{ entityID: ENTITY, origin: 'https://sso.pku.edu.cn' }]);
  });

  it('用户说不 → 什么都不填，也不去碰设置', async () => {
    const h = other();
    h.setAsk(false);
    const e = await errOf(h.fill());
    expect(e.code).toBe('browser.idp_host_mismatch');
    expect(h.log.confirmed).toEqual([]);
    expect(h.log.injected).toEqual([]);
    expect(h.log.reveals).toBe(0);
  });

  /** 锁内 read-modify-write 不符（用户在框上停留时换了学校）→ 这次确认作废。 */
  it('confirmLogin 返回 false → 整条放弃，不填', async () => {
    const h = harness({ url: 'https://sso.pku.edu.cn/login', confirmLoginResult: false });
    const e = await errOf(h.fill());
    expect(e.code).toBe('settings.invalid');
    expect(h.log.injected).toEqual([]);
    expect(h.log.reveals).toBe(0);
  });

  it('问用户时给的是 host + 账号 + 机构名（账号只到用户屏幕为止）', async () => {
    const h = other();
    await h.fill();
    expect(h.log.asked).toEqual([{ host: 'sso.pku.edu.cn', username: 'u2100011000', institutionName: '北京大学' }]);
  });

  it('已经确认过同一个 origin 就不再问', async () => {
    const h = harness({
      url: 'https://sso.pku.edu.cn/login',
      institution: {
        name: '北京大学', entityID: ENTITY, username: 'u', passwordEnc: 'e',
        confirmedLogin: { entityID: ENTITY, origin: 'https://sso.pku.edu.cn' },
      },
    });
    const r = await h.fill();
    expect(h.log.asked).toEqual([]);
    expect(r.askedUser).toBe(false);
  });
});

// ── TOCTOU ──────────────────────────────────────────────────────────────────

/**
 * `checkLoginHost` 的返回值**不能跨越挂起使用**（它的 JSDoc 写明了这条）。
 * 确认框是一次跨进程悬挂，人在框上停留几秒到几十秒是常态，页面完全可以在这期间
 * 自己 `location = 'https://evil.example/'`。
 */
describe('TOCTOU：填充前拿当时的 URL 再判一次', () => {
  it('悬挂期间页面跳走了 → 拒，且一个字都没填', async () => {
    const h = harness({ url: 'https://sso.pku.edu.cn/login' });
    // 用户在确认框上停留时页面自己跳去了别处。
    const orig = h.state;
    const askJump = async () => { orig.url = 'https://evil.example/login'; return true; };
    const e = await errOf(h.flow.fill('t1', { runId: 'run-1', submit: false, ask: askJump }));
    expect(e.code).toBe('browser.idp_host_mismatch');
    expect(h.log.injected).toEqual([]);
    expect(h.log.reveals).toBe(0);
    // 确认确实写下去了（写的是当时那个 origin），只是随后的重判没通过。
    expect(h.log.confirmed).toEqual([{ entityID: ENTITY, origin: 'https://sso.pku.edu.cn' }]);
  });

  it('悬挂期间页面跳到一个 http 地址 → 走 refuse 那条，同样一个字都不填', async () => {
    const h = harness({ url: 'https://sso.pku.edu.cn/login' });
    const askJump = async () => { h.state.url = 'http://iaaa.pku.edu.cn/'; return true; };
    const e = await errOf(h.flow.fill('t1', { runId: 'run-1', submit: false, ask: askJump }));
    expect(e.code).toBe('browser.idp_host_mismatch');
    expect(e.message).toContain('https');
    expect(h.log.injected).toEqual([]);
  });

  it('悬挂期间用户把机构换了 → 用**新**机构的判据，不拿旧快照去填', async () => {
    const h = harness({ url: 'https://sso.pku.edu.cn/login' });
    const askSwap = async () => {
      h.state.institution = {
        name: '清华大学', entityID: 'https://id.tsinghua.edu.cn/idp', username: 'q1',
        passwordEnc: 'e', confirmedLogin: null,
      };
      return true;
    };
    const e = await errOf(h.flow.fill('t1', { runId: 'run-1', submit: false, ask: askSwap }));
    expect(e.code).toBe('browser.idp_host_mismatch');
    expect(h.log.injected).toEqual([]);
  });

  it('页面那道 origin 自检用的是**重判那一刻**的 URL，不是队列外那一份', async () => {
    const h = harness({ url: 'https://sso.pku.edu.cn/login' });
    const askJump = async () => { h.state.url = IDP_URL; return true; };
    await h.flow.fill('t1', { runId: 'run-1', submit: false, ask: askJump });
    expect(h.log.injected[0]).toContain('"expectOrigin":"https://iaaa.pku.edu.cn"');
    expect(h.log.injected[0]).not.toContain('sso.pku.edu.cn');
  });
});

// ── 失败一次就停手 ──────────────────────────────────────────────────────────

describe('spec §4.6：同一轮 run 内失败一次就停手', () => {
  it('填过一次、没看到断言回传 → 同一轮再调直接拒', async () => {
    const h = harness();
    await h.fill();
    const e = await errOf(h.fill());
    expect(e.code).toBe('browser.login_attempted');
    expect(e.message).toContain('交给用户');
    expect(h.log.injected).toHaveLength(1);
  });

  /**
   * 挡住的那一次**连问都不该问用户**。
   *
   * 第一次填在 entityID 自己的 host 上（不需要问），随后把标签挪到一个**没有确认过**
   * 的地址 —— 少了那道前置判据的话，第二次会先弹一个确认框给用户，然后才在队列里
   * 被拒。（早先这条用例是「同一个地址上连调两次」，那时第一次已经把 origin 确认下来，
   * 第二次本来就不用问 —— 把前置判据整条删掉它照样绿。这是一次同码遮蔽。）
   */
  it('拒的那一下排在问用户之前 —— 连确认框都不该弹', async () => {
    const h = harness();
    await h.fill();
    expect(h.log.asked).toEqual([]);
    h.state.url = 'https://sso.pku.edu.cn/login';
    const e = await errOf(h.fill());
    expect(e.code).toBe('browser.login_attempted');
    expect(h.log.asked).toEqual([]);
    expect(h.log.confirmed).toEqual([]);
  });

  /**
   * **作用域是 run，不是标签。**
   *
   * `browser_open` 的 `tabId` 是可选的，不给就新开一个标签，而标签数没有上限 ——
   * 只查「这个标签」的话，模型收到 `browser.login_attempted` 之后开个新标签再调
   * `browser_login` 就照填不误。评审实测：同一轮里六个标签各调一次，**六次全部
   * 注入成功，一次都没被拒**。押的是用户本人的校园统一身份认证账号，而高校 IdP
   * 普遍锁定连续失败的账号 —— spec §4.6 那道闸防的就是这件事。
   */
  it('一轮里换一个标签再调也拒 —— 本轮名下任一标签填过就停手', async () => {
    const h = harness();
    await h.fill();
    const e = await errOf(h.fillOn('t2'));
    expect(e.code).toBe('browser.login_attempted');
    expect(h.log.injected).toHaveLength(1);
  });

  /** 措辞里点出「在这个标签上」等于替模型指出绕法。 */
  it('拒的那句话说的是「本轮」，不提「这个标签」', async () => {
    const h = harness();
    await h.fill();
    const e = await errOf(h.fillOn('t2'));
    expect(e.message).toContain('本轮');
    expect(e.message).toContain('换一个标签页也一样');
    expect(e.message).not.toContain('这个标签');
  });

  /** 判据是 `runId` 相等，不是「表里有东西」—— 上一轮留下的记录不该挡住新一轮。 */
  it('别的轮次名下的标签不算数', async () => {
    const h = harness();
    await h.fill();
    await h.fillOn('t2', { runId: 'run-2' });
    expect(h.log.injected).toHaveLength(2);
  });

  /**
   * **`runId === null` 那一支同样 fail-closed。**
   *
   * 这不是一条理论路径：`AgentService.currentRunIdFor` 在「没见过的 thread」与
   * 「本轮已经结束」两种情况下真的返回 `null`（`AgentService.browserDispose.test.ts`
   * 就在断这个），而 `browserTools` 的 `currentRunId: () => this.currentRunIdFor(threadId)`
   * 把它原样传下来。分不出轮次的时候押的仍然是同一个校园账号，所以按「同一轮」算 ——
   * 同样只放一次过。
   *
   * 评审变异 M4（在 `assertNoPriorAttempt` 开头插一句 `if (runId === null) return;`）
   * 在这条用例之前**存活**：2895 条全绿。那条路上模型可以在一轮里对同一个校园账号
   * 无限次重填 —— 正是 spec §4.6 那道闸要挡的事，而它自己的 null 分支曾是全表唯一
   * 没人守的一块。
   */
  it('分不出轮次（runId 为 null）也按同一轮算 —— 换个标签的第二次照样拒', async () => {
    const h = harness();
    await h.fillOn('t1', { runId: null });
    const e = await errOf(h.fillOn('t2', { runId: null }));
    expect(e.code).toBe('browser.login_attempted');
    expect(h.log.injected).toHaveLength(1);
  });

  it('t1 看到断言回传之后，同一轮 t2 照样可以填（那一次成了，不是「失败一次」）', async () => {
    const h = harness();
    await h.fill();
    h.fire(req());
    await h.fillOn('t2');
    expect(h.log.injected).toHaveLength(2);
  });

  /**
   * 队列内那一次 `assertNoPriorAttempt`（`fillInQueue` 开头）**才是权威的那一次**：
   * 队列外那一判在排队**之前**做，那时表里还可能什么都没有。
   *
   * 造法：第一次填在 `reveal` 上挂住（此刻还没 `attachObserver`，表是空的），这时
   * 发起第二次 —— 它的队列外那一判必然放行，只能靠队列内那一判拦下来。
   * 评审 R21（把队列内那一句整条删掉）在这条用例之前**存活**：2884 条全绿。
   */
  it('两次 fill 排在同一个标签的队列里 —— 后一次在队列内被拒', async () => {
    const h = harness({ holdReveal: true });
    const first = h.fill();
    for (let i = 0; i < 50 && !h.log.order.includes('reveal'); i++) await Promise.resolve();
    expect(h.log.order).toContain('reveal');
    // 第一次卡在取密码那一步：观测者还没挂，表里一条记录都没有。
    expect(h.flow.noteFor('t1')).toBeNull();
    const second = errOf(h.fill());
    h.releaseReveal();
    await first;
    expect(await second).toHaveProperty('code', 'browser.login_attempted');
    expect(h.log.injected).toHaveLength(1);
  });

  it('换一轮 run 就放行 —— 这条状态只在同一轮内成立', async () => {
    const h = harness();
    await h.fill();
    await h.fill({ runId: 'run-2' });
    expect(h.log.injected).toHaveLength(2);
  });

  it('看到断言回传之后同一轮也可以再填（那一次成了，不是「失败一次」）', async () => {
    const h = harness();
    await h.fill();
    h.fire(req());
    await h.fill();
    expect(h.log.injected).toHaveLength(2);
  });

  /**
   * 清除点 C2：页面自报「一个字都没写」时**回滚**这条记录 —— 什么都没发生的一次
   * 调用不该占掉本轮唯一那次机会。
   */
  it('页面回报 wrote:false → 记录回滚，同一轮还能再调', async () => {
    const h = harness({ reply: { ok: false, wrote: false, reason: 'no_password' } });
    await errOf(h.fill());
    expect(h.flow.noteFor('t1')).toBeNull();
    const e = await errOf(h.fill());
    // 第二次拿到的仍是 no_password（页面的问题），**不是** login_attempted。
    expect(e.code).toBe('browser.target_unusable');
  });

  it('页面回报 wrote:true 的失败 → 记录留着，同一轮不许再填', async () => {
    const h = harness({ reply: { ok: false, wrote: true, reason: 'write_rejected' } });
    await errOf(h.fill());
    expect(await errOf(h.fill())).toHaveProperty('code', 'browser.login_attempted');
  });

  /** 撞了单次求值时限：**结果未知**，必须 fail-closed 留着记录。 */
  it('注入撞时限（page_no_result / unknown）→ 记录留着', async () => {
    const h = harness({ evalThrows: new KydogError('browser.page_no_result', '没等到', undefined, 'unknown') });
    await errOf(h.fill());
    expect(await errOf(h.fill())).toHaveProperty('code', 'browser.login_attempted');
  });

  /** 这两个码由 `evalInPage` 在**真正注入之前**的两道闸抛，说得出「一个字节都没进去」。 */
  it('标签没了 / 没有渲染进程（注入之前就拒了）→ 记录回滚', async () => {
    for (const code of ['browser.no_tab', 'browser.not_dispatchable'] as const) {
      const h = harness({ evalThrows: new KydogError(code, '注不进去') });
      await errOf(h.fill());
      expect(h.flow.noteFor('t1')).toBeNull();
    }
  });

  it('页面回了个不成形状的东西 → 结果未知，记录留着', async () => {
    const h = harness({ reply: (() => null) as unknown as () => Reply });
    const e = await errOf(h.fill());
    expect(e.code).toBe('browser.page_no_result');
    expect(e.outcome).toBe('unknown');
    expect(await errOf(h.fill())).toHaveProperty('code', 'browser.login_attempted');
  });

  /** 清除点 C1：标签销毁是这张表**唯一**的常规清除时机。 */
  it('标签销毁 → 记录清掉（这是唯一的常规清除点）', async () => {
    const h = harness();
    await h.fill();
    h.destroy('t1');
    expect(h.flow.noteFor('t1')).toBeNull();
    await h.fill();
    expect(h.log.injected).toHaveLength(2);
  });

  it('销毁的是别的标签 → 这条记录不动', async () => {
    const h = harness();
    await h.fill();
    h.destroy('t2');
    expect(await errOf(h.fill())).toHaveProperty('code', 'browser.login_attempted');
  });
});

// ── 观测者 ──────────────────────────────────────────────────────────────────

describe('观测者挂在标签上，三个拆点', () => {
  it('填之前一个订阅者都没有', () => {
    expect(harness().wr.current).toBe(null);
  });

  /**
   * **挂在注入之前，不是之后。** `submit: true` 那条路上，表单一提交断言回传随时
   * 可能到 —— 挂在注入之后就有一段听不见的窗口，而那一次正是我们要观测的那一次。
   *
   * 替身在**求值还在飞的时候**打一发断言回传进来（真页面上就是这个时序）：
   * 观测者挂晚了的话，这一发谁都没听见。
   */
  it('观测者挂在注入之前 —— 求值途中到的断言回传也听得见', async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({
      reply: () => {
        h.fire(req());
        return { ok: true, wrote: true, field: 'input#u', source: 'structure', submitted: true, submitHow: 'requestSubmit' };
      },
    });
    await h.fill({ submit: true });
    expect(h.flow.noteFor('t1')).toContain('已看到 SAML 断言回传');
  });

  it('拆点一：看见断言回传就摘掉自己，底层监听器跟着摘', async () => {
    const h = harness();
    await h.fill();
    h.fire(req());
    expect(h.flow.noteFor('t1')).toContain('已看到 SAML 断言回传');
    expect(h.wr.current).toBe(null);
  });

  it('拆点二：标签销毁', async () => {
    const h = harness();
    await h.fill();
    h.destroy('t1');
    expect(h.wr.current).toBe(null);
  });

  it('拆点三：同一标签上又发起一次填充时顶替（不留下两个订阅者）', async () => {
    const h = harness();
    await h.fill();
    await h.fill({ runId: 'run-2' });
    // 顶替是「先摘旧的再挂新的」：底层被设置的次数不该随填充次数无限涨。
    expect(h.wr.current).not.toBe(null);
    h.destroy('t1');
    expect(h.wr.current).toBe(null);   // 只剩一个订阅者，摘掉就空了
  });

  /** 归属靠 `details.webContentsId`，**拿不到就不计，别猜**（裁决 1）。 */
  it('webContentsId 对不上的请求不算数', async () => {
    const h = harness();
    await h.fill();
    h.fire(req({ webContentsId: 99 }));
    expect(h.flow.noteFor('t1')).not.toContain('已看到');
  });

  it('details 里没有 webContentsId 的请求不算数（不去用 url 或时间猜）', async () => {
    const h = harness();
    await h.fill();
    h.fire(req({ webContentsId: undefined }));
    expect(h.flow.noteFor('t1')).not.toContain('已看到');
  });

  it('不是断言回传的 POST（回到 IdP 自己那一次）不算数', async () => {
    const h = harness();
    await h.fill();
    h.fire(req({ url: 'https://iaaa.pku.edu.cn/iaaa/oauth.jsp' }));
    expect(h.flow.noteFor('t1')).not.toContain('已看到');
  });

  it('请求体里没有 SAMLResponse 的不算数', async () => {
    const h = harness();
    await h.fill();
    h.fire(req({ body: 'RelayState=x&XSAMLResponse=abc' }));
    expect(h.flow.noteFor('t1')).not.toContain('已看到');
  });

  it('webContentsId 拿不到就压根不填（没有归属就没有观测）', async () => {
    const h = harness({ webContentsId: null });
    const e = await errOf(h.fill());
    expect(e.code).toBe('browser.no_tab');
    expect(h.log.injected).toEqual([]);
  });
});

// ── 头部那句话 ──────────────────────────────────────────────────────────────

describe('noteFor：两种状态说的是不同的事', () => {
  it('没填过 → null（不给每次工具调用添一行噪声）', () => {
    expect(harness().flow.noteFor('t1')).toBeNull();
  });

  it('填过没回传 / 填过且回传了，两句话必须分得开', async () => {
    const h = harness();
    await h.fill();
    const pending = h.flow.noteFor('t1')!;
    h.fire(req());
    const done = h.flow.noteFor('t1')!;
    expect(pending).toContain('还没看到断言回传');
    expect(done).toContain('已看到 SAML 断言回传');
    expect(pending).not.toBe(done);
  });
});

// ── 前置条件 ────────────────────────────────────────────────────────────────

describe('前置条件：没配机构 / 没设密码', () => {
  it('压根没配机构 → settings.invalid，且一次都不去解密', async () => {
    const h = harness({ institution: null });
    const e = await errOf(h.fill());
    expect(e.code).toBe('settings.invalid');
    expect(e.message).toContain('设置');
    expect(h.log.reveals).toBe(0);
  });

  /**
   * `institutionService.reveal()` 在 `passwordEnc === ''` 时**不抛、回空串** ——
   * 得自己判。不判的话我们会往 IdP 上送一次空密码，白白烧掉本轮唯一那次机会。
   */
  it('配了机构但没设密码（reveal 回空串）→ 拒，且不注入', async () => {
    const h = harness({ password: '' });
    const e = await errOf(h.fill());
    expect(e.code).toBe('settings.invalid');
    expect(e.message).toContain('没有设密码');
    expect(h.log.injected).toEqual([]);
  });

  it('没有这个标签 → browser.no_tab', async () => {
    const h = harness({ url: null });
    expect(await errOf(h.fill())).toHaveProperty('code', 'browser.no_tab');
  });
});

// ── usernameIndex ───────────────────────────────────────────────────────────

const snapWith = (nodes: Array<Record<string, unknown>>): AxSnapshot => ({
  snapshotId: 'snap_a', generation: 'g1', url: IDP_URL, title: 't',
  nodes: nodes as never, collection: { truncated: false, returned: nodes.length }, iframes: 0,
} as unknown as AxSnapshot);

describe('usernameIndex 在主进程这一侧解析成 nodeId', () => {
  const node = (over: Record<string, unknown> = {}) =>
    ({ index: 3, nodeId: 42, role: 'textbox', name: '学号', x: 0, y: 0, w: 10, h: 10, ...over });

  it('解析出来的号原样注进页面', async () => {
    const h = harness({ snapshot: snapWith([node()]) });
    await h.fill({ usernameIndex: 3, snapshotId: 'snap_a' });
    expect(h.log.injected[0]).toContain('"usernameNodeId":42');
  });

  it('编号不属于当前快照 → stale_index（措辞只该有一份，走 resolveTarget）', async () => {
    const h = harness({ snapshot: snapWith([node()]) });
    const e = await errOf(h.fill({ usernameIndex: 3, snapshotId: 'snap_old' }));
    expect(e.code).toBe('browser.stale_index');
    expect(h.log.injected).toEqual([]);
  });

  it('给了编号却没给 snapshotId → bad_action', async () => {
    const h = harness({ snapshot: snapWith([node()]) });
    expect(await errOf(h.fill({ usernameIndex: 3 }))).toHaveProperty('code', 'browser.bad_action');
  });

  /** 纵深：快照那一层已经判过一次，这里拿到的是同一份事实，再挡一次。 */
  it('指到的是密码框 → password_field，且不注入', async () => {
    const h = harness({ snapshot: snapWith([node({ isPassword: true })]) });
    const e = await errOf(h.fill({ usernameIndex: 3, snapshotId: 'snap_a' }));
    expect(e.code).toBe('browser.password_field');
    expect(h.log.injected).toEqual([]);
    expect(h.log.reveals).toBe(0);
  });

  it('不给 usernameIndex 时不往请求里塞 usernameNodeId（页面走结构规则）', async () => {
    const h = harness();
    await h.fill();
    // 带引号判，不然会撞上源码里那句 `req.usernameNodeId`（整份源码就在这个串里）。
    expect(h.log.injected[0]).not.toContain('"usernameNodeId"');
  });
});

// ── 密码只往一个方向流 ──────────────────────────────────────────────────────

/**
 * **密码永不进模型上下文、不进日志、不进渲染层。** 它唯一的出口是注进页面那一次
 * 求值的代码串。这一组把「除此之外都没有」钉住 —— 每一条失败路径都过一遍。
 */
describe('密码只有一个出口', () => {
  const noPw = (v: unknown): void => { expect(JSON.stringify(v) ?? '').not.toContain(PW); };

  it('成功时的回执里没有密码，也没有账号', async () => {
    const h = harness();
    const r = await h.fill();
    noPw(r);
    expect(JSON.stringify(r)).not.toContain('u2100011000');
  });

  it('页面回报的每一种失败，错误消息里都没有密码', async () => {
    const reasons = [
      'expired', 'origin_changed', 'no_password', 'many_passwords', 'stale_username_index',
      'username_not_same_form', 'username_not_text', 'username_disabled', 'no_username',
      'username_needs_index', 'no_form', 'no_submit', 'write_rejected', 'submit_failed',
      '某个没见过的值',
    ];
    for (const reason of reasons) {
      const h = harness({ reply: { ok: false, wrote: false, reason, detail: 'd', count: 2 } });
      const e = await errOf(h.fill());
      noPw(e.message);
      expect(e).toBeInstanceOf(KydogError);
    }
  });

  it('注进页面的那一次求值里确实带着它 —— 这是它唯一该出现的地方', async () => {
    const h = harness();
    await h.fill();
    expect(h.log.injected.filter((c) => c.includes(PW))).toHaveLength(1);
  });
});

// ── 页面失败 → 错误码 ───────────────────────────────────────────────────────

describe('页面回报的失败：每一种的下一步都不同', () => {
  const CASES: Array<[string, string]> = [
    ['expired', 'browser.page_no_result'],
    ['origin_changed', 'browser.idp_host_mismatch'],
    ['no_password', 'browser.target_unusable'],
    ['many_passwords', 'browser.target_unusable'],
    ['stale_username_index', 'browser.stale_index'],
    ['username_not_same_form', 'browser.target_unusable'],
    ['username_not_text', 'browser.target_unusable'],
    ['username_disabled', 'browser.target_unusable'],
    ['no_username', 'browser.target_unusable'],
    ['username_needs_index', 'browser.target_unusable'],
    ['no_form', 'browser.target_unusable'],
    ['no_submit', 'browser.target_unusable'],
    ['write_rejected', 'browser.target_unusable'],
    ['submit_failed', 'browser.page_no_result'],
  ];
  for (const [reason, code] of CASES) {
    it(`${reason} → ${code}`, async () => {
      const h = harness({ reply: { ok: false, wrote: false, reason } });
      expect(await errOf(h.fill())).toHaveProperty('code', code);
    });
  }

  /**
   * 页面自报 `expired` 说得出「什么都没做」；撞时限那一条只说得出「结果未知」。
   * 两者共用一个错误码，所以判别语义的必须是 `outcome` 这个字段，不是消息里的措辞。
   */
  it('expired 带 outcome:none（它确实什么都没做）', async () => {
    const h = harness({ reply: { ok: false, wrote: false, reason: 'expired' } });
    expect((await errOf(h.fill())).outcome).toBe('none');
  });

  it('认不出来的 reason 报「结果未知」，不假装知道', async () => {
    const h = harness({ reply: { ok: false, wrote: true, reason: 'brand_new' } });
    const e = await errOf(h.fill());
    expect(e.outcome).toBe('unknown');
    expect(e.message).toContain('不知道');
  });

  /** 每一条都要说清「填了没有」—— 模型据此决定要不要重取快照。 */
  it('说得出「一个字都没填」的那些，消息里真的这么说了', async () => {
    for (const reason of ['no_password', 'no_username', 'username_needs_index', 'no_submit', 'no_form', 'username_disabled']) {
      const h = harness({ reply: { ok: false, wrote: false, reason } });
      expect((await errOf(h.fill())).message).toContain('一个字都没填');
    }
  });

  /**
   * `submit_failed` 是**写值之后**才产生的（密码那时已经在页面的 DOM 里），所以
   * 页面在那一刻能影响到的任何字符串都不许进错误消息 —— 与 `field` 那条
   * （回显在写之前算）是同一类出口。
   */
  it('页面多回一个 detail 字段也进不了错误消息', async () => {
    const h = harness({ reply: { ok: false, wrote: true, reason: 'submit_failed', detail: 'PAGE-TEXT-SENTINEL' } });
    const e = await errOf(h.fill());
    expect(e.code).toBe('browser.page_no_result');
    expect(e.message).not.toContain('PAGE-TEXT-SENTINEL');
    expect(e.message).toContain('凭据已经在页面上了');
  });

  it('已经写进页面的那些，明说「不可回滚 / 凭据已经在页面上」', async () => {
    for (const reason of ['write_rejected', 'submit_failed']) {
      const h = harness({ reply: { ok: false, wrote: true, reason, detail: 'x' } });
      expect((await errOf(h.fill())).message).toMatch(/不可回滚|凭据已经在页面上/);
    }
  });
});

beforeEach(() => { /* 每条用例各建各的 harness，没有跨用例状态 */ });
