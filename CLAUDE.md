# KyDog — Claude Code guidance

面向科研工作流的 AI 智能体桌面应用（Electron + pi coding-agent SDK）。

## Principles

判定必须基于协议层事实，不靠启发式 proxy（时间窗 / 阈值 / 近似 / 聚类等）；当下游发现需要 proxy 才能得出结论时，意味着上游某处把信号丢了 —— 回到源头把信号正确保留下来，而不是在下游补救。

## References

pi coding-agent SDK 相关改动前先查 `docs/references/pi-coding-agent/`，不要凭记忆猜 API：

- `sdk.md` — `createAgentSession` / `createAgentSessionRuntime` 等编程接口总览
- `models.md` — 自定义模型 + 自建 provider（Ollama / vLLM / OpenAI-compat 代理）配置
- `providers.md` — 内置 provider、OAuth、API key 解析顺序
- `examples/sdk/` — 13 个分主题 `.ts` 示例（`01-minimal.ts` … `13-session-runtime.ts`），`README.md` 是入口索引

LLM provider/model 改动前先读 `docs/llm-architecture.md`（数据流 / 状态不变量 / 变更传播规则 / 已知偏离）。

`docs/` 已在 `tsconfig.json` exclude，不参与编译。

## Commands

验证类（gate 命令，可随时跑）：

- `npx tsc --noEmit` — 类型检查
- `npm test` — vitest 全跑；`npm test -- <pattern>` 过滤（e.g. `log.test` / `cwdHash` / `atomicWrite` / `persist`）
- `npm run lint` — ESLint 9 flat config

E2E（Playwright + Electron，需要先打包）：

- `npm run package` — `electron-forge package`，**每次 e2e 前必跑一次**（Playwright `_electron.launch` 需要构建后的 main.js）
- `npm run e2e` — Playwright 全跑；`npm run e2e -- 00-shell 01-first-run-settings` 过滤
- `npx playwright install chromium` — 一次性，幂等

交互式（不要在 agent 上下文里跑）：

- `npm start` — `electron-forge start` 开窗口（需要桌面 UI）
- `npm install` — 装依赖（让用户自己跑）
- `npm run cli:update` — 检查上游 CLI 新版本 + 同步其 skill 到 `src/skills/`，逐项 `[y/N]` 确认
