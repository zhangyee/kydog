# KyDog — Claude Code guidance

面向科研工作流的 AI 智能体桌面应用（Electron + pi coding-agent SDK）。

## Principles

判定必须基于协议层事实，不靠启发式 proxy（时间窗 / 阈值 / 近似 / 聚类等）；当下游发现需要 proxy 才能得出结论时，意味着上游某处把信号丢了 —— 回到源头把信号正确保留下来，而不是在下游补救。

## 改动前先读

- **跨进程的东西**（加 RPC 方法、加事件 topic、改渲染层与主进程的往返）→ `docs/architecture.md`
- **LLM provider / model** → `docs/llm-architecture.md`。写 `settings.llm.*` 必须配合它 §5 的传播调用，漏了不报错、只在运行时静默用错
- **pi coding-agent SDK 用法** → 官方完整文档在 `node_modules/@earendil-works/pi-coding-agent/docs/`，示例在同包 `examples/sdk/`。别凭记忆猜 API（干净 checkout 需先 `npm install`）

## Commands

验证类（gate 命令，可随时跑）：

- `npx tsc --noEmit` — 类型检查
- `npm test` — vitest 全跑；`npm test -- <pattern>` 过滤（e.g. `log.test` / `cwdHash` / `atomicWrite` / `persist`）
- `npm run lint` — ESLint 9 flat config

E2E（Playwright + Electron，需要先打包）：

- `npm run package` — `electron-forge package`，**每次 e2e 前必跑一次**（Playwright `_electron.launch` 需要构建后的 main.js）
- `npm run e2e` — Playwright 全跑；`npm run e2e -- 00-shell 01-first-run-settings` 过滤
- `npx playwright install chromium` — 一次性，幂等

其他：

- `npm install` — 可以自己跑。但**往 `package.json` 加新依赖前先跟用户 review**
- `npm start` — 开窗口，需要桌面 UI，**不要在 agent 上下文里跑**
- `npm run cli:update` — 检查上游 CLI 新版本 + 同步其 skill 到 `src/skills/`，逐项 `[y/N]` 确认（交互式）
- `npm run cli:update fastpaper@0.2.1` — 钉到指定版本（可回退），skill 跟着走同一个 tag；用位置参数，别写 `--tool`（npm 会吞掉它）

## Windows 上跑测试：先开一次「开发者模式」

有一批用例要**真的建符号链接**（考的是软链能不能越出目录、写入会不会穿透链接）。Windows 建符号链接需要 `SeCreateSymbolicLinkPrivilege`，普通用户默认没有，`fs.symlink` 直接抛 `EPERM`。

**设置 → 系统 → 开发者选项 → 开发者模式**，打开即可。这是一次性开关，开完普通用户就一直有这项特权，**不需要每次开管理员窗口**。开之前可以先确认现状：

```bash
node -e "const f=require('fs'),o=require('os'),p=require('path');const d=f.mkdtempSync(p.join(o.tmpdir(),'c-'));f.writeFileSync(p.join(d,'t'),'x');try{f.symlinkSync(p.join(d,'t'),p.join(d,'l'));console.log('OK')}catch(e){console.log('UNAVAILABLE',e.code)}finally{f.rmSync(d,{recursive:true,force:true})}"
```

没开也**不会红**：`src/test-support/symlinkCapability.ts` 会探针式判定，建不了就 `skipIf` 跳过（跳过原因带在用例上，不是静默的）。代价是那批安全用例本机没跑到——所以别把「本机绿」当成「这块没问题」。

CI 里靠 `KYDOG_REQUIRE_SYMLINK=1` 反过来**禁止跳过**：能力缺失就让它以 EPERM 红出来，免得覆盖在发版流水线上悄悄消失。目前钉在两个 macOS 矩阵项上（见 `.github/workflows/release.yml`）。

## 约定

- **不要引入危险色**。设计系统里没有红色 token，破坏性操作走统一的 `confirm()` 对话框，不靠颜色警示。
- **改了 `src/about/` 的篇目**（新增、删除、改标题或正文）→ 同步 `e2e/39-about-page.spec.ts`。它硬编码了当前的篇数、标题与正文片段，而 `npm test` 覆盖不到 e2e，只跑 gate 命令不会发现它红了。
- **往 `vite.main.config.ts` 的 `external` 加包** → 同步 `forge.config.ts` 的 `EXTERNAL_RUNTIME_MODULES`。external 的包不进 bundle，只以裸名留在产物里，运行时按 Node 规则找 `node_modules`；打包成品里没有它就是 `ERR_MODULE_NOT_FOUND`。**开发机上看不出来**：`out/` 在仓库内，解析会一路上溯摸到 `<repo>/node_modules`，借开发树的货照样跑。守这条的是 `e2e/54-packaged-smoke` 的断言 2b（它把成品复制到仓库外再启动），而 e2e 要先 `npm run package`，只跑 gate 命令发现不了。
- **改了 `src/skills/` 的内容**（新增、删除、改 SKILL.md / references / assets）→ 跑 `sync-skill-docs` 审核中英文一致性。`builtinSkillsI18n.test.ts` 只校验双语文件**存在**，校验不了内容有没有同步；放弃 sha 账本之后，这套审核是内容一致性的唯一保障。
