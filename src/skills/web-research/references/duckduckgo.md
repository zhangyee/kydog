# DuckDuckGo 搜索操作卡片

> 2026-09-25 用 KyDog 真实 IAB 的 `browser_open`／`browser_act` 端到端验证。当时网络出口下，中文与英文检索各抽到 10 条。每次以当前工具返回为准。

## 已验证的检索路径

1. `browser_open({url:"https://duckduckgo.com/"})`：首页 HTTP 200。保存返回的 `tabId`，后续动作始终传同一标签。
2. `browser_act({tabId,actions:[{kind:"type",selector:"textarea[name=q]",text:query},{kind:"key",key:"Enter"},{kind:"wait",until:{urlMatches:"q="},timeoutMs:8000}]})`：本次中文检索落到 `duckduckgo.com/?…&q=…`，HTTP 200。`urlMatches` 只确认导航，仍需检查落定页是不是结果页。
3. 在结果页运行 `browser_act({tabId,actions:[{kind:"extract",selectors:{item:"article[data-testid=result]",title:"a[data-testid=result-title-a]",url:"a[data-testid=result-title-a]@href",snippet:"[data-result=snippet]"}}]})`。本次抽到 10 条有标题、目标 URL 和摘要的自然结果。摘要只作发现线索，不是已核验的网页证据。
4. 改词：在同一结果页 `type` 选择器 `input#search_form_input`，接 `key Enter`，再 `wait` 地址含新 query 的独特片段；随后用相同 `extract` 重新抽取。本次英文词 `TypeScript 6.0 release notes` 又抽到 10 条不同结果。

## 判据与边界

- 首页 HTTP 200、动作 `status:ok` 或地址含 `q=` 都不能单独证明搜索成功；要看到当前 query 的结果页和本轮抽出的 `title`、`url`。空数组应记录为未取得可用结果，先检查快照和页面状态，不擅自判为“零结果”。
- 验证页、明确零结果页、翻页、直接拼搜索 URL：本次未验证。遇到拦截、页面结构变化或等待超时，记录本引擎本次 attempt 的失败状态，按实际快照决定是否重试；不要凭猜测改选择器。
- 抽出的 URL 是待抓取候选。后续读取这些 URL 应走独立 WebFetch，不用 IAB 的搜索动作代替抓取。
