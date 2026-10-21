---
name: web-research
description: 当用户需要跟进互联网上的最新信息、核对新版软件文档、调研软件架构或技术趋势，并要求可追溯的网页研究报告时使用。
---

# 网页研究

交付物是保存在当前项目根目录的 **Markdown 研究报告**。研究输入限 HTML 与纯文本网页；不采集 PDF 正文。搜索引擎只由 KyDog 内置浏览器的 `browser_open`、`browser_act` 操作；`web_research_task` 只处理 IAB 已观察的候选目标。主会话负责搜索、反思、反证、结论与报告写作；后台 worker 只抓取、解析、抽取可核查主张。

## 1. 定范围

保留用户的原始问题。在内部拆出 `id`、`label`、初始 `query`，必要时加 `rationale`；标明版本、时间范围与判定条件，并把这些结构直接提交给研究任务。**定范围本身不产生任何会话正文**：不要输出“研究范围（内部）”、不要复述原始问题，也不要展示角度 ID、query 表或尚未执行的“后续补搜”计划；结构准备好后直接开始工具调用。只有研究范围存在歧义、确实需要用户决策时，才展示可选择的范围。后续改词不修改角度的初始 `query`，每次 IAB 搜索观察保存实际使用的 query。已有角度的 `label` 或 `rationale` 不可静默覆盖；需要改变时新建角度 ID。用户未指定预算时用默认值，不默默扩大。

## 2. 用 IAB 搜索并保存观察

先读 `references/` 下四个引擎的操作卡。每次研究先用**同一个初始 query** 在 KyDog IAB 中分别尝试 DuckDuckGo、Bing、Google、百度各一次，保存各自实际状态；这只是本次可用性探测，不表示四者都已验证可用。Google、百度若落入**可由人操作**的验证页，按对应卡片用带 `browserTabId` 的 `ask_user_question` 把原标签交给用户；用户跳过、验证后仍未恢复，或页面没有可操作的验证控件时才记录 `blocked`，本轮后续 query 不再自动撞同一验证页。Chrome 的成功不能代替 IAB 结果。用户限定引擎时只尝试指定的引擎。后续新 query 在本轮已取得可抽取结果的引擎上分别检索，并记录每个引擎实际使用的 query；同一个 `(engineId, query)` 不盲目重复。每次检索检查结果页与当前 query，再按对应卡片保存观察。表单路径把实际提交动作、等待和 `extract` 放在同一次 `browser_act`，并传 `research:{engineId,query,angleIds,executionPath,submitActionIndex}`；Bing 的搜索 URL 路径由 `browser_open` 记录导航事实，再在同标签、同 query 的 `extract` 中传 `executionPath:"search_url"`。工具在主进程保存结果，返回 `observationId`、候选数与少量标题／摘要预览；不用手抄数百条 JSON。翻页或改词后重新抽取，获得新的观察 ID。

四个引擎各自保存和复用自己的 `tabId`。初始探测分成两个并发工具批次：第一批同时打开 DuckDuckGo、Google、百度首页，并直接打开带 `research` 的 Bing 搜索 URL；第二批在 DuckDuckGo 标签用一次 `browser_act` 完成 `type → key Enter → wait → extract`，在 Google 标签完成 `type → key Escape → click → wait → extract`，在百度标签完成 `type → click → wait → extract`，同时在 Bing 标签抽取。`browser_open` 与 `browser_act` 允许不同标签并发，同一标签仍由主进程队列按顺序执行；不要在同一批里对同一标签发两个调用。每个输入动作走 Electron Native 派发并核验目标标签收到输入，不修改用户当前可见标签；只有需要用户处理验证页时，才用带 `browserTabId` 的 `ask_user_question` 显示原标签。

Google、百度和 DuckDuckGo 必须照各自卡片使用完整调用；Bing 使用搜索 URL。DuckDuckGo 的 Enter 是卡片指定的主提交动作；Google、百度使用卡片指定的按钮点击。不要在某条表单路径失败后换另一种提交动作或改拼搜索 URL。表单路径的 `submitActionIndex` 必须指向本批实际负责提交的 `key` 或 `click`。工具分别记录提交动作完成、导航确认、成功等待与结果抽取，不能把其中一个当成其他几个。调用失败后直接使用自动保存的失败观察，不要盲目重放原动作，也不要另发 `browser_act` 做生产环境 DOM 诊断；对应卡片若根据失败返回的新快照规定了一次有界恢复，可以照卡片执行。失败状态只属于当前 `(engineId, query, attempt)`，不能据此停用整个引擎；本轮已有成功观察的引擎仍可承接后续新 query。只有验证页按上文交给用户后仍未恢复、用户跳过或页面没有可操作验证控件时，才把引擎记为 `blocked` 并停止本轮后续 query。

没有结果行时不要自动宣称“零结果”。表单提交前、提交后的等待／导航、抽取动作失败会由工具自动保存为 `submission_error`、`navigation_error`、`extraction_error`，并带失败动作和原始错误；不要再补一条 `status_only` 观察。页面明确无结果才传 `research.status:"explicit_empty"`，挑战页传 `"blocked"`；这两种明确页面状态用 `browser_act({tabId,actions:[],research:{engineId,query,angleIds,executionPath:"status_only",status}})` 记录，不必在验证页编造动作。成功结果仍必须 `extract`。每次 `research` 至少传一个非空 `angleId`；空数组会在碰页面前被拒。搜索摘要可立即指导改词、补搜或查反证；正文证据尚未取得时，不把摘要写成事实结论。是否再搜索由当前线索与证据缺口决定，不预设轮数。

观察记录保留搜索页、引擎、query、原始 href、标题、摘要与角度。IAB 提取的外站直链可直接入队。搜索引擎自有跳转链接（如 Google `/goto`、Bing `/ck/a`、百度 `/link`）仍是**未确认目标**。先根据标题与摘要选出本轮真正拟抓取的短名单，再把各观察的索引集中传给 `browser_open({researchResolveBatch:{selections:[{observationId,resultIndexes}]}})`；工具从保存的观察读取原始链接，用固定少量 IAB lane 批量导航，并只在主 frame 真正离开搜索引擎域后逐条保存最终地址，`resultIndexes` 从 0 开始。不要复制或改写不透明跳转 URL，也不要让模型逐条调用单项解析。**须在该观察 ID 首次 `submit` 前完成全部入选目标的确认**；批量返回中的失败索引不得出现在提交的 `resultIndexes`，也不得先整份提交后再补确认。已提交的观察 ID 不会因后来确认地址而自动重新入队。若浏览器仍停在搜索引擎域，就从本次提交选择中排除该行并保留为线索，不猜解参数，也不让普通抓取器把跳转页当正文。若当前 IAB 的结果条目实际提供并成功提取了独立目标 URL，可同时保存原始链接与 `targetUrl`；不要套用未经本次 IAB 验证的页面选择器。

## 3. 提交持久任务并增量查看

只有一个研究工具 `web_research_task`。首次 `action:"submit"` 传 `originalQuestion`、`angles`，并用 `observationSelections:[{observationId,resultIndexes}]` 精确选择要入队的结果。**有结果行的观察不得使用 `observationIds`**；该兼容字段会选择整份观察，容易把广告、无关项和未确认跳转一并锁定。`observationIds` 只用于绑定没有结果行的 `status_only` 观察，使 `overview` 保留该引擎的实际探测状态而不入队来源。每个 `resultIndexes` 只列外站直链或已通过 `researchResolveBatch` 确认的条目；**未确认跳转不得出现在 `resultIndexes`**。续查传 `researchRunId` 和新选择。首次提交会锁定观察，防止之后的跳转确认静默改变已入队集合；同一观察不能再交给另一个研究任务。工具按观察返回 `acceptedIndexes`、`duplicateIndexes`、`unresolvedIndexes` 与 `rejectedIndexes`；正常流程中 `unresolvedIndexes` 应为空，若非空，说明选择中仍混入未确认跳转，保留该返回用于诊断，但不要把它当成已入队来源，也不要在观察锁定后补确认。工具去重后**立即入队返回**，不等整批正文处理完。同一目标在不同引擎出现时保留全部发现背景。不要传 thread ID 或项目路径，它们由会话绑定。研究任务的后台队列独立于 agent 回合；会话里的研究任务卡显示其当前状态。

一轮研究循环是：保存本轮搜索观察 → 对拟抓取的跳转结果先确认目标 → `submit` 新观察 → 用摘要立即判断术语、反证与下一条 query → 需要正文结论时调用 `action:"wait"` 等当前后台批次空闲并取得最新状态 → 针对完成或失败的来源读取证据与缺口 → 决定补搜、改词、查反证或结束。`wait` 等的是已入队工作，不代替主会话的判断，也不要求固定轮数；任务卡在等待期间持续显示进度。不要连续调用 `inspect overview` 轮询。

用 `action:"inspect"` 指定 `researchRunId` 与 `view:"overview"|"sources"|"claims"|"evidence"`。`overview` 看任务状态、预算，以及每条已提交搜索观察的引擎、query、执行路径、协议布尔值、候选数、已确认数与未确认数；报告的方法说明只引用这些已保存事实。`sources` 看每个 URL 的抓取／抽取状态、失败原因与发现背景；`claims` 看逐源主张及其证据关联；`evidence` 核对某条引文在保存正文中的原文、关系及最终 URL，并返回 `sourceStatus`、`publishable` 与不可发布原因 `unavailableReason`。`sources`、`claims` 按 `cursor`、`pageSize` 分页，可用 `angleId` 或来源 `status` 筛选；返回 `nextCursor` 不表示必须读完全部分页。`wait` 已返回同一时刻的状态与预算，不要紧接着重复调用 `inspect overview`。只有需要解释失败时才按失败 `status` 读取 `sources`；只围绕当前角度、证据缺口或反证读取 `claims`，获得足以决定下一步的材料后停止分页，不把全部主张搬进主会话。写报告前先选定实际采用的引用，再用 `evidence` 每次核对 1–4 个 `evidenceIds`。每次补搜须指出现有观察或正文中的具体缺口及新 query 要验证什么；无可执行新查询时把未解问题写入报告。

任务卡的分母是当前已确认并入队的去重来源数，会随补搜增加；`300` 只是抓取预算上限。`有证据` 表示已处理且有可核验正文证据，`无相关主张` 表示已完整处理但判定无关，`失败` 表示抓取或抽取失败。默认容量为 1,000 个去重候选、300 次抓取、1 GiB 接收字节、1,800 次模型调用；抓取并发 12、模型并发 4。这是上限，不是必须抓满。全局预算耗尽会暂停，并保留排队来源及超出候选上限的搜索观察；确需继续时，在 `submit` 中显式提高相应 `budget`，再 `action:"resume"`。单源大小上限只使该来源失败。`pause`／`cancel` 也由 `web_research_task` 控制。Medium 匿名抓取收到 401/403 时，抓取器会用持久 IAB profile 中仅适用于 `medium.com` 的 Cookie 与 User-Agent 重试一次；仍失败就记 `needs_browser`，不要重复提交同一 URL。**除此之外，IAB 登录态不会传给后台 worker**；提前在 IAB 登录知乎、X、DeepWiki 或其他网站，不会让普通抓取自动带上该站 Cookie。403／`needs_browser` 应改找可抓取的一手或独立来源，或作为证据缺口保留；429 是站点限流，521 是源站／网关故障，脚本壳需要浏览器渲染，均不能用“已登录”推定可恢复。抓取失败、PDF、验证页、无关、反证、未处理应各按真实状态保留，不把失败说成“无相关网页”。

## 4. 自查并保存报告

每个解释架构、工作原理、数据流、控制流、状态变化、角色协作或跨组件交互的主题章节须包含至少一幅 Mermaid 图，使用标准 `mermaid` fenced code 并紧邻解释；引用留在图旁的相邻正文中，不写进 Mermaid。图型选择、证据支持与推断标注遵循报告模板。

主会话负责比较独立来源、识别冲突与时间边界。`grounded` 只说明引文可在已保存正文中定位，不代表主张独立证实；不要按搜索命中数投票。按 `references/report-template.md` 的轻量约束组织报告，主题章节随问题增删；报告须交代问题、检索日期、结论、方法与覆盖范围、发现、冲突、限制与未解决缺口。先用 `inspect` 的 `evidence` 查看要引用的原文。提交给 `complete` 的**草稿**为具体主张写 `[来源](最终URL)〔证据:evidenceId〕`；同一来源的多条证据可写成 `[来源](最终URL)〔证据:id1,id2〕`，不同来源仍分别给链接。链接必须与证据所属来源的最终 URL 完全一致；工具核验后从保存的成品中确定性去掉内部证据 ID，读者只看到可点击的来源链接。

完成时调用 `web_research_task` 的 `action:"complete"`，传 `researchRunId`、`reportMarkdown` 和可选 `fileName`。若传 `fileName`，它只写主题短名，不带 `web-research-` 前缀、日期或 `.md`。工具先核验全部引用；失败时一次返回所有带行、列、摘录和证据 ID 的结构化诊断，不暂停任务、不写文件，集中修订后再试。核验通过后才停止队列、等待进行中的抓取／抽取收尾，并原子保存为项目根目录的 `web-research-<主题>-YYYY-MM-DD.md`；重名自动生成新文件，不覆盖旧报告。报告文件卡在完成结果处单独显示，研究任务卡继续显示进度与状态。若还有排队、抓取或抽取中的来源，须传 `unprocessedReason`，并在报告正文写明同一原因。GitHub Blob 页面可由 worker 从对应 Raw URL 取正文，但报告链接仍保留用户可读的 GitHub 页面 URL。

`complete` 成功后，会话回复只说明报告已经保存并概括不超过三条报告结论；文件卡已经提供路径与打开入口。**完成后的会话回复不得包含“执行说明”**，也不得重新罗列搜索引擎、query、工具名、内部计数、失败调用或调试过程。确实影响结论的访问限制与证据缺口写进报告的“冲突与未核实项”或“限制与开放问题”，不在报告卡之后再附一份运行日志。
