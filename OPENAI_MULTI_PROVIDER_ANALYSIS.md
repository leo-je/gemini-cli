# 需求分析：OpenAI 模式下支持多个 API 提供者

> 状态：**分析稿，尚未实现**。本文只做需求澄清与方案对比，未改动任何生产代码。
> 关联文档：[`README_OPENAI.md`](./README_OPENAI.md)（现有单端点 OpenAI 兼容模式）。

## 一、当前实现的事实基线（已核对代码）

| 维度 | 现状 |
| :--- | :--- |
| 配置来源 | 纯环境变量，无配置文件、无 UI 持久化结构（`GEMINI_OPENAI_BASE_URL / _API_KEY / _MODELID / _HEADERS`） |
| 数量模型 | **单端点**：一个 baseUrl、一个 key、一份 headers，进程级唯一 |
| 数据载体 | `ContentGeneratorConfig { apiKey, baseUrl, customHeaders }`（`packages/core/src/core/contentGenerator.ts`） |
| 工厂分支 | `createContentGenerator` 里 `authType === USE_OPENAI` → `new OpenAIContentGenerator(config, gcConfig)` |
| 模型选择 | `resolveModelId()` **已经**优先 `gcConfig.getActiveModel()`，env 只做默认值——`/model set` 已经能切换模型 |
| 模型发现 | `/model list` 已实现实时 `GET /models`（`openAiClient.listModels` + `OpenAiModelDialog`） |
| 首次运行 | `useAuth.ts` 检测到未配置 → `AuthState.AwaitingOpenAiEndpoint` → `OpenAiEndpointDialog` 收集后写 `~/.gemini/.env`（0600） |
| 认证优先级 | `enforcedType` > `GEMINI_API_TYPE=openai` > `selectedType` > env 探测 |

**关键结论：代码里已经存在「端点即一个配置对象」的雏形，只是没有名字、没有集合、没有切换入口。**

## 二、需求真正要解决的问题（需要澄清的部分）

「支持多个 API 提供者」有三种语义强度截然不同的解读，选择不同则工作量差一个数量级：

| 解读 | 含义 | 现状是否已满足 |
| :--- | :--- | :--- |
| **A. 配置多个，重启切换** | 保存多份 profile，用环境变量/CLI 参数选用其中一个 | ❌ 需要新增配置层 |
| **B. 会话内热切换** | `/provider` 命令在不动进程的情况下换端点 + key + 模型 | ❌ 需要重建 ContentGenerator 链路 |
| **C. 多 provider 并存/路由** | 不同任务（主对话/子代理/压缩/embedding）走不同 provider；或失败自动降级到下一个 | ❌ 架构级改动，且与现有 fallback 设计冲突 |

同时还有一组必须定的边界问题：

1. **是否要跨认证类型？** 是「多个 OpenAI 兼容端点」（OpenRouter + Ollama + Azure），还是「OpenAI 与 Gemini 之间也能切」（后者需要动 `AuthType` 与 `getExplicitAuthType` 的语义，冲突面大得多）。
2. **key 存哪里？** 这是最硬的约束，见下节。
3. **provider 与 model 的关系？** model 归属 provider（切 provider 必须换 model），还是全局 model 列表？

## 三、最硬的约束：凭据存储与信任边界

这是需求里最容易被低估、也最容易做错的地方：

- 上游 `GEMINI_CLI_CUSTOM_HEADERS` 在 OpenAI 模式下**不生效**，适配器的 header 只来自 `GEMINI_OPENAI_HEADERS`；`AUTH_ENV_VAR_WHITELIST` 只放行 `GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION`，所以任何含 key 的变量写在工作区 `.env` 里会被**静默丢弃**（不受信任工作区）。
- 现有端点持久化刻意写到**用户级** `~/.gemini/.env`（0600），因为 `loadEnvironment` 只读它找到的第一个 `.env`。
- 因此：如果多 provider 的 key 存进 `settings.json` 或工作区文件，就是把凭据塞进了会被提交 / 被信任检查过滤的位置——**必须显式决策**。可选方案：
  - 沿用 env 文件（`GEMINI_OPENAI_<PROFILE>_API_KEY`）；
  - 或新增 keychain 存储（`loadApiKey` 已有先例，但 Linux 无 Secret Service 时会阻塞，现有 OpenAI 分支刻意绕开了它）。

## 四、架构改动点（按方案 B 估算）

```
新增：core/src/core/openai/providers.ts
  ├─ OpenAiProviderProfile { id, label, baseUrl, apiKeyEnv, modelId, headers }
  ├─ resolveActiveProvider()  ← 解析 GEMINI_OPENAI_PROVIDER / 默认第一个
  └─ 复用 readEnvWithFallback，保持旧变量可用（单 provider 时行为不变）

改：contentGenerator.ts createContentGeneratorConfig
  └─ USE_OPENAI 分支改为按 profile 填充 apiKey / baseUrl / customHeaders

改：config.ts refreshAuth
  └─ setModel(profile.modelId)，并记住「当前 profile」

改：新增 ui/commands/provider（/provider list|use）+ 复用 OpenAiModelDialog
  └─ 热切换需重建 generator：config.refreshAuth(USE_OPENAI) 已存在这条路径
```

改动量评估：

- **方案 A 约 300–400 行 + 测试**（纯新增为主，仍是「可摘除」的形态）；
- **方案 B 需再处理 chat 历史 / 缓存失效**（换模型后 `geminiChat` 的上下文要继续可用，现有 `setModel` 是 `isTemporary` 语义，需要确认 session 复用边界）。

## 五、风险与冲突点

1. **与上游合并**：`contentGenerator.ts` 的 `getAuthTypeFromEnv()` 和 `createContentGeneratorConfig()` 是既有高危冲突点（`README_OPENAI.md` 已标注）。多 provider 应尽量落在**新增文件**里，工厂只加一层「解析 profile → 填 config」。
2. **`isGeminiModelName()` 启发式**：切 profile 后模型名可能是 `gpt-4o` / `qwen2.5`，该函数是安全网但也会拒绝 `gemma-*` 之外的自定义 Gemini 名。多 profile 下模型名空间更杂，需要重新审视这条规则。
3. **遥测与显示**：`loggingContentGenerator.getEndpoint()` 的 OpenAI 分支现在从 `config.baseUrl` 取 host。多 profile 后必须继续上报**当前生效端点**，否则遥测会把请求记到错误的 provider 上。
4. **`countTokens` 本地估算 / embedding 模型**：多 provider 下 embedding 可能需要独立端点（当前 `embedContent` 只透传模型名，不换 baseUrl），这是能力缺口而非配置缺口。
5. **回退链**：OpenAI 模式下 `handleFallback()` 直接 `return null`。方案 C 的「自动降级到下一个 provider」需要重新打开这条逻辑，属于新功能而非配置扩展。

## 六、建议

**推荐分期：先做方案 A，把数据模型立住，再决定是否上 B。**

- **Phase 1（配置层）**：定义 `OpenAiProviderProfile`，支持 `GEMINI_OPENAI_PROVIDER` 选择 + `GEMINI_OPENAI_PROVIDERS`（JSON，或按 `<ID>_BASE_URL` 约定展开），key 沿用用户级 `.env`。**单 provider 时与现有行为完全兼容**，旧变量作为 profile-less 的降级路径继续有效。
- **Phase 2（交互层）**：`/provider` 命令（list / use / add）+ 扩展现有 `OpenAiEndpointDialog` 收集 profile 名。
- **Phase 3（评估后再定）**：会话内热切换、跨认证类型切换、按任务路由。

**需要先拍板的三个问题：**

1. 目标是 A / B / C 哪个强度？
2. 只覆盖 OpenAI 兼容端点，还是也要覆盖 Gemini / Vertex？
3. Provider 的 key 存 `.env`（简单但明文）还是 keychain（安全但 Linux 有阻塞历史）？
