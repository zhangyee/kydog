import { describe, it, expect } from 'vitest';
import { renderSystemPrompt, buildKydogSystemPrompt } from './systemPrompt';
import { ASK_GUIDELINES } from './askUserQuestionTool';

describe('renderSystemPrompt', () => {
  const bash = { name: 'bash', promptGuidelines: undefined };

  it('身份交给 SOUL/USER/AGENTS，不带 pi 的默认人格与文档索引', () => {
    const prompt = renderSystemPrompt([bash]);
    for (const f of ['SOUL.md', 'USER.md', 'AGENTS.md']) expect(prompt).toContain(f);
    expect(prompt).not.toContain('expert coding assistant');
    expect(prompt).not.toContain('pi-coding-agent');
  });

  it('搬运工具自带的 promptGuidelines，按传入顺序、去重', () => {
    const prompt = renderSystemPrompt([
      { name: 'read', promptGuidelines: ['R1', 'shared'] },
      { name: 'write', promptGuidelines: ['shared', 'W1'] },
    ]);
    const lines = prompt.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual(['- R1', '- shared', '- W1', ...ASK_GUIDELINES.map((g) => `- ${g}`)]);
  });

  it('ask_user_question 的纪律一条不少', () => {
    const prompt = renderSystemPrompt([bash]);
    for (const g of ASK_GUIDELINES) expect(prompt).toContain(g);
  });

  // pi 只在没有 grep/find/ls 专用工具时才提示拿 bash 兜底；照抄它的条件，别照抄它的结论。
  it('bash 兜底提示只在缺 grep/find/ls 时出现', () => {
    expect(renderSystemPrompt([bash])).toContain('Use bash for file operations');
    expect(renderSystemPrompt([bash, { name: 'grep' }])).not.toContain('Use bash for file operations');
    expect(renderSystemPrompt([{ name: 'read' }])).not.toContain('Use bash for file operations');
  });
});

// KyDog 换掉系统提示词后，pi 的 buildSystemPrompt 走 customPrompt 分支提前 return，
// 内置工具的 promptGuidelines 不再被渲染。这条钉的是「我们确实自己搬了」：文案两边都从
// pi 的工具定义现读，pi 改了它不会漂移，KyDog 漏搬了才会红。
describe('buildKydogSystemPrompt', () => {
  it('带上 pi 内置工具声明的每一条 guideline', async () => {
    const pi = await import('@earendil-works/pi-coding-agent');
    const cwd = '/tmp/kydog-prompt-probe';
    const declared = [
      pi.createReadToolDefinition(cwd),
      pi.createEditToolDefinition(cwd),
      pi.createWriteToolDefinition(cwd),
    ].flatMap((t) => t.promptGuidelines ?? []);

    // 上游哪天把 guidelines 清空，这条会先红——否则下面的断言会退化成空转。
    expect(declared.length).toBeGreaterThan(0);

    const prompt = await buildKydogSystemPrompt(cwd);
    for (const g of declared) expect(prompt).toContain(g);
  });
});
