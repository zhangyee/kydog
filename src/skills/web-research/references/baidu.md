# 百度搜索操作卡片

> 2026-09-26 在用户已打开的 Chrome 中实测结果页、抽取选择器和改词；2026-09-25 KyDog IAB 在同类检索中进入安全验证页。**Chrome 成功不等于 KyDog IAB 已验证成功**。每次以当前 IAB 返回为准，百度暂不进入默认启用集。

## Chrome 实测的结果页结构

- 直接打开 `https://www.baidu.com/s?wd=` 加 `encodeURIComponent(query)`，中文检索得到了自然结果。结果页输入框是 `textarea#chat-textarea`，提交按钮是 `button#chat-submit-button`。在同一页输入 `TypeScript 6.0 破坏性变更 官方` 并点击提交后，导航到新 query 的结果页。
- 自然结果卡片是 `#content_left .result.c-container[mu]`；其 `h3` 是标题，`.cos-line-clamp-2, .click-area-exp-block` 是摘要。`h3 a@href` 是 `www.baidu.com/link?url=…` 跳转地址；卡片自身的 `mu` 属性才给出目标 URL。`result-op` 等 AI／相关推荐卡片不属于这组自然结果。
- 若当前 **KyDog IAB** 确实到达结果页，可尝试：

```json
{"item":"#content_left .result.c-container[mu]","title":"h3","url":":scope@mu","snippet":".cos-line-clamp-2, .click-area-exp-block"}
```

`:scope@mu` 用 `browser_act extract` 读取**当前条目自身**的 `mu`，不查子元素。逐行确认 URL 是目标站点且与标题匹配；若 `mu` 缺失或页面改版，检查当前页面，不要从百度跳转参数猜目标 URL。摘要只能指导后续抓取，不能充当正文证据。

## KyDog IAB 已观察到的阻断

- 2026-09-25 `browser_open({url:"https://www.baidu.com/"})` 到达 HTTP 200 首页；`browser_act` 输入中文 query 并点击提交后落到 `wappass.baidu.com/static/captcha/tuxing_v2.html`，标题「`百度安全验证`」。
- 同次 `browser_open` 直达英文搜索 URL 仍落到安全验证页。该 IAB 探测**没有**验证结果抽取或改词。

当前 IAB 若仍显示 `wappass.baidu.com` 或「`百度安全验证`」，把 `(engineId, query, attemptId)` 记为 `blocked`，不能记成零结果，也不能把验证页当作 WebFetch 目标。仅在当前 IAB 真正显示自然结果并成功抽出标题、目标 URL 后，才记录这次检索的发现。
