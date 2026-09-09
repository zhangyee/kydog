import { describe, it, expect } from 'vitest';
import { buildSaveArgs, storedPasswordLost, canSaveDraft, type InstitutionDraft } from './institutionForm';
import type { InstitutionPublic } from '../../shared/types';

const draft = (p: Partial<InstitutionDraft> = {}): InstitutionDraft => ({
  name: '北京大学', entityID: 'https://idp.pku.edu.cn/idp/shibboleth',
  username: 'u2100011000', password: '', pwTouched: false, ...p,
});

const saved: InstitutionPublic = {
  name: '北京大学', entityID: 'https://idp.pku.edu.cn/idp/shibboleth',
  username: 'u2100011000', hasPassword: true, confirmedLogin: null,
};

/**
 * **`password` 这个键出不出现，差的是一个密码。**
 * `institutionService.nextPasswordEnc` 三档：省略 = 不动、`''`/`null` = 清除、
 * 其余字符串 = 设为新值。没碰密码框却带一个空串过去，就是把用户存好的校园密码删了，
 * 而界面上只会显示「已保存」。
 */
describe('buildSaveArgs：password 三档', () => {
  it('没碰过密码框 → 请求里**根本没有** password 这个键', () => {
    const args = buildSaveArgs(draft());
    expect('password' in args).toBe(false);
  });

  it('没碰过、但输入框里恰好有字（比如刚「显示」出来的明文）→ 照样不带', () => {
    const args = buildSaveArgs(draft({ password: '刚显示出来的明文' }));
    expect('password' in args).toBe(false);
  });

  it('碰过 → 带上，值原样（前后空格不许被悄悄去掉）', () => {
    expect(buildSaveArgs(draft({ password: ' pw ', pwTouched: true })).password).toBe(' pw ');
  });

  it('碰过且清空 → 带一个空串（那是「清除密码」这一档）', () => {
    const args = buildSaveArgs(draft({ password: '', pwTouched: true }));
    expect('password' in args).toBe(true);
    expect(args.password).toBe('');
  });

  it('三个标识字段原样透传，不 trim', () => {
    const args = buildSaveArgs(draft({ username: ' u1 ' }));
    expect(args).toMatchObject({
      name: '北京大学', entityID: 'https://idp.pku.edu.cn/idp/shibboleth', username: ' u1 ',
    });
  });

  it('不带 confirmedLogin —— 设置页没有「设成某个值」那一档', () => {
    expect('confirmedLogin' in buildSaveArgs(draft())).toBe(false);
  });
});

/**
 * 两个码要用户做的事**正相反**：一个是「修好钥匙串再试一次，密码还在」，
 * 一个是「这份密文永久失效，只能重新填」。对调过来就是把用户支使到相反方向，
 * 而码上、类型上都看不出任何异常。
 */
describe('storedPasswordLost：只有「密文解不开」那一个码算失效', () => {
  it('stored_password_unreadable → 已存的那份没了', () => {
    expect(storedPasswordLost('settings.stored_password_unreadable')).toBe(true);
  });

  it('secure_storage_unavailable → 密码还在，不许说成失效', () => {
    expect(storedPasswordLost('settings.secure_storage_unavailable')).toBe(false);
  });

  it('别的码、以及压根没有码，一律不算失效', () => {
    for (const c of ['settings.invalid', 'unknown', '', undefined]) {
      expect(storedPasswordLost(c), String(c)).toBe(false);
    }
  });
});

describe('canSaveDraft', () => {
  it('没改动 → 不能按', () => {
    expect(canSaveDraft(draft(), saved)).toBe(false);
  });

  it('改了任意一个标识字段 → 能按', () => {
    expect(canSaveDraft(draft({ name: '清华大学' }), saved)).toBe(true);
    expect(canSaveDraft(draft({ entityID: 'https://idp.tsinghua.edu.cn/idp/shibboleth' }), saved)).toBe(true);
    expect(canSaveDraft(draft({ username: 'u9' }), saved)).toBe(true);
  });

  it('只碰了密码框也算改动（连密码一起是空的也算 —— 那是「清除」）', () => {
    expect(canSaveDraft(draft({ pwTouched: true }), saved)).toBe(true);
  });

  it('三个标识字段缺任何一个都不能按（主进程那边同样会拒）', () => {
    for (const p of [{ name: '' }, { entityID: '' }, { username: '' }, { name: '   ' }]) {
      expect(canSaveDraft(draft({ ...p, pwTouched: true }), saved), JSON.stringify(p)).toBe(false);
    }
  });

  it('还没配过（current 为 null）时，填全了就能按', () => {
    expect(canSaveDraft(draft(), null)).toBe(true);
  });
});
