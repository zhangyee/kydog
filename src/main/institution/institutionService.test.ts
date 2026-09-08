import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { SettingsService } from '../settings/settingsService';
import { KydogError } from '../../shared/errors';
import type { IdpEntry } from '../../shared/types';

/**
 * **测试不许碰真钥匙串。**
 *
 * 这个假 electron 不是「让 import 能过」而已 —— 三个方法都是当场抛。真要有哪条路径
 * 摸到了模块级那个用真 `safeStorage` 造的单例（而不是用例自己注入的假实现），
 * 这里会响；静默弹一个系统钥匙串授权框、或者在 CI 上悄悄失败，都不会发生。
 */
const KEYCHAIN_TRIPWIRE = '用例摸到了真 safeStorage';
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => { throw new Error(KEYCHAIN_TRIPWIRE); },
    encryptString: () => { throw new Error(KEYCHAIN_TRIPWIRE); },
    decryptString: () => { throw new Error(KEYCHAIN_TRIPWIRE); },
  },
}));

const logs: Array<{ level: string; scope: string; msg: string; ctx?: unknown }> = [];
vi.mock('../log', () => ({
  logger: {
    debug: (scope: string, msg: string, ctx?: unknown) => logs.push({ level: 'debug', scope, msg, ctx }),
    info: (scope: string, msg: string, ctx?: unknown) => logs.push({ level: 'info', scope, msg, ctx }),
    warn: (scope: string, msg: string, ctx?: unknown) => logs.push({ level: 'warn', scope, msg, ctx }),
    error: (scope: string, msg: string, ctx?: unknown) => logs.push({ level: 'error', scope, msg, ctx }),
  },
}));

const {
  InstitutionService, decodeByCharset, IDP_LIST_URL, MAX_IDP_LIST_BYTES,
} = await import('./institutionService');

// ── 假 safeStorage ────────────────────────────────────────────────────────────

/**
 * 假加密故意是 **XOR 0x5A**，不是「原样返回」也不是「加个前缀」。
 *
 * 理由是要让「其实没加密」这件事在断言里看得见：明文的字节在密文里一个都不剩，
 * 于是「落盘的不是明文」这条用例真的挡得住 —— 换成原样返回或加前缀，一个把明文
 * 直接写进 passwordEnc 的实现照样能过。
 */
const XOR = 0x5a;
function fakeCipher(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.from(b.map((x) => x ^ XOR));
}
function fakePlain(b: Buffer): string {
  return Buffer.from(Buffer.from(b).map((x) => x ^ XOR)).toString('utf8');
}

type FakeSafe = {
  available: boolean;
  /** 解密时抛错（模拟换了机器 / 钥匙串条目被删）。 */
  decryptThrows: boolean;
  /** encryptString 直接把 Buffer 交出去（真实签名就是 Buffer），用来验调用方有没有 base64。 */
  calls: { encrypt: number; decrypt: number; available: number };
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
};

function makeSafe(available = true): FakeSafe {
  return {
    available,
    decryptThrows: false,
    calls: { encrypt: 0, decrypt: 0, available: 0 },
    isEncryptionAvailable() { this.calls.available += 1; return this.available; },
    encryptString(s: string) { this.calls.encrypt += 1; return fakeCipher(s); },
    decryptString(b: Buffer) {
      this.calls.decrypt += 1;
      if (this.decryptThrows) throw new Error('decrypt failed');
      return fakePlain(b);
    },
  };
}

// ── 装配 ──────────────────────────────────────────────────────────────────────

const PKU = 'https://idp.pku.edu.cn/idp/shibboleth';
const THU = 'https://idp.tsinghua.edu.cn/idp/shibboleth';
const IAAA = 'https://iaaa.pku.edu.cn';

let dir: string;
let settings: SettingsService;
let safe: FakeSafe;

type MakeOpts = {
  available?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function makeService(opts: MakeOpts = {}) {
  safe = makeSafe(opts.available ?? true);
  return new InstitutionService({
    safeStorage: safe,
    settings,
    fetchFn: opts.fetch,
    cacheFile: path.join(dir, 'idp-list.json'),
    timeoutMs: opts.timeoutMs,
  });
}

const settingsOnDisk = () => readFileSync(path.join(dir, 'kydog.json'), 'utf8');
const cacheOnDisk = () => readFileSync(path.join(dir, 'idp-list.json'), 'utf8');

/** 从落盘文件里取密文，绕开一切服务方法 —— 断言的是磁盘上的事实。 */
function passwordEncOnDisk(): unknown {
  return JSON.parse(settingsOnDisk()).institution?.passwordEnc;
}

const BASE = { name: '北京大学', entityID: PKU, username: '2100012345' };

/** 一个只发一次的假 fetch：记下它被调过几次，并回一份给定的响应。 */
function fetchOnce(make: () => Response): { fn: typeof fetch; calls: () => number } {
  let n = 0;
  const fn = (async (...args: unknown[]) => { void args; n += 1; return make(); }) as unknown as typeof fetch;
  return { fn, calls: () => n };
}

function jsonList(list: Array<Record<string, string>>, contentType = 'application/json'): Response {
  return new Response(Buffer.from(JSON.stringify(list), 'utf8'), {
    status: 200, headers: { 'content-type': contentType },
  });
}

beforeEach(() => {
  logs.length = 0;
  dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-inst-'));
  vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
  vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
  vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
  ensureSettingsFile();
  settings = new SettingsService();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── spec §4.6 的硬要求：钥匙串不可用时不许静默退回明文 ────────────────────────

describe('safeStorage 不可用', () => {
  // 这条是整批用例里最要紧的一条：它是 spec §4.6 唯一的守卫。
  it('钥匙串不可用时保存被拒绝（码是 settings.secure_storage_unavailable），不静默退回明文', async () => {
    const svc = makeService({ available: false });
    await expect(svc.save({ ...BASE, password: 'p' }))
      .rejects.toMatchObject({ code: 'settings.secure_storage_unavailable' });
    // 拒绝要彻底：不能留下半条记录（一条没有密码的记录在设置页上看起来像「配好了」）。
    expect(await svc.get()).toBeNull();
    expect(JSON.parse(settingsOnDisk()).institution).toBeNull();
  });

  // 断言明文一个字节都没落盘。上面那条只看了 institution 是不是 null ——
  // 一个「先把明文写进去再抛」的实现能骗过它，骗不过这条。
  it('被拒绝的那次保存，明文没有出现在磁盘上的任何地方', async () => {
    const svc = makeService({ available: false });
    await expect(svc.save({ ...BASE, password: 'PLAINTEXT-SENTINEL' })).rejects.toThrow();
    expect(settingsOnDisk()).not.toContain('PLAINTEXT-SENTINEL');
  });

  // 「不可用就一律拒绝保存」是过宽的：不碰密码的那些保存根本没有明文风险，
  // 一刀切会让用户连学校都改不了。判据是「这次要不要加密」，不是「钥匙串好不好」。
  it('不需要加密的保存（password 省略 / null / 空串）在钥匙串不可用时照常成立', async () => {
    const ok = makeService({ available: true });
    await ok.save({ ...BASE, password: 'p' });

    const svc = makeService({ available: false });
    await svc.save({ ...BASE, username: '2100099999' });                 // 省略：沿用旧密文
    expect((await svc.get())?.username).toBe('2100099999');
    expect((await svc.get())?.hasPassword).toBe(true);

    await svc.save({ ...BASE, username: '2100099999', password: null }); // 清除
    expect((await svc.get())?.hasPassword).toBe(false);

    await svc.save({ ...BASE, username: '2100099999', password: '' });   // 空串 = 清除
    expect((await svc.get())?.hasPassword).toBe(false);
    expect(safe.calls.encrypt).toBe(0);
  });

  it('钥匙串不可用时 reveal 抛 settings.secure_storage_unavailable，不回空串冒充「没设密码」', async () => {
    const ok = makeService({ available: true });
    await ok.save({ ...BASE, password: 'SECRET' });
    const svc = makeService({ available: false });
    await expect(svc.reveal()).rejects.toMatchObject({ code: 'settings.secure_storage_unavailable' });
  });

  // 「钥匙串这一刻用不了」与「这份密文永久解不开了」**不是同一件事**：前者修好钥匙串
  // 密码照常可用，后者修钥匙串一点用都没有，只能重新填一次。两者共用一个码时，渲染层
  // 按码分支就分不出来（措辞不能当判据），而 hasPassword 在两种情形下都还是 true ——
  // 于是「有一个密码、但它已经取不出来了」这个状态在界面上根本表达不出来。
  //
  // 判据与本仓库对 idpList 那两个码用的是同一条：**重试有没有用**。
  it('密文解不开 → settings.stored_password_unreadable，与「钥匙串不可用」不是同一个码', async () => {
    const svc = makeService({ available: true });
    await svc.save({ ...BASE, password: 'SECRET' });
    safe.decryptThrows = true;
    await expect(svc.reveal()).rejects.toMatchObject({ code: 'settings.stored_password_unreadable' });
  });

  // 这一条守的是**两个码不许塌回一个**，而不是某一句措辞：同一份记录、同一个 reveal()，
  // 只换成因，拿到的必须是两个不同的码与两句不同的话。
  it('同一份记录：钥匙串不可用与密文解不开拿到的是两个不同的码、两句不同的话', async () => {
    const ok = makeService({ available: true });
    await ok.save({ ...BASE, password: 'SECRET' });

    const broken = makeService({ available: false });
    const a = await broken.reveal().then(() => null, (e: KydogError) => e);

    const undecipherable = makeService({ available: true });
    safe.decryptThrows = true;
    const b = await undecipherable.reveal().then(() => null, (e: KydogError) => e);

    expect(a).toBeInstanceOf(KydogError);
    expect(b).toBeInstanceOf(KydogError);
    expect(a!.code).not.toBe(b!.code);
    expect(a!.message).not.toBe(b!.message);
    // 两种情形下密码都还在记录里 —— 界面要靠码才说得清哪一种。
    expect((await undecipherable.get())?.hasPassword).toBe(true);
  });
});

// ── 密码只往一个方向流 ────────────────────────────────────────────────────────

describe('密文与明文都不往渲染层去', () => {
  it('get 只回 hasPassword，密文与明文一个字节都不出去', async () => {
    const svc = makeService();
    await svc.save({ ...BASE, password: 'SECRET' });
    const pub = await svc.get();
    const json = JSON.stringify(pub);
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain(String(passwordEncOnDisk()));
    expect(Object.keys(pub ?? {})).not.toContain('passwordEnc');
    expect(pub).toMatchObject({ ...BASE, hasPassword: true, confirmedLogin: null });
  });

  it('save 的返回值与 get 同形 —— 不是另开一条出口', async () => {
    const svc = makeService();
    const saved = await svc.save({ ...BASE, password: 'SECRET' });
    expect(saved).toEqual(await svc.get());
    expect(JSON.stringify(saved)).not.toContain('SECRET');
  });

  it('落盘的是密文的 base64，不是明文；而且真能解回来', async () => {
    const svc = makeService();
    await svc.save({ ...BASE, password: 'SECRET' });
    const enc = passwordEncOnDisk();
    expect(typeof enc).toBe('string');
    expect(settingsOnDisk()).not.toContain('SECRET');
    // 落进去的必须是 base64(密文)，不是 base64(明文)，也不是密文的 latin1 直写。
    expect(fakePlain(Buffer.from(enc as string, 'base64'))).toBe('SECRET');
    expect(await svc.reveal()).toEqual({ password: 'SECRET' });
  });

  it('明文与密文都不进日志', async () => {
    const svc = makeService();
    await svc.save({ ...BASE, password: 'SECRET' });
    await svc.reveal();
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain('SECRET');
    expect(dump).not.toContain(String(passwordEncOnDisk()));
  });
});

// ── save 的三档密码语义 ───────────────────────────────────────────────────────

describe('save：password 省略 = 不动、null/空串 = 清除、字符串 = 设新值', () => {
  it('省略时沿用已存的密文，且不重新加密一次', async () => {
    const svc = makeService();
    await svc.save({ ...BASE, password: 'SECRET' });
    const before = passwordEncOnDisk();
    const encCalls = safe.calls.encrypt;
    await svc.save({ ...BASE, name: '北京大学（改过名）' });
    expect(passwordEncOnDisk()).toBe(before);
    expect(safe.calls.encrypt).toBe(encCalls);
    expect((await svc.get())?.hasPassword).toBe(true);
  });

  it('null 清除密码，记录本身还在', async () => {
    const svc = makeService();
    await svc.save({ ...BASE, password: 'SECRET' });
    await svc.save({ ...BASE, password: null });
    expect(passwordEncOnDisk()).toBe('');
    expect(await svc.get()).toMatchObject({ ...BASE, hasPassword: false });
  });

  it('空串与 null 同义 —— passwordEnc 的空串本来就表示「还没设密码」', async () => {
    const svc = makeService();
    await svc.save({ ...BASE, password: 'SECRET' });
    await svc.save({ ...BASE, password: '' });
    expect(passwordEncOnDisk()).toBe('');
    expect((await svc.get())?.hasPassword).toBe(false);
    // 不许把空串加密后存进去：那样 hasPassword 会是 true，而用户其实没有密码。
    expect(safe.calls.encrypt).toBe(1);
  });

  it('换新密码时旧密文被替换掉，不是两份并存', async () => {
    const svc = makeService();
    await svc.save({ ...BASE, password: 'OLD' });
    const old = passwordEncOnDisk();
    await svc.save({ ...BASE, password: 'NEW' });
    expect(passwordEncOnDisk()).not.toBe(old);
    expect(await svc.reveal()).toEqual({ password: 'NEW' });
  });
});

// ── 前面几批交下来的债 1：非字符串 passwordEnc 不再静默变空串 ────────────────

describe('债 1 在这一层的样子：加密这一步出岔子，绝不落一条「未设置密码」的记录', () => {
  // 这条闸是 save() 敢直接把算出来的 passwordEnc 交出去的理由：忘了 base64
  // （把 Buffer 原样塞进去）会当场被拒，而不是从前那样静默变成空串 ——
  // 界面显示「未设置密码」，全程零错误。判据本体与它的用例在
  // settingsFile.test.ts / settingsService.test.ts。
  it('把密文 Buffer 原样塞进落盘记录会被拒（settings.invalid），消息说的是 passwordEnc', async () => {
    await expect(settings.updateInstitution(() => ({
      ...BASE, passwordEnc: fakeCipher('SECRET') as unknown as string, confirmedLogin: null,
    }))).rejects.toMatchObject({ code: 'settings.invalid' });
    await expect(settings.updateInstitution(() => ({
      ...BASE, passwordEnc: fakeCipher('SECRET') as unknown as string, confirmedLogin: null,
    }))).rejects.toThrow(/passwordEnc/);
    expect(JSON.parse(settingsOnDisk()).institution).toBeNull();
  });

  // 所以 save() 落下去的必须是字符串。拿掉实现里的 `.toString('base64')` → 上面那道闸
  // 当场把整次保存拒掉 → 这条与「落盘的是密文的 base64」两条一起红。
  it('save 落盘的 passwordEnc 一定是字符串', async () => {
    const svc = makeService();
    await svc.save({ ...BASE, password: 'SECRET' });
    expect(typeof passwordEncOnDisk()).toBe('string');
  });

  // isEncryptionAvailable() 为 true 不等于这一次加密成得了（中间还隔着一次系统调用）。
  it('encryptString 自己抛错 → settings.secure_storage_unavailable，磁盘上什么都没留下', async () => {
    const svc = makeService();
    (safe as unknown as { encryptString: (s: string) => unknown }).encryptString = () => {
      throw new Error('keychain says no');
    };
    await expect(svc.save({ ...BASE, password: 'PLAINTEXT-SENTINEL' }))
      .rejects.toMatchObject({ code: 'settings.secure_storage_unavailable' });
    expect(JSON.parse(settingsOnDisk()).institution).toBeNull();
    expect(settingsOnDisk()).not.toContain('PLAINTEXT-SENTINEL');
  });
});

// ── 标识字段与 confirmedLogin ────────────────────────────────────────────────

describe('save：标识字段与已确认的登录页', () => {
  it('三个标识字段缺一 → settings.invalid，不落半条记录', async () => {
    const svc = makeService();
    for (const bad of [{ ...BASE, name: '' }, { ...BASE, entityID: '' }, { ...BASE, username: '' }]) {
      await expect(svc.save({ ...bad, password: 'p' }), JSON.stringify(bad))
        .rejects.toMatchObject({ code: 'settings.invalid' });
    }
    expect(JSON.parse(settingsOnDisk()).institution).toBeNull();
  });

  it('entityID 没变、confirmedLogin 省略 → 上一次的确认保留', async () => {
    const svc = makeService();
    await svc.save({ ...BASE, password: 'p' });
    expect(await settings.confirmLogin(PKU, IAAA)).toBe(true);
    await svc.save({ ...BASE, username: '2100099999' });
    expect((await svc.get())?.confirmedLogin).toEqual({ entityID: PKU, origin: IAAA });
  });

  it('confirmedLogin: null → 显式作废，下次重新问', async () => {
    const svc = makeService();
    await svc.save({ ...BASE, password: 'p' });
    await settings.confirmLogin(PKU, IAAA);
    await svc.save({ ...BASE, confirmedLogin: null });
    expect((await svc.get())?.confirmedLogin).toBeNull();
  });

  // 换学校却留着上一所的确认，等于把新学校的账号密码填进旧学校的统一身份认证页。
  it('换了 entityID → 上一次的确认当场作废，哪怕调用方没说要作废', async () => {
    const svc = makeService();
    await svc.save({ ...BASE, password: 'p' });
    await settings.confirmLogin(PKU, IAAA);
    await svc.save({ name: '清华大学', entityID: THU, username: '2020010101' });
    expect((await svc.get())?.confirmedLogin).toBeNull();
    expect(JSON.stringify(await svc.get())).not.toContain('iaaa.pku.edu.cn');
  });

  it('clear 之后 get 回 null，磁盘上也是 null', async () => {
    const svc = makeService();
    await svc.save({ ...BASE, password: 'SECRET' });
    await svc.clear();
    expect(await svc.get()).toBeNull();
    expect(JSON.parse(settingsOnDisk()).institution).toBeNull();
    expect(settingsOnDisk()).not.toContain('SECRET');
  });
});

describe('reveal', () => {
  it('没配过机构 → settings.invalid，不是空串', async () => {
    const svc = makeService();
    await expect(svc.reveal()).rejects.toMatchObject({ code: 'settings.invalid' });
  });

  it('配了机构但没设密码 → 回空串，且根本没去解密', async () => {
    const svc = makeService();
    await svc.save({ ...BASE });
    expect(await svc.reveal()).toEqual({ password: '' });
    expect(safe.calls.decrypt).toBe(0);
  });

  it('往返：save 什么就 reveal 出什么（含空格与非 ASCII）', async () => {
    const svc = makeService();
    for (const pw of ['SECRET', ' 前后有空格 ', '密码🔒', 'a'.repeat(500)]) {
      await svc.save({ ...BASE, password: pw });
      expect((await svc.reveal()).password, pw).toBe(pw);
    }
  });
});

// ── 债 3：按响应自己声明的 charset 解码 ──────────────────────────────────────

describe('债 3：清单按 charset 解码，不一律当 UTF-8', () => {
  const GBK_PKU = Buffer.from([0xb1, 0xb1, 0xbe, 0xa9, 0xb4, 0xf3, 0xd1, 0xa7]); // 「北京大学」的 GBK 字节

  it('声明 charset=gbk 时按 GBK 解，机构名不乱码', () => {
    const body = Buffer.concat([Buffer.from('[{"', 'utf8'), GBK_PKU, Buffer.from('":"1|https://idp.pku.edu.cn/idp/shibboleth"}]', 'utf8')]);
    const text = decodeByCharset(body, 'application/json; charset=gbk');
    expect(text).toContain('北京大学');
    expect(text).not.toContain('�');
  });

  // 这是 D15 那条债的核心：从前 1064 条乱码机构名原样进 entries、skipped 为空、
  // 全程零错误。现在字节在声明的编码里解不出来就抛，而不是吐一串 U+FFFD。
  it('GBK 字节却没声明 charset → 抛 institution.idp_list_invalid，不产生一个乱码机构名', () => {
    const body = Buffer.concat([Buffer.from('[{"', 'utf8'), GBK_PKU, Buffer.from('":"1|https://idp.pku.edu.cn/idp/shibboleth"}]', 'utf8')]);
    try { decodeByCharset(body, 'application/json'); expect.unreachable('应当抛出'); }
    catch (e) {
      expect(e).toBeInstanceOf(KydogError);
      expect((e as KydogError).code).toBe('institution.idp_list_invalid');
    }
  });

  it('声明 utf-8 但发的是 GBK → 同样抛，不静默替换成 U+FFFD', () => {
    expect(() => decodeByCharset(GBK_PKU, 'application/json; charset=utf-8'))
      .toThrow(KydogError);
  });

  // 实测 2026-09-09：fsso.cnki.net 回的正是 `application/json`（无 charset），字节是 UTF-8。
  // 这是真实端点今天的形态，不是构造出来的。
  it('没有 charset 参数 + UTF-8 字节 → 按 UTF-8 解（实测端点今天的形态）', () => {
    const body = Buffer.from('[{"北京大学":"1|https://idp.pku.edu.cn/idp/shibboleth"}]', 'utf8');
    expect(decodeByCharset(body, 'application/json')).toContain('北京大学');
    expect(decodeByCharset(body, null)).toContain('北京大学');
  });

  it('charset 带引号、大小写混写、前后空格都认', () => {
    const body = Buffer.from('[{"北京大学":"1|https://idp.pku.edu.cn/idp/shibboleth"}]', 'utf8');
    for (const ct of ['application/json; charset="UTF-8"', 'application/json;charset=UTF-8', 'application/json ; Charset = utf-8 ']) {
      expect(decodeByCharset(body, ct), ct).toContain('北京大学');
    }
  });

  it('声明了一个不认识的编码 → 抛 institution.idp_list_invalid，并把那个标签说出来', () => {
    try { decodeByCharset(Buffer.from('[]'), 'application/json; charset=nonsense-9'); expect.unreachable('应当抛出'); }
    catch (e) {
      expect((e as KydogError).code).toBe('institution.idp_list_invalid');
      expect((e as Error).message).toContain('nonsense-9');
    }
  });

  it('UTF-8 BOM 被吃掉，不会变成机构名的第一个字符', () => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[{"北大":"1|https://idp.pku.edu.cn/idp/shibboleth"}]', 'utf8')]);
    expect(JSON.parse(decodeByCharset(body, 'application/json'))[0]).toHaveProperty('北大');
  });

  it('整条链路：GBK 响应经 listIdps 出来的机构名是对的', async () => {
    const body = Buffer.concat([Buffer.from('[{"', 'utf8'), GBK_PKU, Buffer.from('":"1|https://idp.pku.edu.cn/idp/shibboleth"}]', 'utf8')]);
    const f = fetchOnce(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=gbk' } }));
    const svc = makeService({ fetch: f.fn });
    const r = await svc.listIdps({ refresh: true });
    expect(r.entries).toEqual([{ name: '北京大学', entityID: PKU, flag: '1' }]);
    expect(r.stale).toBe(false);
  });
});

// ── listIdps ────────────────────────────────────────────────────────────────

describe('listIdps：抓到 / 没抓到 / 读不懂是三件不同的事', () => {
  const ONE = [{ 北京大学: '1|https://idp.pku.edu.cn/idp/shibboleth' }];

  it('抓到了 → stale 为 false，fetchedAt 是这一次的，并且落了盘', async () => {
    const f = fetchOnce(() => jsonList(ONE));
    const svc = makeService({ fetch: f.fn });
    const before = Date.now();
    const r = await svc.listIdps({ refresh: true });
    expect(r.stale).toBe(false);
    expect(r.entries).toEqual([{ name: '北京大学', entityID: PKU, flag: '1' }]);
    expect(Date.parse(r.fetchedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(JSON.parse(cacheOnDisk())).toMatchObject({ fetchedAt: r.fetchedAt });
  });

  it('打的是 CNKI 那个真实端点，不是别的', async () => {
    const seen: string[] = [];
    const fn = (async (u: unknown) => { seen.push(String(u)); return jsonList(ONE); }) as unknown as typeof fetch;
    await makeService({ fetch: fn }).listIdps({ refresh: true });
    expect(seen).toEqual([IDP_LIST_URL]);
    expect(IDP_LIST_URL).toBe('https://fsso.cnki.net/idp/list?federation=2');
  });

  // 计划原文那条：fsso.cnki.net 不可达时空列表 =「一个机构都没有」，与「我没抓到」长得一样。
  it('抓取失败时回落到落盘的上一次清单，并带上那一次的抓取日期', async () => {
    const fn = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    const svc = makeService({ fetch: fn });
    await svc.cacheIdps([{ name: '北京大学', entityID: PKU, flag: '1' }], '2026-09-08');
    const r = await svc.listIdps({ refresh: true });
    expect(r.entries).toHaveLength(1);
    expect(r.fetchedAt).toBe('2026-09-08');
    expect(r.stale).toBe(true);
  });

  it('回落时 fetchedAt 是旧清单的日期，不是这次调用的时间', async () => {
    const fn = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    const svc = makeService({ fetch: fn });
    await svc.cacheIdps([{ name: '北京大学', entityID: PKU, flag: '1' }], '2020-01-01T00:00:00.000Z');
    expect((await svc.listIdps({ refresh: true })).fetchedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  // 空数组不能当回答：它在设置页上等于「这个 SP 一个机构都没有」。
  it('既抓不到又没有缓存 → 抛 institution.idp_list_unavailable，不回一份空清单', async () => {
    const fn = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    const svc = makeService({ fetch: fn });
    await expect(svc.listIdps({ refresh: true }))
      .rejects.toMatchObject({ code: 'institution.idp_list_unavailable' });
  });

  it('HTTP 非 2xx 也算没抓到（码是 unavailable，消息里有状态码）', async () => {
    const f = fetchOnce(() => new Response('nope', { status: 503 }));
    const svc = makeService({ fetch: f.fn });
    try { await svc.listIdps({ refresh: true }); expect.unreachable('应当抛出'); }
    catch (e) {
      expect((e as KydogError).code).toBe('institution.idp_list_unavailable');
      expect((e as Error).message).toContain('503');
    }
  });

  // 「没抓到」与「读不懂」处置相反：一个该重试，一个重试一百次也一样。
  it('拿到了字节但读不懂 → institution.idp_list_invalid，与 unavailable 分开', async () => {
    const f = fetchOnce(() => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }));
    const svc = makeService({ fetch: f.fn });
    await expect(svc.listIdps({ refresh: true }))
      .rejects.toMatchObject({ code: 'institution.idp_list_invalid' });
  });

  it('源里真的是空数组 → 正常回一份空清单，不抛（与「读不懂」不是一件事）', async () => {
    const f = fetchOnce(() => jsonList([]));
    const svc = makeService({ fetch: f.fn });
    const r = await svc.listIdps({ refresh: true });
    expect(r.entries).toEqual([]);
    expect(r.stale).toBe(false);
  });

  it('不给 refresh 且有缓存 → 直接用缓存，一次网络请求都不发', async () => {
    const f = fetchOnce(() => jsonList(ONE));
    const svc = makeService({ fetch: f.fn });
    await svc.cacheIdps([{ name: '北京大学', entityID: PKU, flag: '1' }], '2026-09-08');
    const r = await svc.listIdps();
    expect(f.calls()).toBe(0);
    expect(r).toEqual({ entries: [{ name: '北京大学', entityID: PKU, flag: '1' }], fetchedAt: '2026-09-08', stale: true });
  });

  it('不给 refresh 但没有缓存 → 还是要去抓（否则第一次打开设置页是空的）', async () => {
    const f = fetchOnce(() => jsonList(ONE));
    const svc = makeService({ fetch: f.fn });
    const r = await svc.listIdps();
    expect(f.calls()).toBe(1);
    expect(r.stale).toBe(false);
  });

  it('refresh 抓到新的之后，缓存被换成新的那份', async () => {
    const svc0 = makeService({ fetch: fetchOnce(() => jsonList(ONE)).fn });
    await svc0.cacheIdps([{ name: '老清单', entityID: PKU, flag: null }], '2020-01-01');
    const r = await svc0.listIdps({ refresh: true });
    expect(r.entries.map((e) => e.name)).toEqual(['北京大学']);
    expect(JSON.parse(cacheOnDisk()).entries.map((e: IdpEntry) => e.name)).toEqual(['北京大学']);
  });

  // 磁盘写不进去 ≠ 网络不通。混在一起的话，磁盘满会被报成「机构清单没抓到」。
  it('缓存写失败不把「刚抓到的这份」降级成「没抓到」', async () => {
    const f = fetchOnce(() => jsonList(ONE));
    const svc = makeService({ fetch: f.fn });
    vi.spyOn(svc, 'cacheIdps').mockRejectedValue(new Error('ENOSPC'));
    const r = await svc.listIdps({ refresh: true });
    expect(r.stale).toBe(false);
    expect(r.entries).toHaveLength(1);
  });

  it('缓存文件坏了 → 当作没有缓存，而不是拿半份出来用', async () => {
    const f = fetchOnce(() => jsonList(ONE));
    const svc = makeService({ fetch: f.fn });
    writeFileSync(path.join(dir, 'idp-list.json'), '{ 坏掉的 json', 'utf8');
    const r = await svc.listIdps();
    expect(f.calls()).toBe(1);
    expect(r.stale).toBe(false);
  });

  it('缓存里有一条形状不对 → 整份缓存作废，不是悄悄丢那一条', async () => {
    const fn = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    const svc = makeService({ fetch: fn });
    writeFileSync(path.join(dir, 'idp-list.json'), JSON.stringify({
      version: 1, fetchedAt: '2026-09-08',
      entries: [{ name: 'A', entityID: PKU, flag: null }, { name: 'B' }],
    }), 'utf8');
    await expect(svc.listIdps({ refresh: true }))
      .rejects.toMatchObject({ code: 'institution.idp_list_unavailable' });
  });

  it('缓存版本号不认识 → 当作没有缓存', async () => {
    const fn = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    const svc = makeService({ fetch: fn });
    writeFileSync(path.join(dir, 'idp-list.json'), JSON.stringify({
      version: 999, fetchedAt: '2026-09-08', entries: [{ name: 'A', entityID: PKU, flag: null }],
    }), 'utf8');
    await expect(svc.listIdps({ refresh: true })).rejects.toThrow(KydogError);
  });

  it('flag 原样往返 —— 源接口给的字节不许在缓存这一趟里丢掉', async () => {
    const f = fetchOnce(() => jsonList([{ A: '0|https://a.edu.cn/idp/shibboleth' }, { B: 'urn:mace:b' }]));
    const svc = makeService({ fetch: f.fn });
    await svc.listIdps({ refresh: true });
    const again = makeService({ fetch: (async () => { throw new Error('x'); }) as unknown as typeof fetch });
    expect((await again.listIdps()).entries).toEqual([
      { name: 'A', entityID: 'https://a.edu.cn/idp/shibboleth', flag: '0' },
      { name: 'B', entityID: 'urn:mace:b', flag: null },
    ]);
  });

  // deadline 必须罩到**正文读完为止**，不只是响应头回来那一刻。
  // 把 clearTimeout 挪进「拿到响应」那一层就只罩得住响应头：响应头秒回、正文一直不来的
  // 服务端（校园网里的透明代理很会这样）会让设置页的下拉一直转圈，且没有任何错误。
  it('响应头回来了但正文一直不来 → 撞 deadline，报「没抓到」而不是永远挂着', async () => {
    const stalled = new Response(
      new ReadableStream({ start() { /* 一个字节都不发，也不 close */ } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const f = fetchOnce(() => stalled);
    const svc = makeService({ fetch: f.fn, timeoutMs: 30 });
    await expect(svc.listIdps({ refresh: true }))
      .rejects.toMatchObject({ code: 'institution.idp_list_unavailable' });
  });

  /**
   * 超限的响应体故意是**合法 JSON**（一条真机构 + 一大段尾随空白，JSON.parse 照吃）。
   *
   * 第一版这里用的是 4MB 个 'a'：拿掉上限之后它会以「不是合法 JSON」被
   * parseIdpList 拒掉，**码还是 institution.idp_list_invalid**，于是用例照样全绿 ——
   * 一条在真 bug 下不会红的断言。现在换成「不设上限就会成功解析」的载荷，
   * 上限被拿掉时这一条会以「本该抛却拿到了结果」红出来。
   */
  const padded = (bytes: number): Buffer => Buffer.concat([
    Buffer.from('[{"北京大学":"1|https://idp.pku.edu.cn/idp/shibboleth"}]', 'utf8'),
    Buffer.alloc(bytes, 0x20),
  ]);

  it('响应体超过上限 → institution.idp_list_invalid，且不落盘', async () => {
    const body = padded(MAX_IDP_LIST_BYTES);
    expect(body.byteLength).toBeGreaterThan(MAX_IDP_LIST_BYTES);
    expect(JSON.parse(body.toString('utf8'))).toHaveLength(1);   // 反证：不设上限它是读得懂的
    const f = fetchOnce(() => new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    const svc = makeService({ fetch: f.fn });
    try { await svc.listIdps({ refresh: true }); expect.unreachable('应当抛出'); }
    catch (e) {
      expect((e as KydogError).code).toBe('institution.idp_list_invalid');
      expect((e as Error).message).toContain(String(MAX_IDP_LIST_BYTES));
    }
    expect(existsSync(path.join(dir, 'idp-list.json'))).toBe(false);
  });

  // 反面：上限不是「一律拒绝」。少了这条，一个恒抛的实现也能过上面那条。
  it('刚好在上限之内的响应照常读完', async () => {
    const body = padded(1024);
    expect(body.byteLength).toBeLessThan(MAX_IDP_LIST_BYTES);
    const f = fetchOnce(() => new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect((await makeService({ fetch: f.fn }).listIdps({ refresh: true })).entries).toHaveLength(1);
  });

  /**
   * 上面两条喂的都是 `new Response(new Uint8Array(body))` —— 实测这种构造**只产生一块**，
   * 于是它们验的其实是「这一块太大」，从来没验过「累计跨过上限」。而实测 2026-09-09 的
   * 真实响应头是 `transfer-encoding: chunked`、没有 content-length：**分块才是生产常态**，
   * 一份超大响应会以几十上百块到达，每块都远小于上限。上限只有累计才拦得住它。
   *
   * 载荷第一块是完整的合法 JSON，其余块全是空白（`JSON.parse` 吃尾随空白）——
   * 所以「上限没生效」等于「整份读完并成功解析」，这一条会以「本该抛却拿到了结果」红出来，
   * 而不是被同一个 `idp_list_invalid` 兜住（M9 那一类）。
   */
  function chunkedJson(chunkSize: number, chunkCount: number): { fn: typeof fetch; pulled: () => number } {
    const head = Buffer.from('[{"北京大学":"1|https://idp.pku.edu.cn/idp/shibboleth"}]', 'utf8');
    let pulled = 0;
    const fn = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= chunkCount) { c.close(); return; }
        const piece = pulled === 0
          ? Buffer.concat([head, Buffer.alloc(chunkSize - head.byteLength, 0x20)])
          : Buffer.alloc(chunkSize, 0x20);
        pulled += 1;
        c.enqueue(new Uint8Array(piece));
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    return { fn, pulled: () => pulled };
  }

  const CHUNK = 64 * 1024;
  /** 累计刚跨过上限所需的块数 —— 从上限算出来的，不是拍的。 */
  const CHUNKS_TO_CROSS = Math.floor(MAX_IDP_LIST_BYTES / CHUNK) + 1;

  it('分块响应：每块都在上限之内、累计超上限 → 照样被拒（上限是累计的，不是按单块算的）', async () => {
    expect(CHUNK).toBeLessThan(MAX_IDP_LIST_BYTES);        // 前提：没有一块自己超限
    const available = CHUNKS_TO_CROSS * 4;                 // 备足了块，够读也读不完
    const s = chunkedJson(CHUNK, available);
    const svc = makeService({ fetch: s.fn });
    try { await svc.listIdps({ refresh: true }); expect.unreachable('应当抛出'); }
    catch (e) {
      expect((e as KydogError).code).toBe('institution.idp_list_invalid');
      expect((e as Error).message).toContain(String(MAX_IDP_LIST_BYTES));
    }
    // 真的分了多块，「累计」才谈得上：按单块判定的实现在这里一次都不会触发。
    expect(s.pulled()).toBeGreaterThan(1);
    // 而且是边读边数：跨过上限就停，不是先把整份物化再回头看。
    expect(s.pulled()).toBeLessThan(available);
    expect(existsSync(path.join(dir, 'idp-list.json'))).toBe(false);
  });

  // 反面，两件事一起守：分块本身不是拒绝的理由；跨块拼接不许损坏字节
  //（把一个多字节汉字切在两块之间 —— 拼错一个字节，机构名就不是「北京大学」了）。
  it('分块响应：累计在上限之内时照常读完，且跨块拼接不损坏多字节字符', async () => {
    const body = Buffer.from('[{"北京大学":"1|https://idp.pku.edu.cn/idp/shibboleth"}]', 'utf8');
    const midOfHanzi = body.indexOf(Buffer.from('京', 'utf8')) + 1;   // 落在「京」三个字节的中间
    expect(midOfHanzi).toBeGreaterThan(0);
    const pieces = [body.subarray(0, midOfHanzi), body.subarray(midOfHanzi, midOfHanzi + 5), body.subarray(midOfHanzi + 5)];
    let i = 0;
    const fn = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) { if (i >= pieces.length) { c.close(); return; } c.enqueue(new Uint8Array(pieces[i++])); },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const r = await makeService({ fetch: fn }).listIdps({ refresh: true });
    expect(r.entries).toEqual([{ name: '北京大学', entityID: PKU, flag: '1' }]);
  });

  // 实测 2026-09-09：真实响应 76,565 字节 / 1064 条。上限得比它宽得多才不误伤。
  it('实测量级（1064 条、约 76KB）远在上限之内', async () => {
    const many = Array.from({ length: 1064 }, (_, i) => ({ [`机构${i}`]: `1|https://idp${i}.edu.cn/idp/shibboleth` }));
    const body = Buffer.from(JSON.stringify(many), 'utf8');
    expect(body.byteLength).toBeLessThan(MAX_IDP_LIST_BYTES);
    const f = fetchOnce(() => new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await makeService({ fetch: f.fn }).listIdps({ refresh: true });
    expect(r.entries).toHaveLength(1064);
  });
});

// ── 幂等、并发、拒绝之后 ──────────────────────────────────────────────────────
//
// 这三样行为本来就是对的，但一条用例都没有 —— 而它们全都属于「坏掉也不报错」那一类：
// 锁泄漏是挂死、锁外读旧记录是密码被悄悄抹成空。

describe('幂等与并发', () => {
  it('clear() 幂等：没配置过时不抛，连调两次也不抛，磁盘上都是 null', async () => {
    const svc = makeService();
    await expect(svc.clear()).resolves.toBeUndefined();      // 从来没配置过
    await svc.save({ ...BASE, password: 'SECRET' });
    await svc.clear();
    await svc.clear();
    expect(await svc.get()).toBeNull();
    expect(JSON.parse(settingsOnDisk()).institution).toBeNull();
    expect(settingsOnDisk()).not.toContain('SECRET');
  });

  // 两次 save 按调用顺序串行（settingsService 的进程内队列 + 文件锁），后一次赢，
  // 而且赢的那一次的密文真的落了盘 —— 不是「两次都写了，密码却是前一次的」。
  it('并发两次 save 被串起来，最后一次的学号与密码都是它自己的', async () => {
    const svc = makeService();
    await Promise.all([
      svc.save({ ...BASE, password: 'FIRST' }),
      svc.save({ ...BASE, username: '2100099999', password: 'SECOND' }),
    ]);
    expect((await svc.get())?.username).toBe('2100099999');
    expect(await svc.reveal()).toEqual({ password: 'SECOND' });
  });

  /**
   * 「密码省略 = 沿用已存的密文」这条语义要读旧记录，而读必须在**锁内**。
   *
   * 锁外读的实现在这条用例上会输：改学号那一次在改密码那一次落盘之前就把旧记录
   * （`passwordEnc: ''`）读进了手里，随后原样写回 —— 用户刚设的密码被抹掉，全程零错误。
   */
  it('并发「设密码」与「只改学号」：省略 password 的那次读到的是锁内的记录，密码不被抹掉', async () => {
    const svc = makeService();
    await svc.save({ ...BASE });                              // 先建一条还没有密码的记录
    await Promise.all([
      svc.save({ ...BASE, password: 'SECRET' }),              // 设密码
      svc.save({ ...BASE, username: '2100099999' }),          // 只改学号，password 省略
    ]);
    expect((await svc.get())?.username).toBe('2100099999');
    expect((await svc.get())?.hasPassword).toBe(true);
    expect(await svc.reveal()).toEqual({ password: 'SECRET' });
  });

  // 「钥匙串不可用」是在锁内的回调里抛的。锁没释放的话这条不会断言失败，
  // 而是整条用例挂到 vitest 的超时 —— 那正是它要挡的现象。
  it('被钥匙串拒掉一次之后锁照常释放，后续保存不会挂死', async () => {
    const svc = makeService({ available: false });
    await expect(svc.save({ ...BASE, password: 'p' })).rejects.toThrow();
    safe.available = true;
    await svc.save({ ...BASE, password: 'SECRET' });
    expect((await svc.get())?.hasPassword).toBe(true);
    expect(await svc.reveal()).toEqual({ password: 'SECRET' });
  });
});
