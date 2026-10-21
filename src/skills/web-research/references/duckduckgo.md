# DuckDuckGo 搜索操作卡片

## 已验证的检索路径

首页输入框是 `textarea[name="q"]`，自然结果项是 `article[data-testid="result"]`。首页的提交按钮会按页面状态折叠；在 IAB 实际页面中，即使输入已成功，它仍可能保持 `0×32`，因此这条路径不点击提交按钮。输入框获得焦点并写入 query 后，用 Enter 提交表单。

先 `browser_open({"url":"https://duckduckgo.com/"})` 保存 `tabId`，随后一次调用完成输入、提交、等待与抽取：

```json
{"tabId":"<ddgTabId>","actions":[{"kind":"type","selector":"textarea[name=\"q\"]","text":"<query>"},{"kind":"key","key":"Enter"},{"kind":"wait","until":{"selector":"article[data-testid=\"result\"]"},"timeoutMs":10000},{"kind":"extract","selectors":{"item":"article[data-testid=result]","title":"a[data-testid=result-title-a]","url":"a[data-testid=result-title-a]@href","snippet":"[data-result=snippet]"}}],"research":{"engineId":"duckduckgo","query":"<query>","angleIds":["<angleId>"],"executionPath":"homepage_form","submitActionIndex":1}}
```

`submitActionIndex` 指向零基的提交 `key Enter`。同一调用返回 `observationId`；不得为了检查 DOM 再拆出额外 `browser_act`。

## 改词与失败判据

- 新 query 复用同一标签，但先用 `browser_open({"tabId":"<ddgTabId>","url":"https://duckduckgo.com/"})` 回到首页，再执行上面的完整调用。
- Enter 是这张卡片的主提交动作，不是失败后的后备方案。不要改点折叠按钮，也不要拼接搜索 URL。提交前失败会自动保存 `submission_error`；提交后结果条件未出现会保存 `navigation_error`；抽取动作失败会保存 `extraction_error`。不要再补一次 `status_only` 抄写同一失败。
- 只有页面明确显示零结果时，才用 `executionPath:"status_only"`、`status:"explicit_empty"` 保存；验证页保存 `blocked`。

## 判据与边界

- 首页 HTTP 200、提交动作完成或地址出现 `q=` 都不能单独证明取得自然结果；必须以结果容器等待和抽取事实为准。
- 搜索摘要只供发现，不是正文证据。挑战页、翻页和明确零结果页没有额外的已验证操作路径。
- IAB 观察用于发现候选；只通过 `observationSelections` 把选中的外站直链交给后台 worker。
