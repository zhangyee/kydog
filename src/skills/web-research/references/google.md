# Google 搜索操作卡片

> 2026-09-25 用 KyDog 真实 IAB 探测；**结果抽取未验证，不进入默认启用集**。这只是当时网络出口的观察，不是对 Google 普遍可用性的判断；每次以当前 IAB 返回为准。

## 本次确实观察到的动作

- `browser_open({url:"https://www.google.com/"})` 到达 HTTP 200 首页，搜索框为 `textarea[name=q]`。
- `browser_act` 对该框 `type` 中文 query 后 `key Enter`，导航到了 `www.google.com/sorry/index?continue=…`，工具报告 HTTP 429，快照有 `presentation "reCAPTCHA"`。首页可达不代表搜索结果可达。
- `browser_open` 打开英文词的 `https://www.google.com/search?q=TypeScript%206.0%20release%20notes`，也落在 `sorry/index` 验证页；不能把中途显示的搜索 URL 或 HTTP 200 文案当作结果页证明。

## 当前处理

本次没有验证结果行、标题、摘要或 `@href` 选择器，也没有验证改词和翻页。看到 `sorry/index`、HTTP 429 或 reCAPTCHA 快照时，将当前 `(engineId, query, attemptId)` 记为被验证页阻断，不把它当“零结果”，更不能把验证页送去 WebFetch 当目标正文。用户完成验证或网络出口变化后，需重新用 KyDog IAB 验证结果抽取，才能把 Google 标为已支持。
