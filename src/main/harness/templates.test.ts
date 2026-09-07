import { describe, it, expect } from 'vitest';
import { harnessTemplates, type HarnessLocale } from './templates';
import { BLOCK_KINDS, PLACEHOLDER_KINDS } from '../../shared/zhSidecar';

describe('harnessTemplates', () => {
  for (const locale of ['zh', 'en'] as const) {
    it(`${locale}: 三模板齐全且占位符/路径正确`, () => {
      const t = harnessTemplates(locale);
      // ?raw 拿到的是磁盘字节，行尾随检出而变（core.autocrlf）。templates.ts 在入口处
      // 归一化成 LF —— 行尾是检出噪声、不是模板内容。这里的 no-CR 断言就是归一化的回归测试，
      // 归一化之后围栏断言收紧回严格 '---\n' 才是对的。
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
  /**
   * 译文边车的 `kind` 契约在两处：zhSidecar 的 BLOCK_KINDS / PLACEHOLDER_KINDS（运行时校验，
   * 一个不认识的值会让**整份文件**被拒），和 AGENTS.md 里给 agent 的那份说明——而模板是 agent
   * 写边车时唯一读得到的东西。取值集合改了、模板没跟上，zhSidecar.test.ts 那两条照样绿
   * （它们钉的是报错里的取值串），模板则静默过期。同 src/about ↔ e2e/39-about-page、
   * vite.main.config ↔ forge.config，是同一形状的漂移，这里补上守卫。
   *
   * 判据是**集合相等**，不是「每一项都出现过」：只断言包含的话，取值删掉一个时模板里留下的那条
   * 多余 bullet 照样全绿，漂移只守住了一个方向。
   */
  for (const locale of ['zh', 'en'] as const) {
    it(`${locale}: AGENTS.md 的 kind 契约与 zhSidecar 的取值集合一致`, () => {
      const md = harnessTemplates(locale).agents;
      // 两份模板里以 "- `x`" 开头的 bullet 只有这一处（block kind 那张表）
      const bullets = [...md.matchAll(/^- `([a-z-]+)`/gm)].map((m) => m[1]);
      expect(new Set(bullets), 'AGENTS.md 的 kind 列表与 BLOCK_KINDS 不一致').toEqual(new Set(BLOCK_KINDS));
      // placeholder 的三个值在模板里是一串行内枚举，按 zhSidecar 报错信息同样的拼法现推整串——
      // 增删或换顺序都会让这个子串消失，同样是双向的。
      expect(md, 'AGENTS.md 的 placeholder kind 枚举与 PLACEHOLDER_KINDS 不一致')
        .toContain(PLACEHOLDER_KINDS.map((k) => `\`${k}\``).join(' / '));
      // 「只认这七个值 / exactly these seven values」里的数目也是这份契约的一部分：再加一个
      // kind 却不改它，agent 读到的是自相矛盾的两句话。数词表只列到手写得出的范围，超出即红
      // ——逼人回来同时改模板与这里，正是漂移守卫该有的效果。
      const COUNT_WORD: Record<HarnessLocale, Record<number, string>> = {
        zh: { 4: '四', 5: '五', 6: '六', 7: '七', 8: '八' },
        en: { 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight' },
      };
      const word = COUNT_WORD[locale][BLOCK_KINDS.length];
      expect(word, `数词表里没有 ${BLOCK_KINDS.length} 的写法，补一条再改模板`).toBeDefined();
      expect(md, `AGENTS.md 里 kind 的数目说法应当是「${word}」`)
        .toContain(locale === 'zh' ? `只认这${word}个值` : `exactly these ${word} values`);
    });
  }

  it('zh 含用户指定语句', () => {
    const t = harnessTemplates('zh');
    expect(t.soul).toContain('陌生不等于浅薄');
    expect(t.agents).toContain('像跨学科合作者之间那样讲解');
  });

  /**
   * glossary 从「保留字段」变成流水线真会读的输入（翻译流水线 spec §2.6 / §3），而模板是 agent
   * 写边车时唯一读得到的说明。同上面那条 kind 契约的守卫，防止它静默过期。
   */
  it('两份 AGENTS.md 都写了 glossary 契约', () => {
    for (const locale of ['zh', 'en'] as const) {
      expect(harnessTemplates(locale).agents).toContain('glossary');
    }
  });

  /**
   * `failedPages` 与 glossary 不同：它**不是**给 agent 写的——是内置翻译那一趟自己的产物，
   * 手写边车的 agent 压根没有「失败页」这个概念。模板里仍然要有一句，理由是校验会拒：
   * validateTranslatedDoc 现在校验这个字段，而 agent 读得到已有边车里的它（用户先跑过一次
   * 内置翻译、再让 agent 修某几页，是主工作流），照抄时写歪一个值就是**整份文件**被拒。
   * 模板是 agent 唯一读得到的契约，沉默等于让它猜。
   */
  it('两份 AGENTS.md 都点名 failedPages 由内置翻译写、agent 不用写', () => {
    for (const locale of ['zh', 'en'] as const) {
      expect(harnessTemplates(locale).agents).toContain('failedPages');
    }
  });

  /**
   * failureReasons 与 failedPages 同一趟写、同一份写入方约束——同样的漂移风险，同样的守法。
   */
  it('两份 AGENTS.md 都点名 failureReasons 由内置翻译写、agent 不用写', () => {
    for (const locale of ['zh', 'en'] as const) {
      expect(harnessTemplates(locale).agents).toContain('failureReasons');
    }
  });
});
