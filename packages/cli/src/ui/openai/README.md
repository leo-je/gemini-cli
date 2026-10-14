# OpenAI provider UI (CLI)

This directory holds the fork's provider picker and add-provider form alongside
the upstream OpenAI-compatible mode UI. It is a **fork-local directory**; the
files marked as fork-added below are owned by this fork.

The backend that these dialogs configure lives in
`packages/core/src/core/openai/`. Read its README first if you are new to the
feature.

## What the user sees

- `/provider` opens a picker listing the configured profiles, marking the one in
  use, and switches to the selection immediately.
- `/provider use <id>` does the same without the picker, for scripting.
- `/provider add` collects a new profile in four steps and adopts it at once.
- `/model list` lists the models the _active_ endpoint serves and records the
  choice back to the profile.

## File inventory

Fork-added (owned by this fork):

| File                                 | Purpose                                                                                                                                                 |
| :----------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ProviderDialog.tsx`                 | The endpoint picker. Reads profiles through the core loader so the dialog and the backend cannot disagree about what is valid.                          |
| `AddProviderDialog.tsx`              | The four-step form: id, base URL, optional default model, optional API key.                                                                             |
| `addProvider.ts`                     | Persists a collected profile. Derives the key's variable name and writes the value to `~/.gemini/.env`, so the secret never lands in the provider file. |
| `providerDialogRouting.ts`           | Routes the provider dialogs through the upstream `'model'` dialog action. See below.                                                                    |
| `ProviderDialogs.tsx`                | Renders whichever provider dialog is active, keeping the upstream `DialogManager` chain to one added branch.                                            |
| `useProviderDialogHandlers.ts`       | The dialog callbacks, kept out of the upstream `AppContainer`.                                                                                          |
| their `.test.tsx` / `.test.ts` files | Coverage for the above.                                                                                                                                 |

Upstream: `OpenAiEndpointDialog.tsx`, `OpenAiModelDialog.tsx`,
`openAiEndpointEnv.ts`, `openAiModelList.ts`, `index.ts`, and their tests. The
fork changes only two of these:

- `openAiEndpointEnv.ts` exports `renderEnvFile` so the provider writer merges
  into `.env` the same way the single-endpoint flow does.
- `openAiModelList.ts` routes its backend check through the core isolation
  module. That check has to consult `GEMINI_API_TYPE` as well as the config's
  auth type, because the auth type is only populated after `refreshAuth` runs.

## Why the dialogs reuse the `'model'` action

`OpenDialogActionReturn['dialog']` in `commands/types.ts` is an upstream union,
and `slashCommandProcessor.ts` switches over it. Adding `'provider'` and
`'addProvider'` to that union would mean editing two high-traffic upstream files
for a fork-only feature.

The union already carries `props?: Record<string, unknown>`, so the provider
dialogs are selected by a discriminator prop instead
(`providerDialogRouting.ts`), and dispatched from one hook inside the existing
`'model'` branch. The consequence: `commands/types.ts` is untouched, and
`slashCommandProcessor.ts` gains one import, two action declarations, and one
dispatch call — with no change to the dialog union or the rest of the switch.

If upstream ever adds a first-class provider dialog kind, delete
`providerDialogRouting.ts` and have the two commands return that kind directly.

## The `.env` write

`addProvider.ts` writes the API key to `~/.gemini/.env` and records only the
variable name in the provider file. Two details are deliberate:

- The write goes through the same comment-preserving merge as the upstream
  single-endpoint flow, so hand-written comments and unrelated variables in
  `.env` survive.
- The value is also put into `process.env` for the running process. Without
  that, a value in a project-level `.env` would shadow it, since environment
  loading only fills variables that are not already set, and the new provider
  would appear to need a restart.
