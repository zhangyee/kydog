import type { SkillEntry } from '../../../shared/types';

export type FeaturedSkill = {
  name: string;       // 真实 skill 名，**不含**前导 "/"
  title: string;
  subtitle: string;
};

export type FeaturedCard = FeaturedSkill & {
  numeral: string;    // I. II. III. IV.
  command: string;    // 含前导 "/"，直接填进输入框
};

/**
 * 空状态「推荐起点」的策展表，research → study → write → review 各一张卡。
 *
 * **`name` 必须是 `src/skills/` 下真实存在的 skill。** 这张表的前身写死了四条
 * 命令（`/frontier` `/literature` `/abstract` `/curate`），一条都对不上实际安装的
 * skill —— 新用户打开第一个会话，看到的四张卡点下去只是往输入框里填一条无效命令，
 * 而当时没有任何测试拦得住。`skillMenuItems.test.ts` 的漂移用例现在盯着这件事：
 * 改名或删掉某个 skill 而没同步这张表，测试变红。
 *
 * 卡片文案只放在这里，不从 SKILL.md 的 frontmatter 取：那份 `description` 是写给
 * 模型做触发判定的，两三百字并且句式是「用户说 X、Y、Z 都用这个 skill」，塞进
 * 副标题没法看。这里要的是一句人话。
 *
 * 只挑四张是版式决定的 —— 空状态是两列两行的网格。要换哪几个 skill 上榜，改这张
 * 表就行；序号不在表里，由 `pickFeaturedSkills` 按实际渲染顺序算。
 */
export const FEATURED_SKILLS: readonly FeaturedSkill[] = [
  {
    name: 'research-ideation',
    title: '评估一个研究选题',
    subtitle: '用 Heilmeier 九问把选题问清楚，再查文献核验它站不站得住。',
  },
  {
    name: 'literature-review',
    title: '生成课题的文献综述',
    subtitle: '多轮跨源检索，先找综述再反查经典，产出可直接粘进论文的研究现状。',
  },
  {
    name: 'research-frontier',
    title: '追一个方向的前沿进展',
    subtitle: '只看最近一年：谁在深耕、哪些假设被动摇、还在争什么，写给内行。',
  },
  {
    name: 'fact-check',
    title: '核验一句话站不站得住',
    subtitle: '正反两路找证据、按研究设计评估强度、反查撤稿，给出带边界的判定。',
  },
] as const;

const NUMERALS = ['I.', 'II.', 'III.', 'IV.'] as const;

/**
 * 把策展表和「已安装且启用」的 skill 求交集，按策展表的顺序返回可渲染的卡片。
 *
 * 没装或被禁用的那条**整张卡不出现**，而不是渲染成一条点不动的死链。一个都没命中
 * 时返回空数组，调用方据此把「推荐起点」整块隐藏掉。
 */
export function pickFeaturedSkills(skills: readonly SkillEntry[]): FeaturedCard[] {
  const available = new Set(skills.filter((s) => s.enabled).map((s) => s.name));
  return FEATURED_SKILLS
    .filter((f) => available.has(f.name))
    .slice(0, NUMERALS.length)
    .map((f, i) => ({ ...f, numeral: NUMERALS[i], command: `/${f.name}` }));
}
