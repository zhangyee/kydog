# KyDog — Claude Code guidance

面向科研工作流的 AI 智能体桌面应用（Electron + pi coding-agent SDK）。

## References

pi coding-agent SDK 相关改动前先查 `docs/references/pi-coding-agent/`，不要凭记忆猜 API：

- `sdk.md` — `createAgentSession` / `createAgentSessionRuntime` 等编程接口总览
- `models.md` — 自定义模型 + 自建 provider（Ollama / vLLM / OpenAI-compat 代理）配置
- `providers.md` — 内置 provider、OAuth、API key 解析顺序
- `examples/sdk/` — 13 个分主题 `.ts` 示例（`01-minimal.ts` … `13-session-runtime.ts`），`README.md` 是入口索引

LLM provider/model 改动前先查 `docs/superpowers/specs/2026-05-01-providers-and-models-redesign-design.md`：

- 22 个内置 provider 的 catalog 在 `src/main/llm/catalog.ts`，pi 升级时需手动同步
- 凭证统一存 `~/.kydog/kydog.json::llm.auth`（KydogAuthStorageBackend）；权限强制 0600
- Cloud cfg 不进 auth blob，靠 `cloudEnvSync.applyCloudEnv` 写 `process.env`
- 配置变更后必须经 `ProviderRegistry.{reloadAuth, refreshAfterProviderChange}` + `AgentService.{invalidateSessionsForProviders, invalidateSessionsForThread, recomputeSessionsAfterDefaultChange}` 之一

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

交互式（不要在 agent 上下文里跑，需要桌面 UI）：

- `npm start` — `electron-forge start` 开窗口
- `npm install` — 装依赖（让用户自己跑）
