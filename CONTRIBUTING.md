# 贡献指南

KyDog 由一个人开发和维护，欢迎任何形式的参与。Issue 和 PR 用中文或英文都可以。

*Issues and pull requests in English are welcome.*

## 最有用的三种反馈

1. **「某个 skill 在我的领域里不好使」** —— 带上你实际给的提示词和它产出的东西。skill 是这个项目最容易在陌生学科上翻车的部分，具体案例比功能许愿有用得多。
2. **某个文献源查不到 / 下不动。** 说清是哪个源、什么标识符、报了什么错。
3. **界面上让你卡住的地方。** 不用想清楚该怎么改，说清你当时想干什么、卡在哪一步就够了。

以上都发到 [Issues](https://github.com/zhangyee/kydog/issues)。

## 开发环境

需要 Node.js ≥ 22.12。

```bash
git clone https://github.com/zhangyee/kydog.git
cd kydog
npm install     # postinstall 会自动拉取当前平台的 fastpaper 二进制
npm start       # 开发模式启动
```

PR 请以 `mvp` 分支为基准。

### 单项目开发调试

调试时可把 Projects 固定为一个目录。先启动一次 KyDog 生成配置，然后在仓库内运行：

```bash
npm run dev-project on ./debug-project  # 指定已有目录并开启，相对路径按当前工作目录解析
npm run dev-project on                  # 使用上次保存的目录开启
npm run dev-project off                 # 关闭，保留目录设置
npm run dev-project status              # 查看磁盘上的配置状态
```

也可以直接编辑 `~/.kydog/kydog.json` 中的以下字段；缺少这项配置时默认关闭：

```json
"development": {
  "singleProject": { "enabled": true, "path": "/absolute/path/to/debug-project" }
}
```

开关和目标目录都在**重启 KyDog 后生效**，窗口刷新不切换模式。开启时只展示目标项目及其对话，
不能添加其他项目或移除目标；其他项目、对话与折叠状态保留。调试目录作为临时项目展示，不加入普通项目列表；
关闭后恢复开启前的项目列表。调试对话继续保存，关闭时隐藏，再次开启同一目录即可恢复。
如果目标原本就在普通项目列表中，关闭后仍保留。临时项目的改名与置顶仅本次运行有效。
目标无效时启动报错，可用 `off` 恢复。
这项设置限定工作区的项目列表，不限制 Agent 的文件访问范围。

## 网页研究的浏览器读取与人工继续

持久网页研究任务先读取 HTTP 正文；遇到明确的 `needs_browser`，或最终域名为 `blog.csdn.net` 的 HTTP 521 时，自动用内置浏览器的任务专用后台标签尝试一次。动态文章正文取得后沿用原来源进入主张和证据提取，原始 HTTP 状态与浏览器响应状态分别保留。

自动读取从获得浏览器读槽开始最多 30 秒（包括导航）；超时仅表示本轮没有取得正文，不表示网站永久不可读，也不自动认定为验证码。来源进入「待用户处理」后，展开研究卡片的来源列表，点「打开页面」，在内置浏览器完成需要的操作，再点「继续读取」。继续读取优先采集当前来源文档，不刷新刚验证的页面；标签已丢失或已改到其他文章时会重新打开专用标签。暂停后先点「恢复任务」，取消走统一确认对话框。已完成任务和报告不会被自动重写。

预算中的来源读取派发包含 HTTP 请求与主动浏览器打开，每次主动打开预先占用一个 `maxFetches` 名额；复用活标签的「打开页面」和原文档采集不新增导航名额。浏览器自动脚本的重载不另算 collector 派发。浏览器文档字节单独累计，与 HTTP 接收字节分开，分别沿用单来源 `maxBytesPerSource` 与任务 `maxTotalBytes` 上限；解析未成功的实际 DOM 快照也计入消耗。站点仍可能返回访问限制或需要人工操作，浏览器入口不保证每个来源都能恢复成功。

## 验证命令

改完随时可以跑，提 PR 前必须全绿：

```bash
npx tsc --noEmit    # 类型检查
npm test            # vitest 全跑
npm run lint        # ESLint
```

`npm test` 支持过滤：`npm test -- log.test`、`npm test -- persist`。

### E2E

Playwright 驱动打包后的 Electron，所以**每次跑 e2e 前必须先 package 一次**：

```bash
npx playwright install chromium   # 一次性，幂等
npm run package
npm run e2e
```

同样支持过滤：`npm run e2e -- 00-shell 01-first-run-settings`。

## 代码在哪

| 目录 | 内容 |
|---|---|
| `src/main/` | 主进程：agent 服务、LLM provider、持久化、skill 加载、harness |
| `src/preload/` | 预加载脚本，渲染层访问主进程的唯一入口 |
| `src/renderer/` | 界面：工作区、会话主面板、检查器、设置、首次设置向导 |
| `src/shared/` | 跨进程协议（`protocol.ts` 是所有 RPC 与事件的收口） |
| `src/skills/` | 内置 skill，每个是一个目录，中英双语两份 SKILL.md |
| `src/about/` | 应用内「关于」页的篇目 |
| `e2e/` | Playwright 用例 |
| `docs/` | 架构文档 |
| `scripts/` | 构建与维护脚本 |

## 动手之前先读

- **跨进程的东西**（加 RPC 方法、加事件 topic、改渲染层与主进程的往返）→ [docs/architecture.md](docs/architecture.md)。所有跨进程的东西都在 `src/shared/protocol.ts` 收口，从那个文件开始改。
- **LLM provider / model** → [docs/llm-architecture.md](docs/llm-architecture.md)。写 `settings.llm.*` 必须配合它 §5 的传播调用，漏了不报错、只在运行时静默用错。
- **pi coding-agent SDK 用法** → 官方完整文档在 `node_modules/@earendil-works/pi-coding-agent/docs/`，示例在同包 `examples/sdk/`。别凭记忆猜 API。

## 约定

- **判定基于协议层事实，不靠启发式 proxy。** 不用时间窗、阈值、近似、聚类去猜状态。如果下游需要 proxy 才能得出结论，说明上游某处把信号丢了 —— 回源头把信号保留下来，而不是在下游补救。
- **不要引入危险色。** 设计系统里没有红色 token，破坏性操作走统一的 `confirm()` 对话框，不靠颜色警示。
- **改了 `src/about/` 的篇目**（新增、删除、改标题或正文）→ 同步 `e2e/39-about-page.spec.ts`，它硬编码了篇数、标题与正文片段。
- **改了 `src/skills/`** → 中英文两版必须同步。`builtinSkillsI18n.test.ts` 只校验双语文件存在，校验不了内容是否一致。
- **新增依赖前先开 issue 讨论。** 这是个要打包分发的桌面应用，每个依赖都进安装包。
- **Commit message 写成简短的一行**，不用 Conventional Commits 前缀。

## 发版

打 `v<version>` 标签触发 GitHub Actions 构建 macOS（arm64 / x64）与 Windows x64 安装包。标签必须与 `package.json` 的 `version` 一致，否则 CI 直接失败 —— 装出来的应用会自报错误版本，更新判定会失效。

## 许可证

提交即表示你同意你的贡献以 [GPL-3.0-or-later](LICENSE) 授权。
