import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { ACTION_KINDS, KEY_NAMES, MAX_REPEAT_TIMES, MAX_STEPS, WAIT_DEFAULT_MS, WAIT_MAX_MS } from '../browser/actions';
import { MAX_FIELDS, MAX_ROWS, MAX_FIELD_CHARS, MAX_BATCH_CHARS } from '../browser/extract';
import { DEFAULT_NODE_LIMIT, PAGE_CONTENT_OPEN, PAGE_CONTENT_CLOSE } from '../browser/snapshot';
import { MAX_TABS } from '../browser/tabRegistry';
import { READ_MAX_CHARS } from '../agent/browserTools';
import * as actionsNs from '../browser/actions';
import * as extractNs from '../browser/extract';
import * as snapshotNs from '../browser/snapshot';
import * as tabRegistryNs from '../browser/tabRegistry';
import * as browserToolsNs from '../agent/browserTools';

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

/**
 * 一条对账：`zh`/`en` 各一条带**一个捕获组**的正则，捕获到的数必须等于 `value`。
 *
 * `constant` 是生产侧那个具名导出的名字。它不是给人看的标签 —— 下面「这张表自己的守卫」
 * 拿它与模块的导出表对账，删掉一行就红。
 */
type Check = { constant: string; what: string; value: number; file: string; zh: RegExp; en: RegExp };

const CHECKS: Check[] = [
  {
    constant: 'MAX_STEPS', what: 'MAX_STEPS（一批展开后的步数上限）', value: MAX_STEPS, file: 'references/browser.md',
    zh: /展开后 ≤ (\d+) 步/g, en: /At most (\d+) steps after expansion/g,
  },
  {
    constant: 'MAX_REPEAT_TIMES', what: 'MAX_REPEAT_TIMES（repeat.times 上限）', value: MAX_REPEAT_TIMES, file: 'references/browser.md',
    zh: /`(?:repeat\.)?times` ≤ (\d+)/g, en: /`(?:repeat\.)?times` ≤ (\d+)/g,
  },
  {
    constant: 'WAIT_DEFAULT_MS', what: 'WAIT_DEFAULT_MS（wait 默认时限）', value: WAIT_DEFAULT_MS, file: 'references/browser.md',
    zh: /`timeoutMs` 不写就是 \*\*(\d+)\*\*/g, en: /`timeoutMs` defaults to \*\*(\d+)\*\*/g,
  },
  {
    constant: 'WAIT_MAX_MS', what: 'WAIT_MAX_MS（wait 时限上限）', value: WAIT_MAX_MS, file: 'references/browser.md',
    zh: /上限 \*\*(\d+)\*\*/g, en: /capped at \*\*(\d+)\*\*/g,
  },
  {
    constant: 'MAX_FIELDS', what: 'MAX_FIELDS（extract 的字段数上限）', value: MAX_FIELDS, file: 'references/browser.md',
    zh: /最多 (\d+) 个字段/g, en: /At most (\d+) fields/g,
  },
  {
    constant: 'MAX_ROWS', what: 'MAX_ROWS（单次 extract 的行数上限）', value: MAX_ROWS, file: 'references/browser.md',
    zh: /最多 (\d+) 行/g, en: /At most (\d+) rows per/g,
  },
  {
    constant: 'MAX_FIELD_CHARS', what: 'MAX_FIELD_CHARS（单格字符上限）', value: MAX_FIELD_CHARS, file: 'references/browser.md',
    zh: /单格最多 (\d+) 字符/g, en: /(\d+) characters per cell/g,
  },
  {
    constant: 'MAX_BATCH_CHARS', what: 'MAX_BATCH_CHARS（整批 extract 的字符预算）', value: MAX_BATCH_CHARS, file: 'references/browser.md',
    zh: /合计约 (\d+) 字符/g, en: /about \*\*(\d+)\s+characters for all/g,
  },
  {
    constant: 'DEFAULT_NODE_LIMIT', what: 'DEFAULT_NODE_LIMIT（一份快照显示多少条）', value: DEFAULT_NODE_LIMIT, file: 'references/browser.md',
    zh: /一次最多显示 (\d+) 条元素/g, en: /at most (\d+)\s+elements are displayed/g,
  },
  {
    constant: 'READ_MAX_CHARS', what: 'READ_MAX_CHARS（browser_read 的正文上限）', value: READ_MAX_CHARS, file: 'references/browser.md',
    zh: /一次最多带回 (\d+) 字符/g, en: /brings back at most (\d+) characters/g,
  },
  {
    constant: 'MAX_TABS', what: 'MAX_TABS（标签数硬上限）', value: MAX_TABS, file: 'SKILL.md',
    zh: /工具硬上限是 (\d+)/g, en: /the tool's hard cap is (\d+)/g,
  },
  {
    constant: 'KEY_NAMES', what: 'KEY_NAMES 的个数（「只认这 N 个名字」）', value: KEY_NAMES.length, file: 'references/browser.md',
    zh: /只认这 (\d+) 个名字/g, en: /accepts only these (\d+) names/g,
  },
];

/**
 * **这张表自己的守卫。**
 *
 * 复审变异 M11：从 `CHECKS` 里删掉 `READ_MAX_CHARS` 那一行 → 210 个文件全绿（3079/3079），
 * 只是总数从 3080 掉到 3079，要靠人盯计数才看得出来。被它守住的那条文档常数就此重新裸奔 ——
 * **守卫自己没有人守**。
 *
 * 补法不是在这里再抄一份名单（那又是一份要维护的副本），而是**拿生产模块自己的导出表对账**：
 * 这五个模块导出的每一个数值常量，就是「文档里写着、模型照抄」的那一批上限。事实来源是
 * 模块的导出表，删掉 `CHECKS` 里的任何一行都会在这里红。
 *
 * 反过来也守：给这几个模块新加一个数值上限而不往文档与 `CHECKS` 里加一行，同样红 ——
 * 那正是「模型不知道有这个上限」的形状。要么写进文档，要么把常量收回模块内部不导出。
 */
const NUMERIC_EXPORTS: Record<string, number> = Object.fromEntries(
  [actionsNs, extractNs, snapshotNs, tabRegistryNs, browserToolsNs]
    .flatMap((ns) => Object.entries(ns as Record<string, unknown>))
    .filter((e): e is [string, number] => typeof e[1] === 'number'),
);

/** `KEY_NAMES` 守的是**个数**（「只认这 13 个名字」）。它是导出数组的长度、不是一个数值
 *  导出，所以单列一行 —— 数字仍然来自生产代码，这里一个都不抄。 */
const COUNTED_EXPORTS: Record<string, number> = { KEY_NAMES: KEY_NAMES.length };

const GUARDED: Record<string, number> = { ...NUMERIC_EXPORTS, ...COUNTED_EXPORTS };

describe('对账表自己也要有人守（复审变异 M11）', () => {
  it('这五个模块导出的数值上限一个不落地解析出来了', () => {
    // 解析垮了（改名、换导出方式）的话下面两条就成了空转 —— 先把它钉住。
    expect(Object.keys(NUMERIC_EXPORTS).length,
      '从生产模块里一个数值常量都没解析出来，下面两条对账就是空转').toBeGreaterThan(5);
  });

  it('生产侧每一个上限在 CHECKS 里都有人守', () => {
    for (const [name, value] of Object.entries(GUARDED)) {
      const row = CHECKS.find((c) => c.constant === name);
      expect(row?.value,
        `${name} 在 CHECKS 里没有人守（这一行被删了？），`
        + '或者那一行接的不是它 —— 它在 slowpaper 文档里的那个数从此无人看管').toBe(value);
    }
  });

  it('CHECKS 里没有守着一个已经不存在的常量的行', () => {
    for (const c of CHECKS) {
      expect(Object.keys(GUARDED),
        `CHECKS 里的 ${c.constant} 不在生产侧的上限清单里 —— 常量改名或没了，这一行在空转`)
        .toContain(c.constant);
    }
  });
});

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

  // I-2：`导航: [tab_…]` 那一行是「403 在 `browser_act` 的提交点击之后才到达」时**唯一**的
  // 判据 —— Scholar 的可达性表写着首页 200、搜索才 403，而 `browser_act` 不等导航，
  // 那次导航的状态码要晚一个往返才落地。与成功判据同一个形状：文档这一侧写的必须与
  // `browserTools` 实发的前缀逐字相同，**改了代码那一侧也要红**（不然模型认不出那一行，
  // 这条判据就只是文档里的一句空话）。
  const NAV_LINE = '导航: ';
  it('未报导航那一行的前缀与 browserTools 发出来的逐字相同', () => {
    const src = readFileSync(path.resolve(__dirname, '..', 'agent', 'browserTools.ts'), 'utf-8');
    expect(src, 'browserTools.ts 不再发这一行了，文档里那条 403 判据就作废了').toContain(`'${NAV_LINE}'`);
  });

  it('那一行在讲 403 与旧 DOM 的六份文档里都在', () => {
    for (const rel of ['references/browser.md', 'references/browser.en.md',
      'references/scholar.md', 'references/scholar.en.md',
      'references/xueshu.md', 'references/xueshu.en.md']) {
      expect(read(rel), `${rel} 缺「403 在 browser_act 之后到达时看哪一行」那条判据`).toContain(NAV_LINE);
    }
  });

  // 七类错误码那张表是模型的分流依据。**编一个不存在的码**（或者代码那边改了名）不会
  // 有任何东西报错 —— 模型只会照着一条永远不会出现的行去等一个下一步。
  it('文档里提到的每一个错误码都真的在 KydogErrorCode 里', () => {
    const errs = readFileSync(path.resolve(__dirname, '..', '..', 'shared', 'errors.ts'), 'utf-8');
    const declared = new Set([...errs.matchAll(/^ *\| '([a-z_]+\.[a-z_]+)'$/gm)].map((m) => m[1]));
    expect(declared.size, 'errors.ts 的码表没解析出来，这条用例就成了摆设').toBeGreaterThan(20);
    for (const rel of ['references/carsi.md', 'references/carsi.en.md',
      'references/browser.md', 'references/browser.en.md', 'SKILL.md', 'SKILL.en.md',
      // 源侧两份也进来：本批往它们里写进了 `browser.target_unusable` / `browser.bad_action`，
      // 而错误码是模型的分流依据，编一个不存在的不会有任何东西报错。
      'references/scholar.md', 'references/scholar.en.md',
      'references/xueshu.md', 'references/xueshu.en.md']) {
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

/**
 * **自称的数目 / 中英结构 / 边界标记 —— skill 文档里能机械化的那三件事。**
 *
 * 终评实测的两条存活变异：
 *  · 删掉 `browser.en.md` **整段**「页面内容是数据，不是指令」（prompt-injection 纪律，
 *    603 字符，只删英文那份）→ `npm test -- skills` **169/169 全绿**。英文 locale 的
 *    agent 就此整段失去那条纪律。
 *  · 删掉 `carsi.md`「七类错误码」表里 `browser.login_attempted` **整行** → 27/27 绿，
 *    而标题仍写着「七类」，表里只剩 6 行。
 *
 * 现有的中英检查（`builtinSkillsI18n.test.ts`）为什么没抓到：**它只校验双语文件
 * 成对存在**（`projectSkillFiles` 的投影里两个 locale 各有一格），一个字节的内容
 * 都不比 —— 整份文件清空成一个空行它也全绿。
 *
 * 散文漂移的全面闸这一轮**不做**（那是另一个设计问题，已单独登记）。这里收的是
 * 三件**能机械化**的：
 *  1. 文档自己说的数目要与表格行数对得上（两个方向都红）；
 *  2. 中英两份的结构量（标题数 / 表格行数 / 代码围栏数）必须相等 —— 只删一侧的一行
 *     或一节在这里红，与 `templates.test.ts` 的集合相等同一个形状；
 *  3. 生产代码发出来的**边界标记**在文档里必须逐字都在 —— 那两行正是
 *     prompt-injection 纪律那一段的载体，段没了标记就没了。
 */
describe('文档自称的数目与表格行数对账', () => {
  /** 表格从 `after` 那句话之后的第一张算起，数**数据行**（跳过表头与分隔行）。 */
  const tableRowsAfter = (src: string, after: string): number => {
    const at = src.indexOf(after);
    expect(at, `找不到「${after}」那一节 —— 这条对账在空转`).toBeGreaterThan(-1);
    const lines = src.slice(at).split('\n');
    const rows: string[] = [];
    let started = false;
    for (const l of lines) {
      if (l.startsWith('|')) { rows.push(l); started = true; continue; }
      if (started) break;
    }
    // 表头一行 + 分隔行一行
    expect(rows.length, `「${after}」后面那张表不成形（只有 ${rows.length} 行）`).toBeGreaterThan(2);
    return rows.length - 2;
  };

  const CN_NUM: Record<string, number> = { 七: 7, 八: 8, 六: 6, 五: 5, 四: 4, 三: 3 };

  it('carsi：标题说几类，表里就得有几行（中英各一份）', () => {
    const zh = read('references/carsi.md');
    const m = /##\s*四、([一二三四五六七八九十])类错误码/.exec(zh);
    expect(m, 'carsi.md 里「N 类错误码」那个标题不见了').not.toBeNull();
    const said = CN_NUM[m![1]];
    expect(said, `标题里的「${m![1]}」不在中文数字表里，补一条`).toBeGreaterThan(0);
    expect(tableRowsAfter(zh, m![0]),
      `carsi.md 的标题自称 ${said} 类，表里的数据行不是这个数 —— `
      + '删一行 / 加一行都不会有任何东西报错，而这张表是模型的分流依据').toBe(said);

    const en = read('references/carsi.en.md');
    const me = /##\s*4\.\s*(Seven|Eight|Six|Five)\s+classes of error code/.exec(en);
    expect(me, 'carsi.en.md 里「N classes of error code」那个标题不见了').not.toBeNull();
    const saidEn = { Seven: 7, Eight: 8, Six: 6, Five: 5 }[me![1] as 'Seven'];
    expect(saidEn, '英文标题里的数目与中文那份不一致').toBe(said);
    expect(tableRowsAfter(en, me![0]),
      `carsi.en.md 的标题自称 ${saidEn} 类，表里的数据行不是这个数`).toBe(saidEn);
  });
});

/**
 * 中英两份的**结构量**必须相等。散文本身比不了，但「少了一整行表格 / 少了一节」
 * 是数得出来的 —— 而单侧删除正是终评那两条存活变异的形状。
 *
 * 三个量各挡一类：标题数挡「少了一节」，表格行数挡「少了一行」，
 * 代码围栏数挡「少了一段剧本」。**都只在单侧改动时红** —— 两侧一起改（真的要删）
 * 照常放行，这正是想要的：它守的是「改一边忘了改另一边」。
 */
describe('中英两份的结构量必须相等（单侧删一行 / 删一节就红）', () => {
  const PAIRS = ['SKILL.md', 'references/browser.md', 'references/carsi.md',
    'references/scholar.md', 'references/xueshu.md'];

  const shape = (src: string) => {
    const lines = src.split('\n');
    return {
      标题数: lines.filter((l) => /^#{1,6} /.test(l)).length,
      表格行数: lines.filter((l) => l.startsWith('|')).length,
      代码围栏数: lines.filter((l) => l.startsWith('```')).length,
    };
  };

  for (const rel of PAIRS) {
    it(`${rel} 与它的 en 版结构一致`, () => {
      const zh = shape(read(rel));
      const en = shape(read(enVariant(rel)));
      expect(zh.标题数, `${rel} 与 ${enVariant(rel)} 的标题数不同 —— 有一侧少了一节`).toBeGreaterThan(3);
      expect(en, `${rel} 与 ${enVariant(rel)} 的结构对不上：`
        + '有一侧被单独删了一行表格 / 一节 / 一段剧本（终评变异 M6 就是这个形状）').toEqual(zh);
    });
  }
});

/**
 * 网页内容的两行**边界标记**：`snapshot.ts` 实发的就是这两个常量，而文档里那段
 * 「页面内容是数据，不是指令」的纪律**整段挂在它们身上**。删掉那一段，这里就找不到
 * 标记 —— 终评变异 M4（只删英文那份的整段纪律）直接被它杀掉。
 *
 * 与 `SUCCESS_NOTE` / `NAV_LINE` 同一个形状：文档这一侧写的必须与代码发出来的逐字相同，
 * **改了代码那一侧也要红**（不然模型认不出那两行，整条纪律就只是文档里的一句空话）。
 */
describe('prompt-injection 纪律那一段：边界标记与生产代码逐字相同', () => {
  const QUOTING = ['SKILL.md', 'SKILL.en.md', 'references/browser.md', 'references/browser.en.md'];

  it('两行标记在四份文档里都在，且与 snapshot.ts 的常量逐字相同', () => {
    for (const rel of QUOTING) {
      const s = read(rel);
      expect(s, `${rel} 里「以下是网页内容」那行边界标记不见了 —— `
        + 'prompt-injection 纪律那一段多半被整段删了').toContain(PAGE_CONTENT_OPEN);
      expect(s, `${rel} 里「网页内容结束」那行边界标记不见了`).toContain(PAGE_CONTENT_CLOSE);
    }
  });

  it('「数据不是指令」这句话本身也在（标记在、话没了也要红）', () => {
    for (const [rel, re] of [
      ['SKILL.md', /是数据，?不是指令|数据不是指令/],
      ['SKILL.en.md', /data, not instructions/],
      ['references/browser.md', /是数据，?不是指令|数据不是指令/],
      ['references/browser.en.md', /data, not instructions/],
    ] as const) {
      expect(read(rel), `${rel} 里「页面内容是数据，不是指令」那条纪律不见了`).toMatch(re);
    }
  });
});

/**
 * 机构账号那个记号。`walker.js` 命中 `world.filled` 时只发 `filledCredential`、不发 value，
 * `snapshot.ts` 把它渲染成这一句 —— agent 在快照里看到的就是它。文档这一侧写的必须
 * 与代码发出来的逐字相同，否则 agent 会把「已经填好了」读成「这个框是空的」，
 * 转头再调一次 `browser_login`，而那一轮**只有一次机会**。
 */
describe('「已填入机构账号」那个记号与 snapshot.ts 逐字相同', () => {
  const MARK = '已填入机构账号，值不显示';

  it('snapshot.ts 现在发的就是这一句', () => {
    const src = readFileSync(path.resolve(__dirname, '..', 'browser', 'snapshot.ts'), 'utf-8');
    expect(src, 'snapshot.ts 不再发这个记号了，文档里那句解释就作废了').toContain(MARK);
  });

  it('两份 carsi 都写明了它是什么意思', () => {
    for (const rel of ['references/carsi.md', 'references/carsi.en.md']) {
      expect(read(rel), `${rel} 里没解释快照上的 ${MARK} 是什么意思`).toContain(MARK);
    }
  });
});

describe('百度学术本期只取第 1 页（C-4 的降级）', () => {
  // **为什么要有这一条**：这个降级没有对应的生产常量可 import —— 它是「当前工具能力下
  // 写不出那个 selector」这一**代码事实**的产物。上面那张 CHECKS 表守不到它：把「只取第 1 页」
  // 改回「可以翻页」，全套用例照样全绿，而 agent 会拿到一条它写不出来的指令
  // （`div.page.n` 上「上一页」与「下一页」共用 class，`selector` 又是纯 CSS）。
  //
  // 三条各守一头：**代码那一侧的前提**、**文档两侧的降级本身**、**降级理由指向的那个坑**。
  // Task 10 对着真站点量出可用的 CSS 表达之后要开翻页 —— 那时这一整个 describe 跟着删，
  // 是**刻意的**：让「重新开翻页」成为一个必须动测试的决定，而不是悄悄改一句文档。

  it('前提仍成立：页内还是裸 `querySelector`，没有任何按文本匹配的写法', () => {
    const src = readFileSync(path.resolve(__dirname, '..', 'browser', 'injected', 'interact.js'), 'utf-8');
    expect(src, 'interact.js 不再用 querySelector 解析 selector 了，降级的前提要重新判').toContain('querySelector(t.selector)');
    // 有了文本匹配，「下一页」就写得出来，这条降级也就该撤销 —— 所以它红了是要人来看的信号。
    expect(src, 'interact.js 里出现了文本匹配，百度学术的翻页降级该重新裁决了').not.toMatch(/:has-text|:contains\(/);
  });

  it('两份 xueshu 与两份 SKILL 都写明了「本期只有第 1 页」', () => {
    for (const [rel, re] of [
      ['references/xueshu.md', /本期只取结果页的第 1 页/],
      ['references/xueshu.en.md', /takes only the first results page/],
      ['SKILL.md', /百度学术本期只有第 1 页/],
      ['SKILL.en.md', /Baidu Xueshu has only page 1 this release/],
    ] as const) {
      expect(read(rel), `${rel} 里「百度学术本期只有第 1 页」那句话不见了`).toMatch(re);
    }
  });

  // **N-1**：改一处忘了改指向它的那处。上一轮删掉了翻页那个没用的 `wait`
  // （`div.page.active` 点击前就成立），却把 `SKILL.md` 索引行里「翻页必须跟 `wait`」留着了 ——
  // agent 带着那个预期进 `xueshu.md`、正文里找不到条件就会**自己发明一个**，最顺手的正是
  // 刚被删掉的那一个。所以索引行与正文要一起守：正反两头各一条，改哪一边都红。
  it('SKILL 的索引行与 xueshu 正文一致：说的是检索提交，不是翻页（N-1）', () => {
    for (const [rel, must, mustNot] of [
      ['SKILL.md', [/检索提交必须跟/, /只取第 1 页/], /翻页必须跟/],
      ['SKILL.en.md', [/search submit must be followed by/, /only page 1 this release/], /paging must be followed by/],
    ] as const) {
      // §六「往下读哪一份」那张表的行，不是 §三 预算表里顺带提到它的那一行。
      const row = read(rel).split('\n').find((l) => l.startsWith('| `references/xueshu.md`'));
      expect(row, `${rel} 里找不到指向 references/xueshu.md 的索引行`).toBeDefined();
      for (const re of must) {
        expect(row ?? '', `${rel} 的 xueshu 索引行不再与正文一致（缺 ${re.source}）`).toMatch(re);
      }
      expect(row ?? '', `${rel} 的索引行又要求「翻页必须跟 wait」了 —— 正文里本期根本不翻页，`
        + 'agent 找不到那个条件就会自己发明一个（多半正是被删掉的 div.page.active）').not.toMatch(mustNot);
    }
  });

  it('两份 xueshu 的剧本里没有任何按「下一页」定位的 selector', () => {
    for (const rel of ['references/xueshu.md', 'references/xueshu.en.md']) {
      const values = [...read(rel).matchAll(/"selector"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
      for (const v of values) {
        // 纯 CSS 的 querySelector 认不出「下一页」这三个字：写进 selector 要么被判非法
        // （`browser.bad_action`），要么退成裸 `div.page.n` 命中「上一页」往回翻。
        expect(v, `${rel} 的剧本里又出现了一个按文本定位「下一页」的 selector：${v}`).not.toContain('下一页');
      }
    }
  });
});
