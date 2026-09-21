# LLM Providers

KyDog 用 `@earendil-works/pi-coding-agent` 跑 LLM agent。这份文档只写**从代码里读不出来的东西**：跨文件的传播规则、pi 施加的外部约束、以及已知偏离。具体在哪个文件、函数签名长什么样，自己 grep——那些写进来只会腐化。

---

## 1. 概念模型

一个 **provider** 是一个 LLM 服务接入点（Anthropic、OpenAI、DeepSeek、本地 Ollama、Azure OpenAI ……），有自己的 baseUrl、auth 模式、模型清单。

KyDog 把 provider 分成四种 **kind**，决定它如何 auth、UI 用哪种表单：

| kind | auth 来源 | 例子 |
|---|---|---|
| `oauth` | 浏览器跳转走 OAuth flow，token 存盘 | ChatGPT (Codex)、GitHub Copilot |
| `apiKey` | 用户填一段 secret，明文存盘 | OpenAI、DeepSeek、Mistral、Groq …… |
| `cloud` | Azure/Bedrock/Vertex 各自的凭证机制（profile / SA / IAM keys） | Amazon Bedrock、Google Vertex AI、Azure OpenAI |
| `custom` | 用户填一份 OpenAI-compat JSON 注册自建 provider | 本地 Ollama / vLLM / 自有代理 |

> 特例：Anthropic 是**混合行**——同时支持 OAuth 登录（Claude Pro/Max）和 API key。pi 把两者写到同一个 `auth['anthropic']` 槽，所以 catalog 里只有一行 `anthropic`，detail 表单同时给两条路径。

## 2. 数据落点

所有 provider 状态写到 `~/.kydog/kydog.json`，文件权限强制 `0600`：

```jsonc
{
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

> 文件还有一个 `schemaVersion` 字段，这里刻意不写它的值——当前版本与迁移链以 `src/main/persist/settingsFile.ts` 为准。

字段含义：

- **`auth[id]`**：凭证。一个 id 同时只能有一种 type（pi 的限制，见 §7.2）。
- **`providers[id]`**：内置 provider 的覆盖项——`baseUrl`、`headers`、`cloud`（云 cfg）、`defaultModel`（该 provider 的默认 model）。
- **`customProviders[]`**：用户自建的 OpenAI-compat provider，每条是完整定义。
- **`defaultProvider` / `defaultModel`**：全局默认，Composer 的模型胶囊显示这个组合。
- **`Thread.modelOverride`**（在 `index.json::threads[i]` 上）：单个 thread 覆盖；优先级最高。

写盘走 `atomicWriteWith0600Async/Sync`：temp 文件出生即 0600（设 `mode` flag，不依赖 umask），rename 后再 idempotent `chmod` 一遍。

渲染层看到的模型列表来自 `llm.list`（`LlmConfiguredEntry[]`，`src/main/llm/llmService.ts`）：每个已配置的 provider 一行，除了 `modelIds` 还带一个 `imageInputModelIds` 取自 pi `Model.input` 含 `'image'` 的模型；自定义服务商没写 `input` 的按 `['text']`，与 `providerRegistry.customProviderToPiConfig` 同一个缺省。输入框靠它预先拦下「有图但当前模型不读图」。

## 3. 运行时架构

启动序列在 `src/main/main.ts` 的 ready 回调里，顺序有意义：

```
installProxyDispatcher()   ← 出网路径：跟随系统代理（见下）。必须最早，ready 之后第一件事
ensureSettingsFile()       ← 保证 ~/.kydog/kydog.json 存在 + 0600
applyCloudEnv(providers)   ← 把 cloud cfg 同步进 process.env（必须早于下一步）
initProviderRegistry(svc)  ← 全进程 singleton
installDispatcher() / createWindow()
```

**出网路径**：pi / pi-ai 的所有请求走主进程的全局 `fetch`，而 Node 的 fetch **既不认系统代理、也不认 `HTTP_PROXY` 环境变量**。`src/main/net/systemProxy.ts` 装一个 undici 全局 dispatcher 把这条补上：优先读 `HTTPS_PROXY` / `HTTP_PROXY`（显式意图，终端 / CI 场景），否则每个请求问一次 `session.resolveProxy(origin)`——也就是内置浏览器那套解析器（系统代理 + PAC + bypass）。

所以「LLM 连不上但浏览器能开」这类报障，先看日志里 `scope=net` 那一行：`跟随系统代理设置` / `按环境变量出网` / `经系统代理出网`。位置为什么卡在 ready 的第一行、以及为什么不需要 `undici.install()`，那份文件的头注释里有实测记录。

`ProviderRegistry` 是 main 进程与 pi 之间的唯一桥梁，持有一个 **`ModelRuntime`**（pi 0.80.8 起把 AuthStorage 与 ModelRegistry 合并成了这一个对象，凭据与模型目录同源）。构造它时有两个刻意的选项，改动前先看 `providerRegistry.ts` 里的成段注释：

- **`modelsPath` 指向 `~/.kydog/agent/models.json`**。不传会默认到 `~/.pi/agent/`，等于把已经拆掉的 pi CLI 耦合重建出来。
- **`allowModelNetwork: false`**。打开的话 `create()` 会 await 一次带 15s 预算的远程目录拉取，而它排在建窗口之前——网络被黑洞（强制门户、公司代理）时就是十几秒白屏。远程目录改由构造后一次**不 await** 的后台 `refresh()` 拉。

**为什么必须是 singleton**：`ModelRuntime` 自带内部 cache。每次新建一个就会出现「盘上写了但 pi 不知道」的状态不一致。全进程一份，配合 §5 的显式传播调用，状态才可控。

新 thread 发消息时：`AgentService.ensureSession` → `resolveActive()` 拿 (providerId, modelId) → `sessionFactory` 从 runtime 找到 Model 并创建 pi session → `bound` 记下绑的是哪个 provider/model（§5 的失效判断靠它）。

## 4. 解析顺序

`resolveActive(threadId, projectPath)` 决定 thread 用哪个 provider/model：

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

为什么需要 `providers[id].defaultModel` 这一层（每个 provider 记自己的默认）：用户在设置里给每个 provider 选过默认之后，切 `defaultProvider` 时不应该重置 model——应该用新 provider 自己记着的那个。

## 5. 配置变更如何传播 ★

**这一节是这份文档存在的主要理由。** 写 `settings.llm.*` 只是落盘；不配合下表的传播调用，pi 和 AgentService 会继续用陈旧状态——**不编译报错、不测试失败，只在运行时静默用错**。

| 写了什么 | 必须接着调 |
|---|---|
| `auth[id]`（增/删 API key 或 OAuth token） | `providerRegistry.refreshAfterProviderChange(svc, agentService, [changedIds])` |
| `providers[id]` 或 `customProviders[]` | 同上 |
| `providers[id].cloud`（任何 cloud cfg 改动） | **先** `cloudEnvSync.applyCloudEnv(providers)`，**再**上面那一条 |
| `defaultProvider` 或 `defaultModel` | `agentService.recomputeSessionsAfterDefaultChange()` |
| `thread.modelOverride` | `agentService.invalidateSessionsForThread(threadId)` |
| 移除 provider | `cascade.sweepDefaultsAfterRemove` 清默认值 → 落盘 → `applyCloudEnv` → `refreshAfterProviderChange`；被移除的若正是当前默认，再补一次 `recomputeSessionsAfterDefaultChange()` |

凭证变更之所以也走 `refreshAfterProviderChange`：0.83 之后没有单独的"重读凭证"入口了（旧的 `reloadAuth` 已删除），该方法直接**重建整个 `ModelRuntime`**，凭据随之一起重新读取，并通知 AgentService 失效相关 session。

`AgentService` 的失效语义统一走 `markStaleOrDispose(bound)`：

- thread idle → 立即 `dispose()`，下次发消息时新建 session
- thread running → 打上 `staleAfterRun`，等 pi 的 `agent_end` 之后再 dispose（不打断进行中的回答）

## 6. Cloud providers 的特殊路径

Cloud（Azure / Bedrock / Vertex）的凭证不是简单的 API key——要么走 SDK 的 profile 链，要么走环境变量，而 pi-ai 跟其他 SDK 一样**靠 `process.env` 读取**。所以：

- Cloud cfg 写到 `providers[id].cloud`，**不是** `auth[id]`
- `applyCloudEnv(providers)` 会**先全清** `MANAGED_VARS` 再按当前配置重写 `process.env`。全清这一步是必须的：否则从 IAM keys 切到 profile 时，旧的 `AWS_ACCESS_KEY_ID` 会残留并继续生效
- 启动时调一次，settings 变更时再调一次（见 §5 表）

`MANAGED_VARS` 白名单见 `src/main/llm/cloudEnvSync.ts`。Vertex 的 ADC 检测有自己的探针（`vertexStatus.ts`，win32 / posix 分支），不依赖 pi 的内部缓存。

## 7. 已知约束

### 7.1 OAuth providerId 必须等于 pi-ai 认识的 id

登录时 pi 内部会拿这个 id 查它自己的 OAuth flow 注册表，对不上直接抛 `Unknown OAuth provider`。catalog 里 OAuth 相关行的 `id` 与 `oauth.piProviderId` 必须取自 pi-ai 实际暴露的那一组。

**权威来源**：`node_modules/@earendil-works/pi-ai/dist/auth/oauth/`——目录下每个 provider 一个文件，`load.d.ts` 的 `OAuthFlowLoaders` 类型是完整清单。升级 pi 后务必重新核对：0.83 就删掉了 Gemini CLI 与 Antigravity 两个（`9167a10` 跟的就是这件事）。

### 7.2 一个 auth 槽位只能存一种凭证

pi 的 `auth[providerId]` 同时只能是 `api_key` 或 `oauth`，不能并存。所以 Anthropic 的 OAuth（Claude Pro/Max）与 API key **互斥**——存 API key 会覆盖 OAuth 凭证，反之亦然。`ApiKeyForm` 的 hint 文字提示了这件事。

### 7.3 ApiKey 表单 mount 时反显已存 key

为避免「用户只想改 baseUrl，但 input 为空被当成清空 key」，表单 mount 时主动把已存 key 拉进 input state（`type='password'`，需点「显示」才看明文）。

代价是 key 短暂出现在 renderer 内存。Packaged build 默认禁用 DevTools，分发出去的包不存在用 inspector 读 renderer 内存的路径。

### 7.4 catalog 与 pi 内置 provider 的一致性

catalog 是手维护的静态数据，pi-ai 升级新增/删除 provider 时不会自动同步。`catalogValidator.test.ts` 盯这件事，跟着 `npm test` 走，两个方向的力度不同：

- **catalog 里有、pi 没有 → 直接 fail。** 这是真 bug：用户能在设置里选中它，建 session 时 pi 却找不到。pi 删掉某个我们还在露的 provider 时也在这里炸（0.83 删 Gemini CLI / Antigravity 就是这种情况）。
- **pi 有、catalog 没有 → `console.warn`。** 我们本来就只挑一部分露给用户，所以测试里有一份 `UNSURFACED` 快照记着「刻意没收的那些」，warn 只针对**既不在 catalog、也不在快照里**的新名字。pi 升级后如果报了新名字，做个决定：想收就进 `PROVIDER_CATALOG`，不收就补进 `UNSURFACED`——两种都行，但要显式做过一次。反过来 pi 删掉的名字还留在快照里，也会 warn 提示可以清理。

清单的权威来源是 `@earendil-works/pi-ai/providers/all` 的 `getBuiltinProviders()`，读的是生成出来的静态目录，不联网、可重现。0.83 之前用的 `pi.BUILTIN_PROVIDERS` 已经没有了；那次改名之后测试静默走了跳过分支、绿着但什么都没比较过，所以现在**「拿不到清单」本身也是一条断言**，不再允许跳过。

## 8. 改动前的 checklist

- [ ] catalog 加新 provider？同步检查 `ApiKeyForm` 的静态元数据（API key 类），以及 pi-ai 是否真的内置了该 provider
- [ ] 写了 `settings.llm.*` 的任何字段？对照 §5 的表补上传播调用
- [ ] 加 OAuth provider？`piProviderId` 必须在 §7.1 的权威来源里存在
- [ ] 改了 cloud cfg？除了落盘还要 `applyCloudEnv`，否则 `process.env` 不更新
- [ ] 加/减 catalog 条目？`catalog.test.ts` 是计数测试，要跟着改
- [ ] 升级了 pi？看 `catalogValidator.test.ts` 有没有 warn 出新 provider（§7.4）
- [ ] 跑：`npm test -- llmService catalog providerRegistry resolveActive`
- [ ] 改了 UI 再跑：`npm run e2e -- 22 23 24 25 26`（e2e 前先 `npm run package`）

## 9. 外部参考

- pi-coding-agent 官方文档（完整一套）：`node_modules/@earendil-works/pi-coding-agent/docs/`，SDK 编程接口看其中的 `sdk.md`，自定义 provider / model 看 `models.md` 与 `providers.md`
- pi 官方 SDK 示例：`node_modules/@earendil-works/pi-coding-agent/examples/sdk/`
- pi-ai OAuth provider 清单（权威）：`node_modules/@earendil-works/pi-ai/dist/auth/oauth/`
- pi-ai env 变量映射：`node_modules/@earendil-works/pi-ai/dist/env-api-keys.js` 的 `getApiKeyEnvVars`

> 干净 checkout 下 `node_modules/` 不存在，上面这些路径要先 `npm install` 才有。
