/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Translation between the Gemini `GenerateContent` dialect (what the rest of the
 * CLI speaks) and the OpenAI Chat Completions dialect (what an OpenAI-compatible
 * endpoint speaks).
 *
 * Everything here is a pure function so it can be unit tested without a network.
 */

import {
  FinishReason,
  GenerateContentResponse,
  type Content,
  type ContentListUnion,
  type ContentUnion,
  type EmbedContentParameters,
  type FunctionDeclaration,
  type GenerateContentParameters,
  type GenerateContentResponseUsageMetadata,
  type Part,
  type ToolConfig,
  type ToolUnion,
} from '@google/genai';
import { debugLogger } from '../../utils/debugLogger.js';
import type {
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAIContentPart,
  OpenAIResponseToolCall,
  OpenAIToolCall,
  OpenAIToolChoice,
  OpenAIToolDefinition,
  OpenAIUsage,
} from './types.js';

/**
 * Gemini `Type` enum values are upper case. OpenAI expects lower case JSON
 * Schema type names, so a declaration that fell back to `parameters` (rather
 * than `parametersJsonSchema`) still produces a valid tool definition.
 */
const SCHEMA_TYPE_MAP: Record<string, string> = {
  TYPE_UNSPECIFIED: 'object',
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
  NULL: 'null',
};

/** Keys that OpenAI's API rejects outright when present in a JSON Schema. */
const UNSUPPORTED_SCHEMA_KEYS = new Set(['$schema', '$id', 'definitions']);

/** JSON Schema keywords whose values are themselves schemas. */
const SUBSCHEMA_KEYS = ['items', 'additionalProperties', 'not'];

/** JSON Schema keywords whose values are arrays of schemas. */
const SUBSCHEMA_LIST_KEYS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];

/**
 * Separates a bare `Part` from a `Content` turn.
 *
 * `Content.parts` is optional, so a plain `'parts' in value` check does not
 * narrow the `Content | Part` union; a predicate that keys on the absence of
 * both turn-only fields does.
 */
function isPart(value: Content | Part): value is Part {
  return !('role' in value) && !('parts' in value);
}

/**
 * Normalizes the many shapes accepted by `contents` into a flat list of
 * `Content` entries, attaching a role to bare parts and strings.
 */
export function normalizeContents(
  contents: ContentListUnion | undefined,
): Content[] {
  if (contents === undefined) {
    return [];
  }
  // Annotated explicitly: `ContentListUnion` nests arrays, so the inferred
  // element type of `Array.isArray(contents) ? contents : [contents]` collapses
  // to a union that no longer matches the `Content | Part` shape handled below.
  const items: Array<Content | Part | string> = Array.isArray(contents)
    ? contents
    : [contents];
  const result: Content[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      result.push({ role: 'user', parts: [{ text: item }] });
    } else if (isPart(item)) {
      result.push({ role: 'user', parts: [item] });
    } else {
      result.push(item);
    }
  }
  return result;
}

/**
 * Flattens `systemInstruction`, which may be a string, a `Content`, or a bare
 * `Part`, into plain text.
 */
export function extractSystemText(
  systemInstruction: ContentUnion | undefined,
): string {
  if (systemInstruction === undefined) {
    return '';
  }
  // `ContentUnion` admits a bare part list as well as a turn, so it goes through
  // the same normalization used for `contents`.
  return normalizeContents(systemInstruction)
    .flatMap((content) => content.parts ?? [])
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * Converts an inline part into an image data URI.
 *
 * Anything that is not an image is rejected: `image_url` is the only inline
 * media slot in the Chat Completions protocol, and sending an audio or video
 * data URI through it makes the endpoint reject the whole request.
 */
function toDataUri(part: Part): string | undefined {
  const inlineData = part.inlineData;
  if (!inlineData?.mimeType || !inlineData.data) {
    return undefined;
  }
  if (!inlineData.mimeType.startsWith('image/')) {
    return undefined;
  }
  return `data:${inlineData.mimeType};base64,${inlineData.data}`;
}

/**
 * Converts conversation history into OpenAI chat messages.
 *
 * Notable rules, all derived from how `geminiChat` consumes and stores history:
 * - `thought` parts and `thoughtSignature` are Gemini-only and are dropped.
 * - A model turn becomes exactly one `assistant` message. Its `functionCall`
 *   parts are collapsed into a single `tool_calls` array so the following
 *   `tool` messages line up with it.
 * - `functionResponse` parts become standalone `tool` messages; OpenAI requires
 *   one message per tool result.
 */
export function toOpenAIMessages(
  contents: ContentListUnion | undefined,
  systemInstruction: ContentUnion | undefined,
  options: { developerRole: boolean },
): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [];
  const systemText = extractSystemText(systemInstruction);
  if (systemText) {
    messages.push({
      role: options.developerRole ? 'developer' : 'system',
      content: systemText,
    });
  }

  // Ids of the tool calls emitted by the most recent assistant message, used to
  // re-associate tool results that carry no id of their own.
  let pendingToolCallIds: string[] = [];
  let syntheticCallCounter = 0;

  for (const content of normalizeContents(contents)) {
    const isModelTurn = content.role === 'model';
    const parts = content.parts ?? [];

    if (isModelTurn) {
      const textChunks: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];

      for (const part of parts) {
        if (part.thought) {
          continue;
        }
        if (typeof part.text === 'string' && part.text.length > 0) {
          textChunks.push(part.text);
        }
        if (part.functionCall) {
          const name = part.functionCall.name ?? '';
          if (!name) {
            debugLogger.debug(
              '[OpenAI] Dropping function call with no name from history.',
            );
            continue;
          }
          const id =
            part.functionCall.id ?? `call_${name}_${syntheticCallCounter++}`;
          toolCalls.push({
            id,
            type: 'function',
            function: {
              name,
              arguments: safeStringifyArgs(part.functionCall.args),
            },
          });
        }
      }

      pendingToolCallIds = toolCalls.map((call) => call.id);

      const message: OpenAIChatMessage = { role: 'assistant' };
      const text = textChunks.join('');
      if (text) {
        message.content = text;
      }
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
        // OpenAI rejects an assistant message whose `content` is absent while
        // `tool_calls` is present only if the key is missing; `null` is the
        // documented encoding for "no text alongside the tool calls".
        message.content ??= null;
      }
      if (message.content !== undefined || message.tool_calls) {
        messages.push(message);
      }
      continue;
    }

    // User turn: tool results become their own messages, everything else is
    // gathered into a single user message so media stays in order.
    const userParts: OpenAIContentPart[] = [];
    for (const part of parts) {
      if (part.thought) {
        continue;
      }
      if (part.functionResponse) {
        const name = part.functionResponse.name ?? 'generic_tool';
        const id = part.functionResponse.id ?? pendingToolCallIds.shift();
        if (!id) {
          debugLogger.debug(
            `[OpenAI] Dropping tool result for "${name}" with no matching call id.`,
          );
          continue;
        }
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: stringifyToolResponse(part.functionResponse.response),
        });
        continue;
      }
      if (typeof part.text === 'string' && part.text.length > 0) {
        userParts.push({ type: 'text', text: part.text });
        continue;
      }
      const dataUri = toDataUri(part);
      if (dataUri) {
        userParts.push({ type: 'image_url', image_url: { url: dataUri } });
        continue;
      }
      if (part.inlineData) {
        debugLogger.debug(
          `[OpenAI] Dropping unsupported inline media of type "${part.inlineData.mimeType ?? 'unknown'}".`,
        );
        continue;
      }
      if (part.fileData) {
        debugLogger.debug(
          `[OpenAI] Dropping unsupported file reference "${part.fileData.fileUri ?? 'unknown'}".`,
        );
      }
    }

    if (userParts.length > 0) {
      messages.push({ role: 'user', content: userParts });
    }
  }

  return messages;
}

function safeStringifyArgs(args: unknown): string {
  if (args === undefined || args === null) {
    return '{}';
  }
  try {
    return JSON.stringify(args) ?? '{}';
  } catch {
    return '{}';
  }
}

function stringifyToolResponse(response: Record<string, unknown> | undefined) {
  if (response === undefined) {
    return '';
  }
  try {
    return JSON.stringify(response) ?? '';
  } catch {
    return '';
  }
}

/**
 * Recursively rewrites a Gemini-flavoured schema into something an
 * OpenAI-compatible endpoint will accept: lower-cased type names and none of
 * the JSON Schema meta keys that the OpenAI API rejects.
 */
export function sanitizeJsonSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const source = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) {
      continue;
    }
    if (key === 'type' && typeof value === 'string') {
      result['type'] = SCHEMA_TYPE_MAP[value] ?? value.toLowerCase();
      continue;
    }
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const properties: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        properties[propName] = sanitizeJsonSchema(propSchema);
      }
      result['properties'] = properties;
      continue;
    }
    if (SUBSCHEMA_KEYS.includes(key)) {
      result[key] = sanitizeJsonSchema(value);
      continue;
    }
    if (SUBSCHEMA_LIST_KEYS.includes(key) && Array.isArray(value)) {
      result[key] = value.map((entry) => sanitizeJsonSchema(entry));
      continue;
    }
    result[key] = value;
  }

  if (result['type'] === undefined && result['properties'] !== undefined) {
    result['type'] = 'object';
  }
  return result;
}

function declarationToTool(
  declaration: FunctionDeclaration,
): OpenAIToolDefinition | undefined {
  if (!declaration.name) {
    return undefined;
  }
  const rawSchema =
    declaration.parametersJsonSchema ?? declaration.parameters ?? undefined;
  const tool: OpenAIToolDefinition = {
    type: 'function',
    function: {
      name: declaration.name,
      parameters: sanitizeJsonSchema(rawSchema),
    },
  };
  if (declaration.description) {
    tool.function.description = declaration.description;
  }
  return tool;
}

/**
 * Converts Gemini tool declarations and the tool calling config into the OpenAI
 * `tools` / `tool_choice` pair.
 */
export function toOpenAITools(
  tools: ToolUnion[] | undefined,
  toolConfig: ToolConfig | undefined,
): { tools?: OpenAIToolDefinition[]; tool_choice?: OpenAIToolChoice } {
  const definitions: OpenAIToolDefinition[] = [];
  for (const tool of tools ?? []) {
    // `CallableTool` instances and hosted tools (googleSearch, codeExecution)
    // have no OpenAI equivalent and are skipped.
    if (!('functionDeclarations' in tool)) {
      continue;
    }
    for (const declaration of tool.functionDeclarations ?? []) {
      const converted = declarationToTool(declaration);
      if (converted) {
        definitions.push(converted);
      }
    }
  }
  if (definitions.length === 0) {
    return {};
  }

  const result: {
    tools?: OpenAIToolDefinition[];
    tool_choice?: OpenAIToolChoice;
  } = { tools: definitions };

  const callingConfig = toolConfig?.functionCallingConfig;
  const mode = callingConfig?.mode;
  if (mode === 'NONE') {
    result.tool_choice = 'none';
  } else if (mode === 'ANY') {
    const allowed = callingConfig?.allowedFunctionNames ?? [];
    result.tool_choice =
      allowed.length === 1
        ? { type: 'function', function: { name: allowed[0] } }
        : 'required';
  } else if (mode === 'AUTO' || mode === 'VALIDATED') {
    result.tool_choice = 'auto';
  }

  return result;
}

/**
 * Models that only accept the `developer` role and reject sampling parameters.
 * Matching is by prefix because these families carry suffixes (`o3-mini`,
 * `gpt-5.1-codex`, ...).
 */
const REASONING_MODEL_PREFIXES = ['o1', 'o3', 'o4', 'gpt-5'];

function matchesModelFamily(modelId: string, prefixes: string[]): boolean {
  const normalized = modelId.toLowerCase().replace(/^.*\//, '');
  return prefixes.some(
    (prefix) =>
      normalized === prefix ||
      normalized.startsWith(`${prefix}-`) ||
      normalized.startsWith(`${prefix}.`),
  );
}

export function usesDeveloperRole(modelId: string): boolean {
  return matchesModelFamily(modelId, REASONING_MODEL_PREFIXES);
}

function supportsSamplingParameters(modelId: string): boolean {
  return !matchesModelFamily(modelId, REASONING_MODEL_PREFIXES);
}

/**
 * Builds the OpenAI request body for a `generateContent` call.
 */
export function toOpenAIRequest(
  request: GenerateContentParameters,
  modelId: string,
  stream: boolean,
): OpenAIChatCompletionRequest {
  const config = request.config;
  const body: OpenAIChatCompletionRequest = {
    model: modelId,
    messages: toOpenAIMessages(request.contents, config?.systemInstruction, {
      developerRole: usesDeveloperRole(modelId),
    }),
  };

  const toolParams = toOpenAITools(config?.tools, config?.toolConfig);
  if (toolParams.tools) {
    body.tools = toolParams.tools;
  }
  if (toolParams.tool_choice) {
    body.tool_choice = toolParams.tool_choice;
  }

  if (supportsSamplingParameters(modelId)) {
    if (config?.temperature !== undefined) {
      body.temperature = config.temperature;
    }
    if (config?.topP !== undefined) {
      body.top_p = config.topP;
    }
  }
  if (config?.maxOutputTokens !== undefined) {
    body.max_tokens = config.maxOutputTokens;
  }
  if (config?.stopSequences?.length) {
    body.stop = config.stopSequences;
  }
  if (config?.responseMimeType === 'application/json') {
    body.response_format = { type: 'json_object' };
  }

  if (stream) {
    body.stream = true;
    // Without this, compatible servers omit `usage` from streamed responses and
    // the CLI loses its token accounting.
    body.stream_options = { include_usage: true };
  }

  return body;
}

const FINISH_REASON_MAP: Record<string, FinishReason> = {
  stop: FinishReason.STOP,
  // A completed tool call is a normal stop. Mapping it to
  // MALFORMED_FUNCTION_CALL would make geminiChat discard a perfectly good turn.
  tool_calls: FinishReason.STOP,
  function_call: FinishReason.STOP,
  length: FinishReason.MAX_TOKENS,
  content_filter: FinishReason.SAFETY,
};

export function toGeminiFinishReason(
  reason: string | null | undefined,
): FinishReason | undefined {
  if (!reason) {
    return undefined;
  }
  return FINISH_REASON_MAP[reason] ?? FinishReason.STOP;
}

export function toGeminiUsage(
  usage: OpenAIUsage | null | undefined,
): GenerateContentResponseUsageMetadata | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokenCount = usage.prompt_tokens ?? 0;
  const candidatesTokenCount = usage.completion_tokens ?? 0;
  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount:
      usage.total_tokens ?? promptTokenCount + candidatesTokenCount,
  };
}

/**
 * Wraps Gemini-shaped parts in a real `GenerateContentResponse` instance.
 *
 * The concrete class matters: `functionCalls` and `text` are prototype getters,
 * so a plain object literal would silently yield `undefined` in `geminiChat`.
 */
export function buildGeminiResponse(
  parts: Part[],
  finishReason: FinishReason | undefined,
  usage: GenerateContentResponseUsageMetadata | undefined,
): GenerateContentResponse {
  const response = new GenerateContentResponse();
  const candidate: {
    content: Content;
    finishReason?: FinishReason;
  } = { content: { role: 'model', parts } };
  if (finishReason) {
    candidate.finishReason = finishReason;
  }
  response.candidates = [candidate];
  if (usage) {
    response.usageMetadata = usage;
  }
  return response;
}

/**
 * Converts a complete (non-streamed) Chat Completion into a Gemini response.
 */
export function toGeminiResponse(completion: {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: OpenAIResponseToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage | null;
}): GenerateContentResponse {
  const choice = completion.choices?.[0];
  const parts: Part[] = [];

  const reasoning =
    choice?.message?.reasoning_content ?? choice?.message?.reasoning;
  if (reasoning) {
    parts.push({ text: reasoning, thought: true });
  }
  if (choice?.message?.content) {
    parts.push({ text: choice.message.content });
  }
  parts.push(...toGeminiToolCallParts(choice?.message?.tool_calls));

  return buildGeminiResponse(
    parts,
    toGeminiFinishReason(choice?.finish_reason),
    toGeminiUsage(completion.usage),
  );
}

/**
 * Converts assembled tool calls into `functionCall` parts. A tool call whose
 * arguments are not valid JSON is dropped rather than crashing the turn.
 */
export function toGeminiToolCallParts(
  toolCalls: OpenAIResponseToolCall[] | undefined,
): Part[] {
  const parts: Part[] = [];
  for (const [index, call] of (toolCalls ?? []).entries()) {
    const name = call.function?.name;
    if (!name) {
      continue;
    }
    const rawArgs = call.function?.arguments;
    let args: Record<string, unknown> = {};
    if (rawArgs) {
      try {
        const parsed: unknown = JSON.parse(rawArgs);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          args = parsed as Record<string, unknown>;
        }
      } catch {
        debugLogger.debug(
          `[OpenAI] Tool call "${name}" returned arguments that are not valid JSON; using empty arguments.`,
        );
      }
    }
    parts.push({
      functionCall: {
        id: call.id ?? `call_${name}_${index}`,
        name,
        args,
      },
    });
  }
  return parts;
}

/**
 * Derives the embeddings request body. Kept here so the generator does not have
 * to know about OpenAI field names.
 */
export function toOpenAIEmbeddingRequest(request: EmbedContentParameters): {
  model: string;
  input: string | string[];
} {
  // One embedding input per content, with that content's parts joined: a single
  // content carrying two text parts is still one thing to embed.
  const inputs: string[] = [];
  for (const content of normalizeContents(request.contents)) {
    const joined = (content.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');
    if (joined) {
      inputs.push(joined);
    }
  }
  return {
    model: request.model ?? '',
    input: inputs.length === 1 ? inputs[0] : inputs,
  };
}
