import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile, DEFAULT_BROWSER_WIDTH, MIN_BROWSER_WIDTH } from '../persist/settingsFile';
import { SettingsService, toRendererSettings } from './settingsService';

describe('SettingsService (v2 + proper-lockfile)', () => {
  let dir: string;
  let svc: SettingsService;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-svc-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    ensureSettingsFile();
    svc = new SettingsService();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('withLock: 写 + 读回一致', async () => {
    await svc.withLock(async (cur) => {
      const next = { ...cur, llm: { ...cur.llm, defaultProvider: 'anthropic' } };
      return { next, result: undefined };
    });
    const got = await svc.get();
    expect(got.llm.defaultProvider).toBe('anthropic');
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'kydog.json'), 'utf8'));
    expect(onDisk.llm.defaultProvider).toBe('anthropic');
  });

  it('withLock: 100 次并发 async 写最终 deterministic（无丢失）', async () => {
    const N = 100;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        svc.withLock(async (cur) => ({
          next: { ...cur, llm: { ...cur.llm, providers: { ...cur.llm.providers, [`p${i}`]: {} } } },
          result: undefined,
        })),
      ),
    );
    const got = await svc.get();
    expect(Object.keys(got.llm.providers).length).toBe(N);
  });

  it('withLock: 磁盘遗留 v3 settings（无 onboarding 键）时按 schema 迁移，不把裸 JSON 污染进 cache（真机 P0 复现）', async () => {
    // 磁盘上是迁移前落地的 v3 文件：没有 onboarding 键。
    const v3OnDisk = {
      schemaVersion: 3,
      ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false, readingFontSize: 'medium' },
      llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: null, defaultModel: null },
      skills: { disabledBuiltins: [] },
      tools: { externalBins: [] },
    };
    writeFileSync(path.join(dir, 'kydog.json'), JSON.stringify(v3OnDisk, null, 2), 'utf8');

    // 真机链路：启动阶段拿锁读 settings，回调拿到的 current 必须是迁移后的形状
    // （onboarding 键存在），而不是裸 JSON.parse 的 v3 形状。
    const captured = await svc.withLock(async (cur) => ({ result: cur.onboarding?.completedAt }));
    expect(captured).toBe(null); // undefined 说明 cur.onboarding 缺失（bug 复现）；null 说明已迁移

    // withLock 内部把 current 写进 this.cache；未迁移的裸对象污染 cache 后，
    // 后续任何 svc.get() 都会返回缺 onboarding 键的对象。
    const after = await svc.get();
    expect(after.onboarding).toBeDefined();
    expect(after.schemaVersion).toBe(9);
  });

  it('update(): patch 混入 onboarding.completedAt + schemaVersion 被过滤（守住不变式）', async () => {
    const before = await svc.get();
    const patch = {
      ui: { theme: 'sepia' as const },
      onboarding: { completedAt: 'HACK' } as any,
      schemaVersion: 99 as any,
    };
    const result = await svc.update(patch);
    expect(result.schemaVersion).toBe(9);
    expect(result.ui.theme).toBe('sepia');
    expect(result.onboarding.completedAt).toBe(before.onboarding.completedAt);
  });

  it('update(): patch 混入 updates 被过滤（守住不变式，spec §7）', async () => {
    await svc.withLock(async (cur) => ({
      next: { ...cur, updates: { autoCheck: false, dismissedCandidateId: 'keep-me' } },
      result: undefined,
    }));
    const patch = {
      ui: { theme: 'porcelain' as const },
      updates: { autoCheck: true, dismissedCandidateId: 'HACK' } as any,
    };
    const result = await svc.update(patch);
    expect(result.ui.theme).toBe('porcelain');
    expect(result.updates).toEqual({ autoCheck: false, dismissedCandidateId: 'keep-me' });
    const got = await svc.get();
    expect(got.updates).toEqual({ autoCheck: false, dismissedCandidateId: 'keep-me' });
  });

  it('update() 不碰 telemetry —— 它只能由 telemetryService 改', async () => {
    // 用 deleting：它是最该被保住的状态，丢了等于静默吞掉用户已发出的删除请求。
    await svc.withLock(async (cur) => ({
      next: { ...cur, telemetry: { state: 'deleting' as const, decidedAt: '2026-08-05T10:00:00.000Z' } },
      result: undefined,
    }));
    const patch = { ui: { theme: 'midnight' as const } };
    const result = await svc.update(patch);
    expect(result.ui.theme).toBe('midnight');
    expect(result.telemetry).toEqual({ state: 'deleting', decidedAt: '2026-08-05T10:00:00.000Z' });
    const got = await svc.get();
    expect(got.telemetry).toEqual({ state: 'deleting', decidedAt: '2026-08-05T10:00:00.000Z' });
  });

  // ── institution：settings.update 这条路必须完全够不着它 ──
  //
  // 这是本文件里最要命的一条不变式，而它以前一条用例都没有：把 update() 里那六行显式
  // 赋值简化成 `{ ...cur, ...patch }`（旁边五行 spread 正邀请这个改法，且 SettingsPatch
  // 里没有 institution 所以 tsc 也不会拦），74 条用例照样全绿，而校园明文密码从此落进
  // ~/.kydog/kydog.json。
  const PKU = 'https://idp.pku.edu.cn/idp/shibboleth';
  const RECORD = {
    name: '北京大学', entityID: PKU, username: '2100012345',
    passwordEnc: 'ENC-FROM-SAFESTORAGE', confirmedLogin: { entityID: PKU, origin: 'https://iaaa.pku.edu.cn' },
  };

  it('update(): patch 混入 institution 被过滤 —— 已有记录一个字段都不许被改', async () => {
    await svc.setInstitution(RECORD);
    await svc.update({
      ui: { theme: 'sepia' as const },
      institution: {
        name: '清华大学', entityID: 'https://idp.tsinghua.edu.cn/idp/shibboleth',
        username: 'attacker', passwordEnc: 'PLAINTEXT-PASSWORD', confirmedLogin: null,
      },
    } as never);

    const got = await svc.get();
    expect(got.ui.theme).toBe('sepia');            // 正常字段确实写进去了
    expect(got.institution).toEqual(RECORD);       // 机构记录一个字段没动
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'kydog.json'), 'utf8'));
    expect(onDisk.institution).toEqual(RECORD);
    // 明文密码一个字节都不许出现在磁盘上
    expect(readFileSync(path.join(dir, 'kydog.json'), 'utf8')).not.toContain('PLAINTEXT-PASSWORD');
  });

  it('update(): 没配过机构时 patch 也塞不进来一条', async () => {
    await svc.update({
      institution: { name: 'n', entityID: 'e', username: 'u', passwordEnc: 'PLAINTEXT-PASSWORD', confirmedLogin: null },
    } as never);
    expect((await svc.get()).institution).toBeNull();
    expect(readFileSync(path.join(dir, 'kydog.json'), 'utf8')).not.toContain('PLAINTEXT-PASSWORD');
  });

  // ── C：密文不出主进程 ──
  it('toRendererSettings(): 密文不过河，hasPassword 过河', async () => {
    await svc.setInstitution({ ...RECORD, passwordEnc: 'SENTINEL-CIPHERTEXT' });
    const full = await svc.get();
    // 反证：哨兵确实在源里。少了这一条，下面那句 not.toContain 什么都证明不了。
    expect(JSON.stringify(full)).toContain('SENTINEL-CIPHERTEXT');

    const view = toRendererSettings(full);
    expect(JSON.stringify(view)).not.toContain('SENTINEL-CIPHERTEXT');
    expect(view.institution).toEqual({
      name: '北京大学', entityID: PKU, username: '2100012345',
      hasPassword: true, confirmedLogin: { entityID: PKU, origin: 'https://iaaa.pku.edu.cn' },
    });
    expect(Object.keys(view.institution ?? {})).not.toContain('passwordEnc');
  });

  it('toRendererSettings(): 还没设密码时 hasPassword 为 false；没配过机构时是 null', async () => {
    await svc.setInstitution({ ...RECORD, passwordEnc: '' });
    expect(toRendererSettings(await svc.get()).institution?.hasPassword).toBe(false);
    await svc.setInstitution(null);
    expect(toRendererSettings(await svc.get()).institution).toBeNull();
  });

  // ── D：写路径不许比读路径宽 ──
  it('setInstitution(): 缺 name / entityID / username 的记录当场被拒，不是落盘后重启消失', async () => {
    for (const bad of [
      { ...RECORD, name: '' },
      { ...RECORD, entityID: '' },
      { ...RECORD, username: '' },
    ]) {
      await expect(svc.setInstitution(bad)).rejects.toMatchObject({ code: 'settings.invalid' });
    }
    expect((await svc.get()).institution).toBeNull();
  });

  // 从前只有三个标识字段会被拒，passwordEnc 那一档是**静默降级成空串**：
  // safeStorage.encryptString 回的是 Buffer，忘了 .toString('base64') 直接往下塞 →
  // typeof 不是 string → 落盘 passwordEnc: '' → 界面显示「未设置密码」，全程零错误。
  // 两条路现在对齐了：读路径丢掉的记录，写路径当场拒。
  it('setInstitution(): passwordEnc 不是字符串（忘了 toString(base64)）当场被拒，不静默变成空串', async () => {
    const buf = Buffer.from('ENC-BYTES');
    for (const bad of [buf, { type: 'Buffer', data: [1, 2, 3] }, 42, null, undefined, ['x']]) {
      await expect(
        svc.setInstitution({ ...RECORD, passwordEnc: bad as never }),
        JSON.stringify(bad) ?? 'undefined',
      ).rejects.toMatchObject({ code: 'settings.invalid' });
    }
    expect((await svc.get()).institution).toBeNull();
  });

  // 报错要说对是哪一档：从前无论什么原因，写路径都只会说「缺少机构名 / entityID / 用户名」，
  // 而那句话对着一个忘了 base64 的 Buffer 完全是误导。
  it('setInstitution(): 拒绝的理由说的是 passwordEnc 本身，不是「缺少机构名 / entityID / 用户名」', async () => {
    await expect(svc.setInstitution({ ...RECORD, passwordEnc: Buffer.from('x') as never }))
      .rejects.toThrow(/passwordEnc/);
    await expect(svc.setInstitution({ ...RECORD, name: '' }))
      .rejects.toThrow(/机构名/);
  });

  // ── updateInstitution()：institutionService.save 的写口，read-modify-write 在锁内 ──
  it('updateInstitution(): 回调拿到的是锁内读回来的当前记录，返回值就是落盘的那一份', async () => {
    await svc.setInstitution(RECORD);
    const seen: unknown[] = [];
    const out = await svc.updateInstitution((cur) => {
      seen.push(cur);
      return { ...cur!, username: '2100099999' };
    });
    expect(seen).toEqual([RECORD]);
    expect(out).toEqual({ ...RECORD, username: '2100099999' });
    expect((await new SettingsService().get()).institution).toEqual(out);
  });

  it('updateInstitution(): 回调抛错 → 整次不写盘，锁照常放开（下一次调用还能拿到锁）', async () => {
    await svc.setInstitution(RECORD);
    await expect(svc.updateInstitution(() => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect((await svc.get()).institution).toEqual(RECORD);
    // 锁真的放开了：否则这一句会卡到 proper-lockfile 重试用尽
    expect(await svc.updateInstitution(() => null)).toBeNull();
  });

  it('updateInstitution(): 落盘前同样过 checkInstitution —— 不是一条绕开判据的写口', async () => {
    await expect(svc.updateInstitution(() => ({ ...RECORD, passwordEnc: Buffer.from('x') as never })))
      .rejects.toMatchObject({ code: 'settings.invalid' });
    await expect(svc.updateInstitution(() => ({ ...RECORD, username: '' })))
      .rejects.toMatchObject({ code: 'settings.invalid' });
    expect((await svc.get()).institution).toBeNull();
  });

  // 「密码省略 = 沿用已存的密文」这条语义要求读旧记录；锁外读就会撞上 confirmLogin
  // 那条 JSDoc 写清楚的路。这里钉住的是：两次并发保存之后，磁盘上是完整的一条，
  // 而不是一条丢了密文的。
  it('updateInstitution(): 并发保存串行发生，沿用旧密文的那一次不会读到半路的状态', async () => {
    await svc.setInstitution({ ...RECORD, confirmedLogin: null });
    await Promise.all([
      svc.updateInstitution((cur) => ({ ...cur!, username: 'A' })),
      svc.updateInstitution((cur) => ({ ...cur!, name: 'B' })),
    ]);
    const got = (await new SettingsService().get()).institution;
    expect(got?.passwordEnc).toBe('ENC-FROM-SAFESTORAGE');
    expect([got?.username, got?.name]).toEqual(['A', 'B']);
  });

  it('setInstitution(): 落盘的是读路径认得出来的形状 —— 存进去什么，重启后就还是什么', async () => {
    await svc.setInstitution(RECORD);
    const reread = await new SettingsService().get();
    expect(reread.institution).toEqual(RECORD);
  });

  it('setInstitution(): confirmedLogin 与 entityID 不符时当场作废，与读路径同一个判据', async () => {
    await svc.setInstitution({
      ...RECORD, entityID: 'https://idp.tsinghua.edu.cn/idp/shibboleth',
    });
    expect((await svc.get()).institution?.confirmedLogin).toBeNull();
  });

  // ── confirmLogin()：read-modify-write 必须发生在锁内 ──
  //
  // setInstitution 收的是整条记录，于是「记下这次确认」唯一写得出来的调用是
  //   const cur = await svc.get();                                   // 锁外，弹框之前的快照
  //   await svc.setInstitution({ ...cur.institution!, confirmedLogin });
  // 而弹框到用户点确认之间有好几秒 —— 这几秒里用户在设置页把学校从北大改成清华，
  // 上面那行就把整条旧记录（name / entityID / username / passwordEnc）原样写回去了。
  // sanitizeInstitution 一句话都不会说：它比的是同一个对象内部的 entityID，当然相符。
  const THU = {
    name: '清华大学', entityID: 'https://idp.tsinghua.edu.cn/idp/shibboleth',
    username: '2021012345', passwordEnc: 'ENC-THU', confirmedLogin: null,
  };

  it('confirmLogin(): 确认对话框开着的十秒里用户改了学校 —— 确认作废，旧记录不会被写回去', async () => {
    await svc.setInstitution({ ...RECORD, confirmedLogin: null });
    await svc.get();                       // 2b 在锁外拿到的那份快照（北大）
    await svc.setInstitution(THU);         // 用户这十秒里改成了清华

    expect(await svc.confirmLogin(PKU, 'https://iaaa.pku.edu.cn')).toBe(false);

    const got = await svc.get();
    expect(got.institution).toEqual(THU);  // 清华那条一个字段都没退回北大
    const rawOnDisk = readFileSync(path.join(dir, 'kydog.json'), 'utf8');
    expect(rawOnDisk).not.toContain('2100012345');            // 北大学号
    expect(rawOnDisk).not.toContain('ENC-FROM-SAFESTORAGE');  // 北大那份密文
  });

  it('confirmLogin(): entityID 相符时记在当前那条记录上，且只动 confirmedLogin 一个字段', async () => {
    await svc.setInstitution({ ...RECORD, confirmedLogin: null });
    expect(await svc.confirmLogin(PKU, 'https://iaaa.pku.edu.cn')).toBe(true);

    const expected = { ...RECORD, confirmedLogin: { entityID: PKU, origin: 'https://iaaa.pku.edu.cn' } };
    expect((await svc.get()).institution).toEqual(expected);
    // 落盘的形状读路径认得出来 —— 否则下次启动这次确认就白问了
    expect((await new SettingsService().get()).institution).toEqual(expected);
  });

  it('confirmLogin(): 没有机构记录时是 no-op，不会凭空造一条', async () => {
    expect(await svc.confirmLogin(PKU, 'https://iaaa.pku.edu.cn')).toBe(false);
    expect((await svc.get()).institution).toBeNull();
  });

  it('confirmLogin(): origin 为空当场被拒，不落一个 confirmedLogin: null 冒充「确认过」', async () => {
    await svc.setInstitution({ ...RECORD, confirmedLogin: null });
    await expect(svc.confirmLogin(PKU, '')).rejects.toMatchObject({ code: 'settings.invalid' });
    expect((await svc.get()).institution?.confirmedLogin).toBeNull();
  });

  // ── D：ui.browserWidth 的写路径也要走同一个 sanitize ──
  // 渲染层拖拽时算错一次 → browserWidth: 0 当场进 cache 与磁盘 → 同一次会话里
  // scale = W/1280 = 0，页面渲染塌掉；重启后 sanitize 又把它拉回默认，于是现象是
  // 「重启就好了」，无法稳定复现。
  it('update(): 非法 browserWidth 走与读路径同一个 sanitize，不进 cache 也不落盘', async () => {
    for (const bad of [0, -5, 100, 319, Number.NaN, 'wide']) {
      const got = await svc.update({ ui: { browserWidth: bad as number } });
      expect(got.ui.browserWidth, String(bad)).toBe(DEFAULT_BROWSER_WIDTH);
      expect((await svc.get()).ui.browserWidth, String(bad)).toBe(DEFAULT_BROWSER_WIDTH);
      const onDisk = JSON.parse(readFileSync(path.join(dir, 'kydog.json'), 'utf8'));
      expect(onDisk.ui.browserWidth, String(bad)).toBe(DEFAULT_BROWSER_WIDTH);
    }
  });

  it('update(): 合法宽度照常写进去（下限本身是合法的）', async () => {
    expect((await svc.update({ ui: { browserWidth: 900 } })).ui.browserWidth).toBe(900);
    expect((await svc.update({ ui: { browserWidth: MIN_BROWSER_WIDTH } })).ui.browserWidth).toBe(MIN_BROWSER_WIDTH);
    // 没碰 ui.browserWidth 的 patch 不该把它顺手改掉
    expect((await svc.update({ ui: { theme: 'midnight' as const } })).ui.browserWidth).toBe(MIN_BROWSER_WIDTH);
  });

  it('setTelemetry(): 落盘且只动 telemetry 一节', async () => {
    await svc.update({ ui: { theme: 'midnight' as const } });
    await svc.setTelemetry({ state: 'enabled', decidedAt: '2026-08-06T09:00:00.000Z' });

    const onDisk = JSON.parse(readFileSync(path.join(dir, 'kydog.json'), 'utf8'));
    expect(onDisk.telemetry).toEqual({ state: 'enabled', decidedAt: '2026-08-06T09:00:00.000Z' });
    expect(onDisk.ui.theme).toBe('midnight');
    const got = await svc.get();
    expect(got.telemetry).toEqual({ state: 'enabled', decidedAt: '2026-08-06T09:00:00.000Z' });
  });
});
