/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal type definitions for the OpenAI Chat Completions wire format.
 *
 * These intentionally model only the subset of the protocol the Gemini CLI
 * needs to translate to and from. They are hand-written rather than imported
 * from a vendor SDK so that the OpenAI-compatible backend stays dependency-free
 * and so that proxies implementing a partial dialect (Ollama, vLLM, LM Studio,
 * LiteLLM, and friends) remain usable.
 */

export type OpenAIRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface OpenAITextContentPart {
  type: 'text';
  text: string;
}

export interface OpenAIImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

export type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart;

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatMessage {
  role: OpenAIRole;
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type OpenAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAIToolDefinition[];
  tool_choice?: OpenAIToolChoice;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  response_format?: Record<string, unknown>;
  reasoning_effort?: string;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** A single tool call as it appears inside a fully assembled message. */
export interface OpenAIResponseToolCall {
  id?: string;
  type?: string;
  /**
   * Present only while streaming, where it identifies which in-flight call a
   * delta belongs to. Omitted for single-call responses by some servers.
   */
  index?: number;
  function?: {
    name?: string;
    arguments?: string;
  };
}

/**
 * The streaming delta for one choice. `reasoning_content` and `reasoning` are
 * not part of the OpenAI specification; they are emitted by reasoning-capable
 * compatible servers (DeepSeek, Qwen, GLM, and others).
 */
export interface OpenAIStreamDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: OpenAIResponseToolCall[];
}

export interface OpenAIResponseMessage {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: OpenAIResponseToolCall[];
}

export interface OpenAIChoice {
  index?: number;
  delta?: OpenAIStreamDelta;
  message?: OpenAIResponseMessage;
  finish_reason?: string | null;
}

export interface OpenAIChatCompletion {
  id?: string;
  object?: string;
  model?: string;
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage | null;
  error?: OpenAIErrorBody;
}

export interface OpenAIErrorBody {
  message?: string;
  type?: string;
  code?: string | number | null;
  param?: string | null;
}

export interface OpenAIEmbeddingResponse {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
  usage?: OpenAIUsage | null;
}
