export type SkillMenuItem = {
  name: string;       // 含前导 "/"
  numeral: string;    // I. II. III. IV.（仅 NewThreadEmptyState ChapterCard 用）
  title: string;
  subtitle: string;
};

export const SKILL_MENU_ITEMS: readonly SkillMenuItem[] = [
  {
    name: '/frontier',
    numeral: 'I.',
    title: '搜索某个方向的前沿进展',
    subtitle:
      '输入领域关键词，agent 并行查询 arXiv / PubMed / Semantic Scholar 并合并去重。',
  },
  {
    name: '/literature',
    numeral: 'II.',
    title: '生成课题的文献综述',
    subtitle: '基于已有 PDF 与长期记忆中的写作偏好，产出 IMRaD 结构大纲。',
  },
  {
    name: '/abstract',
    numeral: 'III.',
    title: '为一份 PDF 做结构化摘要',
    subtitle: '拖入论文，抽取贡献、方法、实验、局限；附带可引用 BibTeX。',
  },
  {
    name: '/curate',
    numeral: 'IV.',
    title: '整理今天的研究日志',
    subtitle: '扫描 daily log 与 MEMORY.md，提炼新条目、合并重复、淘汰过期项。',
  },
] as const;
