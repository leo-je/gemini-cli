# OpenAI API 兼容模式

Gemini CLI 支持把请求转发到任意实现了 OpenAI Chat
Completions 协议的端点。开启方式是设置
`GEMINI_API_TYPE=openai`，之后流式响应、工具调用、图片和 token 用量统计都会走该端点，而 CLI 的其余部分（工具系统、上下文管理、UI）完全不需要改动。

这项能力是围绕"最小侵入"设计的：协议翻译代码全部集中在
`packages/core/src/core/openai/`，对原有代码只做定点注入，因此与上游同步时的冲突面很小。

---

## 快速开始

四个环境变量（需要自定义请求头时再加
`GEMINI_OPENAI_HEADERS`，见[环境变量](#环境变量)）：

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

已经用 `GEMINI_API_KEY` / `GOOGLE_GEMINI_BASE_URL` / `GEMINI_MODEL`
配置过的，只设 `GEMINI_API_TYPE=openai`
也能跑，这三个变量会作为降级来源被读取。见 [降级来源](#降级来源)。

### 本地服务示例

指向 Ollama、vLLM、LM Studio 等本地服务时不需要 API key：

```bash
export GEMINI_API_TYPE="openai"
export GEMINI_OPENAI_BASE_URL="http://localhost:11434/v1"
export GEMINI_OPENAI_MODELID="qwen2.5-coder:14b"
```

---

## 环境变量

| 变量                     | 必需 | 降级来源                 | 说明                                                                                                |
| :----------------------- | :--- | :----------------------- | :-------------------------------------------------------------------------------------------------- |
| `GEMINI_API_TYPE`        | 是   | —                        | 模式开关。**区分大小写**，必须精确等于 `openai`。`OpenAI`、`openai `（带空格）都不会生效。          |
| `GEMINI_OPENAI_BASE_URL` | 是   | `GOOGLE_GEMINI_BASE_URL` | 端点根地址。URL 没有路径时会自动补 `/v1`；已有路径则原样使用，所以需要 `/v1` 的端点请自己写全。     |
| `GEMINI_OPENAI_API_KEY`  | 否   | `GEMINI_API_KEY`         | 以 `Authorization: Bearer` 头发送。为空时不发送该头，适用于无鉴权的本地服务。                       |
| `GEMINI_OPENAI_MODELID`  | 是   | `GEMINI_MODEL`           | 发给端点的模型名。**这是权威来源（`GEMINI_MODEL` 仅为降级），`--model` 在此模式下无效。**           |
| `GEMINI_OPENAI_HEADERS`  | 否   | —                        | 自定义请求头，JSON 对象。**可以覆盖任何内置头**（头名大小写不敏感），含 `Authorization`。详见下节。 |

### 降级来源

`GEMINI_OPENAI_*`
未设置（或设为空串）时，会依次读取上表「降级来源」列里的变量。这让
`GEMINI_OPENAI_*` 前缀出现之前写下的配置继续可用——只设过 `GEMINI_API_KEY` /
`GOOGLE_GEMINI_BASE_URL` / `GEMINI_MODEL` 的用户不必为了切换后端而把值复制一份。

```bash
# 这两组配置等价
export GEMINI_API_TYPE=openai
export GEMINI_OPENAI_BASE_URL="https://api.example.com/v1"
export GEMINI_OPENAI_API_KEY="YOUR_API_KEY"
export GEMINI_OPENAI_MODELID="gpt-4o"

export GEMINI_API_TYPE=openai
export GOOGLE_GEMINI_BASE_URL="https://api.example.com/v1"
export GEMINI_API_KEY="YOUR_API_KEY"
export GEMINI_MODEL="gpt-4o"
```

两条规则：

- **`GEMINI_OPENAI_*` 优先。**
  两个都设置时用前者，降级只在它缺失或为空串时发生，所以降级永远盖不掉一个明确的 OpenAI 模式设置。
- **空串算未设置。**
  `export GEMINI_OPENAI_BASE_URL=`（清空继承来的变量）会走降级，而不是把空串当成一个刻意设置的空端点。

> [!NOTE]
>
> `GEMINI_MODEL` 有双重身份：它同时是 CLI 内部的模型名来源。降级读取
> `GEMINI_MODEL` 作为端点模型名时，这个值也会被 `setModel()`
> 钉到内部状态，因此 UI 显示、遥测上报和实际发出的请求三者一致。

### 自定义请求头

```bash
export GEMINI_OPENAI_HEADERS='{"X-Tenant":"acme","X-Trace":"on"}'
```

| 场景                                     | 配置                                    |
| :--------------------------------------- | :-------------------------------------- |
| Azure OpenAI（用 `api-key` 而非 Bearer） | `{"api-key":"YOUR_KEY"}`                |
| 自建网关要求自有鉴权方案                 | `{"Authorization":"Token abc123"}`      |
| 端点要求租户/项目标识                    | `{"X-Tenant":"acme","X-Project":"web"}` |

规则：

- 值是**扁平 JSON 对象**，键为头名、值为字符串。数字和布尔会自动转成字符串，`{"X-Retries":3}`
  可以写。但 JSON 数字按双精度浮点数解析：超出安全整数范围的整数会丢精度，`1e400`
  会变成 `Infinity`。这类值请直接写成字符串。
- **配置的头覆盖内置默认头**，包括
  `Authorization`、`Content-Type`、`Accept`、`User-Agent`。这是刻意放开的：端点用什么头鉴权是它自己的事，适配器无从预判。
- **头名大小写不敏感。** 写 `authorization` 一样会替换掉内置的
  `Authorization`，不会变成两个头——HTTP 规范下同名的两个头会被合并成一个逗号拼接的值，`Bearer key, Token abc`
  这种拼接凭据端点必然拒绝。
- 同一个头**换个大小写写两遍会报错**（`{"X-A":"1","x-a":"2"}`）。头名既然大小写不敏感，这就是笔误而不是合并，替你猜一个值比直接报错更糟。
- **写错就报错退出，绝不静默忽略。** JSON 非法、头名不合法（必须是 RFC
  9110 的 field-name）、值不是字符串/数字/布尔，都会在启动阶段直接给出原因。配在这里的通常是凭据，静默丢弃只会把一条清晰的配置错误变成端点返回的莫名 401。
- 值必须能表示成**单字节 Latin-1**。C0 控制字符（`\t` 除外）与 DEL 一律拒绝：CR
  / LF 是头注入（header
  injection）向量，一个换行就能凭空插入一个攻击者指定的头。**码点大于 U+00FF 的字符同样拒绝**——HTTP 头值本质是字节，`fetch`
  会在每一个请求上抛出一个既不说头名也不说变量名的
  `TypeError`，不如在启动时就说清楚。中文等非拉丁字符请先编码（例如百分号编码的 UTF-8）。
- 与程序化传入的 `config.customHeaders` 同时存在时，**环境变量优先**。
- 上游的 `GEMINI_CLI_CUSTOM_HEADERS`
  在此模式下**不生效**。那个变量只在 GoogleGenAI分支被解析——它填出的
  `baseHeaders` 只流向 `USE_GEMINI` / `USE_VERTEX_AI` / `GATEWAY` 与
  `LOGIN_WITH_GOOGLE` /
  `COMPUTE_ADC`，到不了 OpenAI 适配器。用它配过的头请改写到
  `GEMINI_OPENAI_HEADERS`。

### `export` 与 `.env` 的优先级

两种方式都可以，但优先级不同：

1. **`export` 的变量优先。** `.env` 只在 `process.env`
   中不存在同名键时才写入（`packages/cli/src/config/settings.ts`），永不覆盖已导出的变量。
2. **`~/.gemini/.env` 仅在工作区受信任时加载。**
   不受信任的目录下它会被完全跳过。需要在不受信任目录里使用，可设
   `GEMINI_CLI_TRUST_WORKSPACE=true`，或直接用 `export`。
3. **不受信任工作区中的项目级 `.env` 会被白名单过滤。** `AUTH_ENV_VAR_WHITELIST`
   当前只放行 `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_CLOUD_PROJECT`、
   `GOOGLE_CLOUD_LOCATION`，因此上表五个变量写在工作区 `.env`
   里会被静默丢弃。改动该白名单涉及安全边界，需谨慎评估。

> 最稳妥的做法是 `export` 或写 `~/.gemini/.env`，两者都不受白名单限制。

> [!NOTE] 上述白名单与启动校验都属于 **CLI 侧**。`packages/a2a-server` 另行组装
> `Config.env`（`a2a-server/src/config/config.ts`），既不走
> `AUTH_ENV_VAR_WHITELIST`，也不调用
> `validateAuthMethod`。因此同一组变量在 a2a-server 下的行为与 CLI 并不一致：配置写错不会在启动时报错，而是等到构造
> `OpenAIContentGenerator`
> 时才抛出来。用 a2a-server 跑 OpenAI 模式时请自行确认环境变量正确。

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

| 文件                        |     行数 | 职责                                                                         |
| :-------------------------- | -------: | :--------------------------------------------------------------------------- |
| `constants.ts`              |      142 | 环境变量名、`readEnvValue`、`parseHeaderJson`。**零 import**，避免循环依赖。 |
| `types.ts`                  |      148 | OpenAI 协议的最小类型集，不引入第三方 SDK。                                  |
| `converters.ts`             |      657 | Gemini ⇄ OpenAI 双向转换（纯函数，可无网络测试）。                           |
| `openaiClient.ts`           |      452 | 原生 `fetch` + 手写 SSE 解析、代理与超时策略、压缩体解码。                   |
| `openaiContentGenerator.ts` |      308 | `ContentGenerator` 实现与流式响应重组。                                      |
| `index.ts`                  |       19 | 对外导出。                                                                   |
| 合计                        | **1726** | 另有 1653 行测试。                                                           |

### 注入点

对新代码之外的改动共 21 个文件：生产代码 13 个文件（+200 /
−22），测试 8 个文件（+352
−3），另有 1 个生成物与 2 篇文档。全部是定点注入；**逐函数、逐行的修改点清单见
[与上游合并升级指南](#与上游合并升级指南)**，下表只作索引：

| 文件                                       | 改动                                                                                   |
| :----------------------------------------- | :------------------------------------------------------------------------------------- |
| `core/src/core/contentGenerator.ts`        | `AuthType.USE_OPENAI` 枚举、`getAuthTypeFromEnv`、认证类型解析函数、两个工厂分支       |
| `core/src/config/config.ts`                | OpenAI 模式下把 `config.model` 固定为 `GEMINI_OPENAI_MODELID`（降级读 `GEMINI_MODEL`） |
| `core/src/fallback/handler.ts`             | OpenAI 模式下禁用 Gemini 回退链                                                        |
| `core/src/core/loggingContentGenerator.ts` | 遥测上报真实端点而非 Gemini 默认端点                                                   |
| `core/src/index.ts`                        | 导出新模块                                                                             |
| `cli/src/config/auth.ts`                   | 校验 `BASE_URL` 与 `MODELID` 必填、`HEADERS` 可解析（API key 可空）                    |
| `cli/src/config/settingsSchema.ts`         | `security.auth.*` 的合法取值描述（文档由它生成）                                       |
| `cli/src/validateNonInterActiveAuth.ts`    | 认证类型解析                                                                           |
| `cli/src/core/initializer.ts`              | 启动鉴权与是否弹出认证对话框                                                           |
| `cli/src/ui/auth/useAuth.ts`               | 交互模式自动认证                                                                       |
| `cli/src/ui/auth/AuthDialog.tsx`           | 菜单项与默认选中                                                                       |
| `cli/src/gemini.tsx`                       | `--list-sessions` 的尽力鉴权                                                           |
| `cli/src/acp/acpSessionManager.ts`         | ACP 会话的两处认证类型解析                                                             |

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

- 发给端点的模型名来自 `GEMINI_OPENAI_MODELID`，未设置时降级读
  `GEMINI_MODEL`。两者都没有则报错。`--model`
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
  （降级读
  `GEMINI_MODEL`）。只有调用方没给模型名时才用这个值填充。（嵌入模型与对话模型通常不同）。目前 CLI 内没有任何生产代码调用该接口。
- Gemini 回退链（fallback）在 OpenAI 模式下禁用：链上每个候选都是 Gemini 模型，切换只会把错误变得更难懂。

### 遥测

OpenAI 流量在遥测中上报端点真实 host，不会像默认分支那样被记成
`generativelanguage.googleapis.com`。

---

## 故障排查

| 现象                                                   | 原因与处理                                                                                                                                                   |
| :----------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `must specify the GEMINI_OPENAI_BASE_URL`              | `GEMINI_OPENAI_BASE_URL` 和降级来源 `GOOGLE_GEMINI_BASE_URL` 都没生效。检查是否写在不受信任工作区的项目 `.env` 里（会被白名单过滤），或改用 `export`。       |
| `must specify the GEMINI_OPENAI_MODELID`               | 同上。`GEMINI_OPENAI_MODELID` 与降级来源 `GEMINI_MODEL` 都没有。                                                                                             |
| `HTTP 403: ... is only available on agentic harnesses` | **模型侧的门禁，不是本适配器的问题。** 详见下节。                                                                                                            |
| 请求打到了 Google 而不是你的端点                       | settings.json 里的 `selectedType` 生效了。确认 `GEMINI_API_TYPE` 精确等于 `openai`，或检查是否被 `enforcedType` 拦下。                                       |
| 本地服务连接失败，返回代理的错误页                     | 端点不是回环地址却在走代理；`config.proxy` 取自 `HTTPS_PROXY` 等变量。确认地址是 `localhost` / `127.0.0.1` / `::1`，或设置 `NO_PROXY`。                      |
| 启动时卡住不动                                         | `createContentGeneratorConfig` 的 OpenAI 分支已提前返回，不会触碰 keychain。若仍卡住，检查是否走了其它认证类型（Linux 无 Secret Service 时 keytar 会阻塞）。 |
| 工具调用在历史里重复                                   | 属于契约 2 被破坏。端点是否在多个 chunk 里重复发送了同一个 `tool_calls`？                                                                                    |
| `GEMINI_OPENAI_HEADERS must be valid JSON`             | 多半是 shell 引号问题。JSON 要整体用**单引号**包住：`export GEMINI_OPENAI_HEADERS='{"X-A":"1"}'`。用双引号时 shell 会吃掉内层 `"`，解析必然失败。            |
| 自定义 header 没发出去                                 | 确认变量名拼写，并检查是否写在工作区项目 `.env` 里（会被白名单过滤，见[环境变量](#环境变量)）。                                                              |

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

> 注：`GEMINI_OPENAI_HEADERS` 是通用的请求头配置，理论上可以拿它去设置
> `HTTP-Referer` /
> `User-Agent`。用它来**冒充白名单内的应用、绕过上述门禁**，性质仍然是规避厂商的访问控制，本适配器不为这种做法背书；该变量的定位是让端点能表达自己的鉴权与租户要求。

**推荐做法是换一个没有门禁的免费模型。** 例如
`nvidia/nemotron-3-ultra-550b-a55b:free`
（1M 上下文、支持工具调用），本适配器已对其做过完整的端到端验证。

---

## 开发与测试

```bash
# 模块单测（116 项，无网络依赖）
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

- 模块单测 116 项全过
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

## 与上游合并升级指南

本功能刻意保持"可摘除"：协议翻译全部在新目录内，不修改任何调用方（`geminiChat`、`client.ts`、工具系统零改动）；使用原生
`fetch` + 手写 SSE，**不新增运行时依赖**；对既有文件的改动都是定点注入——要么以
`authType === AuthType.USE_OPENAI` 或 `GEMINI_API_TYPE=openai`
开关为条件，要么是纯新增（`index.ts` 的 re-export、`settingsSchema.ts`
的文案）。

### 变更性质总览

| 类别                             |                           数量 | 合并时的处理                     |
| :------------------------------- | -----------------------------: | :------------------------------- |
| 新增目录 `core/src/core/openai/` |   6 源文件 + 4 测试（3379 行） | 上游没有，**不会冲突**，原样保留 |
| 新增文档 `README_OPENAI.md`      |                              1 | 同上                             |
| 修改上游生产代码                 |          13 个文件（+200 −22） | 逐个核对，见下节                 |
| 修改上游测试代码                 |            8 个文件（+352 −3） | 与对应生产改动配对               |
| 重新生成的产物                   | `schemas/settings.schema.json` | **不要手改**，用脚本重生成       |

> **新建 `openai/*.test.ts` 时必须 `git add -f`。** 本机全局 gitignore 里有一条
> `*Test.*`：名字里含 `test.` 的路径一律忽略，大小写不敏感，覆盖面远大于
> `*.test.ts`（`contest.md`、`Latest.md`
> 同样中招——新建这类文件时留意）。指定路径 `git add <path>` 会报错退出（exit
> 1，有提示），`git add .` / `git add -A` 则静默跳过（exit
> 0），两种都进不了索引。文件在盘上、`vitest`
> 也照跑，但不在任何提交里，`format-patch` / `git am` 迁移时**静默丢失**。
>
> 该目录下现有 4 个测试文件（`converters` / `openaiClient` /
> `openaiContentGenerator` / `constants`）已全部入库——前 3 个随 `023934a1d`，
> `constants.test.ts` 随 `openai自定义请求头` 那个提交（`git log`
> 最新一条）。后续新增同目录测试沿用同样做法。

### 逐文件修改点

下面的"改动方式"决定了冲突难度：

- **纯插入** —— 只在既有代码之间新增行；上游没动同一处就不会冲突。
- **改既有行**
  —— 修改了上游原有的语句或注释，**上游一旦改同一行就会冲突**。合并时优先保留上游版本，再把 OpenAI 分支重新贴上。

#### `packages/core/src/core/contentGenerator.ts`（+90 −4，冲突高危）

| 位置                                                                      | 改动方式 | 内容                                                                                                                                                                                                                                           |
| :------------------------------------------------------------------------ | :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顶部 import                                                               | 纯插入   | `./openai/openaiContentGenerator.js`、`./openai/constants.js`                                                                                                                                                                                  |
| `enum AuthType`                                                           | 纯插入   | 新增成员 `USE_OPENAI = 'openai'`                                                                                                                                                                                                               |
| `getAuthTypeFromEnv()`                                                    | 改既有行 | 函数体**最前面**插入 `GEMINI_API_TYPE === 'openai'` 判断，并同步改了上方 JSDoc 的编号列表。顺序必须在 `GOOGLE_GENAI_USE_GCA`、`GEMINI_API_KEY` 之前，否则带着 `GEMINI_API_KEY` 的机器会被抢走后端                                              |
| `isOpenAiApiTypeSwitch()` / `resolveAuthType()` / `getExplicitAuthType()` | 纯插入   | 三个新导出函数，整块插在 `getAuthTypeFromEnv()` 与 `ContentGeneratorConfig` 类型之间                                                                                                                                                           |
| `createContentGeneratorConfig()`                                          | 改既有行 | ① 提前返回的 `if` 加了 `\|\| authType === AuthType.USE_OPENAI`；② 分支内填充 `apiKey` / `baseUrl`、置 `vertexai = false`。**这个提前返回是刻意的**：OpenAI 模式绝不能走到下面读 keychain 的 `loadApiKey()`（Linux 无 Secret Service 时会卡死） |
| `createContentGenerator()`                                                | 纯插入   | 在 `fakeResponses` 分支之后、`resolveModel()` 之前插入 `USE_OPENAI` 分支，直接构造 `LoggingContentGenerator(new OpenAIContentGenerator(...))`                                                                                                  |

#### `packages/core/src/config/config.ts`（+13）

| 位置            | 改动方式 | 内容                                                                                                                                                                                                                                                |
| :-------------- | :------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顶部 import     | 纯插入   | `OPENAI_MODEL_ID_ENV`、`readEnvValue`                                                                                                                                                                                                               |
| `refreshAuth()` | 纯插入   | 在 `this.contentGeneratorConfig = newContentGeneratorConfig;` 之后，当 `authMethod === AuthType.USE_OPENAI` 时用 `readEnvWithFallback(GEMINI_OPENAI_MODELID, GEMINI_MODEL)` 调 `setModel()`（`isTemporary` 方式，不覆盖用户保存的 Gemini 模型设置） |

#### `packages/core/src/core/loggingContentGenerator.ts`（+21 −3）

| 位置            | 改动方式 | 内容                                                                                                                                                          |
| :-------------- | :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| import          | 改既有行 | `import type { ContentGenerator }` → `import { AuthType, type ContentGenerator }`                                                                             |
| `getEndpoint()` | 改既有行 | 插入新的 **Case 2**（OpenAI 端点真实 host/port），原 Case 2 → Case 3、Case 3 → Case 4。**冲突点是两处既有的序号注释**（新插入的 Case 2 那行不算），无语义影响 |

#### `packages/core/src/fallback/handler.ts`（+8）

| 位置               | 改动方式 | 内容                                                                    |
| :----------------- | :------- | :---------------------------------------------------------------------- |
| import             | 纯插入   | `AuthType`                                                              |
| `handleFallback()` | 纯插入   | 函数体开头：OpenAI 模式下直接 `return null`（回退链上全是 Gemini 模型） |

#### `packages/core/src/index.ts`（+1）

| 位置        | 改动方式 | 内容                                      |
| :---------- | :------- | :---------------------------------------- |
| export 列表 | 纯插入   | `export * from './core/openai/index.js';` |

#### `packages/cli/src/` 下的 7 处改动

| 文件                            | 改动方式 | 内容                                                                                                                                                                                                                                                                                                                  |
| :------------------------------ | :------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/auth.ts`                | 纯插入   | `validateAuthMethod()` 的 `USE_VERTEX_AI` 分支之后、末尾 `return 'Invalid auth method selected.'` 之前插入 `USE_OPENAI` 分支：校验 `GEMINI_OPENAI_BASE_URL`（或 `GOOGLE_GEMINI_BASE_URL`）与 `GEMINI_OPENAI_MODELID`（或 `GEMINI_MODEL`）必填、`GEMINI_OPENAI_HEADERS` 可解析，**不校验 API key**（本地服务可无鉴权） |
| `validateNonInterActiveAuth.ts` | 改既有行 | import 换成 `resolveAuthType`；`configuredAuthType \|\| getAuthTypeFromEnv()` → `resolveAuthType(configuredAuthType)`；错误提示串末尾补 `GEMINI_API_TYPE`                                                                                                                                                             |
| `core/initializer.ts`           | 改既有行 | `selectedType` → `getExplicitAuthType(selectedType)` 后再传给 `performInitialAuth`；`shouldOpenAuthDialog` 一并改用解析后的值                                                                                                                                                                                         |
| `ui/auth/useAuth.ts`            | 改既有行 | 交互模式取 `authType` 处改为 `getExplicitAuthType(...)`                                                                                                                                                                                                                                                               |
| `ui/auth/AuthDialog.tsx`        | 改既有行 | `items` 数组末尾新增 `OpenAI API (compatible)` 选项；`initialAuthIndex` 的 `selectedType` 判断改为 `getExplicitAuthType(...)`                                                                                                                                                                                         |
| `gemini.tsx`                    | 改既有行 | `--list-sessions` 的尽力鉴权处包一层 `getExplicitAuthType(...)`                                                                                                                                                                                                                                                       |
| `acp/acpSessionManager.ts`      | 改既有行 | 两处 `auth.selectedType \|\|` 包一层 `getExplicitAuthType(...)`                                                                                                                                                                                                                                                       |

这 7 处共用一个语义：**"用户是否显式选择了认证方式"的判定统一收敛到
`getExplicitAuthType()`** —— `GEMINI_API_TYPE=openai` 算显式选择，环境里漂着的
`GEMINI_API_KEY` 不算。上游若在这条路径上新增了取值点，按同一规则补一层即可。

#### `settingsSchema.ts` 与 `settings.schema.json`

| 位置                               | 改动方式 | 内容                                                                              |
| :--------------------------------- | :------- | :-------------------------------------------------------------------------------- |
| `cli/src/config/settingsSchema.ts` | 改既有行 | `security.auth.selectedType` / `enforcedType` 两条 description 文案，列出合法取值 |
| `schemas/settings.schema.json`     | 生成物   | 由 `npm run schema:settings` 从上一条生成                                         |

`schema.json`
是生成产物而非手写文件：合并后重跑一次脚本即可，**不要手工解冲突**。

#### 文档

`docs/get-started/authentication.mdx`（+103 −1）新增
`## Use an OpenAI-compatible API` 小节；`docs/reference/configuration.md`（+33
−2）为其引用与 `security.auth.*` 条目，同样由 `npm run docs:settings` 生成。

#### 测试文件（8 个，+352 −3）

| 文件                                                     | 覆盖内容                                                                                                                                                        |
| :------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/src/core/contentGenerator.test.ts`                 | 3 个新 describe：`resolveAuthType` / `getExplicitAuthType` / `isOpenAiApiTypeSwitch`；已有的 `getAuthTypeFromEnv` describe 增加 3 个用例；另有 3 个工厂行为用例 |
| `core/src/core/loggingContentGenerator.test.ts`          | OpenAI 模式下的端点上报                                                                                                                                         |
| `core/src/fallback/handler.test.ts`                      | OpenAI 模式下回退链被禁用                                                                                                                                       |
| `cli/src/core/initializer.test.ts`                       | 开关驱动启动鉴权与是否弹对话框                                                                                                                                  |
| `cli/src/ui/auth/useAuth.test.tsx`                       | 开关驱动自动认证                                                                                                                                                |
| `cli/src/ui/auth/AuthDialog.test.tsx`                    | 已有 `Initial Auth Type Selection` describe 增加 2 条 `it.each` 行：开关驱动默认选中项（菜单项本身由下一行的快照覆盖）                                          |
| `cli/src/ui/auth/__snapshots__/AuthDialog.test.tsx.snap` | 快照多出 OpenAI 选项，**冲突时用 `-u` 重生成**                                                                                                                  |
| `cli/src/validateNonInterActiveAuth.test.ts`             | 无头模式下开关生效                                                                                                                                              |

> 本表只列**被修改的上游测试**。`core/src/core/openai/`
> 下的 4 个测试文件（`converters` / `openaiClient` / `openaiContentGenerator` /
> `constants`）是新增文件，计入上文「新增目录」。

### 合并流程

```bash
# 一次性配置：上游是 google-gemini/gemini-cli，origin 指向你自己的 fork
git remote add upstream https://github.com/google-gemini/gemini-cli.git

git fetch upstream
git checkout new-version-openai
git merge upstream/main          # 或 git rebase upstream/main
```

本功能的改动都落在 `87de0b636`
之上的提交里（`023934a1d 适配openai`、`3f333a255 openai-gzip自解压`、`openai自定义请求头`，以及其后若干文档补充），因此也可以用"重新贴一遍"的方式绕开纠缠型冲突：

```bash
git format-patch 87de0b636..HEAD -o /tmp/openai-patch
git checkout -b new-version-openai-rebased upstream/main
git am /tmp/openai-patch         # 逐个解决冲突后 git am --continue
```

### 冲突高危点（按上游改动频率排序）

1. **`contentGenerator.ts` 的 `createContentGeneratorConfig()`** —— 提前返回的
   `if` 条件被改过。保留上游新增的认证类型，把
   `|| authType === AuthType.USE_OPENAI`
   重新贴上，并确认 OpenAI 分支仍在读 keychain **之前**返回。
2. **`contentGenerator.ts` 的 `getAuthTypeFromEnv()`**
   —— 上游常在这里加新的探测变量。`GEMINI_API_TYPE`
   必须保持在函数**最前面**：它是显式开关，优先级高于一切环境探测。
3. **`AuthDialog.tsx` 的 `items` 数组与对应快照**
   —— 上游增删认证选项时必冲突。加回 OpenAI 选项后运行
   `npx vitest run packages/cli/src/ui/auth/AuthDialog.test.tsx -u` 重生成快照。
4. **`initializer.ts` / `useAuth.ts` / `validateNonInterActiveAuth.ts`**
   —— 三处认证类型解析语义相同，统一用 `getExplicitAuthType()` /
   `resolveAuthType()`。
5. **`settingsSchema.ts` 的 description 与 `settings.schema.json`**
   —— 改完文案重跑 `npm run schema:settings`。
6. **`openaiClient.ts` 的响应重试路径** —— 上游若调整 `retryWithBackoff`
   或 HTTP 层的错误分类，需确认契约 3（工具调用急切发起）仍然成立，否则 429/5xx 会绕过重试。

### 合并后验证

```bash
npm run build                     # 类型检查
npm run lint
npm run schema:settings           # 确认 schema 无意外 diff

# 本功能相关测试
npx vitest run \
  packages/core/src/core/openai \
  packages/core/src/core/contentGenerator.test.ts \
  packages/core/src/core/loggingContentGenerator.test.ts \
  packages/core/src/fallback/handler.test.ts \
  packages/cli/src/core/initializer.test.ts \
  packages/cli/src/validateNonInterActiveAuth.test.ts \
  packages/cli/src/ui/auth
```

最后跑一次真实端点冒烟 —— **单测全绿不等于请求真的打通**：

```bash
export GEMINI_API_TYPE=openai
export GEMINI_OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export GEMINI_OPENAI_API_KEY="sk-or-..."
export GEMINI_OPENAI_MODELID="<一个不受门禁限制的模型>"
npm start -- -p "Say hello"
```

### 摘除本功能

若上游将来原生支持了 OpenAI 端点，`git revert 3f333a255 023934a1d` 加上
`openai自定义请求头` 那条及其后的文档补充即可：新增目录、新文档与
`settings.schema.json`
的改动随之删除，无需清理散落的补丁。该前提（`openai/*.test.ts`
已进入提交，见上文 `git add -f` 说明）现已满足——`git revert`
只回滚已跟踪的文件，被 gitignore 挡住的孤立测试文件会留在盘上，且 import 的是已被删除的模块，`vitest`
会直接报错。
