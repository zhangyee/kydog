import { describe, it, expect } from 'vitest';
import { harnessTemplates } from './templates';

describe('harnessTemplates', () => {
  for (const locale of ['zh', 'en'] as const) {
    it(`${locale}: 三模板齐全且占位符/路径正确`, () => {
      const t = harnessTemplates(locale);
      // ?raw 拿到的是磁盘字节，行尾随检出而变（core.autocrlf）。行尾是检出噪声、不是模板内容，
      // 必须在这一层归一化：否则 seed.ts 的 front matter 正则在 Windows 上匹配不上，
      // 称呼会漏掉引号、写出坏 YAML。
      for (const [name, text] of Object.entries(t)) {
        expect(text.includes('\r'), `${name} 模板含 CR，行尾未归一化`).toBe(false);
      }
      expect(t.soul.startsWith('---\n')).toBe(true);
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
