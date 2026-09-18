import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { DESCRIPTION_MAX, parseSkillFrontmatter } from './parseSkillFrontmatter';
import { listBuiltinSkills } from './builtinSkills';

/**
 * sync-skill-docs 里那张「description 余量表」必须与真文件一致。
 *
 * 那张表是改 description 之前的预算：还能加多少字。它原先靠手工维护 —— 2026-09-17 就漂了：
 * slowpaper 表里写 389 / 991 / 余量 33，实际已是 384 / 1011 / 余量 13（全仓最紧），而表里还漏了
 * fastpaper。`builtinSkillsI18n.test.ts` 只在超过上限时才红，表漂了没有任何信号。
 *
 * 这里用生产代码的解析（`parseSkillFrontmatter`，不用正则数 —— plain scalar 里的半角 `: `
 * 会被 YAML 判成嵌套 mapping，正则看不出来）逐个量，与表逐行比对。改了 description 没更新表，
 * 这条就红，报错里给出实测数字。
 */

const SRC_ROOT = path.resolve(__dirname, '..', '..', 'skills');
const TABLE_DOC = path.resolve(__dirname, '..', '..', '..', '.claude', 'skills', 'sync-skill-docs', 'SKILL.md');

type Row = { skill: string; zh: number; en: number; margin: number; tightest: boolean };

const ROW = /^\s*\| `([a-z0-9-]+)` \| (\d+) \| (\d+) \| (\*\*)?(\d+)(\*\*)?( ← 最紧)? \|\s*$/;

function readTable(): Row[] {
  return readFileSync(TABLE_DOC, 'utf-8').split('\n').flatMap((line) => {
    const m = ROW.exec(line);
    return m ? [{ skill: m[1], zh: Number(m[2]), en: Number(m[3]), margin: Number(m[5]), tightest: m[7] !== undefined }] : [];
  });
}

async function measure(skill: string, rel: 'SKILL.md' | 'SKILL.en.md'): Promise<number> {
  const r = await parseSkillFrontmatter(readFileSync(path.join(SRC_ROOT, skill, rel), 'utf-8'));
  if (!r.ok) throw new Error(`${skill}/${rel} 解析失败：${r.reason}`);
  return r.description.length;
}

describe('sync-skill-docs 的 description 余量表与真文件一致', () => {
  it('每个内置 skill 一行，中英长度与余量逐个对得上，「最紧」标在余量最小的那一行', async () => {
    expect(existsSync(TABLE_DOC), `${TABLE_DOC} 不在`).toBe(true);
    const table = readTable();
    // 先证明表确实被解析到了 —— 行格式改了、正则一条都没匹配上时，下面的比对会空转全绿
    expect(table.length, '余量表一行都没解析到，这条用例在空转').toBeGreaterThan(0);

    const skills = listBuiltinSkills(SRC_ROOT);
    const actual: Row[] = [];
    for (const skill of skills) {
      const zh = await measure(skill, 'SKILL.md');
      const en = await measure(skill, 'SKILL.en.md');
      actual.push({ skill, zh, en, margin: DESCRIPTION_MAX - Math.max(zh, en), tightest: false });
    }
    const minMargin = Math.min(...actual.map((r) => r.margin));
    for (const r of actual) r.tightest = r.margin === minMargin;

    const byName = (rows: Row[]) => [...rows].sort((a, b) => a.skill.localeCompare(b.skill));
    expect(byName(table), `余量表与实测不符。实测应为：\n${byName(actual).map((r) =>
      `| \`${r.skill}\` | ${String(r.zh)} | ${String(r.en)} | ${r.tightest ? `**${String(r.margin)}** ← 最紧` : String(r.margin)} |`).join('\n')}`)
      .toEqual(byName(actual));
  });
});
