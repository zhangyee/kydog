# CARSI 机构登录

CARSI（教育网联邦认证）让用户用**本校账号**访问机构订阅的文献库。一期只做一件事：
**登录成功**。不下载、不做多机构、不写任何 SP 的检索指令。

---

## 侦察状态

**2026-09-08 侦察，SP 侧与 IdP 侧都采到了真实结构**（SP 用 CNKI，IdP 采了两个不同实现的样本）。
未做的只有一件：**没有真实账号，所以没有走完一次登录**。填充与断言回传的验证要等基座做好、
用 Yee 的账号做（§「验收」）。

---

## 一、机构清单从哪来（实测）

**每个 SP 自带一份清单，不存在一份「全局 CARSI 清单」。** CNKI 的入口是 `https://fsso.cnki.net/`，
它的清单来自一个真接口：

```
GET https://fsso.cnki.net/idp/list?federation=2     → application/json
```

返回 `[{"<机构名>":"<标志>|<entityID>"}, …]`，实测 **1064 条**：

```jsonc
[ {"清华大学":"1|https://idp.tsinghua.edu.cn/idp/shibboleth"},
  {"北京大学":"1|https://idp.pku.edu.cn/idp/shibboleth"} ]
```

`federation=1` 是**另一份、另一种格式**的清单（90 条，国际 eduGAIN）——**值就是裸 entityID，
没有 `标志|` 前缀**，而且 entityID 可能是 URN 不是 URL：

```jsonc
[ {"University of Durham":"urn:mace:ac.uk:sdss.ac.uk:provider:identity:dur.ac.uk"},
  {"University of Birmingham":"https://idp.bham.ac.uk/shibboleth"} ]
```

解析要同时吃下两种格式，且**不能假设 entityID 是合法 URL**。

### 清单里的四个坑（全部实测）

1. **名字和 entityID 都不是唯一键。** 1064 条里只有 **938 个不同 entityID**、936 个不同 host ——
   `https://passport.escience.cn/idp/shibboleth` 这**一个 entityID** 就被 **127 个中科院所**共用
   （它们走同一套认证，机构名只是 SP 显示用的标签）。所以选中项要**名字与 entityID 一起存**：
   登录只用 entityID，名字是给用户看的。按任何一个单独建索引都会丢东西。
   **这几个数是 2026-09-09 直连端点重数的**（`curl` 拉 76,565 字节 → `JSON.parse` →
   按 `|` 右边切出 entityID 分组）：1064 条 / 938 个不同 entityID / 重名 0 条 /
   共享 entityID 的组**只有 1 个**、组内 **127** 个名字。§三表头原先写的 128 是错的，已改。
2. **官方数据里有格式错的条目。** 实测 2 条缺冒号：`https//idp.xjut.edu.cn/idp/shibboleth`
   （新疆工业学院、广东金融学院）。解析要跳过并**留下可见的原因**，不许静默丢、更不许整份解析失败。
3. **`标志` 字段含义未知。** 实测 `1` ×1045、`0` ×19，`0` 里既有 985 高校也有中科院所。
   **不知道含义就不要拿它过滤** —— 猜错会让用户在列表里找不到自己的学校，且没有任何报错。
   一期把 0 和 1 都列出来。
4. 机构名是中文原文。**CNKI 自己的页面**加载了 `Pinyin.js` 与 `opencc.js` 做纯前端过滤，
   `input#o` 的 placeholder 写着「支持汉字、拼音、首字母」—— **那是它的做法，不是我们的**。
   设置页做的是**名字与 entityID 两个字段的子串匹配**（大小写不敏感）：真拼音要一张
   汉字→拼音表（常用字上万条，是一份必须从真实来源拿的数据），而一期的硬约束是零新依赖，
   凭记忆写一张表在这个仓库是明令禁止的。**代价说清楚**：敲 `beijing` 匹配不上「北京大学」
   这个**名字**；不过学校的拼音／缩写通常就写在 entityID 里
   （`idp.pku.edu.cn`、`idp.tsinghua.edu.cn`、`passport.escience.cn`），
   所以 `pku` / `tsinghua` / `escience` 这类敲法自然命中，用户不必切输入法。

## 二、登录链路（实测）

选中机构后，SP 的入口 URL 形态是：

```
https://fsso.cnki.net/Shibboleth.sso/Login
  ?entityID=<机构的 entityID>
  &target=<登录成功后要去的 SP 页面>
```

这是 Shibboleth SP 的标准形态，各 SP 的域名不同、路径通常一致。

**跳转链：** SP `/Shibboleth.sso/Login` → IdP → （可能再跳到本校真正的登录页）→ 用户登录 →
IdP 把 SAML 断言 **POST 回 SP 的 ACS 端点** → SP 种会话 cookie → 落到 `target`。

## 三、IdP 登录页长什么样：变异很大（两个实测样本）

|  | 北京大学 | 中科院（127 机构共用） |
| --- | --- | --- |
| entityID host | `idp.pku.edu.cn` | `passport.escience.cn` |
| **实际登录页 host** | **`iaaa.pku.edu.cn`** —— **不一样！** | `passport.escience.cn` —— 一样 |
| 账号字段 | `userName`（`#user_name`） | `j_username` |
| 密码字段 | `password`（`#password`） | `j_password`（`#password`） |
| 验证码 | **有**：图片 `iaaa.pku.edu.cn/iaaa/servlet/DrawServlet`，另有短信 `sms_code` 与 OTP `otp_code` | **无** |
| 提交 | `#logon_button`（`type=submit`） | `_eventId_proceed`（`type=submit`） |

三条结论直接决定实现：

1. **实际判据是 origin 精确相等，不是注册域（eTLD+1）相同。** 北大的登录表单在
   `iaaa.pku.edu.cn`，entityID 里写的却是 `idp.pku.edu.cn` —— 两者不相等是**常态，
   不是异常**：同一机构的 IdP 登录页 host 常常跟 entityID 的 host 不一样。`checkLoginHost`
   （`src/main/browser/login.ts`）的判据是：当前页 origin（含 scheme）与 entityID 的 host
   精确相等 → 直接填；否则**问用户一次**，确认后把那个 origin（含 scheme，例如
   `https://iaaa.pku.edu.cn`）记进 `confirmedLogin`，之后同一 entityID 命中同一个
   origin 才继续直接填 —— 严格匹配，不放宽到子域或同注册域。
   **注册域相同曾经是判据，已被明确拍板删掉，不要加回来**：那套机制靠一张手写的
   32 条多段公共后缀表冒充 Public Suffix List，「不在表里就按两段算」的兜底方向是
   fail-open —— `ac.za` 不在表里，`idp.uct.ac.za` 与 `login.evil.ac.za` 会双双退化成
   `ac.za` 而被判成同域直接放行；`ac.il` / `ac.th` / `ac.id` / `ac.at` / `edu.ar` /
   `edu.ng` 等 20 多个后缀实测同样能被绕过。第一次多问一次是确认机制本来就要走的
   正常路径，不值得用一张自制的、注定不完整的后缀表去换。
2. **字段名不能写死。** 两个样本一个都不一样。做法是：找页面上的 `input[type="password"]`，
   再取**同一个 form 里**它前面那个可见文本输入框当账号框。
3. **验证码是常态不是例外，`submit: false` 那条分支必须有。** 北大这个页面同时有图片验证码、
   短信码、OTP —— 主进程只填账号密码，剩下的交给人。

## 四、一期怎么做

**设置页**：一个「机构」选择器 —— 拉 `fsso.cnki.net/idp/list?federation=2`，按**名字与 entityID
的子串**筛选（**不是拼音检索**，理由与代价见 §一 第 4 条），选中后存 **`{ 机构名, entityID }`**
（不存 host —— host 从 entityID 解析，且见上面第 1 条）。
账号明文存，密码走 `safeStorage`。

**登录**：agent 用 `browser_open` 打上面那个 `/Shibboleth.sso/Login?entityID=…` URL →
落到本校登录页 → 调 `browser_login`。主进程填账号密码；快照里看得见验证码就传 `submit: false`，
验证码与提交交给人。

**成功判据**：`session.webRequest` 观测到主 frame **POST 到 SP 的 ACS 端点**且响应 2xx/3xx。
不看页面文案。

## 五、还没验证的

- **一次完整登录**：没有真实账号，填充与断言回传都没跑过
- **ACS 端点的确切路径**：Shibboleth 默认是 `/Shibboleth.sso/SAML2/POST`，但**本次没有观测到
  真实回传**，不要当成已知
- **`标志` 字段的含义**（见坑 3）
- **有些学校不允许从 `fsso.cnki.net` 直连**，要求从本校图书馆门户进 —— 调研文档提过，本次两个
  样本都没撞上
- 登录后 SP 会话 cookie 的存活期。Shibboleth SP 会话通常是**会话 cookie**，跨 KyDog 重启不保留

## 六、验收（要成对）

1. **正向**：配好机构与账号，agent 登录 CNKI，工具结果里有 ACS 端点 URL 与 2xx/3xx 状态码
2. **反向**：故意配错密码，工具报「仍停在 IdP 域名、未观测到断言回传」并交给人，**不报成功**

只有正向的话，一个永远返回成功的实现也能过。
