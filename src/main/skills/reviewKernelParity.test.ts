import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// 评审内核在两个评审 skill 里各有一份拷贝。拷贝而不是跨 skill 引用，是因为 skill 必须
// 自包含：禁用其一不能弄断另一个 —— buildSkillsOverride 会把禁用的 skill 从 loader
// 整个过滤掉（skillResourceLoader.ts），届时「去读另一个 skill 的文件」就是断链。
// 拷贝的漂移风险由本测试钉死：两份必须逐字节相同，改内核必须两边一起改。
// 中英文各自成对；zh↔en 的内容一致性照旧归 sync-skill-docs 审核。
const SRC = path.resolve(__dirname, '..', '..', 'skills');
const COPIES = ['peer-review', 'peer-review-response'] as const;
const KERNEL_FILES = ['references/review-kernel.md', 'references/review-kernel.en.md'] as const;

describe('评审内核的两份拷贝逐字节相同', () => {
  for (const file of KERNEL_FILES) {
    it(file, () => {
      const [a, b] = COPIES.map((s) => readFileSync(path.join(SRC, s, file), 'utf8'));
      expect(a).toBe(b);
    });
  }
});
