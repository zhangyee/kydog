import { describe, it, expect } from 'vitest';
import { checkLoginHost, isSamlAssertionPost } from './login';
import type { ConfirmedLogin } from '../../shared/types';

const PKU = 'https://idp.pku.edu.cn/idp/shibboleth';
const THU = 'https://idp.tsinghua.edu.cn/idp/shibboleth';
/** 北大实测：entityID 是 idp.pku.edu.cn，登录表单却在 iaaa.pku.edu.cn。 */
const IAAA = 'https://iaaa.pku.edu.cn/iaaa/oauth.jsp';
const CONFIRMED_IAAA: ConfirmedLogin = { entityID: PKU, origin: 'https://iaaa.pku.edu.cn' };

describe('checkLoginHost：直接填只有两条路', () => {
  it('当前页 host 精确等于 entityID 的 host → 直接填', () => {
    expect(checkLoginHost({
      entityID: PKU,
      currentUrl: 'https://idp.pku.edu.cn/idp/profile/SAML2/Redirect/SSO',
      confirmedLogin: null,
    })).toEqual({ kind: 'fill', host: 'idp.pku.edu.cn' });
  });

  it('大小写与尾点归一之后仍算精确相等', () => {
    expect(checkLoginHost({ entityID: PKU, currentUrl: 'https://IDP.PKU.EDU.CN./x', confirmedLogin: null }))
      .toEqual({ kind: 'fill', host: 'idp.pku.edu.cn' });
  });

  it('entityID 那一侧带尾点也一样归一', () => {
    expect(checkLoginHost({ entityID: 'https://idp.pku.edu.cn./idp/shibboleth', currentUrl: 'https://idp.pku.edu.cn/x', confirmedLogin: null }))
      .toEqual({ kind: 'fill', host: 'idp.pku.edu.cn' });
  });

  it('已确认的 origin 全等 → 直接填', () => {
    expect(checkLoginHost({ entityID: PKU, currentUrl: IAAA, confirmedLogin: CONFIRMED_IAAA }))
      .toEqual({ kind: 'fill', host: 'iaaa.pku.edu.cn' });
  });
});

describe('checkLoginHost：删掉 eTLD+1 之后，其余一律先确认一次', () => {
  // 原来「同注册域就直接填」，靠的是一张手写 32 条多段后缀表 + 「不在表里按两段算」
  // 的兜底 —— 而那个兜底方向是 fail-open。这套机制的全部收益只是「第一次不用问
  // 用户」，而确认机制本来就存在，所以整套删掉，北大这条改成问一次。
  it('同一所学校的另一个子域也要确认一次', () => {
    expect(checkLoginHost({ entityID: PKU, currentUrl: IAAA, confirmedLogin: null }))
      .toEqual({ kind: 'confirm-then-fill', host: 'iaaa.pku.edu.cn', origin: 'https://iaaa.pku.edu.cn' });
  });

  // 实测绕过：ac.za 不在那张表里 → registrableDomain 把两边都算成 'ac.za' →
  // 攻击者拿一个同后缀域就能收走别校密码。ac.il / ac.th / ac.id / ac.at /
  // edu.ar / edu.ng 等 20 多个后缀同样通过。
  it('表外后缀（ac.za）的攻击者域拿不到「直接填」', () => {
    expect(checkLoginHost({
      entityID: 'https://idp.uct.ac.za/idp/shibboleth',
      currentUrl: 'https://login.evil.ac.za/',
      confirmedLogin: null,
    })).toEqual({ kind: 'confirm-then-fill', host: 'login.evil.ac.za', origin: 'https://login.evil.ac.za' });
  });

  it('跨域也只到「确认一次」，永远不直接填', () => {
    for (const u of ['https://evil.com/', 'https://idp.pku.edu.cn.evil.com/',
                     'https://pku.edu.cn.attacker.net/', 'https://evil.edu.cn/']) {
      expect(checkLoginHost({ entityID: PKU, currentUrl: u, confirmedLogin: null }).kind, u)
        .toBe('confirm-then-fill');
    }
  });
});

describe('checkLoginHost：确认必须绑在 entityID 上', () => {
  // 用户先配北大（确认过 iaaa.pku.edu.cn），后来改选清华并换成清华的学号密码。
  // entityID 不参与判据的话，主进程会把清华账号密码填进北大的统一身份认证页。
  it('换成清华的 entityID 之后，北大那次确认作废', () => {
    const r = checkLoginHost({ entityID: THU, currentUrl: IAAA, confirmedLogin: CONFIRMED_IAAA });
    expect(r.kind).toBe('confirm-then-fill');
  });

  it('origin 对得上但 entityID 对不上，一样不算确认过', () => {
    const wrongEntity: ConfirmedLogin = { entityID: THU, origin: 'https://iaaa.pku.edu.cn' };
    expect(checkLoginHost({ entityID: PKU, currentUrl: IAAA, confirmedLogin: wrongEntity }).kind)
      .toBe('confirm-then-fill');
  });
});

describe('checkLoginHost：scheme 必须进判据', () => {
  // urlGuard 明确放行 http。判据拿不到 scheme 的话，同一 Wi-Fi 上的攻击者应答
  // http://iaaa.pku.edu.cn/ 就能收走校园密码，而用户之前在 https 上做的那次确认
  // 反而把它一并放行了。
  it('非 https 一律拒绝，连确认的机会都不给', () => {
    expect(checkLoginHost({ entityID: PKU, currentUrl: 'http://iaaa.pku.edu.cn/', confirmedLogin: null }).kind)
      .toBe('refuse');
  });

  it('entityID 自己那个 host 走 http 也不例外', () => {
    expect(checkLoginHost({ entityID: PKU, currentUrl: 'http://idp.pku.edu.cn/', confirmedLogin: null }).kind)
      .toBe('refuse');
  });

  it('已确认过 https 的那个 host，它的 http 版本仍然被拒', () => {
    expect(checkLoginHost({ entityID: PKU, currentUrl: 'http://iaaa.pku.edu.cn/', confirmedLogin: CONFIRMED_IAAA }).kind)
      .toBe('refuse');
  });

  // 落盘的 origin 只兜了「是个非空字符串」，值本身没人校验。
  it('落盘的 origin 记成 http（脏数据）→ https 页不算命中它', () => {
    const dirty: ConfirmedLogin = { entityID: PKU, origin: 'http://iaaa.pku.edu.cn' };
    expect(checkLoginHost({ entityID: PKU, currentUrl: IAAA, confirmedLogin: dirty }).kind)
      .toBe('confirm-then-fill');
  });

  it('落盘的 origin 根本解析不了 → 当没确认过，不当崩', () => {
    const junk: ConfirmedLogin = { entityID: PKU, origin: 'iaaa.pku.edu.cn' };
    expect(checkLoginHost({ entityID: PKU, currentUrl: IAAA, confirmedLogin: junk }).kind)
      .toBe('confirm-then-fill');
  });

  it('端口也算 origin 的一部分', () => {
    expect(checkLoginHost({ entityID: PKU, currentUrl: 'https://iaaa.pku.edu.cn:8443/x', confirmedLogin: CONFIRMED_IAAA }).kind)
      .toBe('confirm-then-fill');
  });
});

describe('checkLoginHost：直接拒绝（不给确认机会）', () => {
  it('裸 IP —— 公网的那些也一样', () => {
    for (const u of ['https://127.0.0.1/', 'https://8.8.8.8/', 'https://[::1]/', 'https://[2001:db8::1]/']) {
      expect(checkLoginHost({ entityID: PKU, currentUrl: u, confirmedLogin: null }).kind, u).toBe('refuse');
    }
  });

  it('localhost 一类的内网名字', () => {
    for (const u of ['https://localhost/', 'https://localhost./', 'https://foo.local/',
                     'https://nas.lan/', 'https://localhost.localdomain/']) {
      expect(checkLoginHost({ entityID: PKU, currentUrl: u, confirmedLogin: null }).kind, u).toBe('refuse');
    }
  });

  it('currentUrl 为空 / 畸形 / 没有主机名', () => {
    for (const u of ['', '   ', 'not a url', 'https//idp.pku.edu.cn/', 'https://./']) {
      expect(checkLoginHost({ entityID: PKU, currentUrl: u, confirmedLogin: null }).kind, u).toBe('refuse');
    }
  });

  // 拒绝这一档要压在 confirmedLogin 前面：脏数据里存着 https://localhost 的话，
  // 「已确认」不能反过来把本机地址放行。
  it('已确认过也拦得住 —— 本机地址优先于 confirmedLogin', () => {
    const c: ConfirmedLogin = { entityID: PKU, origin: 'https://localhost' };
    expect(checkLoginHost({ entityID: PKU, currentUrl: 'https://localhost/', confirmedLogin: c }).kind)
      .toBe('refuse');
  });

  // 国际联邦那份清单里的 entityID 是 URN，没有 host 可比，没有任何协议层依据
  // 判断「这确实是本校的登录页」——「确认框上显示一个我们自己也说不清的 host」
  // 不是确认，是让用户替我们猜。走人工。
  it('entityID 是 URN → 拒绝，走人工', () => {
    const r = checkLoginHost({
      entityID: 'urn:mace:ac.uk:sdss.ac.uk:provider:identity:dur.ac.uk',
      currentUrl: 'https://sso.dur.ac.uk/',
      confirmedLogin: null,
    });
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('URN');
  });

  it('entityID 畸形或为空 → 拒绝', () => {
    // CARSI 官方清单里就有两条缺冒号的真实脏数据。
    expect(checkLoginHost({ entityID: 'https//idp.xjut.edu.cn/idp/shibboleth', currentUrl: 'https://idp.xjut.edu.cn/', confirmedLogin: null }).kind)
      .toBe('refuse');
    expect(checkLoginHost({ entityID: '', currentUrl: 'https://a.com/', confirmedLogin: null }).kind)
      .toBe('refuse');
  });

  it('拒绝理由不回显 currentUrl 的原串', () => {
    const r = checkLoginHost({ entityID: PKU, currentUrl: 'https://svc:秘密密码@[bad/', confirmedLogin: null });
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).not.toContain('秘密密码');
      expect(r.reason).not.toContain('svc');
    }
  });
});

describe('checkLoginHost：refuse 带一个可分流的判别值 why', () => {
  // reason 是给人看的中文，不能让下游 match 它来分流。why 是字面量联合，
  // 要和 checkLoginHost 里实际的 refuse 分支一一对应 —— 六个分支，六个取值。
  const refuseWhy = (args: Parameters<typeof checkLoginHost>[0]) => {
    const r = checkLoginHost(args);
    expect(r.kind).toBe('refuse');
    if (r.kind !== 'refuse') throw new Error('unreachable');
    return r.why;
  };

  it('当前标签的网址无法解析 → unparsable', () => {
    expect(refuseWhy({ entityID: PKU, currentUrl: 'https://svc:秘密密码@[bad/', confirmedLogin: null }))
      .toBe('unparsable');
  });

  it('当前标签没有主机名 → no-host', () => {
    expect(refuseWhy({ entityID: PKU, currentUrl: 'https://./', confirmedLogin: null })).toBe('no-host');
  });

  it('非 https → not-https', () => {
    expect(refuseWhy({ entityID: PKU, currentUrl: 'http://iaaa.pku.edu.cn/', confirmedLogin: null }))
      .toBe('not-https');
  });

  it('裸 IP → bare-ip', () => {
    expect(refuseWhy({ entityID: PKU, currentUrl: 'https://8.8.8.8/', confirmedLogin: null })).toBe('bare-ip');
  });

  it('内网名字 → local-host', () => {
    expect(refuseWhy({ entityID: PKU, currentUrl: 'https://localhost/', confirmedLogin: null }))
      .toBe('local-host');
  });

  it('entityID 是 URN，没有 host 可比 → entity-has-no-host', () => {
    expect(refuseWhy({
      entityID: 'urn:mace:ac.uk:sdss.ac.uk:provider:identity:dur.ac.uk',
      currentUrl: 'https://sso.dur.ac.uk/',
      confirmedLogin: null,
    })).toBe('entity-has-no-host');
  });
});

describe('checkLoginHost：返回形状让漏判确认的调用方编译不过', () => {
  // 老形状是 { ok: true; needsConfirm: boolean; host: string }，调用方写
  // `if (check.ok) await fillPassword()` 完全合法、编译通过、用例全绿 ——
  // 而 spec §4.6 第 2 条那次用户确认就整条消失了。
  it('host 必须先按 kind 收窄才取得到', () => {
    const d = checkLoginHost({ entityID: PKU, currentUrl: IAAA, confirmedLogin: null });
    // @ts-expect-error refuse 分支上没有 host，不收窄就取不到。返回形状要是被摊平
    // 回「一个布尔加一个 host」，这里就没有错误可抑制，npx tsc --noEmit 直接红。
    const leaked: string = d.host;
    expect(leaked).toBe('iaaa.pku.edu.cn');
    expect(d.kind).toBe('confirm-then-fill');
  });
});

describe('checkLoginHost：确认框前后的 TOCTOU', () => {
  // 这次确认是一次工具执行中途的跨进程悬挂（ask broker：挂起 promise → 广播 →
  // UI → RPC 回来），人在框上停留几秒到几十秒是常态。返回值不能跨越挂起使用。
  it('确认后写回同一个 origin，再判就是 fill', () => {
    const r = checkLoginHost({ entityID: PKU, currentUrl: IAAA, confirmedLogin: null });
    expect(r.kind).toBe('confirm-then-fill');
    if (r.kind !== 'confirm-then-fill') return;
    const written: ConfirmedLogin = { entityID: PKU, origin: r.origin };
    expect(checkLoginHost({ entityID: PKU, currentUrl: IAAA, confirmedLogin: written }))
      .toEqual({ kind: 'fill', host: 'iaaa.pku.edu.cn' });
  });

  it('确认框还开着的时候页面自己跳走 → 重判不是 fill', () => {
    const written: ConfirmedLogin = { entityID: PKU, origin: 'https://iaaa.pku.edu.cn' };
    expect(checkLoginHost({ entityID: PKU, currentUrl: 'https://evil.com/idp/', confirmedLogin: written }).kind)
      .toBe('confirm-then-fill');
  });

  it('confirm-then-fill 带上被确认的那个 origin，且只有 origin —— 路径/查询/片段不进去', () => {
    expect(checkLoginHost({ entityID: PKU, currentUrl: 'https://iaaa.pku.edu.cn:8443/login?next=a#f', confirmedLogin: null }))
      .toEqual({ kind: 'confirm-then-fill', host: 'iaaa.pku.edu.cn', origin: 'https://iaaa.pku.edu.cn:8443' });
  });
});

const post = (url: string, body: string) => ({
  url, method: 'POST',
  uploadData: [{ bytes: Buffer.from(body) }],
});

describe('isSamlAssertionPost：两条协议事实同时满足才算断言回传', () => {
  it('带 SAMLResponse 且目的 host 不是 IdP → 是', () => {
    expect(isSamlAssertionPost(
      post('https://fsso.cnki.net/Shibboleth.sso/SAML2/POST', 'SAMLResponse=PHNhbWxw&RelayState=x'), PKU,
    )).toBe(true);
  });

  // 用户在 IdP 页点提交本身就是一次主 frame POST。密码错时多数 IdP 返回
  // 200 错误页或 302 回自己 —— 松判据会把它报成登录成功。
  it('目的仍是 IdP host → 不是（这正是被冒充的那一次）', () => {
    expect(isSamlAssertionPost(
      post('https://idp.pku.edu.cn/idp/profile/SAML2/POST', 'userName=x&password=y'), PKU,
    )).toBe(false);
  });

  it('域外但没有 SAMLResponse → 不是', () => {
    expect(isSamlAssertionPost(post('https://fsso.cnki.net/anything', 'foo=bar'), PKU)).toBe(false);
  });

  it('GET 不算', () => {
    expect(isSamlAssertionPost(
      { url: 'https://fsso.cnki.net/x', method: 'GET', uploadData: undefined }, PKU,
    )).toBe(false);
  });

  // 上面那条 GET 的 uploadData 本来就是空的，方法判据删掉它照样绿 —— 要真的守住
  // 「必须是 POST」，得给一个带得出 SAMLResponse 的 GET。HTTP-Redirect 绑定就是
  // 这个形态：SAMLResponse 在查询串里，那不是断言回传的那一次 POST。
  it('带得出 SAMLResponse 的 GET 也不算 —— 方法判据自己要立得住', () => {
    expect(isSamlAssertionPost({
      url: 'https://fsso.cnki.net/x?SAMLResponse=PHNhbWxw',
      method: 'GET',
      uploadData: [{ bytes: Buffer.from('SAMLResponse=PHNhbWxw') }],
    }, PKU)).toBe(false);
  });

  it('entityID 是 URN（无 host 可比）→ 一律不是，走人工', () => {
    expect(isSamlAssertionPost(
      post('https://sp.example/acs', 'SAMLResponse=x'), 'urn:mace:ac.uk:x',
    )).toBe(false);
  });
});

describe('isSamlAssertionPost：参数名要按边界匹配', () => {
  // includes('SAMLResponse=') 会被 XSAMLResponse= / mySAMLResponse= 骗到。
  it('前缀粘连的参数名不算', () => {
    expect(isSamlAssertionPost(post('https://sp.example/acs', 'XSAMLResponse=x'), PKU)).toBe(false);
    expect(isSamlAssertionPost(post('https://sp.example/acs', 'foo=1&mySAMLResponse=x'), PKU)).toBe(false);
  });

  it('排在后面的 SAMLResponse 照样算', () => {
    expect(isSamlAssertionPost(post('https://sp.example/acs', 'RelayState=x&SAMLResponse=y'), PKU)).toBe(true);
  });

  it('请求体被切成多块时要先拼起来再判', () => {
    expect(isSamlAssertionPost({
      url: 'https://sp.example/acs', method: 'POST',
      uploadData: [{ bytes: Buffer.from('RelayState=x&SAML') }, { bytes: Buffer.from('Response=y') }],
    }, PKU)).toBe(true);
  });

  it('uploadData 缺失或没有 bytes → 不是', () => {
    expect(isSamlAssertionPost({ url: 'https://sp.example/acs', method: 'POST' }, PKU)).toBe(false);
    expect(isSamlAssertionPost({ url: 'https://sp.example/acs', method: 'POST', uploadData: [{}] }, PKU)).toBe(false);
  });

  it('IdP host 的比较也要归一（大小写、尾点）', () => {
    // 目的一侧带尾点
    expect(isSamlAssertionPost(
      post('https://IDP.PKU.EDU.CN./idp/profile/SAML2/POST', 'SAMLResponse=x'), PKU,
    )).toBe(false);
    // entityID 一侧带尾点
    expect(isSamlAssertionPost(
      post('https://idp.pku.edu.cn/idp/profile/SAML2/POST', 'SAMLResponse=x'),
      'https://idp.pku.edu.cn./idp/shibboleth',
    )).toBe(false);
  });

  it('目的 url 畸形 → 不是', () => {
    expect(isSamlAssertionPost(post('not a url', 'SAMLResponse=x'), PKU)).toBe(false);
  });
});
