# CARSI institutional login

CARSI (the CERNET federated authentication service) lets a user reach subscription databases
with **their own university account**. This release does exactly one thing: **log in
successfully**. It does not download, does not support multiple institutions, and writes no
search or full-text instructions for any SP.

---

## Reconnaissance status

**Reconnoitred 2026-09-08; real structure was captured on both the SP side and the IdP side**
(CNKI as the SP, with two IdP samples of different implementations). Only one thing was not
done: **there was no real account, so a login was never completed end to end.** Verifying the
fill and the assertion round trip has to wait until the substrate is built and be done with
Yee's account (see "Acceptance").

---

## 1. Where the institution list comes from (measured)

**Every SP carries its own list; there is no single global CARSI list.** CNKI's entry point is
`https://fsso.cnki.net/`, and its list comes from a real endpoint:

```
GET https://fsso.cnki.net/idp/list?federation=2     → application/json
```

It returns `[{"<institution name>":"<flag>|<entityID>"}, …]`, **1064 entries** as measured:

```jsonc
[ {"清华大学":"1|https://idp.tsinghua.edu.cn/idp/shibboleth"},
  {"北京大学":"1|https://idp.pku.edu.cn/idp/shibboleth"} ]
```

`federation=1` is **a different list in a different format** (90 entries, international
eduGAIN) — **the value is a bare entityID with no `flag|` prefix**, and the entityID may be a
URN rather than a URL:

```jsonc
[ {"University of Durham":"urn:mace:ac.uk:sdss.ac.uk:provider:identity:dur.ac.uk"},
  {"University of Birmingham":"https://idp.bham.ac.uk/shibboleth"} ]
```

A parser has to swallow both formats and **must not assume the entityID is a valid URL**.

### Four traps in the list (all measured)

1. **Neither the name nor the entityID is a unique key.** Among 1064 entries there are only
   **938 distinct entityIDs** and 936 distinct hosts — that **one** entityID
   `https://passport.escience.cn/idp/shibboleth` is shared by **127 CAS institutes** (they use
   one authentication system, and the institution name is only a label the SP displays).
   So a selection has to store **the name and the entityID together**: login uses only the
   entityID, and the name is for the user to see. Indexing by either one alone loses data.
   **These numbers were recounted against the live endpoint on 2026-09-09** (`curl` pulled
   76,565 bytes → `JSON.parse` → entityIDs cut out to the right of the `|` and grouped):
   1064 entries / 938 distinct entityIDs / 0 duplicate names / **only 1** group sharing an
   entityID, with **127** names in it. The table in §3 originally said 128; that was wrong and
   has been fixed.
2. **The official data contains malformed entries.** Two were measured missing a colon:
   `https//idp.xjut.edu.cn/idp/shibboleth` (Xinjiang Institute of Technology, Guangdong
   University of Finance). A parser must skip them and **leave a visible reason** — never drop
   them silently, and certainly never fail the whole parse.
3. **The meaning of the `flag` field is unknown.** Measured `1` ×1045, `0` ×19, and the `0`s
   include both 985-tier universities and CAS institutes. **Do not filter on something whose
   meaning you do not know** — guessing wrong means a user cannot find their own university in
   the list, with no error anywhere. This release lists both 0 and 1.
4. Institution names are in Chinese. **CNKI's own page** loads `Pinyin.js` and `opencc.js` for
   purely front-end filtering, and the placeholder on `input#o` says 「支持汉字、拼音、首字母」
   — **that is what they do, not what we do**. The settings page does **substring matching over
   two fields, the name and the entityID** (case-insensitive): real pinyin would need a
   Chinese-character→pinyin table (tens of thousands of common characters, data that must come
   from a real source), and this release's hard constraint is zero new dependencies, while
   writing such a table from memory is expressly forbidden in this repository. **State the cost
   plainly**: typing `beijing` will not match the **name** 「北京大学」; however, a university's
   pinyin or abbreviation is usually written into the entityID itself
   (`idp.pku.edu.cn`, `idp.tsinghua.edu.cn`, `passport.escience.cn`), so `pku` / `tsinghua` /
   `escience` and the like match naturally, and the user need not switch input method.

## 2. The login chain (measured)

Once an institution is selected, the SP's entry URL has the shape:

```
https://fsso.cnki.net/Shibboleth.sso/Login
  ?entityID=<the institution's entityID>
  &target=<the SP page to land on after a successful login>
```

This is the standard Shibboleth SP shape; the domain differs per SP, the path is usually the
same.

**The redirect chain:** SP `/Shibboleth.sso/Login` → IdP → (possibly one more hop to the
university's real login page) → the user logs in → the IdP **POSTs the SAML assertion back to
the SP's ACS endpoint** → the SP sets a session cookie → it lands on `target`.

## 3. What an IdP login page looks like: highly variable (two measured samples)

|  | Peking University | Chinese Academy of Sciences (shared by 127 institutions) |
| --- | --- | --- |
| entityID host | `idp.pku.edu.cn` | `passport.escience.cn` |
| **Actual login-page host** | **`iaaa.pku.edu.cn`** — **different!** | `passport.escience.cn` — the same |
| Username field | `userName` (`#user_name`) | `j_username` |
| Password field | `password` (`#password`) | `j_password` (`#password`) |
| CAPTCHA | **Yes**: image at `iaaa.pku.edu.cn/iaaa/servlet/DrawServlet`, plus SMS `sms_code` and OTP `otp_code` | **No** |
| Submit | `#logon_button` (`type=submit`) | `_eventId_proceed` (`type=submit`) |

Three conclusions that directly determine the implementation:

1. **The actual test is exact origin equality, not "same registrable domain (eTLD+1)".**
   Peking University's login form is on `iaaa.pku.edu.cn` while the entityID says
   `idp.pku.edu.cn` — the two differing is **normal, not an anomaly**: an institution's IdP
   login page host is often not the entityID's host. `checkLoginHost`
   (`src/main/browser/login.ts`) tests: the current page's origin (scheme included) equals the
   entityID's host exactly → fill directly; otherwise **ask the user once**, and after they
   confirm, record that origin (scheme included, e.g. `https://iaaa.pku.edu.cn`) into
   `confirmedLogin`; thereafter the same entityID hitting the same origin fills directly —
   strict matching, never widened to a subdomain or the same registrable domain.
   **"Same registrable domain" used to be the test and was explicitly ruled out and deleted;
   do not add it back**: that mechanism relied on a hand-written 32-entry multi-segment public
   suffix table posing as the Public Suffix List, and its "not in the table, assume two
   segments" fallback fails open — `ac.za` is not in the table, so `idp.uct.ac.za` and
   `login.evil.ac.za` both degrade to `ac.za` and are judged same-domain and let through;
   `ac.il` / `ac.th` / `ac.id` / `ac.at` / `edu.ar` / `edu.ng` and 20-odd other suffixes were
   measured to be bypassable the same way. Asking once more the first time is the normal path
   the confirmation mechanism was built for, and it is not worth trading for a home-made,
   inevitably incomplete suffix table.
2. **Field names cannot be hard-coded.** Not one of them matches between the two samples.
   The approach is: find the `input[type="password"]` on the page, then take the visible text
   input before it **inside the same form** as the username field.
3. **CAPTCHAs are normal, not exceptional, so the `submit: false` branch is mandatory.**
   The Peking University page has an image CAPTCHA, an SMS code and an OTP all at once — the
   main process only fills the username and password and leaves the rest to a person.

## 4. How this release does it

**Settings page**: one institution picker — it pulls
`fsso.cnki.net/idp/list?federation=2` and filters by **substring over the name and the
entityID** (**not pinyin search**; the reason and the cost are in §1 trap 4), and on selection
stores **`{ name, entityID }`** (not the host — the host is parsed from the entityID, and see
trap 1 above). The username is stored in plain text and the password goes through
`safeStorage`.

**Login**: the agent opens the `/Shibboleth.sso/Login?entityID=…` URL above with
`browser_open` → lands on the university's login page → calls `browser_login`. The main process
fills the username and password; when a CAPTCHA is visible in the snapshot, pass `submit: false`
and leave the CAPTCHA and the submission to the user.

**Success test**: `session.webRequest` observes a main-frame **POST to the SP's ACS endpoint**
with a 2xx/3xx response. Page text is not consulted.

## 5. Not yet verified

- **One complete login**: with no real account, neither the fill nor the assertion round trip
  has ever been exercised
- **The exact path of the ACS endpoint**: Shibboleth's default is
  `/Shibboleth.sso/SAML2/POST`, but **no real round trip was observed in this round**, so do
  not treat it as known
- **The meaning of the `flag` field** (see trap 3)
- **Some universities do not allow a direct connection from `fsso.cnki.net`** and require
  entering through the university library portal — the research document mentions it, and
  neither of this round's two samples hit it
- The lifetime of the SP session cookie after login. Shibboleth SP sessions are usually
  **session cookies** and do not survive a KyDog restart

## 6. Acceptance (must come in pairs)

1. **Positive**: with the institution and account configured, the agent logs in to CNKI, and
   the tool result carries the ACS endpoint URL and a 2xx/3xx status code
2. **Negative**: with a deliberately wrong password, the tool reports "still on the IdP domain,
   no assertion round trip observed" and hands over to the user, **without reporting success**

With only the positive case, an implementation that always returns success would pass too.
