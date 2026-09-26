# 百度搜索操作卡片

> 2026-09-25 用 KyDog 真实 IAB 探测；**结果抽取未验证，不进入默认启用集**。这只是当时网络出口的观察，每次以当前 IAB 返回为准。

## 本次确实观察到的动作

- `browser_open({url:"https://www.baidu.com/"})` 到达 HTTP 200 首页。可见输入框为 `textarea#chat-textarea`，提交按钮为 `button#chat-submit-button`。
- `browser_act` 输入中文 query 并点击提交后，搜索导航最终转到 `wappass.baidu.com/static/captcha/tuxing_v2.html`，标题为「`百度安全验证`」，没有可抽取的自然结果。
- 另用 `browser_open` 打开 `https://www.baidu.com/s?wd=TypeScript%206.0%20release%20notes`，仍落到百度安全验证页。直接 URL 在本出口不能绕过验证。

## 当前处理

本次没有验证结果行、标题、摘要或 `@href` 选择器，也没有验证改词和翻页。看到 `wappass.baidu.com` 或「`百度安全验证`」时，将当前 `(engineId, query, attemptId)` 记为被验证页阻断，不把它当“零结果”，不把验证页抓取为目标正文。验证完成或出口变化后，重新用 KyDog IAB 验证结果抽取，才能标为已支持。
