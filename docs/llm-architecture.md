# LLM Providers

KyDog 用 [`@earendil-works/pi-coding-agent`][pi] 跑 LLM agent。这份文档说明 provider/model 这层是怎么组织的、为什么这么组织、改动它要做什么。

[pi]: ../docs/references/pi-coding-agent/sdk.md

---

## 1. 概念模型

一个 **provider** 是一个 LLM 服务接入点（Anthropic、OpenAI、DeepSeek、本地 Ollama、Azure OpenAI ……），有自己的 baseUrl、auth 模式、模型清单。

KyDog 把 provider 分成四种 **kind**，决定它如何 auth、UI 用哪种表单：

| kind | auth 来源 | 例子 |
|---|---|---|
| `oauth` | 浏览器跳转走 OAuth flow，token 存盘 | ChatGPT (Codex)、GitHub Copilot、Gemini CLI、Google Antigravity |
| `apiKey` | 用户填一段 secret，明文存盘 | OpenAI、DeepSeek、Mistral、Groq …… |
| `cloud` | Azure/Bedrock/Vertex 各自的凭证机制（profile / SA / IAM keys） | Amazon Bedrock、Google Vertex AI、Azure OpenAI |
| `custom` | 用户填一份 OpenAI-compat JSON 注册自建 provider | 本地 Ollama / vLLM / 自有代理 |

> 特例：Anthropic 是 **混合行**——同时支持 OAuth 登录（Claude Pro/Max）和 API key。pi-ai 把两者写到同一个 `auth['anthropic']` 槽，所以 KyDog catalog 里只有一行 `anthropic`，detail 表单同时给两条路径。

## 2. 数据落点

所有 provider 状态写到 `~/.kydog/kydog.json`，文件权限强制 `0600`：

```jsonc
{
  "schemaVersion": 2,
  "llm": {
    "auth": {
      "anthropic": { "type": "api_key", "key": "sk-ant-…" },
      "openai-codex": { "type": "oauth", "refresh": "…", "access": "…", "expires": 1234 }
    },
    "providers": {
      "anthropic": { "baseUrl": "https://api.anthropic.com", "defaultModel": "claude-sonnet-4-5" },
      "amazon-bedrock": { "cloud": { "kind": "bedrock", "authMode": "profile", "awsProfile": "me", "region": "us-east-1" } }
    },
    "customProviders": [
      {
        "id": "ollama-local", "displayName": "Ollama", "baseUrl": "http://localhost:11434/v1",
        "api": "openai-completions", "apiKey": "ollama",
        "models": [{ "id": "llama3.1:8b" }],
        "defaultModel": "llama3.1:8b"
      }
    ],
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-5"
  }
}
```

字段含义：

- **`auth[id]`**：凭证。一个 id 同时只能有一种 type（pi 的限制）。
- **`providers[id]`**：内置 provider 的覆盖项——`baseUrl`、`headers`、`cloud`（云 cfg）、`defaultModel`（该 provider 的默认 model）。
- **`customProviders[]`**：用户自建的 OpenAI-compat provider，每条是完整定义。
- **`defaultProvider` / `defaultModel`**：全局默认，InputPill 显示这个组合。
- **`Thread.modelOverride`**（在 `index.json::threads[i]` 上）：单个 thread 覆盖；优先级最高。

写盘走 `atomicWriteWith0600Async/Sync`：`temp` 文件出生即 0600（设 `mode` flag，不依赖 umask），rename 后再 idempotent `chmod` 一遍。

## 3. 运行时架构

启动序列（`src/main/main.ts::app.on('ready')`）：

```
ensureSettingsFile()            ← 保证 ~/.kydog/kydog.json 存在 + 0600
applyCloudEnv(providers)        ← 把 cloud cfg 同步进 process.env
initProviderRegistry(svc)       ← 全进程 singleton；持唯一 AuthStorage + ModelRegistry
```

`ProviderRegistry` 是 main 进程的桥梁：

- `authStorage` = `pi.AuthStorage.fromStorage(KydogAuthStorageBackend(SettingsService))`
  - pi 把 auth blob 当一段 JSON 字符串读写；我们的 backend 把它桥接到 `kydog.json::llm.auth`
- `modelRegistry` = `pi.ModelRegistry.inMemory(authStorage)`
  - 启动时把 `customProviders` 一一 `registerProvider` 进去
  - `providers[id]` 里的 `baseUrl/headers` 覆盖通过同一个 `registerProvider` 接入

新 thread 发消息时：

```
AgentService.ensureSession(threadId, projectPath)
  → resolveActive() 拿 (providerId, modelId)
  → sessionFactory.createSession({ ... providerId, modelId })
      → modelRegistry.find(providerId, modelId)        ← 找 Model 对象
      → pi.createAgentSession({ authStorage, modelRegistry, model, ... })
  → bound = { session, providerId, modelId, ... }       ← 记下绑哪个 model
```

为什么 `ProviderRegistry` 是 singleton：pi 的 `AuthStorage` 实例本身有内部 `data` cache。如果每次新建一个 `AuthStorage`，就会出现「写盘了但 pi 不知道」的状态不一致。全进程一份，配合显式 `reload()` / 重建 `modelRegistry`，状态可控。

## 4. 解析顺序

`resolveActive(threadId, _projectPath)` 决定 thread 用哪个 provider/model：

```
providerId =
  thread.modelOverride?.providerId
  ?? settings.llm.defaultProvider
  ?? throw ResolveError('no-provider')

modelId =
  thread.modelOverride?.modelId
  ?? settings.llm.providers[providerId]?.defaultModel
  ?? settings.llm.customProviders.find(cp => cp.id === providerId)?.defaultModel
  ?? settings.llm.defaultModel
  ?? throw ResolveError('no-model')
```

为什么需要 `providers[id].defaultModel`（每个 provider 有自己的默认）：用户在 settings 给每个 provider 选了一个 default 之后，切 `defaultProvider` 时 InputPill 不应该重置 model——它应该用新 provider 自己记着的那个。

## 5. 配置变更如何传播

任何写 `settings.llm.*` 的代码必须配合下表里对应的传播调用，否则 pi/AgentService 还在用陈旧状态：

| 写了什么 | 必须接着调 |
|---|---|
| `auth[id]`（增/删 key 或 OAuth token） | `providerRegistry.reloadAuth()` |
| `providers[id]` 或 `customProviders[]` | `providerRegistry.refreshAfterProviderChange(svc, agentService, [changedIds])` |
| `defaultProvider` 或 `defaultModel` | `agentService.recomputeSessionsAfterDefaultChange()` |
| `thread.modelOverride` | `agentService.invalidateSessionsForThread(threadId)` |
| `providers[id].cloud`（任何 cloud cfg 改动） | 上一行 + `cloudEnvSync.applyCloudEnv(providers)`（同步 process.env） |

`AgentService` 的失效语义统一走 `markStaleOrDispose(bound)`：

- thread idle → 立即 `dispose()`，下次发消息时新建 session
- thread running → `bound.staleAfterRun = true`，等 pi 的 `agent_end` 事件后再 dispose（避免打断进行中的回答）

`reloadAuth` 与 `refreshAfterProviderChange` 的区别：

- `reloadAuth()` 让 pi 的 AuthStorage 重新从我们的 backend 读一遍（凭证类变更）
- `refreshAfterProviderChange(...)` 重建整个 ModelRegistry（baseUrl / 模型清单 / 自定义 provider 类变更），并通知 AgentService 失效相关 session

## 6. Cloud providers 的特殊路径

Cloud（Azure / Bedrock / Vertex）的凭证机制不是简单的 API key——它们要么走 SDK 的 profile 链，要么走环境变量。pi-ai 跟其他 SDK 一样，**靠 `process.env` 读取**这些凭证。所以：

- Cloud cfg 写到 `providers[id].cloud`（而不是 `auth[id]`）
- `cloudEnvSync.applyCloudEnv(providers)` 把当前所有 cloud cfg **先全清** `MANAGED_VARS` 再按当前配置写进 `process.env`
- 启动时调一次（main.ts），settings 变更时再调一次（llmService.configure 内）
- 这样切换 authMode 时（如 Bedrock 从 IAM keys 改成 profile）旧的 `AWS_ACCESS_KEY_ID` 不会残留

`MANAGED_VARS` 列表见 `src/main/llm/cloudEnvSync.ts`。

Vertex 的 ADC 检测有自己的探针（`vertexStatus.ts`，平台分支 win32 vs posix），不依赖 pi 的内部缓存。

## 7. 加一个新 provider

### 内置 (catalog) provider，pi-ai 已支持

例：DeepSeek、Mistral 这种 pi-ai 的 `KnownProvider`。

1. 在 `src/main/llm/catalog.ts::PROVIDER_CATALOG` 加一行
2. 如果是 API key 类，往 `src/renderer/settings/forms/ApiKeyForm.tsx::STATIC_META` 加 `envFallback / baseUrlOverridable`
3. 跑 `npm test -- catalog` 更新计数测试

不用改 pi 或 ProviderRegistry——pi-ai 内置的 provider 它自己已经知道 baseUrl + 模型清单。

### 内置 provider，pi-ai 没支持

需要先升 pi-ai；不行的话走自定义路径。

### 用户自定义 provider

走 `customProviders[]` 路径，UI 表单是 `CustomProviderForm.tsx`。raw JSON + zod 校验，apiKey 字段必填（pi 要求；本地 LLM 可填占位字符串如 `'ollama'`）。

## 8. 已知约束

### 8.1 OAuth providerId 必须等于 pi-ai 的内置 `OAuthProviderId`

调 `authStorage.login(piProviderId, callbacks)` 时，pi 内部会查 OAuth provider 注册表。pi-ai 当前暴露的 5 个 OAuth provider：

- `anthropic` （Claude Pro/Max）
- `openai-codex` （ChatGPT Codex）
- `github-copilot`
- `google-gemini-cli`
- `google-antigravity`

catalog 里 OAuth 相关 provider 的 `id` 与 `oauth.piProviderId` 必须取自这个列表。改名会导致 `Unknown OAuth provider` 抛错。pi-ai 升级时记得验证这个列表是否变更（看 `node_modules/@earendil-works/pi-ai/dist/utils/oauth/index.d.ts`）。

### 8.2 一个 auth 槽位只能存一种凭证

pi 的 `auth[providerId]` 同时只能是 `{type: 'api_key', ...}` 或 `{type: 'oauth', ...}`，不能两者并存。所以 Anthropic 的 OAuth (Claude Pro/Max) 与 API key 互斥——保存 API key 会覆盖 OAuth 凭证、反之亦然。`ApiKeyForm` 的 hint 文字提示了这件事。

### 8.3 ApiKey 表单 mount 时反显已存 key

为避免「用户开表单只想改 baseUrl，但因为 input 为空被当作清空 key」，表单 mount 时主动 `settings.get` 把已存 key 拉到 input state（`type='password'` 掩盖，需点「显示」才看明文）。

代价：key 短暂出现在 renderer 进程内存。Packaged build 默认禁用 DevTools（`main.ts` 里 `if (!app.isPackaged) openDevTools(...)`），分发的 .app 不存在 inspector 把 renderer 内存暴露的路径。

### 8.4 SettingsService 的 sync/async 锁

`proper-lockfile` 的 sync API 不支持 retries。我们的 async 路径走 in-process promise queue 把同进程并发串行化，sync 路径只走单次 `lockSync`。理论上 async 持锁 await 期间收到 sync 调用会立即 `ELOCKED` 抛错——实际并发模型下没观察到（pi 的 sync auth 写入是稀疏事件，不与 IPC 设置写入并发）。

### 8.5 catalog 与 pi-ai 的 BUILTIN_PROVIDERS

KyDog 的 catalog 是手维护的静态数据。pi-ai 升级新 provider 时不会自动出现在 catalog 里——`catalogValidator.test.ts` 是个 informational drift check，会 `console.warn` 提示但不 fail，跑测试时留意输出。

## 9. 文件索引

### main 进程

| 文件 | 作用 |
|---|---|
| `src/main/llm/catalog.ts` | builtin provider 静态数据（kind / group / piProviderId / envFallback / cloudCfgKind） |
| `src/main/llm/providerRegistry.ts` | singleton，build / reloadAuth / refreshAfterProviderChange |
| `src/main/llm/kydogAuthBackend.ts` | pi 的 `AuthStorageBackend` 实现，桥接到 `SettingsService` |
| `src/main/llm/cloudEnvSync.ts` | Azure/Bedrock/Vertex env 同步；`MANAGED_VARS` 白名单 |
| `src/main/llm/vertexStatus.ts` | Vertex ADC 探针（平台分支） |
| `src/main/llm/cascade.ts` | 移除 provider / 模型清单变化时清理默认值 |
| `src/main/llm/llmService.ts` | `llm.*` IPC 业务逻辑 |
| `src/main/llm/oauth.ts` | OAuth 协调器（broadcast `oauth.*` 事件给 renderer） |
| `src/main/agent/sessionFactory.ts` | 走 ProviderRegistry singleton 创建 pi session |
| `src/main/agent/resolveActive.ts` | (provider, model) 解析 helper |
| `src/main/persist/settingsFile.ts` | schema v2 + ensureSettingsFile + v1→v2 migration |
| `src/main/settings/settingsService.ts` | proper-lockfile 互斥 + in-process queue |

### renderer

| 文件 | 作用 |
|---|---|
| `src/renderer/stores/llmStore.ts` | catalog / configured / defaultProvider/Model 镜像 |
| `src/renderer/settings/ProviderListSection.tsx` | 已配置列表（点击进 detail；● 设为默认） |
| `src/renderer/settings/AddProviderPage.tsx` | 4 段分组 catalog（推入式整页） |
| `src/renderer/settings/ProviderDetailPane.tsx` | kind 路由表单 |
| `src/renderer/settings/forms/ApiKeyForm.tsx` | 15 个 API key provider；`anthropic` 行额外内嵌 OAuth 登录块 |
| `src/renderer/settings/forms/OAuthForm.tsx` | 4 个纯 OAuth provider |
| `src/renderer/settings/forms/CloudForm.tsx` | Azure / Bedrock / Vertex 三分支 |
| `src/renderer/settings/forms/CustomProviderForm.tsx` | raw JSON + zod，apiKey 必填 |
| `src/renderer/panels/main-pane/InputPill.tsx` | 显示 effective provider · model |
| `src/renderer/panels/main-pane/InputPillModelMenu.tsx` | 二级菜单切 thread modelOverride |

## 10. 改动前的 checklist

- [ ] catalog 加新 provider？同步检查 `ApiKeyForm.STATIC_META`（API key 类）+ pi-ai 是否已内置该 KnownProvider
- [ ] 写 `settings.llm.{auth, providers, customProviders, defaultProvider, defaultModel}`？必须配合 §5 表里对应的传播调用
- [ ] 加 OAuth provider？`piProviderId` 必须等于 pi-ai 真实暴露的 `OAuthProviderId`（见 §8.1）
- [ ] Cloud cfg 改动？除了写盘还要 `cloudEnvSync.applyCloudEnv`，否则 `process.env` 不更新
- [ ] 改完跑：`npm test -- llmService catalog providerRegistry resolveActive`；改 UI 还要跑 `npm run e2e -- 22 23 24 25 26`

## 11. 外部参考

- pi-coding-agent SDK 总览：`docs/references/pi-coding-agent/sdk.md`
- pi-coding-agent 自定义 provider / model：`docs/references/pi-coding-agent/models.md`、`providers.md`
- pi-ai OAuth provider 列表（权威）：`node_modules/@earendil-works/pi-ai/dist/utils/oauth/index.d.ts`
- pi-ai env 变量映射：`node_modules/@earendil-works/pi-ai/dist/env-api-keys.js`（`getApiKeyEnvVars`）
