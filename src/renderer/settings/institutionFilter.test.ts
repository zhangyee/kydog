import { describe, it, expect } from 'vitest';
import { filterIdps, idpRowKey } from './institutionFilter';
import type { IdpEntry } from '../../shared/types';

const e = (name: string, entityID: string): IdpEntry => ({ name, entityID, flag: '1' });

/** 形状照实测样本（`references/carsi.md` §二）：真清单里 entityID 就是这种 host。 */
const LIST: IdpEntry[] = [
  e('清华大学', 'https://idp.tsinghua.edu.cn/idp/shibboleth'),
  e('北京大学', 'https://idp.pku.edu.cn/idp/shibboleth'),
  e('中国科学院大学', 'https://passport.escience.cn/idp/shibboleth'),
  e('中国科学院物理研究所', 'https://passport.escience.cn/idp/shibboleth'),
  e('University of Birmingham', 'https://idp.bham.ac.uk/shibboleth'),
];

describe('filterIdps', () => {
  it('空串给全部（顺序照上游）', () => {
    expect(filterIdps(LIST, '').map((x) => x.name)).toEqual(LIST.map((x) => x.name));
    expect(filterIdps(LIST, '   ').map((x) => x.name)).toEqual(LIST.map((x) => x.name));
  });

  it('汉字子串', () => {
    expect(filterIdps(LIST, '北京').map((x) => x.name)).toEqual(['北京大学']);
    expect(filterIdps(LIST, '中国科学院').map((x) => x.name))
      .toEqual(['中国科学院大学', '中国科学院物理研究所']);
  });

  /**
   * **这一条是「不切输入法也找得到」的全部依据。** 学校的拼音／缩写实测就写在
   * entityID 的 host 里，所以敲拉丁字母能命中。注意它命中的是 entityID 而不是名字 ——
   * 这不是拼音检索（见 `institutionFilter.ts` 的说明与那条登记在案的偏离）。
   */
  it('拉丁串命中 entityID 里的拼音／缩写', () => {
    expect(filterIdps(LIST, 'pku').map((x) => x.name)).toEqual(['北京大学']);
    expect(filterIdps(LIST, 'tsinghua').map((x) => x.name)).toEqual(['清华大学']);
    expect(filterIdps(LIST, 'escience').map((x) => x.name))
      .toEqual(['中国科学院大学', '中国科学院物理研究所']);
  });

  it('大小写不敏感，两边都是', () => {
    expect(filterIdps(LIST, 'PKU').map((x) => x.name)).toEqual(['北京大学']);
    expect(filterIdps(LIST, 'birmingham').map((x) => x.name)).toEqual(['University of Birmingham']);
  });

  it('名字命中的排在只有 entityID 命中的前面', () => {
    const list = [
      e('某某学院', 'https://idp.pku-affiliate.edu.cn/x'),   // 只有 entityID 里有 pku
      e('PKU 医学部', 'https://idp.bjmu.edu.cn/x'),          // 名字里有 pku
    ];
    expect(filterIdps(list, 'pku').map((x) => x.name)).toEqual(['PKU 医学部', '某某学院']);
  });

  it('同一条不会既进名字组又进 entityID 组', () => {
    const list = [e('escience 联盟', 'https://passport.escience.cn/idp/shibboleth')];
    expect(filterIdps(list, 'escience')).toHaveLength(1);
  });

  it('一条都不匹配就是空数组（不是「退回全部」）', () => {
    expect(filterIdps(LIST, '不存在的学校')).toEqual([]);
  });

  it('不改传进来的数组', () => {
    const copy = [...LIST];
    filterIdps(LIST, '北京');
    expect(LIST).toEqual(copy);
  });
});

/**
 * 实测：一个 entityID（`https://passport.escience.cn/idp/shibboleth`）被 127 个
 * 中科院所共用。key 撞车会让 React 把一行的 fiber 复用到位置不同的另一行上。
 */
describe('idpRowKey：共用 entityID 的行也必须各有各的 key', () => {
  it('两条共用 entityID 的记录 key 不同', () => {
    const rows = filterIdps(LIST, 'escience');
    const keys = rows.map((r, i) => idpRowKey(r, i));
    expect(rows[0].entityID).toBe(rows[1].entityID);   // 前提：它们确实共用
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('整份清单的 key 全局唯一', () => {
    const keys = LIST.map((r, i) => idpRowKey(r, i));
    expect(new Set(keys).size).toBe(LIST.length);
  });

  it('连名字也一样的两条（活数据里不保证不出现）也不撞', () => {
    const dup = [e('同名学院', 'https://a.example/x'), e('同名学院', 'https://a.example/x')];
    const keys = dup.map((r, i) => idpRowKey(r, i));
    expect(new Set(keys).size).toBe(2);
  });
});
