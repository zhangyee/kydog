import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { SkillEntry } from '../../../shared/types';
import { FEATURED_SKILLS, pickFeaturedSkills } from './skillMenuItems';

// __dirname 是 src/renderer/panels/main-pane/，向上三层是 src/。
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', '..', 'skills');

/** 读 `src/skills/<name>/SKILL.md` 的 frontmatter `name:`，读不到返回 null。 */
function frontmatterName(skillDir: string): string | null {
  const file = path.join(SKILLS_ROOT, skillDir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm === null) return null;
  const line = fm[1].match(/^name:\s*(.+?)\s*$/m);
  return line === null ? null : line[1].replace(/^['"]|['"]$/g, '');
}

const entry = (name: string, enabled = true): SkillEntry =>
  ({ name, description: '', origin: 'builtin', enabled, dirPath: `/skills/${name}` });

describe('FEATURED_SKILLS 不许漂移', () => {
  // 这个用例是这张策展表存在的前提。旧版 SKILL_MENU_ITEMS 写死了 /frontier、
  // /literature、/abstract、/curate 四条，src/skills/ 下一个都不存在，新用户
  // 打开第一个会话看到的四张卡全是死链——而当时没有任何测试拦得住。
  it('每条策展项都对应 src/skills/ 下真实存在的 skill', () => {
    const broken = FEATURED_SKILLS
      .filter((f) => frontmatterName(f.name) !== f.name)
      .map((f) => `${f.name}：src/skills/${f.name}/SKILL.md 不存在，或其 frontmatter name 对不上`);
    expect(broken).toEqual([]);
  });

  it('不重复，且不超过 4 张（空状态是两列两行的网格）', () => {
    expect(new Set(FEATURED_SKILLS.map((f) => f.name)).size).toBe(FEATURED_SKILLS.length);
    expect(FEATURED_SKILLS.length).toBeLessThanOrEqual(4);
  });
});

describe('pickFeaturedSkills', () => {
  it('只渲染已安装的，没装的那条整张卡不出现', () => {
    const only = FEATURED_SKILLS[0].name;
    const picked = pickFeaturedSkills([entry(only)]);
    expect(picked.map((c) => c.name)).toEqual([only]);
  });

  it('禁用的 skill 不算已安装', () => {
    const picked = pickFeaturedSkills(FEATURED_SKILLS.map((f) => entry(f.name, false)));
    expect(picked).toEqual([]);
  });

  it('一个都没装时返回空数组——调用方据此整块不渲染', () => {
    expect(pickFeaturedSkills([])).toEqual([]);
    expect(pickFeaturedSkills([entry('some-user-skill')])).toEqual([]);
  });

  it('按策展表的顺序排，不跟着 store 里的顺序走', () => {
    const reversed = [...FEATURED_SKILLS].reverse().map((f) => entry(f.name));
    expect(pickFeaturedSkills(reversed).map((c) => c.name))
      .toEqual(FEATURED_SKILLS.map((f) => f.name));
  });

  it('序号按实际渲染顺序连续编号，不写死在策展表里', () => {
    // 少装一个的时候，序号不能跳号——写死在表里就会跳。
    const withoutFirst = FEATURED_SKILLS.slice(1).map((f) => entry(f.name));
    expect(pickFeaturedSkills(withoutFirst).map((c) => c.numeral))
      .toEqual(['I.', 'II.', 'III.'].slice(0, FEATURED_SKILLS.length - 1));
  });

  it('command 带前导斜杠，name 不带', () => {
    const picked = pickFeaturedSkills(FEATURED_SKILLS.map((f) => entry(f.name)));
    for (const c of picked) {
      expect(c.command).toBe(`/${c.name}`);
      expect(c.name.startsWith('/')).toBe(false);
    }
  });
});
