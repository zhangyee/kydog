import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { ACTION_KINDS, KEY_NAMES, MAX_REPEAT_TIMES, MAX_STEPS, WAIT_DEFAULT_MS, WAIT_MAX_MS } from '../browser/actions';
import { MAX_FIELDS, MAX_ROWS, MAX_FIELD_CHARS, MAX_BATCH_CHARS } from '../browser/extract';
import { DEFAULT_NODE_LIMIT } from '../browser/snapshot';
import { MAX_TABS } from '../browser/tabRegistry';
import { READ_MAX_CHARS } from '../agent/browserTools';

/**
 * **slowpaper 文档里的常数、工具名、动作名、按键名与生产代码对账。**
 *
 * 为什么要有这一条：这个 skill 的产物是**给模型读的说明书**，没有编译器、没有别的用例
 * 拦着它。Task 9 评审独立做了 8 条变异，`60 步 → 600 步`、`browser_read → browser_fetch`、
 * `key → keypress`、`13 个 → 12 个`、`50 行 → 500 行` **五条全部存活**（3057 全绿）——
 * 文档正文里的每一个数值与名字当时一个都没人看守。这条用例就是那五类变异的守卫。
 *
 * 两个方向都要守，缺一个都不算数：
 *  · **值不对要红** —— 捕获到的那个数与常量不等；
 *  · **句子没了也要红** —— 一条正则一次都匹配不上就报「这句话不见了」。
 *    （只断「值对」的话，把整句删掉反而全绿：没有匹配 = 没有断言。）
 *
 * 事实来源一律是 `import` 进来的生产常量，**不在这里再抄一份数字**。
 */

const SKILLS = path.resolve(__dirname, '..', '..', 'skills', 'slowpaper');
const read = (rel: string): string => readFileSync(path.join(SKILLS, rel), 'utf-8');

/** 一条对账：`zh`/`en` 各一条带**一个捕获组**的正则，捕获到的数必须等于 `value`。 */
type Check = { what: string; value: number; file: string; zh: RegExp; en: RegExp };

const CHECKS: Check[] = [
  {
    what: 'MAX_STEPS（一批展开后的步数上限）', value: MAX_STEPS, file: 'references/browser.md',
    zh: /展开后 ≤ (\d+) 步/g, en: /At most (\d+) steps after expansion/g,
  },
  {
    what: 'MAX_REPEAT_TIMES（repeat.times 上限）', value: MAX_REPEAT_TIMES, file: 'references/browser.md',
    zh: /`(?:repeat\.)?times` ≤ (\d+)/g, en: /`(?:repeat\.)?times` ≤ (\d+)/g,
  },
  {
    what: 'WAIT_DEFAULT_MS（wait 默认时限）', value: WAIT_DEFAULT_MS, file: 'references/browser.md',
    zh: /`timeoutMs` 不写就是 \*\*(\d+)\*\*/g, en: /`timeoutMs` defaults to \*\*(\d+)\*\*/g,
  },
  {
    what: 'WAIT_MAX_MS（wait 时限上限）', value: WAIT_MAX_MS, file: 'references/browser.md',
    zh: /上限 \*\*(\d+)\*\*/g, en: /capped at \*\*(\d+)\*\*/g,
  },
  {
    what: 'MAX_FIELDS（extract 的字段数上限）', value: MAX_FIELDS, file: 'references/browser.md',
    zh: /最多 (\d+) 个字段/g, en: /At most (\d+) fields/g,
  },
  {
    what: 'MAX_ROWS（单次 extract 的行数上限）', value: MAX_ROWS, file: 'references/browser.md',
    zh: /最多 (\d+) 行/g, en: /At most (\d+) rows per/g,
  },
  {
    what: 'MAX_FIELD_CHARS（单格字符上限）', value: MAX_FIELD_CHARS, file: 'references/browser.md',
    zh: /单格最多 (\d+) 字符/g, en: /(\d+) characters per cell/g,
  },
  {
    what: 'MAX_BATCH_CHARS（整批 extract 的字符预算）', value: MAX_BATCH_CHARS, file: 'references/browser.md',
    zh: /合计约 (\d+) 字符/g, en: /about \*\*(\d+)\s+characters for all/g,
  },
  {
    what: 'DEFAULT_NODE_LIMIT（一份快照显示多少条）', value: DEFAULT_NODE_LIMIT, file: 'references/browser.md',
    zh: /一次最多显示 (\d+) 条元素/g, en: /at most (\d+)\s+elements are displayed/g,
  },
  {
    what: 'READ_MAX_CHARS（browser_read 的正文上限）', value: READ_MAX_CHARS, file: 'references/browser.md',
    zh: /一次最多带回 (\d+) 字符/g, en: /brings back at most (\d+) characters/g,
  },
  {
    what: 'MAX_TABS（标签数硬上限）', value: MAX_TABS, file: 'SKILL.md',
    zh: /工具硬上限是 (\d+)/g, en: /the tool's hard cap is (\d+)/g,
  },
  {
    what: 'KEY_NAMES 的个数（「只认这 N 个名字」）', value: KEY_NAMES.length, file: 'references/browser.md',
    zh: /只认这 (\d+) 个名字/g, en: /accepts only these (\d+) names/g,
  },
];

/** `references/browser.md` → `references/browser.en.md`。 */
const enVariant = (rel: string): string => rel.replace(/\.md$/, '.en.md');

describe('slowpaper 文档里的常数与生产代码对账', () => {
  for (const c of CHECKS) {
    it(`${c.what} = ${c.value}`, () => {
      for (const [locale, rel, re] of [
        ['zh', c.file, c.zh], ['en', enVariant(c.file), c.en],
      ] as const) {
        const found = [...read(rel).matchAll(re)].map((m) => m[1]);
        // 句子整段消失也要红 —— 没有匹配就是没有断言。
        expect(found.length, `${rel}（${locale}）里找不到「${c.what}」那句话`).toBeGreaterThan(0);
        for (const got of found) {
          expect(got, `${rel}（${locale}）写的是 ${got}，生产代码是 ${c.value}`).toBe(String(c.value));
        }
      }
    });
  }
});

describe('slowpaper 文档里的名字与生产代码对账', () => {
  // 评审变异 M5：`key`→`keypress`、`wait`→`waitFor` 当时全绿。动作名是模型照抄的东西，
  // 写错一个就是整批被 TypeBox 拒掉，而文档不会告诉它错在哪。
  it('九种动作名逐字同序（`browser.md` §二 那一行）', () => {
    const line = '`' + ACTION_KINDS.join('` · `') + '`';
    for (const rel of ['references/browser.md', 'references/browser.en.md']) {
      expect(read(rel), `${rel} 里那行动作清单与 ACTION_KINDS 不一致`).toContain(line);
    }
  });

  // 评审变异 M7：「只认这 13 个」改成 12 当时全绿（个数由上面那张表守）；
  // 这里守的是**名字本身**：少写一个、拼错一个，模型就会用一个当场报错的键名。
  it('13 个按键名逐字同序', () => {
    const names = KEY_NAMES.map((k) => `\`${k}\``);
    for (const rel of ['references/browser.md', 'references/browser.en.md']) {
      const s = read(rel);
      // 按顺序逐个往后找：顺序错、少一个、拼错一个都会在这里断掉。
      let at = s.indexOf('`Enter`');
      expect(at, `${rel} 里找不到按键白名单`).toBeGreaterThan(-1);
      for (const n of names) {
        const next = s.indexOf(n, at);
        expect(next, `${rel} 的按键白名单里按顺序找不到 ${n}`).toBeGreaterThanOrEqual(at);
        at = next + n.length;
      }
    }
  });

  // 评审变异 M2：`browser_read`→`browser_fetch` 当时全绿。工具名写错，模型调一个
  // 不存在的工具；而 skill 文档是它唯一的名字来源之一。
  it('四个工具名都在，且没有第五个 `browser_*`', () => {
    const REAL = ['browser_open', 'browser_act', 'browser_read', 'browser_login'];
    // 文档里明写「没有这两个」的两个名字是**有意提到**的，不算多出来的工具。
    const DENIED = ['browser_close', 'browser_tabs'];
    for (const rel of ['references/browser.md', 'references/browser.en.md',
      'SKILL.md', 'SKILL.en.md', 'references/carsi.md', 'references/carsi.en.md']) {
      const s = read(rel);
      const mentioned = new Set([...s.matchAll(/browser_[a-z_]+/g)].map((m) => m[0]));
      for (const name of mentioned) {
        expect([...REAL, ...DENIED], `${rel} 提到了一个不存在的工具 ${name}`).toContain(name);
      }
    }
    // 四个都必须在 browser.md 的工具一览里出现 —— 少一个就是模型不知道有它。
    const overview = read('references/browser.md');
    for (const name of REAL) expect(overview).toContain(name);
  });

  // browser_login 那条线的契约（Task 7 交下来的五条）各自的**判据字面量**。
  // 它们不是散文，是模型要在工具结果里逐字认出来的串 —— 改写或译过去就等于判据作废。
  //
  // **成功判据那句话两头都要对**：文档这一侧写的必须与 `loginFlow.noteFor` 里那句原文
  // 逐字相同。只断文档里有这句话的话，改了代码那一侧文档照样全绿 —— 而模型读的是代码
  // 发出来的那一句，认不出就永远不知道自己登进去没有。
  const SUCCESS_NOTE = '已看到 SAML 断言回传';
  it('成功判据那句原文与 loginFlow 发出来的逐字相同', () => {
    const src = readFileSync(path.resolve(__dirname, '..', 'browser', 'loginFlow.ts'), 'utf-8');
    expect(src, `loginFlow.ts 不再发这句话了，文档里那条唯一的成功判据就作废了`).toContain(SUCCESS_NOTE);
  });

  it('机构登录的判据字面量在四份文档里都在', () => {
    for (const rel of ['references/carsi.md', 'references/carsi.en.md',
      'references/browser.md', 'references/browser.en.md']) {
      const s = read(rel);
      expect(s, `${rel} 缺唯一的成功判据那句原文`).toContain(SUCCESS_NOTE);
      expect(s, `${rel} 缺「一轮一次机会」的错误码`).toContain('browser.login_attempted');
      expect(s, `${rel} 缺「submit 不给就是不提交」`).toMatch(/submit: true|submit` 不给|Omitting `submit`/);
    }
  });

  // 七类错误码那张表是模型的分流依据。**编一个不存在的码**（或者代码那边改了名）不会
  // 有任何东西报错 —— 模型只会照着一条永远不会出现的行去等一个下一步。
  it('文档里提到的每一个错误码都真的在 KydogErrorCode 里', () => {
    const errs = readFileSync(path.resolve(__dirname, '..', '..', 'shared', 'errors.ts'), 'utf-8');
    const declared = new Set([...errs.matchAll(/^ *\| '([a-z_]+\.[a-z_]+)'$/gm)].map((m) => m[1]));
    expect(declared.size, 'errors.ts 的码表没解析出来，这条用例就成了摆设').toBeGreaterThan(20);
    for (const rel of ['references/carsi.md', 'references/carsi.en.md',
      'references/browser.md', 'references/browser.en.md', 'SKILL.md', 'SKILL.en.md']) {
      const mentioned = new Set([...read(rel).matchAll(/`((?:browser|settings|institution)\.[a-z_]+)`/g)]
        .map((m) => m[1])
        // `browser.md` 是文件名不是错误码 —— 两者形态一样，这里按扩展名摘掉。
        .filter((c) => !/\.(?:md|ts|js|json)$/.test(c)));
      expect(mentioned.size, `${rel} 里一个错误码都没提到，这条用例在这个文件上是空转`).toBeGreaterThan(0);
      for (const code of mentioned) {
        expect([...declared], `${rel} 提到了一个不存在的错误码 ${code}`).toContain(code);
      }
    }
  });
});
