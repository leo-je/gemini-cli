# OpenAI provider profiles (core)

This directory holds the fork's multi-provider support alongside the upstream
OpenAI-compatible backend. It is a **fork-local directory**: the maintainers of
this fork own the files marked as fork-added below, and the isolation contract
described here is what makes the feature removable at merge time.

## Why this lives here

Upstream implements one OpenAI-compatible endpoint per process: one base URL,
one key, one header set, all read from `GEMINI_OPENAI_*` variables. Alternating
between several endpoints (a hosted gateway, a local model server, a corporate
proxy) meant editing environment variables and restarting.

This directory adds the missing noun — a **named provider profile** — and keeps
it in a user-level file so the set of destinations belongs to the person rather
than to whichever workspace is open.

## The isolation contract

The rule that keeps upstream merges cheap:

- This directory may import from upstream freely.
- **Upstream must not import this directory's internals.** The only sanctioned
  entry point is `integration.ts`, and upstream call sites use it as a single
  statement, not as a source of logic.

That is why `contentGenerator.ts`, `config.ts`, and the CLI's `DialogManager`
each gained a call rather than an implementation. If upstream rewrites one of
those spots, the fix is to re-apply one line, not to re-derive the feature.

`index.ts` re-exports the barrel, so consumers import from
`@google/gemini-cli-core` rather than reaching into these paths.

## File inventory

Fork-added (owned by this fork):

| File                       | Purpose                                                                                                                                                                                                    |
| :------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration.ts`           | The sanctioned hook surface. Applies a profile to a content-generator config, resolves the active provider, performs a session switch, and answers whether the session is on an OpenAI-compatible backend. |
| `providers.ts`             | The provider file: schema, validation, read/write, credential resolution, and model write-back.                                                                                                            |
| `providers.test.ts`        | Coverage for the above.                                                                                                                                                                                    |
| `addProvider.test.ts`      | Coverage for appending a provider.                                                                                                                                                                         |
| `opencode/headers.ts`      | OpenCode client-identity headers, opt-in via `security.auth.openAiOpencodeHeaders`; the session-id encoding is documented inline.                                                                          |
| `opencode/headers.test.ts` | Coverage for the above: header set, session-id clock encoding, opt-in gate, and precedence against configured headers.                                                                                     |
| `opencode/body.ts`         | Free-lane request shape: appends the `bash` / `read` placeholder tools the endpoint's gate looks for.                                                                                                      |
| `opencode/body.test.ts`    | Coverage for the above: append-only merge, caller tools preserved, idempotence, placeholder shape.                                                                                                         |

Upstream (do not treat as fork-owned): `constants.ts`, `converters.ts`,
`openaiClient.ts`, `openaiContentGenerator.ts`, `types.ts`, `index.ts`, and
their tests.

The fork touches two of them, minimally:

- `constants.ts` exports `HEADER_NAME_PATTERN` and `toHeaderValue`, and gives
  the latter an optional `source` label that defaults to the existing env
  variable name. Upstream messages are therefore unchanged; the provider loader
  passes its own label so its errors name the provider file instead.
- `index.ts` re-exports `providers.js` and `integration.js`.

## The provider file

Located at `~/.gemini/openai-providers.json`, next to `settings.json` and
`.env`. It is user-level on purpose: the set of endpoints belongs to the person,
and a project-level file could be committed by accident.

A missing file is not an error — it is the state every existing user is in, and
the ambient `GEMINI_OPENAI_*` variables keep describing the endpoint. A file
that exists but is malformed **is** an error: it was written by someone who
expects it to be used, and silently ignoring it would connect them somewhere
else.

Credentials are referenced, not embedded. A profile names the environment
variable holding its key (`apiKeyEnv`), and the key stays in `.env` under the
same permission and trust handling as the rest of the CLI's secrets. A literal
`apiKey` is accepted only in a file that is unreadable by anyone else.

## Resolution is opt-in

A provider is used only when the session asked for one: an explicit id, a choice
made with `/provider`, or `GEMINI_OPENAI_PROVIDER`. A bare provider file is
deliberately not enough.

This matters because `createContentGeneratorConfig` has callers that have
nothing to do with providers — embedding-only sessions, tests passing a stub
config, subagents. Reading a personal file unconditionally would make all of
them depend on it.

## OpenCode request adaptation

Some OpenAI-compatible endpoints accept a valid credential but still gate on the
_client identity_: a request that does not carry OpenCode's headers is
answered 403. `security.auth.openAiOpencodeHeaders` (off by default) sends that
header set when the session is on an OpenAI-compatible backend.

The same endpoints may also gate on the _request shape_. The Zen free lane
admits a chat request only when it is streaming and its tools array carries
`bash` and `read`; a header-only disguise still answers 403 `FreeTierError`.
`opencode/body.ts` adds two call-disabled placeholders under those names, so the
request passes the gate without handing the model a working tool. The gate is
name-based, and the caller's own tool with the same name is never replaced.
Non-streaming requests cannot pass that gate at all — the endpoint requires
`stream: true` — so a free-lane model only works on the streaming path.

The headers are derived from the conversation's session id, so they stay stable
for the life of the session — the endpoint groups quota and cache affinity by
session, and a fresh id per request would both break that and look like a
different client every turn. The disguise sits at the _bottom_ of the header
precedence chain: a provider profile's headers and any explicitly configured
header still win, so enabling the setting cannot clobber an endpoint that needs
its own headers.

The exact encoding of the session id (a truncated, inverted millisecond clock)
is documented in `opencode/headers.ts`; it is copied from `opencode2dsh`, which
validated it against the live service. Only enable the setting for endpoints
that need the disguise — sending OpenCode headers to an endpoint that does not
expect them is at best noise.
