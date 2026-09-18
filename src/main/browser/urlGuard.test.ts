import { describe, it, expect } from 'vitest';
import { checkUrl, assertAllowedUrl, parseIPv4 } from './urlGuard';
import { KydogError } from '../../shared/errors';

const ok = (u: string) => { const v = checkUrl(u); expect(v.ok, `期望放行：${u}（实际拒绝：${v.ok ? '' : v.reason}）`).toBe(true); return v; };
const no = (u: string) => { const v = checkUrl(u); expect(v.ok, `期望拒绝：${u}`).toBe(false); return v as Extract<typeof v, { ok: false }>; };

describe('urlGuard：协议白名单', () => {
  it('放行 http / https', () => {
    ok('https://scholar.google.com/');
    ok('http://xueshu.baidu.com/s?wd=x');
    ok('https://fsso.cnki.net/Shibboleth.sso/Login?entityID=https://idp.pku.edu.cn/idp/shibboleth');
  });

  // file: 能读本机任意文件；data: / javascript: 能在我们的 partition 里执行任意脚本，
  // 那个 partition 装着用户的机构登录态。
  it('拒绝 file / data / javascript / blob / about 等一切非 http(s)', () => {
    for (const u of ['file:///etc/passwd', 'data:text/html,<h1>x', 'javascript:alert(1)',
                     'blob:https://a.com/x', 'about:blank', 'chrome://settings', 'ftp://a.com/']) {
      expect(no(u).code).toBe('browser.bad_url');
    }
  });

  it('拒绝畸形 URL 与空串', () => {
    for (const u of ['', '   ', 'not a url', 'https//idp.xjut.edu.cn/idp/shibboleth', '://x']) no(u);
  });

  // CARSI 官方清单里就有两条缺冒号的 entityID（新疆工业学院、广东金融学院）。
  // 那种串必须在这里被挡住，而不是被当成相对路径解析成别的东西。
  it('CARSI 清单里那两条缺冒号的真实脏数据被挡住', () => {
    no('https//idp.xjut.edu.cn/idp/shibboleth');
    no('https//idp.gduf.edu.cn/idp/shibboleth');
  });
});

describe('urlGuard：内网与本机', () => {
  it('拒绝 localhost 及其子域', () => {
    for (const u of ['http://localhost/', 'http://localhost:8080/x', 'https://LOCALHOST/',
                     'http://foo.localhost/', 'http://a.b.localhost:3000/']) no(u);
  });

  it('拒绝 IPv4 私有段与回环', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '10.255.255.255',
                     '192.168.0.1', '192.168.255.1', '172.16.0.1', '172.31.255.255',
                     '169.254.1.1', '0.0.0.0']) {
      expect(no(`http://${h}/`).code).toBe('browser.bad_url');
    }
  });

  // 172.16/12 的边界：15 和 32 在公网段里，不该被误挡。
  it('172.15.x 与 172.32.x 是公网，不误挡', () => {
    ok('http://172.15.0.1/');
    ok('http://172.32.0.1/');
  });

  it('拒绝云元数据端点', () => {
    no('http://169.254.169.254/latest/meta-data/');
    no('http://metadata.google.internal/computeMetadata/v1/');
  });

  it('拒绝 IPv6 回环、链路本地与唯一本地地址', () => {
    for (const h of ['[::1]', '[fe80::1]', '[fc00::1]', '[fd12:3456::1]', '[::ffff:127.0.0.1]']) no(`http://${h}/`);
  });

  it('放行公网 IP', () => {
    ok('http://8.8.8.8/');
    ok('http://[2001:4860:4860::8888]/');
  });

  // https://evil.com@scholar.google.com/ 里真正被访问的是后者，但人眼读到的是前者。
  // 这类串没有正当用途，直接拒绝比让它进来再解释便宜。
  it('拒绝 URL 里带用户名密码的形态', () => {
    no('https://evil.com@scholar.google.com/');
    no('https://user:pw@scholar.google.com/');
  });
});

describe('urlGuard：承诺的边界', () => {
  // 这道闸只挡「显式写出来的内网地址」，不是 SSRF 防线：公网域名可以解析或重绑定到
  // 内网 IP，页面的子资源请求也根本不经过这里。文档与代码都不许把它说成后者。
  it('一个解析到内网的公网域名不会被挡 —— 这是已知且明确接受的边界', () => {
    ok('http://localtest.me/');
  });
});

describe('assertAllowedUrl', () => {
  it('放行时返回解析好的 URL 对象', () => {
    expect(assertAllowedUrl('https://scholar.google.com/x?q=1').host).toBe('scholar.google.com');
  });
  it('拒绝时抛 KydogError 且 code 是 browser.bad_url', () => {
    try { assertAllowedUrl('file:///etc/passwd'); expect.unreachable('应当抛出'); }
    catch (e) { expect(e).toBeInstanceOf(KydogError); expect((e as KydogError).code).toBe('browser.bad_url'); }
  });
});

describe('urlGuard：尾点 FQDN 不能整条绕过主机名判据', () => {
  // new URL('http://localhost./').hostname 是 'localhost.' —— 根标签的那个点原样
  // 留在 hostname 上，四个 endsWith / === 分支一个都不命中。而 dns.lookup('localhost.')
  // 实测返回 127.0.0.1 与 ::1（RFC 6761：localhost. 就是 localhost 的 FQDN）。
  it('带尾点的本机与内网名字照样拒绝', () => {
    for (const u of ['http://localhost./', 'http://LOCALHOST.:8080/x', 'http://foo.local./',
                     'http://metadata.google.internal./computeMetadata/v1/', 'http://a.internal./',
                     'http://localhost.localdomain./', 'http://nas.lan./']) no(u);
  });

  // 失败场景原样钉住：只差一个点的 http://localhost:11434/ 会被正确挡下，
  // 而 http://localhost.:11434/ 曾经能读到用户本机 Ollama 的模型清单。
  it('本机 Ollama 那条真实绕过', () => {
    no('http://localhost:11434/api/tags');
    no('http://localhost.:11434/api/tags');
  });

  it('归一后主机名为空的畸形网址也拒绝', () => {
    no('http://./');
    no('http://../');
  });
});

describe('urlGuard：内网名字逐条都有人守', () => {
  // 下面每条都对应 isLocalHostname 里的一个后缀。删掉任何一条，这里必须红。
  it('.local（mDNS）', () => {
    no('http://printer.local/');
    no('http://nas.local/');
  });

  it('.internal —— 云元数据端点靠的就是它', () => {
    no('http://metadata.google.internal/computeMetadata/v1/');
    no('http://a.internal/');
  });

  it('localhost.localdomain —— 多数发行版 /etc/hosts 第一行就有它，连尾点都不需要', () => {
    no('http://localhost.localdomain/');
  });

  it('家用网络：.lan / .home.arpa（RFC 8375）/ fritz.box', () => {
    no('http://nas.lan/');
    no('http://router.home.arpa/');
    no('http://home.arpa/');
    no('http://fritz.box/');
    no('http://www.fritz.box/');
  });

  // 后缀判据必须按标签边界比，不能是裸 endsWith 字符串包含。
  // `.box` 是真实的 gTLD，`notfritz.box` 是一个可以注册的公网域名 ——
  // 判据退化成 h.endsWith('fritz.box') 就会连它一起挡掉，而这里正是唯一
  // 能观察到那次退化的地方（其余几条都在 TLD 位置上，撞不出来）。
  it('形近的公网域名不误挡', () => {
    ok('https://notfritz.box/');
    ok('https://mylan.com/');
    ok('https://notlocal.example.com/');
    ok('https://internal-medicine.org/');
    ok('https://arpa.example.com/');
    ok('https://fritz.box.example.com/');
  });
});

describe('urlGuard：IP 判据里没人守的几条', () => {
  it('CGNAT 100.64/10 被挡，段外的 100.63 与 100.128 不误挡', () => {
    no('http://100.64.0.0/');
    no('http://100.100.1.1/');
    no('http://100.127.255.255/');
    ok('http://100.63.255.255/');
    ok('http://100.128.0.0/');
  });

  it('IPv6 未指定地址 :: 也是本机', () => {
    no('http://[::]/');
  });
});

describe('parseIPv4：八位组越界不算 IPv4 字面量', () => {
  // 这条边界从 checkUrl 那一侧观察不到 —— WHATWG 在 new URL 就把越界的
  // 点分十进制拒了（见下面那条），所以只能直接钉这个纯函数。
  it('越界的八位组返回 null', () => {
    expect(parseIPv4('256.1.2.3')).toBeNull();
    expect(parseIPv4('127.0.0.256')).toBeNull();
    expect(parseIPv4('999.999.999.999')).toBeNull();
  });

  it('合法的点分十进制照常解析', () => {
    expect(parseIPv4('127.0.0.1')).toEqual([127, 0, 0, 1]);
    expect(parseIPv4('10.0.0.255')).toEqual([10, 0, 0, 255]);
    expect(parseIPv4('0.0.0.0')).toEqual([0, 0, 0, 0]);
  });

  it('不是点分十进制的返回 null', () => {
    expect(parseIPv4('example.com')).toBeNull();
    expect(parseIPv4('1.2.3')).toBeNull();
    expect(parseIPv4('[::1]')).toBeNull();
  });

  it('越界的点分十进制在 new URL 那一步就被拒', () => {
    no('http://256.1.2.3/');
    no('http://127.999.0.1/');
  });
});

describe('urlGuard：拒绝理由不许回显原串', () => {
  // 解析失败的两条分支原样把 raw 写进 reason，绕过了同一个函数里「不回显凭据」
  // 的保护。这个 reason 会进 KydogError.message（→ 模型上下文）与 logger（→ 落盘）。
  it('解析失败时 reason 不含原串里的凭据', () => {
    const v = no('https://svc:秘密密码@[bad/');
    expect(v.reason).not.toContain('秘密密码');
    expect(v.reason).not.toContain('svc');
    expect(v.reason).not.toContain('bad');
  });

  it('能解析但带凭据的那条也不回显（原来就是对的）', () => {
    const v = no('https://user:pw@scholar.google.com/');
    expect(v.reason).not.toContain('pw');
    expect(v.reason).not.toContain('user');
  });

  it('没有主机名的网址不回显原串', () => {
    expect(no('http://./').reason).not.toContain('http');
  });
});
