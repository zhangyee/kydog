import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SKILL_ROOT = path.resolve(__dirname, '..', '..', 'skills', 'web-research');
const read = (rel: string): string => readFileSync(path.join(SKILL_ROOT, rel), 'utf8');

function firstJsonBlock(rel: string): Record<string, unknown> {
  const match = read(rel).match(/```json\n([\s\S]*?)\n```/);
  expect(match, `${rel} 缺少可执行的 JSON 示例`).not.toBeNull();
  return JSON.parse(match![1]) as Record<string, unknown>;
}

describe('web-research 搜索卡片的真实操作路径', () => {
  it.each([
    ['references/duckduckgo.md', '中文'],
    ['references/duckduckgo.en.md', '英文'],
  ])('DuckDuckGo %s 使用已验证的 type → Enter → wait → extract 路径', (rel) => {
    const example = firstJsonBlock(rel);
    const actions = example.actions as Array<Record<string, unknown>>;

    expect(actions.map((action) => action.kind)).toEqual(['type', 'key', 'wait', 'extract']);
    expect(actions[1]).toEqual({ kind: 'key', key: 'Enter' });
    expect((example.research as Record<string, unknown>).submitActionIndex).toBe(1);
  });

  it.each([
    ['SKILL.md', /DuckDuckGo[^\n]*`type → key Enter → wait → extract`/],
    ['SKILL.en.md', /DuckDuckGo[^\n]*`type → key Enter → wait → extract`/],
  ])('%s 明确区分 DDG 的 Enter 主路径与 Google／百度的按钮路径', (rel, rule) => {
    expect(read(rel)).toMatch(rule);
  });

  it.each([
    ['SKILL.md', /有结果行的观察不得使用 `observationIds`/, /未确认跳转不得出现在 `resultIndexes`/],
    ['SKILL.en.md', /Do not use `observationIds` for an observation with result rows/, /An unresolved redirect must not appear in `resultIndexes`/],
  ])('%s 禁止整份提交结果观察，并在首次提交前排除未确认跳转', (rel, wholeObservationRule, unresolvedRule) => {
    const text = read(rel);
    expect(text).toMatch(wholeObservationRule);
    expect(text).toMatch(unresolvedRule);
  });

  it.each([
    ['references/google.md', /Google 自有的 `\/goto`/, /researchResolve/],
    ['references/google.en.md', /Google-owned `\/goto`/, /researchResolve/],
  ])('%s 把 Google 跳转结果留在首次提交前确认', (rel, redirectRule, resolverRule) => {
    const text = read(rel);
    expect(text).toMatch(redirectRule);
    expect(text).toMatch(resolverRule);
  });

  it.each([
    ['references/google.md', '中文'],
    ['references/google.en.md', '英文'],
  ])('Google %s 在输入后先收起联想层，再唯一定位可见提交按钮', (rel) => {
    const example = firstJsonBlock(rel);
    const actions = example.actions as Array<Record<string, unknown>>;
    expect(actions.map((action) => action.kind)).toEqual(['type', 'key', 'click', 'wait', 'extract']);
    expect(actions[1]).toEqual({ kind: 'key', key: 'Escape' });
    expect(actions[2]).toEqual({ kind: 'click', locator: {
      role: 'button', name: ['Google 搜索', 'Google Search'], visible: true,
    } });
    expect(actions[2]).not.toHaveProperty('index');
    expect(actions[2]).not.toHaveProperty('snapshotId');
    expect((example.research as Record<string, unknown>).submitActionIndex).toBe(2);
  });

  it.each([
    ['SKILL.md', /定范围本身不产生任何会话正文/, /完成后的会话回复不得包含“执行说明”/],
    ['SKILL.en.md', /Scoping itself produces no conversation prose/, /must not contain an “Execution notes” section/],
  ])('%s 把内部范围和执行过程留在工具参数及报告中', (rel, scopeRule, finalRule) => {
    const text = read(rel);
    expect(text).toMatch(scopeRule);
    expect(text).toMatch(finalRule);
  });

  it.each([
    ['references/report-template.md', '> 原始问题：{{用户的原始问题}}\n>\n> 检索日期：{{YYYY-MM-DD}}'],
    ['references/report-template.en.md', "> Original question: {{the user's original question}}\n>\n> Search date: {{YYYY-MM-DD}}"],
  ])('%s 让检索日期成为独立引用段落', (rel, header) => {
    expect(read(rel)).toContain(header);
  });

  it.each([
    ['references/baidu.md', /批量确认返回 `timeout`[^\n]*未确认/, /不得提交/],
    ['references/baidu.en.md', /batch resolver returns `timeout`[^\n]*unresolved/i, /must not be submitted/i],
  ])('%s 明确批量地址确认超时只淘汰该候选', (rel, timeoutRule, submitRule) => {
    const text = read(rel);
    expect(text).toMatch(timeoutRule);
    expect(text).toMatch(submitRule);
  });

  it.each([
    ['SKILL.md', /researchResolveBatch/, /批量/],
    ['SKILL.en.md', /researchResolveBatch/, /batch/i],
    ['references/bing.md', /researchResolveBatch/, /批量/],
    ['references/bing.en.md', /researchResolveBatch/, /batch/i],
    ['references/google.md', /researchResolveBatch/, /批量/],
    ['references/google.en.md', /researchResolveBatch/, /batch/i],
    ['references/baidu.md', /researchResolveBatch/, /批量/],
    ['references/baidu.en.md', /researchResolveBatch/, /batch/i],
  ])('%s 要求把短名单交给 IAB 批量地址确认', (rel, call, wording) => {
    const text = read(rel);
    expect(text).toMatch(call);
    expect(text).toMatch(wording);
  });
});
