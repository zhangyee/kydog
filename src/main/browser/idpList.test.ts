import { describe, it, expect } from 'vitest';
import { parseIdpList } from './idpList';

describe('parseIdpList：吃下 CARSI 清单的两种真实格式', () => {
  // federation=2（国内）：值是 "<标志>|<entityID>"
  it('带 标志| 前缀的格式', () => {
    const r = parseIdpList(JSON.stringify([
      { '清华大学': '1|https://idp.tsinghua.edu.cn/idp/shibboleth' },
      { '北京大学': '1|https://idp.pku.edu.cn/idp/shibboleth' },
    ]));
    expect(r.entries).toEqual([
      { name: '清华大学', entityID: 'https://idp.tsinghua.edu.cn/idp/shibboleth' },
      { name: '北京大学', entityID: 'https://idp.pku.edu.cn/idp/shibboleth' },
    ]);
    expect(r.skipped).toEqual([]);
  });

  // federation=1（国际 eduGAIN）：值就是裸 entityID，没有前缀，而且可能是 URN
  it('裸 entityID 的格式，含 URN', () => {
    const r = parseIdpList(JSON.stringify([
      { 'University of Birmingham': 'https://idp.bham.ac.uk/shibboleth' },
      { 'University of Durham': 'urn:mace:ac.uk:sdss.ac.uk:provider:identity:dur.ac.uk' },
    ]));
    expect(r.entries).toEqual([
      { name: 'University of Birmingham', entityID: 'https://idp.bham.ac.uk/shibboleth' },
      { name: 'University of Durham', entityID: 'urn:mace:ac.uk:sdss.ac.uk:provider:identity:dur.ac.uk' },
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
    expect(r.skipped.length).toBeGreaterThanOrEqual(3);
  });

  it('同一个 entityID 被多个机构共用时全部保留 —— 中科院那 127 家就是这样', () => {
    const e = 'https://passport.escience.cn/idp/shibboleth';
    const r = parseIdpList(JSON.stringify([
      { '中国科学院大学': `1|${e}` }, { '中国科学院物理研究所': `1|${e}` },
    ]));
    expect(r.entries).toHaveLength(2);
    expect(new Set(r.entries.map((x) => x.entityID)).size).toBe(1);
  });

  it('整份不是数组 / 不是 JSON → 抛错，不返回空清单', () => {
    for (const bad of ['{}', 'null', 'not json', '"x"', '123']) {
      expect(() => parseIdpList(bad), bad).toThrow();
    }
  });

  it('机构名两侧空白被裁掉，空名跳过', () => {
    const r = parseIdpList(JSON.stringify([
      { '  清华大学  ': '1|https://a.edu.cn/idp/shibboleth' },
      { '   ': '1|https://b.edu.cn/idp/shibboleth' },
    ]));
    expect(r.entries).toEqual([{ name: '清华大学', entityID: 'https://a.edu.cn/idp/shibboleth' }]);
    expect(r.skipped).toHaveLength(1);
  });
});
