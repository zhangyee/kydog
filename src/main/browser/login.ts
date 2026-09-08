import type { ConfirmedLogin } from '../../shared/types';
import { isLocalHostname, normalizeHost, parseIPv4 } from './urlGuard';

/**
 * CARSI 机构登录的判据。纯函数 —— 真正的填充在 browserService 里做。
 *
 * 这一层回答的唯一问题是：**当前这个页面，是不是用户那所学校的登录页？**
 * 答错的代价是把校园密码填进一个伪造的表单，所以宁可拒绝也不放宽。
 *
 * **这里没有 eTLD+1（注册域）判据，是刻意删掉的，别加回来。** 原来那张手写的 32 条
 * 多段公共后缀表在冒充 Public Suffix List，而「不在表里就按两段算」这个兜底方向是
 * fail-open：`ac.za` 不在表里 → `idp.uct.ac.za` 与 `login.evil.ac.za` 双双退化成
 * `ac.za` → 判成同域直接放行（`ac.il` / `ac.th` / `ac.id` / `ac.at` / `edu.ar` /
 * `edu.ng` 等 20 多个后缀实测同样通过）。
 *
 * Chrome 对同类问题分三档：同 origin（含 scheme）直填 / 同 eTLD+1 不同子域「提示但
 * 不静默填」（用真 PSL）/ 跨域一律不猜。第二档 Chrome 也要人点一下，而这里是
 * **无人值守、agent 驱动着代填**，门槛只应更高。那张表的全部收益不过是「第一次不用
 * 问用户」，而确认机制本来就存在，所以整套删掉：**要么 origin 全等，要么问一次。**
 */

/**
 * 判据的结论。**刻意做成判别式联合**：老形状是
 * `{ ok: true; needsConfirm: boolean; host: string }`，调用方写
 * `if (check.ok) await fillPassword()` 完全合法、编译通过、lint 通过、用例全绿 ——
 * 而 spec §4.6 第 2 条那次用户确认就整条消失了。现在拿不到 `host` 就填不了，
 * 而拿到 `host` 必须先显式区分 `fill` 与 `confirm-then-fill`。
 */
export type LoginHostDecision =
  /** 有协议层依据，直接填。 */
  | { kind: 'fill'; host: string }
  /**
   * 要先问用户一次。`origin` 是**被确认的那个 origin**（含 scheme 与端口）：
   * 确认通过后用它调 `settingsService.confirmLogin(entityID, origin)`，然后
   * **必须用当时的 URL 重新跑一次 `checkLoginHost`**，只有拿到 `fill` 才可以填。
   */
  | { kind: 'confirm-then-fill'; host: string; origin: string }
  /**
   * 不填，也不问。`reason` 会进模型上下文与日志，所以不含原始 URL，是给人看的中文。
   *
   * `why` 是给下游分流用的判别值 —— 字面量联合，与 `checkLoginHost` 里实际的六个
   * `refuse` 分支一一对应，别多也别少。之所以不用 `KydogErrorCode`：理由的分类
   * 属于登录模块，错误码属于协议层，「字面量 → 错误码」的映射留给调用方自己做。
   */
  | {
      kind: 'refuse';
      reason: string;
      why: 'not-https' | 'no-host' | 'bare-ip' | 'local-host' | 'entity-has-no-host' | 'unparsable';
    };

/** IPv6 字面量在 URL 里带方括号，WHATWG 解析后 hostname 仍保留它们。 */
function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || parseIPv4(host) !== null;
}

/**
 * origin 的规范形式：`scheme://host[:port]`，host 走 normalizeHost。
 *
 * 不直接用 `URL.origin` 是因为域名的根标签点会原样留在 hostname 上
 * （`https://iaaa.pku.edu.cn./` 的 origin 是 `https://iaaa.pku.edu.cn.`），
 * 两边不一起归一就会把同一个 host 判成两个。落盘的 `origin` 也只兜过「是个非空
 * 字符串」，值本身没人校验，所以那一侧同样要重新解析再规范化。
 */
function canonicalOrigin(u: URL): string {
  return `${u.protocol}//${normalizeHost(u.hostname)}${u.port ? `:${u.port}` : ''}`;
}

/** 解析一个可能是脏数据的 origin 串；解析不了就当「没有确认过」。 */
function canonicalOriginOf(raw: string): string | null {
  try { return canonicalOrigin(new URL(raw)); } catch { return null; }
}

/**
 * 填凭据之前判断当前页面。判据按这个顺序：
 *
 * 1. 当前页 host 精确等于 entityID 的 host（归一后）→ 直接填。
 * 2. `confirmedLogin` 非 null、其 `entityID` 等于当前 entityID、且当前页 origin
 *    **全等**于它的 `origin` → 直接填。三个条件缺一不可。
 * 3. 其余 → 要求确认一次。
 * 4. 当前页非 https、没有主机名、是裸 IP、是 localhost 一类，或 entityID 没有
 *    可比的 host（URN / 畸形）→ 拒绝，且不给确认的机会。
 *
 * 第 2 条比的是 **origin 而不是 host**，scheme 就是靠它进的判据：`urlGuard` 明确
 * 放行 http，只比 host 的话，同一 Wi-Fi 上的攻击者应答 `http://iaaa.pku.edu.cn/`
 * 就能收走校园密码，而用户先前在 https 上做的那次确认反而把它一并放行。
 *
 * entityID 也必须显式参与第 2 条。`sanitizeInstitution` 确实会在读写两条路径上把
 * entityID 不符的确认归 null，但那是隐式契约，下一个人重构 sanitize 就没了；不校验
 * 的后果是用户从北大改选清华之后，主进程把清华的账号密码填进北大的统一身份认证页。
 *
 * **返回值不能跨越挂起使用。** 那次确认是一次工具执行中途的跨进程悬挂（ask broker：
 * 挂起 promise → 广播 → UI → RPC 回来），人在框上停留几秒到几十秒是常态，页面完全
 * 可以在这期间自己 `location = 'https://evil.com/idp/'` 或者走一个 5 秒的 meta
 * refresh。调用方**必须在实际填充的那一刻拿当时的 URL 再判一次**：
 *
 * ```
 * const d = checkLoginHost({ entityID, currentUrl: tab.url, confirmedLogin });
 * if (d.kind === 'confirm-then-fill') {
 *   if (!(await askUser(d.host))) return;
 *   await settingsService.confirmLogin(entityID, d.origin);   // 锁内，只收两个标量
 *   const again = checkLoginHost({ entityID, currentUrl: tab.url, confirmedLogin: ... });
 *   if (again.kind !== 'fill') return;                        // 悬挂期间跳走了
 * }
 * ```
 *
 * 第 2 条的 origin 全等正是让「跳走了」这件事必然落进 `confirm-then-fill` 的东西。
 */
export function checkLoginHost(args: {
  entityID: string;
  /** 当前标签的完整 URL。**不是裸 host** —— scheme 与端口都要参与判据。 */
  currentUrl: string;
  confirmedLogin: ConfirmedLogin | null;
}): LoginHostDecision {
  const { entityID, currentUrl, confirmedLogin } = args;

  // 拒绝理由里一律不回显 currentUrl：它可能整条带着凭据，而 reason 会进
  // KydogError.message（→ 模型上下文）与日志（→ 落盘）。
  let cur: URL;
  try { cur = new URL(currentUrl); } catch { return { kind: 'refuse', reason: '当前标签的网址无法解析', why: 'unparsable' }; }

  const host = normalizeHost(cur.hostname);
  if (host === '') return { kind: 'refuse', reason: '当前标签没有主机名', why: 'no-host' };

  // 校园密码只走 https。这一档压在 confirmedLogin 前面 —— 否则一条脏的
  // http origin 就能把「已确认」变成放行 http 的通行证。
  if (cur.protocol !== 'https:') {
    return {
      kind: 'refuse',
      reason: `当前标签是 ${cur.protocol.replace(':', '')}，机构登录只在 https 上填`,
      why: 'not-https',
    };
  }

  // 学校的登录页不会是一个 IP 或本机名字。这一档同样压在 confirmedLogin 前面。
  if (isIpLiteral(host)) {
    return { kind: 'refuse', reason: `当前标签是 IP 地址（${host}），不是机构的登录页`, why: 'bare-ip' };
  }
  // 内网名字直接复用 urlGuard 那份后缀表 —— 同一件事不许有第二份，会漂。
  // 但**不能整个调 checkUrl**：那道闸放行公网 IP（`http://8.8.8.8/` 是 ok 的），
  // 而登录页判据要连公网裸 IP 一起拒，所以上面那条 isIpLiteral 是额外加的。
  if (isLocalHostname(host)) {
    return {
      kind: 'refuse',
      reason: `当前标签是本机或内网地址（${host}），不是机构的登录页`,
      why: 'local-host',
    };
  }

  const entityHost = hostOfEntityID(entityID);
  if (entityHost === null) {
    // 国际联邦那份清单里的 entityID 是 URN（urn:mace:...），没有 host 可比。
    // 这时没有任何协议层依据判断「这确实是本校的登录页」——「在确认框上摆一个
    // 我们自己也说不清的 host」不是确认，是让用户替我们猜。交给人工登录。
    return {
      kind: 'refuse',
      reason: '这个机构的 entityID 是 URN 或格式不合，无法据此判断登录页，请手动登录',
      why: 'entity-has-no-host',
    };
  }

  if (host === entityHost) return { kind: 'fill', host };

  const origin = canonicalOrigin(cur);
  if (
    confirmedLogin !== null
    && confirmedLogin.entityID === entityID
    && canonicalOriginOf(confirmedLogin.origin) === origin
  ) {
    return { kind: 'fill', host };
  }

  return { kind: 'confirm-then-fill', host, origin };
}

/** entityID 的 host（归一后）。URN、畸形、非 http(s) 一律 null —— 没有 host 可比。 */
function hostOfEntityID(entityID: string): string | null {
  let u: URL;
  try { u = new URL(entityID); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = normalizeHost(u.hostname);
  return h === '' ? null : h;
}

/**
 * Electron `onBeforeRequest` 那份 details 里我们用得上的三个字段。
 * 只声明用得上的，别把整个 OnBeforeRequestListenerDetails 拖进纯函数。
 */
export type UploadedRequest = {
  url: string;
  method: string;
  uploadData?: Array<{ bytes?: Buffer }>;
};

/**
 * 这一次请求是不是 SAML 断言回传（HTTP-POST 绑定打到 SP 的 ACS）。
 *
 * 判据是**两条协议事实同时满足**：
 *
 * 1. 请求体里有 `SAMLResponse` —— HTTP-POST 绑定的定义，只有带断言那次才有。
 * 2. 目的 host **不等于** IdP 的 host —— 确实回到了 SP 那一侧。
 *
 * 少了第 1 条，用户在 IdP 页点提交那次会冒充成功：那本身就是一次主 frame POST，
 * 而密码错时多数 IdP 返回 200 错误页或 302 回自己 ——「主 frame POST + 2xx/3xx」
 * 这种松判据会把它报成登录成功。
 *
 * entityID 是 URN 时没有 host 可比，一律返回 false 走人工，不猜。
 */
export function isSamlAssertionPost(req: UploadedRequest, entityID: string): boolean {
  if (req.method?.toUpperCase() !== 'POST') return false;

  const idpHost = hostOfEntityID(entityID);
  if (idpHost === null) return false;

  let targetHost: string;
  try { targetHost = normalizeHost(new URL(req.url).hostname); } catch { return false; }
  if (targetHost === '' || targetHost === idpHost) return false;

  // 分块要先拼起来再判：`SAMLResponse=` 可能正好跨在两块中间。
  // 拼的是 Buffer 不是字符串 —— 逐块先各自 toString('utf8') 再 join 的话，跨块的
  // 多字节字符会在两侧各解出一个 U+FFFD（ASCII 的 `&`/`SAMLResponse=` 不受影响，
  // 所以这里不是漏判，但拼字节才是正确的做法）。
  const body = Buffer.concat((req.uploadData ?? []).map((d) => d.bytes ?? Buffer.alloc(0))).toString('utf8');
  // 按参数边界匹配，不用 includes —— `XSAMLResponse=` 会假阳。
  return /(^|&)SAMLResponse=/.test(body);
}
