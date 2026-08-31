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
