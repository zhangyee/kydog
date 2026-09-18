# e2e 用例指南

写或改 `e2e/` 下的用例之前读。e2e 慢（每次冷启动本机约 2 秒、CI 的 Intel runner 约 5 秒），而且只有它会撞上
CI 与开发机的环境差 —— 发版流水线历次卡住，几乎都卡在这里。下面每一条都来自一次真实的红。

## 1. 先判断：这条非 e2e 不可吗

e2e 只用来证明单测证明不了的事：

- 渲染层与主进程**真服务**之间的往返：IPC、广播回流、主进程的 `process.env`
- 重启之后的磁盘状态、冷启动行为
- Chromium 的真渲染：canvas 像素、真实布局几何、沙箱 iframe（OOPIF）与 CSP、字体真的加载
- 原生能力：`WebContentsView`、CDP 输入、真实的文件监听、窗口与焦点
- 打包成品（`54-packaged-smoke`）

其余一律写 vitest：纯逻辑、store、组件接线（`src/test-support/miniReact.ts`，node 环境、不许加依赖）、
文案、校验、编排（翻译流水线的重试与合并、工具结果的截断……）。同一个功能，e2e 只留主路径；分支、边界、
错误码放单测。**动手前先 grep 有没有同样断言的单测**，有就不写 e2e。

## 2. 成本：一个功能区一次启动

- **合并写法**：同一个 spec 里 `test.describe.configure({ mode: 'serial' })`，`beforeAll` 启动一次、
  `afterAll` 收掉，每个说法仍是一条独立的 `test()`，报告里各自出名字。范例：`e2e/30-markdown-editor.spec.ts`、
  `e2e/53-reload-keeps-view.spec.ts`。一个 spec 需要两个干净进程就写两个 `test.describe`。
- **串行意味着上一条的状态是下一条的起点**：在 spec 头部写清顺序约束（例：57 的字号缓存必须第一次进对照、
  46 的沙箱 iframe 一次启动只有一键可靠投递、会改坏边车的那步放最后）。
- **重启类的说法共用一次重启**（范例：`18-projects-sidebar-actions` 末尾那条一次核对主题、置顶、收起、改名、视图不恢复）。
- **agent 回合用 fixture 的 `scripts` 形状**（`e2e/fixtures/fixture.types.ts`）：按这一轮发送的原文挑剧本，
  几个流式场景共用一次启动。挑不到剧本会当场报错，不回落。
- **不打真实上游**：发消息必须带 fixture（否则拿假 key 真打 API）；内置浏览器的页面由用例起的本地代理提供
  （`61-browser` 文件头：会话代理加一张只对 example.com/.org/.net 生效的自签证书，别的 host 一律连不出去）。

## 3. 开发机与 CI 的环境差

已在 `e2e/helpers.ts` 的启动参数里钉成与 CI 一致，别去掉：

| 差异 | CI runner | 开发机 | 处置 |
|---|---|---|---|
| 屏幕 | 1024×768，应用要的 1280 窗口会被压 | 大屏 | 窗口钉 1024×720 |
| 像素比 | dpr 1 | Retina dpr 2 | `--force-device-scale-factor=1` |
| 滚动条 | 常驻（macOS runner 没触控板；Windows 一直常驻） | 浮动（宽 0） | macOS 上 `-AppleShowScrollBars Always` |
| 减少动态效果 | runner 镜像默认 reduce | no-preference | `--force-prefers-no-reduced-motion` |
| DevTools | — | dev 模式会开分离窗口抢焦点 | `main.ts` 对 `KYDOG_E2E` 不开，`00-shell` 守 |

还有几类钉不住、只能在写法上躲：

- **冷启动慢且方差大**：`launchKydog` 等到真 UI 出来（30 秒基础设施预算）；`expect.timeout` 5 秒是行为判据，不许放大。
- **CPU 共享、慢**：判据不许依赖耗时。纯性能用例默认不跑，要跑显式设 `KYDOG_PERF_BROWSER_E2E=1`。
- **Windows 路径是反斜杠**：定位用 `getByTestId`（它会转义），拼选择器用 `testIdSelector`；展示文件名用 `path.basename`。

遇到新的环境差，**先在本机把同一个开关钉成 CI 那样、复现出同一个数，再改判据**。不许照着 CI 报错逐条猜。

## 4. 判据怎么写

- **等协议事实，不等时间**：`data-*` 标记（如 `data-harness-check="done"`）、主进程广播回来的状态、盘上的内容
  （`expect.poll` 读文件）、done 计数加 `fenceRendererIpc`。`waitForTimeout` 只允许用在「断言一段时间里什么都
  没发生」而又没有协议事实可等的地方，并在注释里写明理由（例：30 的开档不标脏、52 的保存回声不重建、
  57 的滚动回声不把窄栏拽回）。
- **fixture 的 `after_ms` 节拍不是同步手段**：别在两个夹具事件之间抢窗口断言中间态。
- **几何判据从实际几何推**（比例、舞台宽），不写死像素；量到页面右缘的判据要把常驻滚动条算进去。
- **像素判据轮询到成立**：`capturePage` 拿的是合成器最近交出的一帧，可能是旧帧，也可能还没有帧
  （`UnknownVizError`）。范例：`61-browser` 的 `shootUntil`。1 像素量级的差别别在 e2e 里量，抽成纯函数用单测钉数值。
- **悬停出按钮要反复施加**：单发 `hover()` 没有到达回执，CI 上丢过。放进 poll，锚定按钮的 computed
  `pointer-events`（范例：`18-projects-sidebar-actions` 的 `reveal`）。
- **沙箱 iframe 的键盘**：一次启动里只有第一次按键可靠送达，要多按先在 frame 里真点一下武装投递（`46-html-tab` 文件头 ⚠️）。
- **一个定位器可能命中多个**：开过的 tab 编辑器仍挂在 DOM 里（用 `locator('visible=true')`）；按 URL 认 webContents 要唯一。
- **否定断言在同一条 `test()` 里要有正向证明**（CLAUDE.md）。合并成串行以后，上一条 `test()` 里的正向不算。
- **夹具字段逐个翻面**（CLAUDE.md）。

## 5. 写完之后

1. `npm run package`，然后 `npx playwright test e2e/<spec> --repeat-each 3 --retries 0`，三遍全绿再提交。
2. 翻面：把被测行为改坏一次，确认它红；改回来。
3. 新 spec，或改了环境相关的东西：打 tag 之前 `gh workflow run release.yml --ref <分支>` 在三个平台演练一遍
   （演练不会发版：release job 只认 tag push）。
4. CI 红了：先下载 `e2e-test-results-*` artifact 看 trace 与报错里的实际数值，在本机钉成同样的环境复现；
   复现不了就不下结论。只有已证实的纯基建抖动（如打 dmg 时 `hdiutil detach` 失败）才 `gh run rerun --failed`。
