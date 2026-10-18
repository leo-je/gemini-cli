/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Zen free lane gates chat requests on the body as well as the headers.
 *
 * A canonical `ses_*` header set alone still answers 403 `FreeTierError`
 * (`OpenCode's free tier can only be used from within OpenCode`). The request
 * is admitted only when the body also looks like an agent turn: `stream: true`
 * plus a `tools` array carrying `bash` and `read`. The gate is shape-based and
 * name-only — descriptions and JSON schemas go uninspected — so two
 * call-disabled placeholders satisfy it without giving the model anything
 * useful. Live-probed 2026-10-18 against
 * `https://opencode.ai/zen/v1/chat/completions`; the same gate is documented by
 * the reference client (`opencode2dsh-leo` adapter/messages.ts, free-lane tool
 * names).
 *
 * A placeholder can still be selected by the model. The names are reserved for
 * the host runtime, so such a call surfaces as an unknown-tool error instead of
 * executing anything.
 */

import type { OpenAIToolDefinition } from '../types.js';

const FREE_LANE_TOOL_NAMES = ['bash', 'read'] as const;

type FreeLaneToolName = (typeof FREE_LANE_TOOL_NAMES)[number];

function freeLaneTool(name: FreeLaneToolName): OpenAIToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  };
}

/**
 * Adds the free-lane placeholders a request body is missing, in place.
 *
 * Only appends: a tool the caller already declared under a gate name is left
 * untouched, so a real `bash` or `read` implementation keeps its schema.
 *
 * The gate also requires `stream: true`; that is a request-level choice made by
 * the caller, not something this helper can supply. Non-streaming calls to a
 * free-lane model are still rejected by the endpoint.
 */
export function ensureOpencodeFreeLaneShape(body: {
  tools?: OpenAIToolDefinition[];
}): void {
  const declared = new Set(
    (body.tools ?? []).map((tool) => tool.function.name),
  );
  const missing = FREE_LANE_TOOL_NAMES.filter((name) => !declared.has(name));
  if (missing.length === 0) {
    return;
  }
  body.tools = [...(body.tools ?? []), ...missing.map(freeLaneTool)];
}
