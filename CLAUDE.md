# KyDog — Claude Code guidance

面向科研工作流的 AI 智能体桌面应用（Electron + pi coding-agent SDK）。

## References

pi coding-agent SDK 相关改动前先查 `docs/references/pi-coding-agent/`（`sdk.md` + `examples/README.md`），不要凭记忆猜 API。`docs/` 已在 `tsconfig.json` exclude，不参与编译。

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
