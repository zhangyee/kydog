# CARSI institutional login

CARSI (the CERNET federated authentication service) lets a user reach subscription databases
with **their own university account**. This release does exactly one thing: **log in
successfully**. It does not download, does not support multiple institutions, and writes no
search or full-text instructions for any SP.

**This is an operating manual.** The reconnaissance record (the four traps in the list
endpoint, why the test is exact origin equality, what has not been verified yet) is not here —
that is material for the implementer, not a set of steps for you.

---

## 1. The whole path, once through

1. **This assumes the user has already configured an institutional account in Settings.** If
   they have not, `browser_login`'s own description says so — 「设置里**还没有配置机构账号**」
   — and you should tell the user to configure it rather than calling the tool to see.
2. `browser_open` the SP's login entry URL (how to build it is in §2); you land on the
   university's unified identity authentication page.
3. **Look at the snapshot first**: does this page have a CAPTCHA, and which box is the username.
4. Call `browser_login` (parameters and the five hard rules are in §3).
5. Read the line **at the top of the tool result** that starts with 「机构登录: 」 — it is the
   only success test (§3).

After a successful login the session on that tab carries the subscription entitlement.
**This release still downloads nothing** — even with subscription access you only report the
links to the user.

---

## 2. How to build the login entry URL

Once an institution is selected, the SP's entry URL has the shape:

```
https://fsso.cnki.net/Shibboleth.sso/Login
  ?entityID=<the institution's entityID>
  &target=<the SP page to land on after a successful login>
```

This is the standard Shibboleth SP shape; the domain differs per SP, the path is usually the
same.

**Where the `entityID` comes from: `browser_login`'s own tool description carries it** —
「当前配置的机构：…，entityID：…」. That line is a snapshot taken when the session started and
goes stale if the user switches university mid-session — every call's **return value** echoes
the current institution name and entityID, and **the return value is the one that counts**.

**The redirect chain** (knowing it is how you tell which step you are on): SP
`/Shibboleth.sso/Login` → IdP → (possibly one more hop to the university's real login page) →
the user logs in → the IdP POSTs the SAML assertion back to the SP's ACS endpoint → the SP
sets a session cookie → it lands on `target`.

---

## 3. How to call `browser_login`

There are only four parameters:

| Parameter | Required? | What it is |
| --- | --- | --- |
| `tabId` | required | the tab holding the institutional login page |
| `submit` | optional | whether to submit the form right after filling. **Omitting it means do not submit** |
| `usernameIndex` | optional | the snapshot index of the username box |
| `snapshotId` | optional | required whenever `usernameIndex` is given: the snapshot that produced it |

The username and password are filled by the main process directly; **you neither see nor
receive them** (the password never leaves the main process at all).

### Hard rule 1: omitting `submit` means fill only, do not submit

**The default is not to submit.** It is not "pass `submit: false` when you see a CAPTCHA" —
the other way round: **you must write `submit: true` explicitly when you want a submission**.

This is deliberate: CAPTCHAs are the **normal path**, not a corner case, and the two directions
cost differently — submitting one time too many sends a login that is bound to fail on a page
with a CAPTCHA and burns the **only** attempt this round; submitting one time too few just
means you click the submit button yourself, which is always recoverable.

When it does not submit, the return value says 「**没有提交**（你没给 submit: true）」, and the
username and password are by then filled in on the page.

### Hard rule 2: the success test is one single sentence

**The line at the top of the tool result**: `机构登录: [tab_…] 已看到 SAML 断言回传`.

Only that sentence counts. **Page text does not count, whichever page it redirected to does not
count, and neither does the HTTP status code** — with a wrong password most IdPs return a 200
error page or a 302 back to themselves, and the page looks perfectly normal.

That line rides on the head of **every** browser tool result, not only `browser_login`'s: on
the path where `submit` is omitted, the assertion round trip happens after you click submit
yourself, and by that moment `browser_login` has long returned. While no round trip has been
seen, the line reads 「已经填过一次凭据，还没看到断言回传（本轮不会再填第二次）」.

### Hard rule 3: one attempt per round — do not write a retry

**If this round already filled credentials once without an assertion round trip being seen, a
second call is refused** (`browser.login_attempted`), **and switching to another tab changes
nothing** — that gate is scoped to the round of work, not to the tab.

The reason: university identity providers routinely **lock accounts after consecutive
failures**, and what is at stake is the user's own campus account. On
`browser.login_attempted`, **hand over to the user**: let them log in themselves in the
built-in browser, or check the institutional account and password in Settings. **Do not retry,
do not try again on another tab.**

### Hard rule 4: pointing at the username box yourself is the most accurate

Take a snapshot first and give the tool the username box's index via `usernameIndex` +
`snapshotId`.

It works without that too — the structural rule looks for "a visible, non-disabled text input
**before** the password box **inside the same `<form>`**". But the return value **echoes which
box was actually chosen**, in the form
`实际填的账号框：input#user[name=userName]（按结构规则找到的）`. **Check that it is right**: if
it is not, do not call the tool again (that would burn the round's only attempt) — tell the
user first.

The main process finds the password box itself, accepting only "it is a password box right
now" or "it was one in this document"; more than one and it refuses the whole call. Pointing
`usernameIndex` at a password box is rejected on the spot (`browser.password_field`) — do not
get the two boxes the wrong way round.

### Hard rule 5: the standard script for a CAPTCHA page

CAPTCHAs are normal; these four steps:

1. `browser_login({ tabId })` — **omit `submit`**, filling only the username and password
2. `browser_act` types the CAPTCHA into the CAPTCHA box (typing into a **CAPTCHA box** is fine;
   typing into a **password box** is refused outright with `browser.password_field`)
3. `browser_act` clicks the submit button on the page (**do not count on Enter**, see
   `browser.md`)
4. Read the 「机构登录: 」 line at the top of the next tool result — hard rule 2

**Ask the user before step 2?** You cannot read an image CAPTCHA yourself — so call
`ask_user_question` with `browserTabId`, let the user fill the CAPTCHA and click submit in the
sidebar themselves, and you only read the status line. SMS codes and OTPs are the same: always
hand those to a person.

---

## 4. Seven classes of error code, each with a different next step

**Do not collapse them into one "login failed"** — the next step differs for every class:

| Error code | What it means | Your next step |
| --- | --- | --- |
| `browser.idp_host_mismatch` | this page is not (or is no longer) the confirmed institutional login page; **nothing was filled** | navigate to the institution's own unified identity authentication page first, then call again |
| `browser.target_unusable` | the boxes on the page are wrong: no password box / several of them / the one you pointed at is not a text box, is disabled, or is not in the same form as the password box | move to another page (you are probably not at the password step yet), or point at one with `usernameIndex` |
| `browser.stale_index` | the index given in `usernameIndex` no longer resolves in the current document | take a fresh snapshot and call again with an index from it |
| `browser.page_no_result` | **we do not know how far this step got** | **do not retry on the assumption that it did nothing** — take a snapshot and see what the page looks like now |
| `browser.login_attempted` | this round already filled once and no assertion round trip was seen | **hand over to the user**; no more attempts this round (hard rule 3) |
| `settings.invalid` | a Settings-side problem: no institution configured / no password set / the entityID is a URN and can never log in automatically | **hand over to the user** to fix it in Settings — another page, another hundred tries, same result |
| `settings.secure_storage_unavailable` / `settings.stored_password_unreadable` | the first is "the keychain is unavailable right now" (**the password is not lost**); the second is "the stored ciphertext is permanently undecryptable" | **never merge these two**: for the first, have the user restore the keychain and try once more; for the second the keychain is irrelevant — the user has to enter the password again |

`browser.password_field` is the eighth, and the easiest to bring on yourself: `usernameIndex`
pointed at a password box. Point it at the username box instead; nothing was filled that time.

---

## 5. What that page looks like: highly variable (two measured samples)

|  | Peking University | Chinese Academy of Sciences (shared by 127 institutions) |
| --- | --- | --- |
| entityID host | `idp.pku.edu.cn` | `passport.escience.cn` |
| **Actual login-page host** | **`iaaa.pku.edu.cn`** — **different!** | `passport.escience.cn` — the same |
| Username field | `userName` (`#user_name`) | `j_username` |
| Password field | `password` (`#password`) | `j_password` (`#password`) |
| CAPTCHA | **Yes**: image at `iaaa.pku.edu.cn/iaaa/servlet/DrawServlet`, plus SMS `sms_code` and OTP `otp_code` | **No** |
| Submit | `#logon_button` (`type=submit`) | `_eventId_proceed` (`type=submit`) |

This table **is not a list of selectors for you to copy** (not one field name matches between
the two samples, so hard-coding is guaranteed wrong); it is here to make three points that bear
directly on what you do:

1. **The login page's host is often not the entityID's host** (Peking University is exactly
   that), and this is normal, not an anomaly. So the first time it meets a new address the tool
   **stops and asks the user once** whether this is that university's login page; a confirmed
   address is remembered and never asked about again. The return value then says
   「用户刚刚确认了 … 已经记住」.
2. **Field names cannot be copied**: the main process looks for the page's
   `input[type="password"]` and takes the visible text box before it inside the same form as
   the username box. Your job is to **check that the echo is right** (hard rule 4).
3. **CAPTCHAs are normal**: the Peking University page has an image CAPTCHA, an SMS code and an
   OTP all at once. Hence hard rule 1 and hard rule 5.

---

## 6. The boundaries of this release

- **Login only, no downloads.** The subscription access you gain is still used only to report
  links to the user.
- **One institution only**: whichever is configured in Settings. If the user switches
  university mid-session, the echo in the return value is what counts.
- **SP sessions are usually session cookies** and do not survive a KyDog restart — the next
  round of work has to log in again.
- **Some universities do not allow a direct connection from `fsso.cnki.net`** and require
  entering through the university library portal. If you hit that, hand it to the user; do not
  guess the portal address yourself.
