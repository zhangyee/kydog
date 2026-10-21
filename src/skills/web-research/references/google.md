# Google 搜索操作卡片

## 已验证的检索路径

首页输入框是 `textarea[name="q"]`。页面存在多个同名提交控件；`div[jsname="VlcLAe"] input.gNO89b[name="btnK"]` 是 0×0 的隐藏副本，不得使用。输入后联想层有时还会同时暴露两个非零尺寸的“Google 搜索”按钮。先给仍持有焦点的输入框发送 Escape，明确收起联想层，再用动作时语义定位点击唯一可见的提交按钮。

```json
{"tabId":"<googleTabId>","actions":[{"kind":"type","selector":"textarea[name=\"q\"]","text":"<query>"},{"kind":"key","key":"Escape"},{"kind":"click","locator":{"role":"button","name":["Google 搜索","Google Search"],"visible":true}},{"kind":"wait","until":{"urlMatches":"/search?"},"timeoutMs":10000},{"kind":"extract","selectors":{"item":"a:has(h3)","title":"h3","url":":scope@href"}}],"research":{"engineId":"google","query":"<query>","angleIds":["<angleId>"],"executionPath":"homepage_form","submitActionIndex":2}}
```

Escape 只负责关闭联想层，不是提交动作；`submitActionIndex` 因此指向零基的第 2 个动作 `click`。`locator` 对名称做精确匹配并要求唯一的非零尺寸节点；零匹配或多匹配都会失败，不按顺序或坐标猜一个按钮。定位与测量之间若页面明确报告节点失效、尺寸消失或被新层遮挡，工具会重取当前快照再定位一次。`div.MjjYud` 只表示结果页布局容器，不是稳定结果项；最终抽取使用包住 `h3` 的 `a`。

## 改词与失败判据

- 新 query 复用同一标签，但先回到 `https://www.google.com/`，再执行同一完整调用；语义目标在点击动作时重新解析，不复用旧快照编号。
- 不用 Enter、不拼接搜索 URL、不回退到隐藏按钮 CSS。自动保存的 `submission_error`、`navigation_error`、`extraction_error` 已经是本次真实失败，不再追加 DOM 诊断调用。
- 输入后先用 Escape 收起联想层，再解析按钮；这避免联想层按钮与首页按钮同时可见造成多匹配。若 Escape 后仍得到零匹配或多匹配的 `submission_error`，失败只属于当前 query，Google 仍为可用引擎，不能记为 `blocked` 或停止后续 query；不要在会话中手工重取按钮编号或重复原批次。
- 若出现 reCAPTCHA 或其他可由人操作的验证页，只调用一次带当前 `browserTabId` 的 `ask_user_question`，提供“解好了，继续”和“跳过 Google”。等待时不读、不点、不另开标签。
- 用户确认后先检查同一标签；已回到结果页就直接抽取。用户跳过、仍未恢复或没有可操作控件时，以 `status_only`、`blocked` 保存，本任务后续 query 不再自动撞同一验证页。

## 判据与边界

- 首页 HTTP 200、点击成功或 URL 含 query 都不能单独证明取得自然结果。验证页不是零结果，也不是普通抓取目标。
- `submission_error`、`navigation_error`、`extraction_error` 是 query 尝试状态，不是引擎状态；只有上一节规定的未恢复验证页才能使本轮 Google 成为 `blocked`。
- 结果抽取只保存标题链接，不保证摘要。用 `resultIndexes` 排除导航、广告和与 query 无关的候选。
- 抽取出的 Google 自有的 `/goto` 跳转仍是未确认目标。先按标题选出拟抓取索引，在观察首次提交前一次调用 `browser_open({"researchResolveBatch":{"selections":[{"observationId":"<id>","resultIndexes":[0,3,7]}]}})` 批量确认；只把返回为已确认的索引写进 `observationSelections`。工具用少量 IAB 标签并发导航，不复制或解码跳转参数。
- 动作时语义定位是该动态按钮的精确路径；固定 CSS 只有经过真实 IAB 成功调用后才能写进本卡片。
