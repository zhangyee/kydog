import { describe, it, expect } from 'vitest';
import { createLoginAsk } from './loginConfirm';
import { QuestionBroker } from './questionBroker';
import type { AskOutcome, AskQuestion } from '../../shared/askQuestion';

/** `onOpened` 那一刻的探针（考「broker 已经准备好了吗」）。 */
type Probe = (args: {
  broker: QuestionBroker; order: string[]; toolCallId: string; questions: AskQuestion[];
}) => void;

/**
 * `browser_login` 的首次确认（spec §4.6 第 2 条）。
 *
 * 它**走现成的 ask broker，不新发明挂起机制** —— 所以这里用的是真的
 * `QuestionBroker`，只把 UI 那一侧换成记录器。守的是三件事：
 * 注册顺序、「没表态不等于同意」、以及账号只到用户屏幕为止。
 */

function harness(opts: { probe?: Probe } = {}) {
  const broker = new QuestionBroker();
  const opened: Array<{ toolCallId: string; questions: AskQuestion[]; browserTabId?: string }> = [];
  const closed: Array<{ toolCallId: string; outcome: AskOutcome }> = [];
  const order: string[] = [];
  const shared = {
    onOpened: (toolCallId: string, questions: AskQuestion[], browserTabId?: string) => {
      order.push('onOpened');
      // **顺序不能反**：UI 打开时 broker 必须已经准备好，否则用户手快提交会被
      // 当成迟到消息丢弃。验证它的探针由用例注入 —— 探针本身会**结束**这次提问，
      // 所以不能挂在每一条用例上（也不许写成一句不动真格的恒真断言，见下面那条）。
      opts.probe?.({ broker, order, toolCallId, questions });
      opened.push({ toolCallId, questions, browserTabId });
    },
    onClosed: (toolCallId: string, outcome: AskOutcome) => { order.push('onClosed'); closed.push({ toolCallId, outcome }); },
  };
  const ask = createLoginAsk('thread-1', shared, broker);
  return { broker, shared, opened, closed, order, ask };
}

const ARGS = {
  tabId: 'tab_abc12345', host: 'iaaa.pku.edu.cn', username: 'u2100011000', institutionName: '北京大学',
};

/** 拿到 UI 那一侧看到的题目（`onOpened` 是同步调的，所以此时已经有了）。 */
async function askAndAnswer(pick: 'yes' | 'no' | 'cancel' | 'skip'): Promise<{ ok: boolean; q: AskQuestion }> {
  const h = harness();
  const p = h.ask('call-1', ARGS);
  const q = h.opened[0].questions[0];
  if (pick === 'cancel') h.broker.cancel('thread-1', 'call-1');
  else if (pick === 'skip') h.broker.submit('thread-1', 'call-1', [{ questionId: q.id, kind: 'skipped' }]);
  else {
    const id = pick === 'yes' ? q.options[0].id : q.options[1].id;
    h.broker.submit('thread-1', 'call-1', [{ questionId: q.id, kind: 'answered', optionIds: [id] }]);
  }
  return { ok: await p, q };
}

describe('确认框的题面', () => {
  it('host、账号、机构名三样都在题面上 —— 用户要凭它判断', async () => {
    const { q } = await askAndAnswer('yes');
    expect(q.question).toContain('iaaa.pku.edu.cn');
    expect(q.question).toContain('u2100011000');
    expect(q.question).toContain('北京大学');
  });

  it('是非题：恰好两个选项，第一个是「是」', async () => {
    const { q } = await askAndAnswer('yes');
    expect(q.options).toHaveLength(2);
    expect(q.options[0].label).toContain('是');
    expect(q.options[1].label).toContain('不是');
  });

  it('「是」那一项说清了「会记住这个地址」—— 用户是在授权一次持久化', async () => {
    const { q } = await askAndAnswer('yes');
    expect(q.options[0].description).toContain('记住');
    expect(q.options[0].description).toContain('iaaa.pku.edu.cn');
  });

  it('没有 recommended —— 这道题不许由我们替用户偏向任何一边', async () => {
    const { q } = await askAndAnswer('yes');
    expect(q.options.some((o) => o.recommended === true)).toBe(false);
  });
});

describe('只有明确点了「是」才算确认', () => {
  it('点「是」→ true', async () => {
    expect((await askAndAnswer('yes')).ok).toBe(true);
  });

  it('点「不是」→ false', async () => {
    expect((await askAndAnswer('no')).ok).toBe(false);
  });

  /** 「没表态」不许被读成「同意」—— 押的是校园密码。 */
  it('用户关掉了问题（cancelled）→ false', async () => {
    expect((await askAndAnswer('cancel')).ok).toBe(false);
  });

  it('跳过这一题（skipped）→ false', async () => {
    expect((await askAndAnswer('skip')).ok).toBe(false);
  });

  it('按了停止（aborted）→ false', async () => {
    const h = harness();
    const ctrl = new AbortController();
    const p = h.ask('call-1', ARGS, ctrl.signal);
    ctrl.abort();
    expect(await p).toBe(false);
  });

  it('信号已经中止时也不挂着 —— 直接 false', async () => {
    const h = harness();
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await h.ask('call-1', ARGS, ctrl.signal)).toBe(false);
  });
});

describe('与 ask broker 的接线', () => {
  /**
   * 与 askUserQuestionTool 一字不差：先注册 pending，再通知 UI。
   *
   * **探针必须对真的那个 thread / toolCallId 动作。** 早先这里是
   * `broker.cancel('nope', 'nope') === false`：`'nope'` 这个 thread 永远不在
   * `pending` 里，所以它**无论 broker 注册没注册都回 false** —— 一句恒真的断言。
   * 评审 I2 实测：把 `loginConfirm.ts` 里 `broker.ask` 与 `shared.onOpened` 两句
   * 对调，2884 条全绿。守法照兄弟文件 `askUserQuestionTool.test.ts:27`：在 `onOpened`
   * 里往**真的那个** pending 上 `submit` 并断它被收下（顺序反了就会被丢弃）。
   */
  it('先 broker.ask 注册，再 onOpened 通知 UI', async () => {
    const h = harness({
      probe: ({ broker, order, toolCallId, questions }) => {
        const q = questions[0];
        const taken = broker.submit('thread-1', toolCallId, [
          { questionId: q.id, kind: 'answered', optionIds: [q.options[0].id] },
        ]);
        order.push(taken ? 'brokerAlive' : 'brokerNotReady');
      },
    });
    const p = h.ask('call-1', ARGS);
    expect(h.order.slice(0, 2)).toEqual(['onOpened', 'brokerAlive']);
    // 这一发提交是在 UI「打开」的同一瞬打进去的（用户手快）。它必须被收下并
    // 一路走通 —— 顺序反了的话它落在注册之前，会被当成迟到消息丢弃。
    expect(await p).toBe(true);
    expect(h.order).toEqual(['onOpened', 'brokerAlive', 'onClosed']);
  });

  it('onClosed 拿到的是真实的 outcome（UI 那一侧靠它收掉卡片）', async () => {
    const h = harness();
    const p = h.ask('call-9', ARGS);
    h.broker.cancel('thread-1', 'call-9');
    await p;
    expect(h.closed).toEqual([{ toolCallId: 'call-9', outcome: { kind: 'cancelled' } }]);
  });

  it('toolCallId 原样传下去 —— UI 靠它和这次工具调用对上', async () => {
    const h = harness();
    const p = h.ask('call-42', ARGS);
    expect(h.opened[0].toolCallId).toBe('call-42');
    h.broker.cancel('thread-1', 'call-42');
    await p;
  });

  /**
   * 「是」的判据是**结构地取第一个选项的 id**，不是写死 `q0o0`。
   * 写死的话，id 规则一变这里会静默地永远返回 false —— 也就是永远拒绝登录，
   * 而一条用例都不会红。这里反过来验证：换一个 id 去答，不算「是」。
   */
  it('答了一个不是第一项的 id → 不算确认', async () => {
    const h = harness();
    const p = h.ask('call-1', ARGS);
    const q = h.opened[0].questions[0];
    h.broker.submit('thread-1', 'call-1', [{ questionId: q.id, kind: 'answered', optionIds: [q.options[1].id] }]);
    expect(await p).toBe(false);
  });
});

/**
 * `browserTabId` 是人机交接口（spec §4.5）：确认框问的是「你看这一页是不是你学校的
 * 登录页」，用户看不到那一页就无从判断。所以标签 id 必须跟着 `run.ask_start` 过河。
 *
 * 这里断的是**同一个字符串真的到了 UI 那一侧**，不是「有这么个字段」——
 * 后者在把 `args.tabId` 写成 `args.host` 的变异下照样绿。
 */
describe('标签 id 透传给 UI', () => {
  it('onOpened 收到的 browserTabId 就是调用方给的那个 tabId', async () => {
    const h = harness();
    const p = h.ask('call-1', { ...ARGS, tabId: 'tab_deadbeef' });
    expect(h.opened[0].browserTabId).toBe('tab_deadbeef');
    h.broker.cancel('thread-1', 'call-1');
    await p;
  });

  it('它与 host 不是同一个值 —— 拿错字段传过去这里会红', async () => {
    const h = harness();
    const p = h.ask('call-1', ARGS);
    expect(h.opened[0].browserTabId).not.toBe(ARGS.host);
    expect(h.opened[0].browserTabId).toBe(ARGS.tabId);
    h.broker.cancel('thread-1', 'call-1');
    await p;
  });
});
