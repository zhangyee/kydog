import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFixtureSession } from './fixtureProvider';
import { pickFixtureEvents, type FixtureEvent, type FixtureFile } from '../../../e2e/fixtures/fixture.types';
import { encodeUserTurn } from '../../shared/userTurn';

/**
 * fixture 的 `scripts` 形状：同一次启动里按用户这一轮发的原文挑剧本，e2e 靠它让几个流式场景
 * 共用一次冷启动。要钉的是「挑得对、挑不到就响、停过一轮不连累下一轮」。
 */

const noopAskShared = { onOpened: () => {}, onClosed: () => {} };

/** 一轮只说一句话的最小剧本。 */
const say = (text: string, afterMs = 0): FixtureEvent[] => [
  { after_ms: 0, type: 'agent_start' },
  { after_ms: afterMs, type: 'text_delta', messageId: 'm1', delta: text },
  { after_ms: 0, type: 'agent_end', reason: 'completed' },
];

type PiEvent = { type: string; [k: string]: unknown };
const textsOf = (events: PiEvent[]) => events
  .filter((e) => e.type === 'message_update')
  .map((e) => (e.assistantMessageEvent as { delta: string }).delta);

let dir = '';
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kydog-fixp-')); });

async function sessionOf(file: FixtureFile) {
  const p = path.join(dir, 'f.json');
  await fsp.writeFile(p, JSON.stringify(file));
  const session = await createFixtureSession(p, noopAskShared, 't1', 'zh');
  const events: PiEvent[] = [];
  session.subscribe((e) => events.push(e));
  return { session, events };
}

describe('pickFixtureEvents', () => {
  it('events 形状不看用户发了什么；scripts 形状按 trim 后的原文逐字挑', () => {
    const one = say('一');
    expect(pickFixtureEvents({ events: one }, '随便什么')).toBe(one);
    const a = say('甲'); const b = say('乙');
    const file: FixtureFile = { scripts: { 甲: a, 乙: b } };
    expect(pickFixtureEvents(file, '  乙\n')).toBe(b);
    expect(pickFixtureEvents(file, '甲')).toBe(a);
  });

  it('挑不到就抛，并列出有哪些剧本（不回落到任何一份）', () => {
    const file: FixtureFile = { scripts: { 甲: say('甲'), 乙: say('乙') } };
    expect(() => pickFixtureEvents(file, '丙')).toThrow(/没有名为「丙」的剧本；有：「甲」、「乙」/);
  });

  it('scripts：带结构块的消息按正文挑剧本（结构块不参与匹配）', () => {
    const one: FixtureEvent[] = [{ after_ms: 0, type: 'agent_start' }];
    const file: FixtureFile = { scripts: { 看图: one } };
    const { text } = encodeUserTurn({ body: '看图', attachments: [{ kind: 'image', name: '截图 1', data: 'A', mimeType: 'image/png' }], comments: [] });
    expect(pickFixtureEvents(file, text, 1)).toBe(one);
    expect(pickFixtureEvents(file, '看图')).toBe(one);
    expect(() => pickFixtureEvents(file, text, 0)).toThrow(/没有名为/);
  });
});

describe('createFixtureSession × scripts', () => {
  it('同一个 session 连发两轮，各放各的剧本', async () => {
    const { session, events } = await sessionOf({ scripts: { 甲: say('甲的回复'), 乙: say('乙的回复') } });
    await session.prompt('乙');
    expect(textsOf(events)).toEqual(['乙的回复']);
    await session.prompt('甲');
    expect(textsOf(events)).toEqual(['乙的回复', '甲的回复']);
  });

  it('认不到剧本：prompt 在发出任何事件之前就 reject', async () => {
    const { session, events } = await sessionOf({ scripts: { 甲: say('甲的回复') } });
    await expect(session.prompt('丙')).rejects.toThrow(/没有名为「丙」的剧本/);
    expect(events).toEqual([]);
    // 正向对照：同一个 session 换个认得的名字照常出事件 —— 上面的「一个事件都没有」不是因为订阅没接上。
    await session.prompt('甲');
    expect(textsOf(events)).toEqual(['甲的回复']);
  });

  it('每一轮都以 agent_settled 收尾（照 pi 的 finally），正常跑完与中止都发', async () => {
    const { session, events } = await sessionOf({ scripts: { 快: say('快的那句'), 慢: say('慢的那句', 10_000) } });
    await session.prompt('快');
    expect(events.map((e) => e.type).slice(-2)).toEqual(['agent_end', 'agent_settled']);

    const slow = session.prompt('慢');
    await new Promise((r) => setTimeout(r, 20));
    session.abort();
    await slow;
    expect(events.filter((e) => e.type === 'agent_settled')).toHaveLength(2);
    expect(events.at(-1)?.type).toBe('agent_settled');
  });

  it('中止只作用于那一轮：停过之后下一轮的事件照常送出', async () => {
    const { session, events } = await sessionOf({ scripts: { 慢: say('慢的那句', 10_000), 快: say('快的那句') } });
    const slow = session.prompt('慢');
    await new Promise((r) => setTimeout(r, 20));
    session.abort();
    await slow;
    // 这一轮确实被停住了：那句 10 秒后才到的话没有送出去，收场的 agent_end 照发。
    expect(textsOf(events)).toEqual([]);
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);

    await session.prompt('快');
    expect(textsOf(events)).toEqual(['快的那句']);
  });
});
