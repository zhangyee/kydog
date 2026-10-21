# Bing 搜索操作卡片

## 已验证的检索路径

Bing 直接走搜索 URL，不需要先开首页。首次检索可不传 `tabId`；改词时复用已有标签：

```json
{"url":"https://www.bing.com/search?q=<encodeURIComponent(query)>","research":{"engineId":"bing","query":"<query>","angleIds":["<angleId>"],"executionPath":"search_url"}}
```

导航成功后，在同一标签、同一 query 抽取：

```json
{"tabId":"<bingTabId>","actions":[{"kind":"extract","selectors":{"item":"li.b_algo","title":"h2 a","url":"h2 a@href","snippet":".b_caption p"}}],"research":{"engineId":"bing","query":"<query>","angleIds":["<angleId>"],"executionPath":"search_url"}}
```

保存返回的 `observationId`。HTTP 200 或 URL 中有 `q=` 不代替结果抽取。

## 改词与失败判据

- 新 query 用同一 `bingTabId` 再次 `browser_open` 搜索 URL，并传完全一致的 `research`；随后同标签抽取。
- `/ck/a` 是 Bing 自有跳转，不是目标 URL。根据标题与摘要先选短名单，在观察首次提交前调用一次 `browser_open({"researchResolveBatch":{"selections":[{"observationId":"<id>","resultIndexes":[0,3,7]}]}})` 批量确认。工具用少量 IAB 标签并发导航，只在主 frame 离开 Bing 域后逐条保存最终地址。
- 批量结果中的 `timeout` 只表示时限内未观察到离开 Bing 域；不证明目标站不可达，也不能据此复制或解码跳转参数。只提交返回为已确认的索引。
- 搜索 URL 导航失败保存 `navigation_error`；抽取动作失败会自动保存 `extraction_error`。挑战页用 `status_only` 保存真实状态，不把旧 query 或挑战页记成零结果。

## 判据与边界

- 首次 `submit` 只选择已确认的结果。未确认 `/ck/a` 保留为线索，出现在 `unresolvedIndexes`，不会进入正文抓取，也不算抓取失败。
- 搜索摘要只供发现，不是正文证据。明确零结果页与翻页没有已验证操作路径。
