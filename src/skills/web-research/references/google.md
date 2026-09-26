# Google 搜索操作卡片

> 2026-09-26 在用户已打开的 Chrome 中实测结果页、抽取选择器和改词；2026-09-25 KyDog IAB 在同类检索中进入验证页。**Chrome 成功不等于 KyDog IAB 已验证成功**。每次以当前 IAB 返回为准，Google 暂不进入默认启用集。

## Chrome 实测的结果页结构

- 直接打开 `https://www.google.com/search?q=` 加 `encodeURIComponent(query)`，检索 `TypeScript 6.0 release notes` 得到自然结果；结果页搜索框是 `textarea[name=q]`。在同一页把它改为 `TypeScript 6.0 breaking changes official` 并按 Enter，导航到新 query 的结果页，结果与摘要随之改变。
- 自然结果容器是 `div.N54PNb`，其 `h3` 为标题、`a:has(h3)@href` 为目标 URL、`div.VwiC3b` 为摘要。第二次检索抽到官方 TypeScript 文档等结果。页面另有 AI 区块，不能把其中的标题混入自然结果。
- 若当前 **KyDog IAB** 确实到达结果页，可尝试：

```json
{"item":"div.N54PNb","title":"h3","url":"a:has(h3)@href","snippet":"div.VwiC3b"}
```

抽取后检查当前 query、标题和 URL 是否对齐；摘要只是发现线索，不能代替抓取目标正文。Chrome 页面结构会变化，以上选择器是候选，不保证 IAB 页面相同。

## KyDog IAB 已观察到的阻断

- 2026-09-25 `browser_open({url:"https://www.google.com/"})` 到达 HTTP 200 首页，`browser_act` 对 `textarea[name=q]` 输入中文 query 并按 Enter 后导航到 `www.google.com/sorry/index?continue=…`，工具报告 HTTP 429，快照有 `presentation "reCAPTCHA"`。
- 同次 `browser_open` 直达英文搜索 URL 也落在 `sorry/index`。该 IAB 探测**没有**验证结果抽取或改词。

当前 IAB 若仍出现 `sorry/index`、HTTP 429 或 reCAPTCHA，把 `(engineId, query, attemptId)` 记为 `blocked`，不能记成零结果，也不能把验证页当作 WebFetch 目标。仅在当前 IAB 真正显示自然结果并成功抽出标题、目标 URL 后，才记录这次检索的发现。
