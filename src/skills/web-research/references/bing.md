# Bing 搜索操作卡片

> 2026-09-25 与 26 日用 KyDog 真实 IAB 的 `browser_open`／`browser_act` 探测。当时网络出口下，中文 query 的结果页可抽取 10 条；英文改词落到验证挑战，不能声称改词抽取成功。每次以当前 IAB 返回为准。

## 已验证的结果页路径

1. `browser_open({url:"https://www.bing.com/"})` 到首页 HTTP 200。首页输入框是 `textarea#sb_form_q`，但本次从首页输入并点击 `label#search_icon` 后仍停在首页，`wait` 搜索地址超时；**不要依赖这条首页提交路径**。
2. 对已经确定的 query，可以在同一 IAB 标签调用 `browser_open({tabId,url:"https://www.bing.com/search?q="+encodeURIComponent(query)})`。本次中文词 `TypeScript 6.0 新特性` 到达 HTTP 200 结果页。必须核对快照确实含自然结果，不以 HTTP 200 或地址中的 `q=` 单独判定成功。
3. 在结果页调用 `browser_act({tabId,actions:[{kind:"extract",selectors:{item:"li.b_algo",title:"h2 a",url:"h2 a@href",snippet:".b_caption p"}}]})`。本次中文页抽到 10 条；个别字段可能是 `null`，需要逐行检查标题与 URL，摘要可缺。

## 改词与失败判据

结果页搜索框是 `input#sb_form_q`，提交按钮是 `input#sb_form_go`。首次探测中 `type` 英文词 `TypeScript 6.0 release notes`、`click` 提交后，新 URL 与标题出现；但 `wait` 选择器 `li.b_algo h2 a` 超时。再次探测改用同标签的 `browser_open` 直达英文搜索 URL，快照明确显示「最后一步 请解决以下难题以继续」，`extract` 抽到 0 条。应将这次 attempt 记为 `blocked`，不能把旧 query 的 10 条算成新结果，也不能把挑战页当“零结果”。遇到页面验证或结构变化，查看当前快照并记录实际状态。

## URL 与证据边界

本次抽出的 `@href` 形如 `https://www.bing.com/ck/a?...`，是 Bing 跳转链接。保留原始 href 及发现背景，让 WebFetch 逐跳跟随并记录最终 URL；不要猜测或手工解码其 `u` 参数。搜索摘要只供发现，不能充当正文证据。明确零结果和翻页未验证。
