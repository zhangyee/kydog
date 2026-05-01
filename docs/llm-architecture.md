# LLM provider / model 架构

写给改动 LLM 相关代码的人。先读这份，再看具体文件。

## 1. 顶层数据流

```
PROVIDER_CATALOG          ← src/main/llm/catalog.ts（22 行 builtin 静态数据）
       │
       │ 用户在 Settings 配置（key / OAuth / cloud / custom）
       ▼
~/.kydog/kydog.json::llm  ← schema v2，权限强制 0600
  ├─ auth:           pi 的 AuthStorageBackend 唯一权威源（KydogAuthStorageBackend 桥接）
  ├─ providers[id]:  baseUrl / headers / cloud cfg / defaultModel
  ├─ customProviders[]: 用户自建 OpenAI-compat provider 列表
  └─ defaultProvider / defaultModel: 全局默认
       │
       ▼
ProviderRegistry          ← src/main/llm/providerRegistry.ts（main 进程 singleton）
  ├─ authStorage:    pi.AuthStorage.fromStorage(KydogAuthStorageBackend)
  └─ modelRegistry:  pi.ModelRegistry.inMemory(authStorage)
       │
       ▼
sessionFactory.createSession({providerId, modelId, ...})
       │
       ▼
pi.createAgentSession({authStorage, modelRegistry, model, ...})
       │
       ▼
AgentService.bound = { session, providerId, modelId, ... }
```

## 2. 状态存储不变量

| 字段 | 说明 |
|---|---|
| `auth[id]` | `{type: 'api_key', key}` 或 `{type: 'oauth', refresh, access, expires}`。同一 id 二选一（pi 限制） |
| `providers[id].baseUrl` | 覆盖 pi builtin baseUrl |
| `providers[id].headers` | 透传给 pi |
| `providers[id].cloud` | Azure/Bedrock/Vertex 配置；写盘后 `cloudEnvSync.applyCloudEnv` 同步到 `process.env` |
| `providers[id].defaultModel` | 该 provider 的默认 model（次级解析键） |
| `customProviders[i]` | 自建 provider 完整定义（id / displayName / baseUrl / api / apiKey / models / ...） |
| `defaultProvider` / `defaultModel` | 全局默认；InputPill 显示 |
| `Thread.modelOverride` | 单 thread 覆盖；优先级最高 |

文件权限强制 0600。`atomicWriteWith0600Async/Sync` 保证 temp 文件出生即 0600（不依赖 umask）。

## 3. 配置变更如何传播

任何写入 `settings.llm.{auth, providers, customProviders}` 的代码必须配合下列调用之一，否则运行时 pi/agent 会读到陈旧状态：

| 触发场景 | 必须调用 |
|---|---|
| `auth[id]` 变化（增/删 key 或 OAuth） | `providerRegistry.reloadAuth()` |
| `providers[id]` 或 `customProviders[]` 变化（新加 / 改 baseUrl / 改 cloud） | `providerRegistry.refreshAfterProviderChange(svc, agentService, [changedIds])` |
| `defaultProvider` 或 `defaultModel` 变化 | `agentService.recomputeSessionsAfterDefaultChange()` |
| `Thread.modelOverride` 变化 | `agentService.invalidateSessionsForThread(threadId)` |
| Cloud cfg 写入 | 上面 (b) + `cloudEnvSync.applyCloudEnv(providers)` 同步 process.env |

`AgentService` 的失效语义：idle 立即 dispose，running 时 `bound.staleAfterRun = true`，等 pi 的 `agent_end` 后再 dispose。

## 4. 解析顺序（resolveActive / resolveProviderDefault）

`AgentService.ensureSession` 通过 `resolveActive(threadId, projectPath)` 确定要绑哪个 model：

```
1. thread.modelOverride        （存在则优先用）
2. settings.providers[id].defaultModel       ← resolveProviderDefault helper
3. settings.customProviders[i].defaultModel  ← resolveProviderDefault helper
4. settings.defaultModel       （全局兜底）
└─ 都没有 → 抛 ResolveError('no-model')
```

`defaultProvider` 同理，override > 全局，缺则抛 `ResolveError('no-provider')`。

## 5. 关键文件索引

| 文件 | 作用 |
|---|---|
| `src/main/llm/catalog.ts` | 22 行 builtin provider 静态数据（kind / group / piProviderId / envFallback / cloudCfgKind） |
| `src/main/llm/providerRegistry.ts` | singleton，build/reloadAuth/refreshAfterProviderChange |
| `src/main/llm/kydogAuthBackend.ts` | pi 的 AuthStorageBackend 实现，桥接到 SettingsService |
| `src/main/llm/cloudEnvSync.ts` | Azure/Bedrock/Vertex env 同步（先全清再按当前配置写入 MANAGED_VARS） |
| `src/main/llm/vertexStatus.ts` | Vertex ADC 探针（绕过 pi 缓存；Win/macOS 平台分支） |
| `src/main/llm/cascade.ts` | 移除 provider / 模型清单变化时清理默认值 |
| `src/main/llm/llmService.ts` | `llm.*` IPC 业务（list/configure/setDefault/setThreadOverride/remove/testConnection） |
| `src/main/llm/oauth.ts` | OAuth 协调器（broadcast oauth.* 事件给 renderer） |
| `src/main/agent/sessionFactory.ts` | 走 ProviderRegistry singleton 创建 pi session |
| `src/main/agent/resolveActive.ts` | 解析顺序 helper |
| `src/main/persist/settingsFile.ts` | schema v2 + ensureSettingsFile + v1→v2 reset migration |
| `src/main/settings/settingsService.ts` | proper-lockfile 互斥 + in-process queue |

renderer：

| 文件 | 作用 |
|---|---|
| `src/renderer/stores/llmStore.ts` | catalog / configured / defaultProvider/Model 镜像 |
| `src/renderer/settings/ProviderListSection.tsx` | 已配置列表（点击进 detail；● 设为默认） |
| `src/renderer/settings/AddProviderPage.tsx` | 4 段分组 catalog（推入式整页，不是抽屉） |
| `src/renderer/settings/ProviderDetailPane.tsx` | kind 路由表单（apiKey/oauth/cloud/custom） |
| `src/renderer/settings/forms/ApiKeyForm.tsx` | 14 + 1 个 API key provider；mount 时 prefill key + baseUrl |
| `src/renderer/settings/forms/OAuthForm.tsx` | 4 个纯 OAuth provider（claude/Pro/Max 走 ApiKeyForm 内嵌 OAuth 块） |
| `src/renderer/settings/forms/CloudForm.tsx` | Azure / Bedrock / Vertex 三分支 |
| `src/renderer/settings/forms/CustomProviderForm.tsx` | raw JSON + zod，apiKey 必填 |
| `src/renderer/panels/main-pane/InputPill.tsx` | 显示 effective provider · model；点开二级菜单 |
| `src/renderer/panels/main-pane/InputPillModelMenu.tsx` | 二级菜单切 thread modelOverride |

## 6. 实现偏离 spec 之处

设计稿（agent 内部草稿，仓库内不可见）与代码不一致的地方：

### 6.1 OAuth piProviderId 名字

设计稿用 `claude / codex / gemini-cli / antigravity`。pi-ai 实际暴露 `OAuthProviderId` 是 `anthropic / openai-codex / google-gemini-cli / google-antigravity`。catalog id 与 piProviderId 对齐到 pi-ai 真实名字。**不要按设计稿改回去**——会立刻让 OAuth 全报 `Unknown OAuth provider`。

### 6.2 Claude Pro/Max ↔ Anthropic API key 合并

pi-ai 把 OAuth 和 API key 都存到 `auth['anthropic']` 同一槽（同时只能存一种）。原设计稿分两行 UI 会出现 configured 状态错位。已合并为 1 行：catalog 里 `anthropic` 是 `kind='apiKey'` + 带 `oauth` 字段的混合行。`ApiKeyForm` 检测 `supportsOAuth` 后插一个 OAuth 登录 inline 块。

### 6.3 SettingsService 异步路径加 in-process 队列

`proper-lockfile` 的 sync API 禁止 retries（直接抛错），高并发下 retries 也不够。实现里 async 路径多包了一层 promise 队列把同进程内的 async withLock 串行化，sync 路径单独走 `lockSync`（无 retries）。**已知 edge case**：async 持锁 await 期间 sync 调用会立即 ELOCKED 抛错——KyDog 实际并发不高（pi 同步 auth 调用稀疏），未观察到触发。

### 6.4 ApiKey 输入框反显

为避免「用户改 baseUrl / 默认模型后保存把 key 误删」，表单 mount 时调 `settings.get` 把已存 key 反显进 `apiKey` state，但仍用 `type='password'` 掩盖。代价：key 跑到 renderer 进程内存（key 本来就在磁盘明文，差别不大）。打包发布若需收紧，可用 `app.isPackaged` 在 dev/prod 走不同代码路径。

### 6.5 Add provider 改为整页推入

设计稿是「右侧滑入抽屉」，落地改为整页推入（与 ProviderDetailPane 同节奏）。`uiStore.settingsAddProviderOpen` 路由 list / add / detail 三态互斥。

### 6.6 `setDefault` 同步写 per-provider defaultModel

不只写全局 `defaultProvider/defaultModel`，也同时写 `providers[id].defaultModel`（或 `customProviders[i].defaultModel`）。否则 `entryFor` 解析会落到 `modelIds[0]` fallback，下拉框视觉回弹。

## 7. 改 LLM 相关代码前的 checklist

- [ ] catalog 加新 provider？同时检查 `ApiKeyForm.STATIC_META`（如果是 API key 类）+ pi-ai 是否已内置该 KnownProvider（不然要走 customProviders 走 registerProvider）
- [ ] 写 `settings.llm.auth` / `providers` / `customProviders`？必须配合 §3 表里对应的传播调用，不能少
- [ ] OAuth 新加？`piProviderId` 必须等于 pi-ai `OAuthProviderId`（见 §6.1）
- [ ] Cloud cfg 改动？除了写盘还要 `cloudEnvSync.applyCloudEnv`，否则 process.env 不更新
- [ ] 跑 `npm test -- llmService catalog providerRegistry resolveActive` 看单测；改 UI 跑 `npm run e2e -- 22 23 24 25 26`
