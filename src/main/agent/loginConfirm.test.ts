import { describe, it, expect } from 'vitest';
import { createLoginAsk } from './loginConfirm';
import { QuestionBroker } from './questionBroker';
import type { AskOutcome, AskQuestion } from '../../shared/askQuestion';

/**
 * `browser_login` 的首次确认（spec §4.6 第 2 条）。
 *
 * 它**走现成的 ask broker，不新发明挂起机制** —— 所以这里用的是真的
 * `QuestionBroker`，只把 UI 那一侧换成记录器。守的是三件事：
 * 注册顺序、「没表态不等于同意」、以及账号只到用户屏幕为止。
 */

function harness() {
  const broker = new QuestionBroker();
  const opened: Array<{ toolCallId: string; questions: AskQuestion[] }> = [];
  const closed: Array<{ toolCallId: string; outcome: AskOutcome }> = [];
  const order: string[] = [];
  const shared = {
    onOpened: (toolCallId: string, questions: AskQuestion[]) => {
      order.push('onOpened');
      // **顺序不能反**：UI 打开时 broker 必须已经准备好，否则用户手快提交会被
      // 当成迟到消息丢弃。这里就地验证 pending 已经在了。
      order.push(broker.cancel('nope', 'nope') === false ? 'brokerAlive' : 'x');
      opened.push({ toolCallId, questions });
    },
    onClosed: (toolCallId: string, outcome: AskOutcome) => { order.push('onClosed'); closed.push({ toolCallId, outcome }); },
  };
  const ask = createLoginAsk('thread-1', shared, broker);
  return { broker, shared, opened, closed, order, ask };
}

const ARGS = { host: 'iaaa.pku.edu.cn', username: 'u2100011000', institutionName: '北京大学' };

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
  /** 与 askUserQuestionTool 一字不差：先注册 pending，再通知 UI。 */
  it('先 broker.ask 注册，再 onOpened 通知 UI', async () => {
    const h = harness();
    const p = h.ask('call-1', ARGS);
    expect(h.order.slice(0, 2)).toEqual(['onOpened', 'brokerAlive']);
    const q = h.opened[0].questions[0];
    h.broker.submit('thread-1', 'call-1', [{ questionId: q.id, kind: 'answered', optionIds: [q.options[0].id] }]);
    await p;
    expect(h.order).toContain('onClosed');
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
