import { KydogError } from '../../shared/errors';
import type { KydogErrorCode } from '../../shared/errors';

/**
 * URL 闸。**承诺的范围是「拒绝显式写出来的内网地址」，不是 SSRF 防线** ——
 * 一个公网域名完全可以解析、或被重新绑定到内网 IP，而页面自己发出的子资源请求
 * 根本不经过这里。真正的网络隔离要在 DNS / 网络层做，本期不做。
 * 别在任何文档或注释里把它说成后者。
 *
 * 它必须装在每一条入口上，不只是 browser.open 的参数：点链接、提交表单、服务端
 * 重定向、window.open、子 frame、页面主动发起的下载，都要过同一个判据。
 */

export type UrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; code: KydogErrorCode; reason: string };

const deny = (reason: string): UrlVerdict => ({ ok: false, code: 'browser.bad_url', reason });

/**
 * 点分十进制 IPv4 字面量。主机名形如 "1.2.3.4" 时才走 IP 判据，域名不走。
 *
 * 导出只为让「八位组越界」这条边界能被直接钉住：经 checkUrl 进来的 hostname 已经
 * 被 WHATWG 规范化过，`http://256.1.2.3/` 在 `new URL` 那一步就抛了，所以从
 * checkUrl 那一侧根本观察不到这条判据 —— 删掉它 checkUrl 的用例照样全绿。
 */
export function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

function isPrivateIPv4([a, b]: number[]): boolean {
  if (a === 0) return true;              // 0.0.0.0/8：本网络
  if (a === 10) return true;             // 10/8
  if (a === 127) return true;            // 回环
  if (a === 169 && b === 254) return true; // 链路本地，云元数据端点也在这段
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 —— 边界是 16..31，
                                                    // 172.15 与 172.32 是公网，不能跟着一起挡
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

/**
 * 把 IPv6 字面量展开成 8 组 16 位。必须真的展开而不是看前缀字符串：
 * WHATWG 的 URL 解析器会**规范化**主机名 —— `[::ffff:127.0.0.1]` 落到 hostname
 * 时已经变成 `[::ffff:7f00:1]`，按点分十进制去匹配永远匹配不到。
 */
function expandIPv6(raw: string): number[] | null {
  const s = raw.toLowerCase();
  if (!/^[0-9a-f:]*$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (t: string) => (t === '' ? [] : t.split(':').map((g) => parseInt(g, 16)));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  if ([...head, ...tail].some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

/** URL 里的 IPv6 字面量带方括号；WHATWG 解析后 hostname 仍保留它们。 */
function isPrivateIPv6(host: string): boolean {
  if (!host.startsWith('[') || !host.endsWith(']')) return false;
  const g = expandIPv6(host.slice(1, -1));
  if (!g) return false;
  if (g.every((n) => n === 0)) return true;                         // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d —— 内嵌的 v4 决定它指向哪
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
    return isPrivateIPv4(v4);
  }
  if ((g[0] & 0xffc0) === 0xfe80) return true;  // fe80::/10 链路本地
  if ((g[0] & 0xfe00) === 0xfc00) return true;  // fc00::/7  唯一本地
  return false;
}

/**
 * 指向本机或内网基础设施的名字后缀。每条都按**标签边界**比（`h === s` 或
 * `h.endsWith('.' + s)`），不是裸字符串包含 —— 否则 `mylan.com` 会被 `lan` 误挡。
 *
 * 这里刻意没有 `metadata.google.internal` 那条单独的相等判据：它被 `internal`
 * 完全覆盖，两条并存等于互为冗余 —— 只删其一「拒绝云元数据端点」的用例仍然全绿，
 * 也就是那条规则实际上没人守。要守就只留一条。
 */
const LOCAL_HOST_SUFFIXES = [
  'localhost',    // RFC 6761
  'localdomain',  // 多数 Linux 发行版 /etc/hosts 第一行：127.0.0.1 localhost.localdomain localhost
  'local',        // mDNS
  'internal',     // 云元数据端点 metadata.google.internal 也在这里
  'lan',
  'home.arpa',    // RFC 8375 给家庭网络的保留域
  'fritz.box',    // AVM 路由器的管理页
];

/**
 * 这些名字不必解析就知道指向本机或内网基础设施。
 *
 * **入参必须是 normalizeHost 归一过的主机名**：根标签的那个点会原样留在
 * `new URL(...).hostname` 上（`'localhost.'`），不剥掉的话下面每条判据都不命中，
 * 而 `dns.lookup('localhost.')` 实测就是 127.0.0.1 —— 整条黑名单被一个点绕过。
 *
 * 导出给 login.ts 用：机构登录页判据要拒同一批名字，两份表会漂。
 */
export function isLocalHostname(h: string): boolean {
  return LOCAL_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * 主机名归一：小写 + 剥掉根标签的点。
 *
 * WHATWG 已经替我们小写并把 IPv4 的尾点吃掉了，域名的尾点它却原样保留 ——
 * 所以这一步不是多余的，`http://localhost./` 与 `http://LOCALHOST.:8080/x`
 * 都靠它落回同一个判据。
 */
export function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}

export function checkUrl(raw: string): UrlVerdict {
  if (typeof raw !== 'string' || raw.trim() === '') return deny('空网址');

  // 解析失败的分支**不许回显 raw** —— 它可能整条带着凭据（实测
  // `https://svc:秘密密码@[bad/` 会走到这里），而 reason 会进 KydogError.message
  // （→ 模型上下文）与 logger.warn（→ 落盘），正好绕过下面那条不回显凭据的保护。
  let u: URL;
  try { u = new URL(raw); } catch { return deny('网址无法解析'); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return deny(`只允许 http/https，收到 ${u.protocol}`);
  }

  // https://evil.com@scholar.google.com/ 真正访问的是后者，人眼读到的是前者。
  // 这种形态在学术检索里没有正当用途，直接拒绝比放进来再解释便宜。
  if (u.username !== '' || u.password !== '') return deny('网址里不允许带用户名或密码');

  const host = normalizeHost(u.hostname);
  if (host === '') return deny('网址里没有主机名');

  if (isLocalHostname(host)) return deny(`不允许访问本机与内网地址：${host}`);
  const v4 = parseIPv4(host);
  if (v4 && isPrivateIPv4(v4)) return deny(`不允许访问本机与内网地址：${host}`);
  if (isPrivateIPv6(host)) return deny(`不允许访问本机与内网地址：${host}`);

  return { ok: true, url: u };
}

export function assertAllowedUrl(raw: string): URL {
  const v = checkUrl(raw);
  if (!v.ok) throw new KydogError(v.code, v.reason);
  return v.url;
}
