# 百度搜索操作卡片

## 已验证的检索路径

当前首页优先使用新版表单 `textarea#chat-textarea` 与 `button#chat-submit-button`。只有快照明确显示经典输入框和按钮都可见时，才成对改用 `input#kw` 与 `input#su`；不得跨两套表单混用。

先 `browser_open({"url":"https://www.baidu.com/"})` 保存 `tabId`，随后一次调用完成输入、提交、等待自然结果与抽取：

```json
{"tabId":"<baiduTabId>","actions":[{"kind":"type","selector":"textarea#chat-textarea","text":"<query>"},{"kind":"click","selector":"button#chat-submit-button"},{"kind":"wait","until":{"selector":"#content_left .c-container:not(.EC_result)"},"timeoutMs":10000},{"kind":"extract","selectors":{"item":"#content_left .c-container:not(.EC_result)","title":"h3 a","url":"h3 a@href"}}],"research":{"engineId":"baidu","query":"<query>","angleIds":["<angleId>"],"executionPath":"homepage_form","submitActionIndex":1}}
```

经典表单只替换前两个 selector，其余等待、抽取和 `research` 不变。`.EC_result` 是广告卡的结构标记；不按位置或标题猜广告。

## 改词与失败判据

- 结果页内改词没有已验证路径。新 query 复用同一标签但先回到首页，重新从快照判断哪一整套表单可见，再执行完整调用。
- 不用 Enter，不拼接搜索 URL。地址变化后仍须等待自然结果容器，不能把 AI 摘要变化、空白主体或旧结果当成成功。
- 提交前、提交后等待、抽取三个阶段的动作失败会分别自动保存 `submission_error`、`navigation_error`、`extraction_error`；不要再用诊断列或第二次调用猜原因。
- 若到达 `wappass.baidu.com` 或可由人操作的安全验证，只调用一次带当前 `browserTabId` 的 `ask_user_question`。用户跳过、仍未恢复或无可操作控件时保存 `blocked`。

## 判据与边界

- `h3 a@href` 可能得到 `www.baidu.com/link?url=...`。对拟抓取的短名单，在观察首次提交前调用一次 `browser_open({"researchResolveBatch":{"selections":[{"observationId":"<id>","resultIndexes":[0,3,7]}]}})` 批量确认；只提交返回为已确认的索引，不抄写、不猜解跳转参数。
- 批量确认返回 `timeout` 表示该索引仍未确认，不表示目标不存在。只排除并保留这条线索；超时索引不得提交，也不因少数超时重跑整批。
- 只提交已选择并确认的跳转结果。明确零结果页与翻页没有已验证路径；搜索摘要只供发现，不是正文证据。
