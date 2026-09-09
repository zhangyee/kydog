import { describe, it, expect, vi } from 'vitest';
import { createAskUserQuestionTool } from './askUserQuestionTool';
import { QuestionBroker } from './questionBroker';
import { ASK_TOOL_NAME } from '../../shared/askQuestion';

const params = {
  questions: [{ question: '选哪个？', header: '选择', options: [
    { label: 'A', description: 'a' }, { label: 'B', description: 'b' },
  ] }],
};

function make() {
  const broker = new QuestionBroker();
  const onOpened = vi.fn();
  const onClosed = vi.fn();
  const tool = createAskUserQuestionTool('t1', { onOpened, onClosed }, 'zh', broker);
  return { broker, onOpened, onClosed, tool };
}

describe('createAskUserQuestionTool', () => {
  it('工具名与执行模式符合协议', () => {
    const { tool } = make();
    expect(tool.name).toBe(ASK_TOOL_NAME);
    expect(tool.executionMode).toBe('sequential');
  });

  it('onOpened 在 broker 注册之后才触发：收到回调时 submit 已能被接收', async () => {
    const { broker, onOpened, tool } = make();
    onOpened.mockImplementation((toolCallId: string) => {
      expect(broker.submit('t1', toolCallId, [
        { questionId: 'q0', kind: 'answered', optionIds: ['q0o0'] },
      ])).toBe(true);
    });
    const result = await tool.execute('tc1', params, undefined, undefined, {} as never);
    expect(onOpened).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({
      kind: 'answered',
      answers: [{ questionId: 'q0', kind: 'answered', optionIds: ['q0o0'] }],
    });
    expect(result.terminate).toBeUndefined();
  });

  it('onOpened 收到的是分配过 id 的问题', async () => {
    const { broker, onOpened, tool } = make();
    onOpened.mockImplementation((toolCallId: string) => broker.cancel('t1', toolCallId));
    await tool.execute('tc1', params, undefined, undefined, {} as never);
    expect(onOpened.mock.calls[0][1][0].id).toBe('q0');
    expect(onOpened.mock.calls[0][1][0].options[0].id).toBe('q0o0');
  });

  it('details 里连问题一起存，供历史恢复对齐 answers', async () => {
    const { broker, onOpened, tool } = make();
    onOpened.mockImplementation((toolCallId: string) => broker.cancel('t1', toolCallId));
    const result = await tool.execute('tc1', params, undefined, undefined, {} as never);
    const details = result.details as { questions: Array<{ id: string }> };
    expect(details.questions[0].id).toBe('q0');
  });

  it('取消时设 terminate 让 pi 早停', async () => {
    const { broker, onOpened, onClosed, tool } = make();
    onOpened.mockImplementation((toolCallId: string) => broker.cancel('t1', toolCallId));
    const result = await tool.execute('tc1', params, undefined, undefined, {} as never);
    expect(result.terminate).toBe(true);
    expect(result.details).toMatchObject({ kind: 'cancelled' });
    expect(onClosed).toHaveBeenCalledWith('tc1', { kind: 'cancelled' });
  });

  it('中止不设 terminate（signal 已经在终止循环了）', async () => {
    const { onOpened, tool } = make();
    const ac = new AbortController();
    onOpened.mockImplementation(() => ac.abort());
    const result = await tool.execute('tc1', params, ac.signal, undefined, {} as never);
    expect(result.terminate).toBeUndefined();
    expect(result.details).toMatchObject({ kind: 'aborted' });
  });

  it('content 是给模型读的文本', async () => {
    const { broker, onOpened, tool } = make();
    onOpened.mockImplementation((toolCallId: string) => broker.submit('t1', toolCallId, [
      { questionId: 'q0', kind: 'answered', optionIds: ['q0o0'] },
    ]));
    const result = await tool.execute('tc1', params, undefined, undefined, {} as never);
    expect(result.content).toEqual([{ type: 'text', text: '用户回答：\n- 选哪个？ → A' }]);
  });

  it('参数非法时抛错，且从未 onOpened / onClosed', async () => {
    const { onOpened, onClosed, tool } = make();
    await expect(
      tool.execute('tc1', { questions: [] }, undefined, undefined, {} as never),
    ).rejects.toThrow(/1[–-]10/);
    expect(onOpened).not.toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('参数非法时不会在 broker 里留下 pending', async () => {
    const { broker, tool } = make();
    await expect(
      tool.execute('tc1', { questions: [] }, undefined, undefined, {} as never),
    ).rejects.toThrow();
    expect(() => broker.ask('t1', 'tc2', [], undefined)).not.toThrow();
  });

  it('parameters 是 typebox schema，声明了 1–10 题与 2–8 选项', () => {
    const { tool } = make();
    const s = tool.parameters as unknown as {
      properties: { questions: { minItems: number; maxItems: number; items: {
        properties: { options: { minItems: number; maxItems: number } } } } };
    };
    expect(s.properties.questions.minItems).toBe(1);
    expect(s.properties.questions.maxItems).toBe(10);
    expect(s.properties.questions.items.properties.options.minItems).toBe(2);
    expect(s.properties.questions.items.properties.options.maxItems).toBe(8);
  });
});

/**
 * `browserTabId` 是人机交接口（spec §4.5）：带上它，渲染层就展开浏览器侧栏并切到
 * 那个标签，用户看着页面回答。**刻意不让渲染层去推断**「ask 发生时正好有 agent
 * 焦点标签」—— 那是拿时间相关性当事实。
 *
 * 形状不对时**不抛**：模型多写一个字段不该把整道题毙掉，那个字段只影响界面切不切标签。
 */
describe('createAskUserQuestionTool · browserTabId 透传', () => {
  const withTab = (browserTabId: unknown) => ({ ...params, browserTabId });

  it('给了合法字符串就原样传给 onOpened（第三个参数）', async () => {
    const { broker, onOpened, tool } = make();
    onOpened.mockImplementation((toolCallId: string) => broker.cancel('t1', toolCallId));
    await tool.execute('tc1', withTab('tab_abc12345'), undefined, undefined, {} as never);
    expect(onOpened.mock.calls[0][2]).toBe('tab_abc12345');
  });

  it('没给就是 undefined —— 不许自己编一个', async () => {
    const { broker, onOpened, tool } = make();
    onOpened.mockImplementation((toolCallId: string) => broker.cancel('t1', toolCallId));
    await tool.execute('tc1', params, undefined, undefined, {} as never);
    expect(onOpened.mock.calls[0][2]).toBeUndefined();
  });

  it('形状不对（非字符串 / 空串 / 全空格）当没给，且这道题照常问得出去', async () => {
    for (const bad of [42, null, {}, '', '   ', ['tab_x']]) {
      const { broker, onOpened, tool } = make();
      onOpened.mockImplementation((toolCallId: string) => broker.cancel('t1', toolCallId));
      const r = await tool.execute('tc1', withTab(bad), undefined, undefined, {} as never);
      expect(onOpened.mock.calls[0][2], JSON.stringify(bad)).toBeUndefined();
      expect(r.details, JSON.stringify(bad)).toMatchObject({ kind: 'cancelled' });
    }
  });
});
