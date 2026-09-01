import { describe, it, expect } from 'vitest';
import { harnessTemplates } from './templates';

describe('harnessTemplates', () => {
  for (const locale of ['zh', 'en'] as const) {
    it(`${locale}: 三模板齐全且占位符/路径正确`, () => {
      const t = harnessTemplates(locale);
      // 认 \r\n：断言的是「以 front matter 围栏开头」，不是签出用哪种换行。
      expect(/^---\r?\n/.test(t.soul)).toBe(true);
      expect(t.soul).toContain('name: {{agentName}}');
      expect(t.user).toContain('name: {{userName}}');
      expect(t.agents).not.toContain('{{');          // AGENTS 无占位符
      expect(t.agents).toContain('~/.kydog/SOUL.md');
      expect(t.agents).toContain('~/.kydog/USER.md');
      expect(t.agents).toContain('~/.kydog/AGENTS.md');
    });
  }
  it('zh 含用户指定语句', () => {
    const t = harnessTemplates('zh');
    expect(t.soul).toContain('陌生不等于浅薄');
    expect(t.agents).toContain('像跨学科合作者之间那样讲解');
  });
});
