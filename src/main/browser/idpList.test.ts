import { describe, it, expect } from 'vitest';
import { parseIdpList, MAX_IDP_ENTRIES, MAX_IDP_SKIPPED } from './idpList';
import { KydogError } from '../../shared/errors';

describe('parseIdpList：吃下 CARSI 清单的两种真实格式', () => {
  // federation=2（国内）：值是 "<标志>|<entityID>"
  it('带 标志| 前缀的格式', () => {
    const r = parseIdpList(JSON.stringify([
      { '清华大学': '1|https://idp.tsinghua.edu.cn/idp/shibboleth' },
      { '北京大学': '1|https://idp.pku.edu.cn/idp/shibboleth' },
    ]));
    expect(r.entries).toEqual([
      { name: '清华大学', entityID: 'https://idp.tsinghua.edu.cn/idp/shibboleth', flag: '1' },
      { name: '北京大学', entityID: 'https://idp.pku.edu.cn/idp/shibboleth', flag: '1' },
    ]);
    expect(r.skipped).toEqual([]);
  });

  // federation=1（国际 eduGAIN）：值就是裸 entityID，没有前缀，而且可能是 URN
  it('裸 entityID 的格式，含 URN', () => {
    const r = parseIdpList(JSON.stringify([
      { 'University of Birmingham': 'https://idp.bham.ac.uk/shibboleth' },
      { 'University of Durham': 'urn:mace:ac.uk:sdss.ac.uk:provider:identity:dur.ac.uk' },
    ]));
    // 裸格式没有前缀 —— flag 是 null（「源里确实没有」），不是 undefined
    expect(r.entries).toEqual([
      { name: 'University of Birmingham', entityID: 'https://idp.bham.ac.uk/shibboleth', flag: null },
      { name: 'University of Durham', entityID: 'urn:mace:ac.uk:sdss.ac.uk:provider:identity:dur.ac.uk', flag: null },
    ]);
  });

  // 标志字段实测有 "1"×1045、"0"×19，含义未知。不知道含义就不能拿它过滤 ——
  // 猜错会让用户在列表里找不到自己的学校，而且不报任何错。
  it('标志为 0 的条目照样列出，不拿一个含义未知的字段过滤', () => {
    const r = parseIdpList(JSON.stringify([{ '南京理工大学': '0|https://idp.njust.edu.cn/idp/shibboleth' }]));
    expect(r.entries).toHaveLength(1);
  });

  // 官方数据里真有两条缺冒号的（新疆工业学院、广东金融学院）。
  it('entityID 不是合法 URL 也不是 URN → 跳过，并留下可见原因', () => {
    const r = parseIdpList(JSON.stringify([
      { '新疆工业学院': '1|https//idp.xjut.edu.cn/idp/shibboleth' },
      { '清华大学': '1|https://idp.tsinghua.edu.cn/idp/shibboleth' },
    ]));
    expect(r.entries.map((e) => e.name)).toEqual(['清华大学']);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].name).toBe('新疆工业学院');
    expect(r.skipped[0].reason).not.toBe('');
  });

  // 一条坏数据不能让整份清单不可用 —— 那会让用户一个学校都选不了。
  it('坏条目不影响其余条目', () => {
    const r = parseIdpList(JSON.stringify([
      { 'A': '1|https://a.edu.cn/idp/shibboleth' },
      { 'B': '' },
      { 'C': null },
      'not an object',
      { },
      { 'D': '1|https://d.edu.cn/idp/shibboleth' },
    ]));
    expect(r.entries.map((e) => e.name)).toEqual(['A', 'D']);
    // 精确 4 条，不是「至少 3 条」：坏数据有四种（空串值 / null 值 / 不是对象 / 空对象），
    // 「跳过要留痕」这条保证要四条都算数 —— 写成下界的话，任意一条改成静默 continue 都不会红。
    expect(r.skipped).toHaveLength(4);
    expect(r.skipped.map((x) => x.reason).every((x) => x !== '')).toBe(true);
  });

  it('同一个 entityID 被多个机构共用时全部保留 —— 中科院那 127 家就是这样', () => {
    const e = 'https://passport.escience.cn/idp/shibboleth';
    const r = parseIdpList(JSON.stringify([
      { '中国科学院大学': `1|${e}` }, { '中国科学院物理研究所': `1|${e}` },
    ]));
    expect(r.entries).toHaveLength(2);
    expect(new Set(r.entries.map((x) => x.entityID)).size).toBe(1);
  });

  // 断言的是**码**不是「抛了就行」：仓库里同批用例都断言 KydogError.code，
  // 渲染层也按 code 分支。只写 toThrow() 的话，换成一个裸 Error 照样全绿。
  it('整份不是数组 / 不是 JSON → 抛 KydogError，码是 institution.idp_list_invalid', () => {
    for (const bad of ['{}', 'null', 'not json', '"x"', '123']) {
      try { parseIdpList(bad); expect.unreachable(`应当抛出：${bad}`); }
      catch (e) {
        expect(e, bad).toBeInstanceOf(KydogError);
        expect((e as KydogError).code, bad).toBe('institution.idp_list_invalid');
      }
    }
  });

  // 按「第一个 | 之前全切掉」剥的话，entityID 里带竖线的那一条会被切成 "2"，
  // 然后以「entityID 既不是网址也不是 URN：2」被跳过 —— 把解析器的 bug 记成数据的错，
  // 用户在列表里找不到自己学校，看到的还是一条误导性的原因。
  it('只剥开头的 0| / 1|，entityID 自己带的竖线不动', () => {
    const r = parseIdpList(JSON.stringify([{ 'X 大学': 'https://idp.x.edu/sso?a=1|2' }]));
    expect(r.entries).toEqual([{ name: 'X 大学', entityID: 'https://idp.x.edu/sso?a=1|2', flag: null }]);
    expect(r.skipped).toEqual([]);
  });

  it('有前缀时也只剥开头那两个字符，后面的竖线留着', () => {
    const r = parseIdpList(JSON.stringify([{ 'Y 大学': '1|https://idp.y.edu/sso?a=1|2' }]));
    expect(r.entries).toEqual([{ name: 'Y 大学', entityID: 'https://idp.y.edu/sso?a=1|2', flag: '1' }]);
  });

  it('开头是别的数字或字母时不当前缀剥', () => {
    const r = parseIdpList(JSON.stringify([{ 'Z 大学': 'urn:mace:z|w' }]));
    expect(r.entries).toEqual([{ name: 'Z 大学', entityID: 'urn:mace:z|w', flag: null }]);
  });

  // 字符类只认 "0" 与 "1" 这两个字面值，不是「随便一个数字」。用别的数字开头
  // （2|、9|）探这个边界 —— 上面那条「开头是别的数字或字母」的用例名虽然提到了
  // 数字，实际只喂了字母 u，正则一旦被放宽成 \d 或 . 都不会被这条抓住。
  // 这里没被剥掉前缀的话，"2|https://..." 整个既不是 http(s) 网址也不是 URN，
  // 应当落进 skipped 而不是被当成已知格式剥掉、静默收进 entries。
  it('标志前缀只认 0/1，开头是别的数字（2、9）时不当前缀剥', () => {
    const r = parseIdpList(JSON.stringify([
      { 'W 大学': '2|https://idp.w.edu/shibboleth' },
      { 'V 大学': '9|https://idp.v.edu/shibboleth' },
      { '清华大学': '1|https://idp.tsinghua.edu.cn/idp/shibboleth' },
    ]));
    expect(r.entries).toEqual([
      { name: '清华大学', entityID: 'https://idp.tsinghua.edu.cn/idp/shibboleth', flag: '1' },
    ]);
    expect(r.skipped.map((s) => s.name)).toEqual(['W 大学', 'V 大学']);
    // raw 里那个没被认成标志的 "2|" / "9|" 还完整留着 —— 证明确实没剥
    expect(r.skipped.map((s) => s.raw)).toEqual([
      '2|https://idp.w.edu/shibboleth',
      '9|https://idp.v.edu/shibboleth',
    ]);
  });

  // 标志是源接口给的**协议层事实**。spec §4.6 说的是「一期不拿它过滤」，
  // 不是「不保留它」—— 丢在解析层，下游就再也拿不回来。
  it('标志原样保留，两种格式分别是 "1" / "0" / null', () => {
    const r = parseIdpList(JSON.stringify([
      { A: '1|https://a.edu.cn/idp/shibboleth' },
      { B: '0|https://b.edu.cn/idp/shibboleth' },
      { C: 'https://c.edu.cn/idp/shibboleth' },
    ]));
    expect(r.entries.map((e) => e.flag)).toEqual(['1', '0', null]);
  });

  // URL 那条路 WHATWG 解析器自己会裁掉空白，裁不裁得住测不出来；URN 不经过 URL
  // 解析器，尾部空白会原样活下来，后续与 IdP 侧精确匹配对不上，登录失败又无从解释。
  it('entityID 两侧空白被裁掉（URN 不会被 URL 解析器顺手裁掉，得靠这里）', () => {
    const r = parseIdpList(JSON.stringify([{ 'X 大学': '1|urn:mace:x.edu:idp ' }]));
    expect(r.entries).toEqual([{ name: 'X 大学', entityID: 'urn:mace:x.edu:idp', flag: '1' }]);
  });

  it('机构名两侧空白被裁掉，空名跳过', () => {
    const r = parseIdpList(JSON.stringify([
      { '  清华大学  ': '1|https://a.edu.cn/idp/shibboleth' },
      { '   ': '1|https://b.edu.cn/idp/shibboleth' },
    ]));
    expect(r.entries).toEqual([{ name: '清华大学', entityID: 'https://a.edu.cn/idp/shibboleth', flag: '1' }]);
    expect(r.skipped).toHaveLength(1);
  });
});

describe('parseIdpList：「读不懂」不能与「这个源一个机构都没有」长得一样', () => {
  // SP 改了值的形状（比如换成 {"name":..,"entityID":..} 对象）→ 1064 条全进 skipped、
  // entries 为空、不抛错 → 机构选择器空白，而真相是我们没读懂它。
  it('读到 N 条却一条都没留下 → 抛错，并把 N 说出来', () => {
    const raw = JSON.stringify([
      { 北京大学: { entityID: 'https://idp.pku.edu.cn/idp/shibboleth' } },
      { 清华大学: { entityID: 'https://idp.tsinghua.edu.cn/idp/shibboleth' } },
    ]);
    try { parseIdpList(raw); expect.unreachable('应当抛出'); }
    catch (e) {
      expect(e).toBeInstanceOf(KydogError);
      expect((e as KydogError).code).toBe('institution.idp_list_invalid');
      expect((e as Error).message).toContain('2');
    }
  });

  // 而「这个源真的一条都没有」是另一件事：正常返回，不抛。两者从此可分。
  it('源里真的是空数组 → 正常返回空清单，不抛', () => {
    const r = parseIdpList('[]');
    expect(r.entries).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.dropped).toEqual({ entries: 0, skipped: 0 });
  });

  it('哪怕只留下一条也不算「读不懂」', () => {
    const r = parseIdpList(JSON.stringify([
      { A: '1|https://a.edu.cn/idp/shibboleth' },
      { B: 'not-a-url' },
    ]));
    expect(r.entries).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
  });
});

describe('parseIdpList：同名与上限', () => {
  // 同名不同 entityID 在设置页的下拉里就是两行一模一样的文字。用户选错一条，
  // 登录在 IdP 那边失败，界面无从解释 —— 至少要让调用方能区分。
  it('同名不同 entityID 报出来，调用方能据此消歧', () => {
    const r = parseIdpList(JSON.stringify([
      { 同名大学: '1|https://a.edu.cn/idp/shibboleth' },
      { 同名大学: '1|https://b.edu.cn/idp/shibboleth' },
      { 清华大学: '1|https://c.edu.cn/idp/shibboleth' },
    ]));
    expect(r.ambiguousNames).toEqual(['同名大学']);
  });

  it('同名同 entityID 不算歧义 —— 选哪条都通向同一套认证', () => {
    const e = 'https://passport.escience.cn/idp/shibboleth';
    const r = parseIdpList(JSON.stringify([{ 中国科学院大学: `1|${e}` }, { 中国科学院大学: `1|${e}` }]));
    expect(r.ambiguousNames).toEqual([]);
  });

  it('多个机构共用一个 entityID 不算歧义 —— 歧义是同名，不是同 ID', () => {
    const e = 'https://passport.escience.cn/idp/shibboleth';
    const r = parseIdpList(JSON.stringify([{ 中国科学院大学: `1|${e}` }, { 中国科学院物理研究所: `1|${e}` }]));
    expect(r.ambiguousNames).toEqual([]);
  });

  // 这份清单来自网络。端点异常返回几十万条时，两个数组连同每条的 raw
  // 会全构造出来留在主进程内存里。
  it('entries 撞上限时截断，并如实报出丢了多少', () => {
    const many = Array.from({ length: MAX_IDP_ENTRIES + 5 },
      (_, i) => ({ [`机构${i}`]: `1|https://i${i}.edu.cn/idp/shibboleth` }));
    const r = parseIdpList(JSON.stringify(many));
    expect(r.entries).toHaveLength(MAX_IDP_ENTRIES);
    expect(r.dropped.entries).toBe(5);
  });

  it('skipped 撞上限时也截断并如实回报', () => {
    const many: unknown[] = [{ 好的大学: '1|https://ok.edu.cn/idp/shibboleth' }];
    for (let i = 0; i < MAX_IDP_SKIPPED + 3; i++) many.push({ [`坏的${i}`]: 'not-a-url' });
    const r = parseIdpList(JSON.stringify(many));
    expect(r.skipped).toHaveLength(MAX_IDP_SKIPPED);
    expect(r.dropped.skipped).toBe(3);
    expect(r.entries).toHaveLength(1);
  });

  it('没撞上限时两个计数都是 0', () => {
    const r = parseIdpList(JSON.stringify([{ A: '1|https://a.edu.cn/idp/shibboleth' }]));
    expect(r.dropped).toEqual({ entries: 0, skipped: 0 });
    expect(r.ambiguousNames).toEqual([]);
  });
});
