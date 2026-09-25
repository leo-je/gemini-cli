# OpenAI API 兼容模式

Gemini CLI 支持把请求转发到任意实现了 OpenAI Chat
Completions 协议的端点。开启方式是设置
`GEMINI_API_TYPE=openai`，之后流式响应、工具调用、图片和 token 用量统计都会走该端点，而 CLI 的其余部分（工具系统、上下文管理、UI）完全不需要改动。

这项能力是围绕"最小侵入"设计的：协议翻译代码全部集中在
`packages/core/src/core/openai/`，对原有代码只做定点注入，因此与上游同步时的冲突面很小。

---

## 快速开始

四个环境变量：

```bash
export GEMINI_API_TYPE="openai"                   # 模式开关，必须精确等于 openai
export GEMINI_OPENAI_BASE_URL="https://api.example.com/v1"
export GEMINI_OPENAI_API_KEY="YOUR_API_KEY"       # 本地服务可省略
export GEMINI_OPENAI_MODELID="gpt-4o"
```

然后正常运行：

```bash
gemini -p "Say hello"
```

不需要在认证对话框里做任何选择——`GEMINI_API_TYPE=openai` 会直接选中 **OpenAI API
(compatible)** 并跳过对话框。

### 本地服务示例

指向 Ollama、vLLM、LM Studio 等本地服务时不需要 API key：

```bash
export GEMINI_API_TYPE="openai"
export GEMINI_OPENAI_BASE_URL="http://localhost:11434/v1"
export GEMINI_OPENAI_MODELID="qwen2.5-coder:14b"
```

---

## 环境变量

| 变量                     | 必需 | 说明                                                                                            |
| :----------------------- | :--- | :---------------------------------------------------------------------------------------------- |
| `GEMINI_API_TYPE`        | 是   | 模式开关。**区分大小写**，必须精确等于 `openai`。`OpenAI`、`openai `（带空格）都不会生效。      |
| `GEMINI_OPENAI_BASE_URL` | 是   | 端点根地址。URL 没有路径时会自动补 `/v1`；已有路径则原样使用，所以需要 `/v1` 的端点请自己写全。 |
| `GEMINI_OPENAI_API_KEY`  | 否   | 以 `Authorization: Bearer` 头发送。为空时不发送该头，适用于无鉴权的本地服务。                   |
| `GEMINI_OPENAI_MODELID`  | 是   | 发给端点的模型名。**这是唯一权威来源，`--model` 和 `GEMINI_MODEL` 在此模式下无效。**            |

### `export` 与 `.env` 的优先级

两种方式都可以，但优先级不同：

1. **`export` 的变量优先。** `.env` 只在 `process.env`
   中不存在同名键时才写入（`packages/cli/src/config/settings.ts`），永不覆盖已导出的变量。
2. **`~/.gemini/.env` 仅在工作区受信任时加载。**
   不受信任的目录下它会被完全跳过。需要在不受信任目录里使用，可设
   `GEMINI_CLI_TRUST_WORKSPACE=true`，或直接用 `export`。
3. **不受信任工作区中的项目级 `.env` 会被白名单过滤。** `AUTH_ENV_VAR_WHITELIST`
   当前只放行 `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_CLOUD_PROJECT`、
   `GOOGLE_CLOUD_LOCATION`，因此上表四个变量写在工作区 `.env`
   里会被静默丢弃。改动该白名单涉及安全边界，需谨慎评估。

> 最稳妥的做法是 `export` 或写 `~/.gemini/.env`，两者都不受白名单限制。

### 认证类型优先级

从高到低：

1. `security.auth.enforcedType` —— 管理员的强制策略，**开关也无法绕过**
2. `GEMINI_API_TYPE=openai`
3. `security.auth.selectedType`（settings.json 中保存的选择）
4. 环境变量自动探测（`GEMINI_API_KEY`、`GOOGLE_GENAI_USE_VERTEXAI` 等）

也就是说开启开关会覆盖 settings.json 里已保存的认证方式，但覆盖不了强制策略：若
`enforcedType`
被设为其它值，CLI 会照常报错退出。这是刻意的——开关是用户偏好，不是绕过管理员策略的手段。

---

## 工作原理

CLI 对模型的所有调用都收敛在单一接口 `ContentGenerator`
上，因此只需在工厂函数里增加一条分支：

```
geminiChat / baseLlmClient / contextManager / summarizer
                    │  只依赖这个接口
                    ▼
        ContentGenerator { generateContent / generateContentStream
                           countTokens / embedContent }
                    ▲
        createContentGenerator(config, gcConfig)   ← 唯一分叉点
                    │
                    ├── CodeAssist（Google 登录 / ADC）
                    ├── GoogleGenAI（Gemini API key / Vertex / Gateway）
                    └── OpenAIContentGenerator          ← 新增
```

### 模块结构

| 文件                        |     行数 | 职责                                                       |
| :-------------------------- | -------: | :--------------------------------------------------------- |
| `constants.ts`              |       36 | 环境变量名与 `readEnvValue`。**零 import**，避免循环依赖。 |
| `types.ts`                  |      148 | OpenAI 协议的最小类型集，不引入第三方 SDK。                |
| `converters.ts`             |      657 | Gemini ⇄ OpenAI 双向转换（纯函数，可无网络测试）。         |
| `openaiClient.ts`           |      438 | 原生 `fetch` + 手写 SSE 解析、代理与超时策略、压缩体解码。 |
| `openaiContentGenerator.ts` |      298 | `ContentGenerator` 实现与流式响应重组。                    |
| `index.ts`                  |       19 | 对外导出。                                                 |
| 合计                        | **1596** | 另有 1373 行测试。                                         |

### 注入点

对新代码之外的改动共 21 个文件：生产代码 13 个文件（+192 /
−21），测试 8 个文件（+352）。全部是定点注入：

| 文件                                       | 改动                                                                             |
| :----------------------------------------- | :------------------------------------------------------------------------------- |
| `core/src/core/contentGenerator.ts`        | `AuthType.USE_OPENAI` 枚举、`getAuthTypeFromEnv`、认证类型解析函数、两个工厂分支 |
| `core/src/config/config.ts`                | OpenAI 模式下把 `config.model` 固定为 `GEMINI_OPENAI_MODELID`                    |
| `core/src/fallback/handler.ts`             | OpenAI 模式下禁用 Gemini 回退链                                                  |
| `core/src/core/loggingContentGenerator.ts` | 遥测上报真实端点而非 Gemini 默认端点                                             |
| `core/src/index.ts`                        | 导出新模块                                                                       |
| `cli/src/config/auth.ts`                   | 校验 `BASE_URL` 与 `MODELID`（API key 可空）                                     |
| `cli/src/config/settingsSchema.ts`         | `security.auth.*` 的合法取值描述（文档由它生成）                                 |
| `cli/src/validateNonInterActiveAuth.ts`    | 认证类型解析                                                                     |
| `cli/src/core/initializer.ts`              | 启动鉴权与是否弹出认证对话框                                                     |
| `cli/src/ui/auth/useAuth.ts`               | 交互模式自动认证                                                                 |
| `cli/src/ui/auth/AuthDialog.tsx`           | 菜单项与默认选中                                                                 |
| `cli/src/gemini.tsx`                       | `--list-sessions` 的尽力鉴权                                                     |
| `cli/src/acp/acpSessionManager.ts`         | ACP 会话的两处认证类型解析                                                       |

### 请求路径

```
geminiChat 传入 Gemini 格式的 GenerateContentParameters
        │  converters.toOpenAIMessages() / toOpenAITools()
        ▼
POST {BASE_URL}/chat/completions   (stream: true, stream_options.include_usage)
        │  SSE 解析 + 工具调用增量组装
        ▼
   new GenerateContentResponse()   ← 必须是 SDK 类实例
```

最后一步的细节很关键：`functionCalls` 和 `text` 是 `@google/genai` 类上的
**原型 getter**，纯对象字面量取不到值，必须实例化后逐字段赋值。

---

## 协议转换

### 请求：Gemini → OpenAI

| Gemini part                 | 转换结果                               | 说明                                  |
| :-------------------------- | :------------------------------------- | :------------------------------------ |
| `{text}`                    | `content` 文本                         | 相邻文本合并                          |
| `{text, thought:true}`      | **丢弃**                               | Gemini 专有                           |
| `thoughtSignature`          | 丢弃                                   | Gemini 专有                           |
| `{functionCall}`            | `assistant.tool_calls[]`               | `arguments` 为 `JSON.stringify(args)` |
| `{functionResponse}`        | `{role:"tool", tool_call_id, content}` | 必须独立成条消息                      |
| `{inlineData}`（`image/*`） | `image_url` data URI                   |                                       |
| `{inlineData}`（其它类型）  | **丢弃并告警**                         | Chat Completions 无对应槽位           |
| `{fileData}`                | **丢弃并告警**                         |                                       |

其它映射：

- 角色：`user`→`user`，`model`→`assistant`
- `systemInstruction` → 首条 `system` 消息（推理模型用 `developer`）
- 工具声明取 `parametersJsonSchema`，并清洗 OpenAI 不接受的关键字（`$schema`
  等），大写 `Type` 枚举值统一转小写
- `toolConfig.functionCallingConfig.mode`：`AUTO`/`VALIDATED`→`auto`，
  `ANY`→`required`（单一允许项时用具名 `tool_choice`），`NONE`→`none`
- `temperature`、`topP`、`maxOutputTokens`、`stopSequences` 直通
- `responseMimeType: "application/json"` →
  `response_format: {type:"json_object"}`

### 响应：OpenAI → Gemini

| OpenAI                                  | 转换结果                                             |
| :-------------------------------------- | :--------------------------------------------------- |
| `delta.content`                         | `parts:[{text}]`，实时透传                           |
| `delta.reasoning_content` / `reasoning` | `parts:[{text, thought:true}]`                       |
| `delta.tool_calls[]`                    | 缓冲聚合，**单次发出**                               |
| `finish_reason: stop`                   | `FinishReason.STOP`                                  |
| `finish_reason: tool_calls`             | `FinishReason.STOP`                                  |
| `finish_reason: length`                 | `FinishReason.MAX_TOKENS`                            |
| `finish_reason: content_filter`         | `FinishReason.SAFETY`                                |
| `usage`                                 | `usageMetadata`（需 `stream_options.include_usage`） |

### 三条必须守住的契约

这三条都是从 `geminiChat` 的消费逻辑反推出来的，破坏任何一条都会静默产生脏数据：

1. **流末尾必须有一个带 `finishReason` 的 chunk。** 否则 `geminiChat` 抛
   `NO_FINISH_REASON`。端点完全没给 `finish_reason` 时，在已有输出的前提下合成
   `STOP`；完全空流仍然照常报错，不会被伪装成"成功但空回复"。
2. **每个 `functionCall` 只能出现在一个 chunk 里。** `geminiChat` 对
   `chunk.functionCalls`
   是无条件累加的，重复发出会让同一个调用在历史里出现两次。因此工具调用一律缓冲到流结束、聚合完整参数后一次性发出。
3. **工具调用必须急切发起。** HTTP 请求在 `generateContentStream()`
   调用时就发出，而不是等到迭代生成器时才发——否则 429/5xx 会绕过
   `retryWithBackoff`，重试机制完全失效。

---

## 行为与限制

### 模型

- `GEMINI_OPENAI_MODELID` 是唯一权威来源，`--model` 与 `GEMINI_MODEL`
  无效。CLI 内部仍以 Gemini 模型名推理（默认 `auto`），放行会把 `auto`
  发给端点。
- 推理模型（`o1`、`o3`、`o4`、`gpt-5` 前缀）自动改用 `developer` 角色，并剥离
  `temperature` / `top_p`——这些模型不接受采样参数。

### 网络

- 使用原生 `fetch`，不走 `utils/fetch.ts`
  的 SSRF 防护。该防护会 fail-closed 拦截所有本地与内网地址，而本地端点是本功能最主要的场景之一。
- **回环地址自动绕过代理。** `HTTPS_PROXY`
  在开发机上很常见（Clash、Charles、企业网关），把它应用到 `localhost`
  会让每个请求都失败。`localhost`、`127.0.0.1`、 `::1`
  一律直连，其余地址照常走代理。
- 超时：等待响应头 60 秒；流式空闲 300 秒（与 `utils/fetch.ts` 的默认值一致）。
- **压缩体自行解码。** `fetch` 本应依据 `Content-Encoding`
  自动解压，但该头在代理 dispatcher 路径上会丢失，于是 Cloudflare 前置的报错会以**原始 gzip 字节**到达，把一条本可读的
  `403: 模型不可用` 变成乱码。`openaiClient.ts` 因此按魔数（gzip `1f 8b`、zlib
  `78 xx`）兜底解码；识别不出的一律原样返回，不会误伤真正的二进制响应。

### 不支持的能力

- `countTokens` 使用本地估算（OpenAI 无对应端点）。调用方本就有估算兜底。
- 音频、视频、PDF 的 `inlineData` 与 `fileData` 会被丢弃并记录 debug 日志。
- `embedContent` 会把调用方给的模型名原样透传，不替换成 `GEMINI_OPENAI_MODELID`
  （嵌入模型与对话模型通常不同）。目前 CLI 内没有任何生产代码调用该接口。
- Gemini 回退链（fallback）在 OpenAI 模式下禁用：链上每个候选都是 Gemini 模型，切换只会把错误变得更难懂。

### 遥测

OpenAI 流量在遥测中上报端点真实 host，不会像默认分支那样被记成
`generativelanguage.googleapis.com`。

---

## 故障排查

| 现象                                                   | 原因与处理                                                                                                                                                   |
| :----------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `must specify the GEMINI_OPENAI_BASE_URL`              | 变量没生效。检查是否写在不受信任工作区的项目 `.env` 里（会被白名单过滤），或改用 `export`。                                                                  |
| `must specify the GEMINI_OPENAI_MODELID`               | 同上。该变量是必需的。                                                                                                                                       |
| `HTTP 403: ... is only available on agentic harnesses` | **模型侧的门禁，不是本适配器的问题。** 详见下节。                                                                                                            |
| 请求打到了 Google 而不是你的端点                       | settings.json 里的 `selectedType` 生效了。确认 `GEMINI_API_TYPE` 精确等于 `openai`，或检查是否被 `enforcedType` 拦下。                                       |
| 本地服务连接失败，返回代理的错误页                     | 端点不是回环地址却在走代理；`config.proxy` 取自 `HTTPS_PROXY` 等变量。确认地址是 `localhost` / `127.0.0.1` / `::1`，或设置 `NO_PROXY`。                      |
| 启动时卡住不动                                         | `createContentGeneratorConfig` 的 OpenAI 分支已提前返回，不会触碰 keychain。若仍卡住，检查是否走了其它认证类型（Linux 无 Secret Service 时 keytar 会阻塞）。 |
| 工具调用在历史里重复                                   | 属于契约 2 被破坏。端点是否在多个 chunk 里重复发送了同一个 `tool_calls`？                                                                                    |

### 403：模型侧的「Agent 框架」门禁

部分厂商在 OpenRouter 上提供的免费端点（如 `thinkingmachines/inkling:free`）只对
**其应用目录中登记的客户端**开放，OpenRouter 用 `HTTP-Referer` / `User-Agent`
对照白名单执行该门禁。报文是：

```
403 thinkingmachines/inkling:free is only available on agentic harnesses.
    Try plugging it into a coding agent or productivity app listed on
    https://openrouter.ai/apps
```

实测结论：

- 门禁依据是 `HTTP-Referer` 与 `User-Agent`，**不是** `X-Title`。
- 是**白名单**，不是"有值即可"：任意 referer（`example.com`、`localhost`）和任意UA（`foobar/1.0`）同样 403，只有登记在册的应用标识才会放行。
- Gemini
  CLI 不在该目录中，因此使用本模型只有两条路：换模型，或伪造其它应用的标识—— 后者是对厂商访问控制的规避，也会误导 OpenRouter 的流量归属，本适配器不提供该能力，也不建议采用。

**推荐做法是换一个没有门禁的免费模型。** 例如
`nvidia/nemotron-3-ultra-550b-a55b:free`
（1M 上下文、支持工具调用），本适配器已对其做过完整的端到端验证。

---

## 开发与测试

```bash
# 模块单测（90 项，无网络依赖）
npx vitest run --root packages/core src/core/openai

# 认证相关
npx vitest run --root packages/cli src/ui/auth src/core/initializer.test.ts \
  src/validateNonInterActiveAuth.test.ts

# 类型检查与 lint
npx tsc --noEmit -p packages/core/tsconfig.json
npx tsc --noEmit -p packages/cli/tsconfig.json
npx eslint packages/core/src/core/openai/
```

转换器是纯函数，用表驱动单测覆盖；SSE 客户端用 `ReadableStream`
构造假响应；流式组装用假的 `fetch` 验证三条契约。

### 本地端到端验证

起一个最小 mock 端点即可验证全链路：

```bash
node -e "
const http=require('http');
http.createServer((req,res)=>{
  if(!req.url.includes('/chat/completions')) return res.writeHead(404).end();
  let b=''; req.on('data',c=>b+=c);
  req.on('end',()=>{
    const p=JSON.parse(b);
    console.error('[mock] model='+p.model+' tools='+(p.tools?.length??0));
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write('data: '+JSON.stringify({choices:[{delta:{content:'hi'}}]})+'\n\n');
    res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\n');
    res.write('data: [DONE]\n\n'); res.end();
  });
}).listen(8123,'127.0.0.1');
"
```

然后用 `GEMINI_OPENAI_BASE_URL=http://127.0.0.1:8123/v1`
运行 CLI，观察 mock 打印的模型名与工具数量是否符合预期。

### 已完成的验证

- 模块单测 92 项全过
- core 全量 8144 项通过；5 个失败经 `git stash`
  在干净树对照确认为预先存在（`mock-fs` 与 Node 26 不兼容、PTY
  fd、`update_topic` 策略、model golden）
- cli 全量 7129 项通过；1 个文件因同样的 `mock-fs` 问题无法加载
- 端到端：文本对话、工具调用两轮往返（`system → user → assistant(tool_calls) → tool`，id 匹配、无 Gemini 专有字段泄漏）
- 覆盖优先级 A/B 验证：开关开启时覆盖 settings.json 的
  `selectedType`；开关关闭时设置项照常胜出；`enforcedType` 始终优先
- **经 HTTP 代理的端到端验证**（`HTTPS_PROXY=http://127.0.0.1:7890` +
  OpenRouter）：文本对话与工具调用（读取 `package.json`
  并取回字段值）均正常；被门禁拦截的模型现在返回完整的可读原因而非 gzip 乱码

---

## 与上游同步的策略

本功能刻意保持"可摘除"：

- 协议翻译全部在新目录内，不修改任何调用方（`geminiChat`、`client.ts`、工具系统零改动）。
- 原生 `fetch` + 手写 SSE，**不新增运行时依赖**，避免与上游的依赖策略冲突。
- 对既有文件的改动都是小的条件分支，且绝大多数以
  `authType === AuthType.USE_OPENAI` 为条件。

同步上游时，冲突应集中在 `packages/core/src/core/contentGenerator.ts`
的枚举与工厂分支，以及 `packages/cli/src/ui/auth/AuthDialog.tsx` 的菜单列表。

### 相关文档

`docs/get-started/authentication.mdx` 与 `docs/reference/configuration.md`
中已有面向用户的英文说明（随本功能一并加入）。其中 `configuration.md` 的
`security.auth.*` 条目由 `settingsSchema.ts` 自动生成，修改描述后需运行
`npm run docs:settings`。
