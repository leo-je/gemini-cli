# OpenAI Provider 选择失败：环境变量遮蔽与错误归因缺陷

> 记录一次已复现并**已修复**的故障：在 `~/git/test` 下运行
> `gemini-leo`，选择 OpenAI 方式并挑选 provider `linksub-008`，报错
>
> ```
> Failed to use provider "linksub-008":
>   Provider "ytoken-01" references the environment variable
>   YTOKEN_01_API_KEY, which is not set.
> ```
>
> 报错里提到的 provider
> **不是**用户选择的那个。本文记录根因、复现证据，以及三处缺陷的修复实现与验证结果。

- 仓库：`~/git/gemini-cli`
- 版本：`0.67.0-nightly.20261020.gb041de017`（HEAD `41738191b`）
- 已安装产物：`/data/data/com.termux/files/usr/lib/node_modules/gemini-cli-leo/gemini.mjs`
- 环境：Termux / Android，Node v26.4.0
- 复现日期：2026-11-14
- **修复日期：2026-11-14**

---

## 1. 结论摘要

单个报错由 **三个独立缺陷叠加** 造成。按因果顺序：

| #   | 缺陷                                                  | 位置                                                            | 后果                                                     | 状态      |
| --- | ----------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- | --------- |
| 1   | 项目 `.env` 遮蔽用户级 `.env`，不合并                 | `packages/cli/src/config/settings.ts:607` `findEnvFile()`       | 7 个 provider 的 key 全部不可见                          | ✅ 已修复 |
| 2   | 会话级 provider 解析失败后吞掉原始错误，降级到第 0 条 | `packages/core/src/core/openai/integration.ts:172-188`          | 报错归因到 `ytoken-01`；成功时还会**静默换端点**         | ✅ 已修复 |
| 3   | 认证门只看第 0 条，且忽略持久化的 `openAiProviderId`  | `integration.ts:246` + `packages/cli/src/config/auth.ts:45,110` | 配置完好也会退化成 "must specify GEMINI_OPENAI_BASE_URL" | ✅ 已修复 |

其中
**缺陷 2 是导致"报错说 ytoken-01"的直接原因**，缺陷 1 是让它被触发的条件。三者的修复实现见第 5 节。

---

## 2. 触发链详解

### 2.1 缺陷 1：项目 `.env` 整体遮蔽用户级 `.env`

`findEnvFile()` 自下而上（cwd → 家目录）查找，**命中第一个即返回，不做合并**：

```ts
// packages/cli/src/config/settings.ts:607
function findEnvFile(startDir, isTrusted, ignoreLocalEnv): string | null {
  let currentDir = path.resolve(startDir);
  while (true) {
    if (isTrusted) {
      const geminiEnvPath = path.join(currentDir, GEMINI_DIR, '.env');
      if (fs.existsSync(geminiEnvPath)) return geminiEnvPath;
    }
    const envPath = path.join(currentDir, '.env'); // ← 先命中项目级
    if (fs.existsSync(envPath)) {
      if (!ignoreLocalEnv || currentDir === homedir()) return envPath;
    }
    // ... 只有一路走到家目录才会回落 ~/.gemini/.env
  }
}
```

当前实际的文件布局与内容：

```
~/git/test/.env        ← 69 字节，只有一行 NGROK_AUTHTOKEN=<已脱敏>
~/.gemini/.env         ← 834 字节，7 个 provider 的 key 全在这里
```

`~/git/test/.env` 一旦存在就立即返回，`~/.gemini/.env`
**永远读不到**。因此在该目录下：

```bash
$ cd ~/git/test && node -e '...findEnvFile...'
chosen .env -> /data/data/com.termux/files/home/git/test/.env
```

验证（把 key 从 shell 环境剥离后，模拟干净启动）：

```bash
$ env -i HOME=$HOME PATH=$PATH bash -lc 'env | grep -c "YTOKEN_01_API_KEY\|LINKSUB_008_API_KEY"'
0
fresh shell: 0 keys
```

也就是说 `.env` 是这些 key 的**唯一来源**；被遮蔽后它们全部缺失。

### 2.2 缺陷 2：错误归因到别的 provider（直接原因）

```ts
// packages/core/src/core/openai/integration.ts:160
export function resolveActiveProvider(options) {
  const { requestedId, sessionProviderId, env, allowImplicitProvider } =
    options;
  const choice = requestedId ?? sessionProviderId;
  // ...
  if (choice) {
    try {
      return resolveProvider(choice, undefined, env); // ← linksub-008 在此抛错
    } catch (error) {
      // 只有 caller 显式指定的 id 才重新抛出
      if (requestedId !== undefined) {
        throw error;
      }
      // ← sessionProviderId 走到这里：真实错误被丢弃
      return resolveImplicitProvider(sessionProviderId, env); // 降级去解析 providers[0]
    }
  }
  // ...
}
```

`AppContainer.tsx:1217` 的 `activateOpenAiProvider()` 调用顺序是：

```ts
config.setActiveOpenAiProvider(providerId); // 记为 session 选择
await config.refreshAuth(AuthType.USE_OPENAI); // 内部走 resolveActiveProvider({ sessionProviderId })
```

即传的是 **`sessionProviderId`**，不是 `requestedId`。于是：

1. `resolveProvider('linksub-008')` 抛 `LINKSUB_008_API_KEY 未设置`；
2. 该错误被 `catch` 吞掉（因为 `requestedId === undefined`）；
3. 降级调用 `resolveImplicitProvider()` → `resolveProvider(undefined)` →
   **`providers[0]` = `ytoken-01`**；
4. `ytoken-01` 的 key 同样缺失，再次抛出；
5. 这条**第二次**的错误冒泡到 `AppContainer.tsx:1273`，成为用户看到的文案。

用编译产物直接复现：

```bash
$ cd ~/git/gemini-cli/packages/core
$ env -u YTOKEN_01_API_KEY -u LINKSUB_008_API_KEY node --input-type=module -e '
  const m = await import("./dist/src/core/openai/integration.js");
  try {
    const p = m.resolveActiveProvider({ sessionProviderId: "linksub-008", allowImplicitProvider: true });
    console.log("resolved:", p && p.id);
  } catch (e) { console.log("THROWN:", e.message); }'

THROWN: Provider "ytoken-01" references the environment variable YTOKEN_01_API_KEY, which is not set.
```

**更危险的变体：静默换端点。** 若 `ytoken-01`
的 key 恰好存在，降级就会**成功**，把一个并非用户选择的 provider 装进会话：

```bash
$ env -u LINKSUB_008_API_KEY YTOKEN_01_API_KEY=sk-test node --input-type=module -e '
  const m = await import("./dist/src/core/openai/integration.js");
  const p = m.resolveActiveProvider({ sessionProviderId: "linksub-008", allowImplicitProvider: true });
  console.log("asked for linksub-008 -> got:", p && p.id, "| baseUrl:", p && p.baseUrl);'

asked for linksub-008 -> got: ytoken-01 | baseUrl: https://api.ytoken.eu.cc/v1
```

此时唯一提示是一条 warning：

```
The selected OpenAI provider "linksub-008" is no longer configured,
so this session is using "ytoken-01" instead. Run /provider to choose another.
```

这条文案本身也是错的——`linksub-008` **并未**"no longer
configured"，它是**存在但凭据缺失**。同一句 `catch`
把两种完全不同的事故（provider 被删除 / provider 的 key 没设）压成了同一种。

### 2.3 缺陷 3：认证门只认第 0 条

```ts
// packages/core/src/core/openai/integration.ts:246
export function hasResolvableOpenAiProvider(env, filePath) {
  // ...
  const requestedId = cleanEnv?.[OPENAI_PROVIDER_ENV]; // 只认 GEMINI_OPENAI_PROVIDER
  const profile = resolveProvider(requestedId, filePath, cleanEnv);
  return Boolean(profile?.baseUrl && profile?.modelId);
}
```

问题有二：

1. 它**不读** `settings.json` 里的
   `security.auth.openAiProviderId`（用户已持久化的选择）；
2. 无 `GEMINI_OPENAI_PROVIDER` 时永远只看 `providers[0]`。

当前 provider 文件的实际状况：

```
providers: 7 | without modelId: 2 | without apiKeyEnv: 0
entry0: ytoken-01  modelId: undefined      ← 缺 modelId
selected linksub-008 modelId: deepseek-v4.1-flash
```

`providers[0]` 没有 `modelId`，所以门恒为 false：

```bash
$ node --input-type=module -e '...'
entry0: ytoken-01 modelId: undefined (needs a modelId for the gate)
hasResolvableOpenAiProvider: false        # 即使所有 key 都齐
gate with provider env var: true          # 只有显式指定 GEMINI_OPENAI_PROVIDER 才 true
```

门判 false ⇒ 走 `validateAuthMethod` 的兜底分支 ⇒ 用户看到与真正原因无关的：

```
When using an OpenAI-compatible API, you must specify the GEMINI_OPENAI_BASE_URL environment variable.
```

这正是 `cd ~` 下的无用报错，也是"配置明明都在，却反复要求 BASE_URL"的来源。

---

## 3. 复现证据汇总

| 场景                                   | 命令/条件                                                    | 结果                                           |
| -------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| 基线（key 齐备）                       | `cd ~/git/test; gemini-leo -p ok`                            | ✅ `ok`                                        |
| key 被剥离                             | 同上 + `env -u YTOKEN_01_API_KEY -u LINKSUB_008_API_KEY ...` | ❌ 报 `ytoken-01 ... not set`（归因错误）      |
| 换到无项目 `.env` 的目录               | `cd ~` + 同样剥离                                            | ✅ 读到了 `~/.gemini/.env`，正常启动           |
| 显式指定 provider + key 齐备           | `GEMINI_OPENAI_PROVIDER=linksub-008 gemini-leo -p ok`        | ✅ `ok`                                        |
| 只缺 `LINKSUB_008`，`YTOKEN` 存在      | `env -u LINKSUB_008_API_KEY YTOKEN_01_API_KEY=...`           | ⚠️ 静默解析为 `ytoken-01` / `api.ytoken.eu.cc` |
| 直接调用 `resolveActiveProvider`       | 见 2.2                                                       | ❌ 抛出 `ytoken-01` 的错误                     |
| 认证门（所有 key 齐备、未设 env 变量） | `hasResolvableOpenAiProvider({...})`                         | ❌ `false`（因 entry0 缺 modelId）             |

关键对照实验——同一台机器、同一份配置，仅改变 cwd：

```
=== cwd=~/git/test（有项目 .env）===
Ignoring the OpenAI provider file at ~/.gemini/openai-providers.json:
  Provider "ytoken-01" references the environment variable YTOKEN_01_API_KEY, which is not set.
When using an OpenAI-compatible API, you must specify the GEMINI_OPENAI_BASE_URL environment variable.

=== cwd=~（无项目 .env）===
- Review or refactor code
- Build a new feature
Just tell me the task and I'll dig in.        ← 正常
```

---

## 4. 临时规避方案

### 方案 A：让项目 `.env` 不再遮蔽（推荐，已验证）

在 `~/git/test/.gemini/settings.json` 写入：

```json
{
  "advanced": {
    "ignoreLocalEnv": true
  }
}
```

`ignoreLocalEnv=true` 会跳过项目 `.env`，一路回落到 `~/.gemini/.env`。已验证：

```bash
# 剥离 key 后，仅靠 settings 即可恢复
$ cd ~/git/test && env -u YTOKEN_01_API_KEY -u LINKSUB_008_API_KEY -u OPENROUTER_API_KEY \
    GEMINI_OPENAI_PROVIDER=linksub-008 gemini-leo -p ok
ok
```

> 注意：`--ignore-env`
> 这个 CLI 参数在当前版本**不被接受**（`Unknown arguments: ignore-env`），只能用 settings 或
> `advanced.ignoreLocalEnv`。

### 方案 B：合并 `.env` 文件（最彻底）

把 `~/git/test/.env` 的内容并进 `~/.gemini/.env`，然后删除项目级 `.env`：

```bash
cat ~/git/test/.env >> ~/.gemini/.env
rm ~/git/test/.env
```

这样 `findEnvFile()` 无论从哪里启动都会命中同一个文件，不存在遮蔽问题。

### 方案 C：启动时显式指定 provider

因 `providers[0]` 缺 `modelId`，认证门不会自动放行，需要显式指定：

```bash
GEMINI_OPENAI_PROVIDER=linksub-008 gemini-leo
```

可写进 `~/.bashrc` 或包一层 alias / 启动脚本。

### 方案 D：补全第 0 条 provider

给 `ytoken-01` 补一个
`modelId`，认证门即可通过（仍建议配合方案 A/B 解决 key 缺失）：

```jsonc
{
  "id": "ytoken-01",
  "baseUrl": "https://api.ytoken.eu.cc/v1",
  "apiKeyEnv": "YTOKEN_01_API_KEY",
  "modelId": "deepseek-v4.1-flash", // ← 新增
}
```

---

## 5. 修复实现

三处缺陷都已修复，按风险从低到高实施。

### 5.1 缺陷 2：不再把错误归因到别的 provider

**改动：** `packages/core/src/core/openai/providers.ts`、`.../integration.ts`

`resolveProvider()` 原本对所有失败都抛同一种
`Error`，调用方无从区分"provider 不存在"和"provider 存在但凭据缺失"，只能一概降级。现在前者抛出专用的
`UnknownProviderError`（携带 `requestedId` 与 `knownIds`）：

```ts
export class UnknownProviderError extends Error {
  constructor(
    readonly requestedId: string,
    readonly knownIds: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = 'UnknownProviderError';
  }
}
```

`resolveActiveProvider()` 的 `catch` 随之收紧——**只有**"会话选择 +
provider 确实不存在"才降级：

```ts
if (requestedId !== undefined || !(error instanceof UnknownProviderError)) {
  throw error;
}
return resolveImplicitProvider(sessionProviderId, env);
```

用类型而非匹配消息来判别，避免将来改文案时静默恢复成换端点。同时把
`resolveImplicitProvider()` 的 warning 从 "is no longer configured" 改为 "is not
configured in the provider file"，因为它现在只会因条目确实缺失而触发。

**效果：** 选择 `linksub-008` 而后者的 key 未设置时，报出的是

```
Provider "linksub-008" references the environment variable LINKSUB_008_API_KEY, which is not set.
```

即使 `ytoken-01` 的 key 存在，也不会再静默把会话切到 `api.ytoken.eu.cc`。

### 5.2 缺陷 3：认证门尊重已持久化的选择

**改动：** `integration.ts`、`packages/cli/src/config/auth.ts`

`hasResolvableOpenAiProvider()` 增加第三个可选参数
`selectedProviderId`，判定优先级与 `resolveActiveProvider()`
严格一致：**持久化选择 > `GEMINI_OPENAI_PROVIDER` > 第一条**。两者共用一个
`pickRequestedId()`，避免再次漂移。

新增 `describeUnusableOpenAiProvider()`
作为"报告侧"：门本身必须保持静默（它会被 React 渲染路径反复调用），而
`validateAuthMethod()` 只调用一次，拿到真实原因后直接返回：

```ts
const providerFailure = describeUnusableOpenAiProvider(
  { ...process.env },
  undefined,
  selected,
);
if (providerFailure) return providerFailure;
```

`auth.ts` 的两个调用点（`isOpenAiEndpointConfigured()` 与
`validateAuthMethod()`）都改为通过
`readPersistedProviderId(loadSettings().merged)` 传入该选择。

**效果：** `providers[0]` 缺 `modelId`
不再拖垮一个配置完好的选择；配置有误时看到的是具体原因，而不是无关的 "must
specify GEMINI_OPENAI_BASE_URL"。

### 5.3 缺陷 1：项目 `.env` 不再遮蔽用户级 `.env`

**改动：** `packages/cli/src/config/settings.ts`

采取的是最小侵入方案，而非把 `findEnvFile()` 改造成返回列表——那样会波及
`settings-env-isolation.test.ts` 中十余个锁定短路行为的断言。

`findEnvFile()` 的选择语义保持不变（项目 `.env` 仍是权威），但
`loadEnvironment()` 在加载完主文件后，追加读取被跳过的用户级文件：

```ts
if (envFilePath) {
  loadEnvFileIntoProcess(envFilePath, settings, isTrusted);
}
for (const fallbackPath of findUserLevelEnvFiles(envFilePath)) {
  loadEnvFileIntoProcess(fallbackPath, settings, isTrusted);
}
```

`findUserLevelEnvFiles()` 返回 `<home>/.gemini/.env` 与 `<home>/.env`
中尚未被选为主文件、且确实存在的那些。解析循环被提取为
`loadEnvFileIntoProcess()`，确保兜底文件走**完全相同**的检查——包括不可信工作区的白名单与值清洗，以及项目文件的
`excludedEnvVars` 过滤。由于既有规则是"仅在 `process.env`
尚无该键时写入"，兜底天然只补空缺，优先级不变。

### 5.4 测试

新增/调整的用例：

| 文件                             | 覆盖内容                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `hasResolvableProvider.test.ts`  | 所选 provider 存在但 key 缺失 → 报**该** provider 名字与变量名；fallback 可用时也不换端点；provider 确实缺失时仍降级并 warn            |
| 同上                             | 认证门：所选条目可用而 `providers[0]` 缺 `modelId` → `true`；持久化选择优先于 `GEMINI_OPENAI_PROVIDER`；空白 id 视为未设置             |
| 同上                             | `describeUnusableOpenAiProvider()` 的四种返回（报原因 / 可用 / stale / 未指定）                                                        |
| `settings-env-isolation.test.ts` | 项目 `.env` 只有一个无关变量时，用户级 key 仍可读到；同名键仍以项目为准；`ignoreLocalEnv` 下仍读家目录；主文件即家目录文件时不重复读取 |

其中两个用例刻意使用 `TEST_UNSET_*` 这种测试专用变量名：`readEnvValue()` 在
`configEnv` 缺键时会回落到
`process.env`，用真实变量名会让断言依赖运行机器的实际环境。

### 5.5 顺带修掉的测试缺陷

`auth.test.ts` 的 6 个用例在**改动前就已失败**（已用 `git stash`
对照基线确认），原因是认证门会读取开发者真实的
`~/.gemini/openai-providers.json`——配置了 provider 的机器上，"nothing
set" 自然会变成
`true`。这正是本次要修的 bug 在测试里的同构版本，所以一并处理：用一个模块级
`beforeEach` 把 `GEMINI_CLI_HOME` 指向临时目录（core 的 `homedir()`
每次调用都会读它），无需 mock 任何模块。

`settings.test.ts` 的 4 个缓存用例断言了 `fs.readFileSync`
的**固定调用次数**（"每个 workspace
5 次"）。兜底读取会多读 2 个文件，于是计数断言失败——但用例真正要验证的是缓存，不是文件数。已改为断言语义：命中缓存返回同一对象且不再读取；`saveSettings`
后返回新对象。

### 5.6 验证结果

```
core  src/core/openai            302 passed (11 files)
cli   src/config                 981 passed | 1 skipped
```

剩余两项失败与本次改动无关，均已用基线对照确认：

- `extension-manager-scope.test.ts` —— Termux/Android 缺少
  `@lydell/node-pty-android-arm64` 二进制，文件级加载失败；
- `extension-manager.test.ts` 的并发安装用例 ——
  Android 文件系统下的时序问题，基线上同样失败。

端到端复现（编译产物 + 临时 HOME）：

```
=== 所选 key 缺失、fallback key 存在 ===
   THROWN: Provider "linksub-008" references the environment variable LINKSUB_008_API_KEY, which is not set.
=== provider 确实缺失 ===
   degraded to: ytoken-01
=== 门：entry0 缺 modelId ===
   default (entry0): false
   with selection:   true
=== 项目 .env 只有一个无关变量 ===
   NGROK_AUTHTOKEN    : abc123      (来自项目 .env)
   YTOKEN_01_API_KEY  : sk-a        (来自 ~/.gemini/.env，修复前读不到)
   LINKSUB_008_API_KEY: sk-b
```

---

## 6. 相关文件索引

| 文件                                                          | 作用                                                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/core/openai/providers.ts`                  | `UnknownProviderError`、`resolveProvider()`、`resolveApiKey()` 抛错                                                                                               |
| `packages/core/src/core/openai/integration.ts`                | `resolveActiveProvider()` 降级判定、`resolveImplicitProvider()` 文案、`hasResolvableOpenAiProvider()` 门、`describeUnusableOpenAiProvider()`、`pickRequestedId()` |
| `packages/cli/src/config/auth.ts`                             | `isOpenAiEndpointConfigured()`、`validateAuthMethod()` 的门调用与原因呈现                                                                                         |
| `packages/cli/src/ui/openai/openAiProviderPreference.ts`      | `readPersistedProviderId()`（`security.auth.openAiProviderId` 的读取）                                                                                            |
| `packages/cli/src/config/settings.ts`                         | `findEnvFile()`、`findUserLevelEnvFiles()`、`loadEnvFileIntoProcess()`、`loadEnvironment()`                                                                       |
| `packages/core/src/core/openai/hasResolvableProvider.test.ts` | 门 / 降级 / 原因报告的全部用例                                                                                                                                    |
| `packages/cli/src/config/settings-env-isolation.test.ts`      | `.env` 遮蔽与兜底的全部用例                                                                                                                                       |

---

## 7. 附：改动范围

诊断阶段产生的临时改动（`~/git/test/.gemini/settings.json`、`~/git/test/.env`、临时目录
`~/.gemini/tmp/envtest`、`~/.gemini/tmp/wtest`）当时已还原或删除。

修复阶段**修改了源码**，范围如下：

```bash
$ cd ~/git/gemini-cli && git status --short
 M packages/cli/src/config/auth.ts
 M packages/cli/src/config/auth.test.ts
 M packages/cli/src/config/settings-env-isolation.test.ts
 M packages/cli/src/config/settings.test.ts
 M packages/cli/src/config/settings.ts
 M packages/core/src/core/openai/hasResolvableProvider.test.ts
 M packages/core/src/core/openai/integration.ts
 M packages/core/src/core/openai/providers.ts
?? docs/openai-provider-env-shadowing.md
```

第 4 节的规避方案仍然有效，但已是冗余的——修复后不再需要 `ignoreLocalEnv`
或显式指定 `GEMINI_OPENAI_PROVIDER` 才能正常启动。
