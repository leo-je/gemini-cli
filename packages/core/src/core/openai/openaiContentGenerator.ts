/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A `ContentGenerator` backed by any OpenAI-compatible Chat Completions
 * endpoint.
 *
 * Everything Gemini-specific lives in `converters.ts`; this class is only
 * responsible for issuing requests and reassembling the streamed response into
 * the chunk shape `geminiChat` expects.
 */

import {
  CountTokensResponse,
  EmbedContentResponse,
  FinishReason,
  type CountTokensParameters,
  type EmbedContentParameters,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
  type Part,
} from '@google/genai';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import type { Config } from '../../config/config.js';
import { debugLogger } from '../../utils/debugLogger.js';
import { estimateTokenCountSync } from '../../utils/tokenCalculation.js';
import type { LlmRole } from '../../telemetry/llmRole.js';
import {
  OpenAICompatibleClient,
  OpenAIHttpError,
  parseSseStream,
} from './openaiClient.js';
import {
  buildGeminiResponse,
  normalizeContents,
  toGeminiFinishReason,
  toGeminiResponse,
  toGeminiToolCallParts,
  toGeminiUsage,
  toOpenAIEmbeddingRequest,
  toOpenAIRequest,
} from './converters.js';
import type { OpenAIChatCompletion, OpenAIResponseToolCall } from './types.js';
import {
  OPENAI_HEADERS_ENV,
  OPENAI_MODEL_ID_ENV,
  OPENAI_MODEL_ID_FALLBACK_ENV,
  parseHeaderJson,
  readEnvValue,
  readEnvWithFallback,
} from './constants.js';

/** A partially accumulated `tool_calls` entry spread across stream deltas. */
interface PartialToolCall {
  id?: string;
  name: string;
  args: string;
}

export class OpenAIContentGenerator implements ContentGenerator {
  private readonly client: OpenAICompatibleClient;
  private readonly configuredModelId: string | undefined;

  constructor(config: ContentGeneratorConfig, gcConfig: Config) {
    this.configuredModelId = readEnvWithFallback(
      OPENAI_MODEL_ID_ENV,
      OPENAI_MODEL_ID_FALLBACK_ENV,
      gcConfig.env,
    );
    // `GEMINI_OPENAI_HEADERS` is merged over `config.customHeaders`, so the
    // user's explicit environment setting beats any programmatic default.
    const configuredHeaders = parseHeaderJson(
      readEnvValue(OPENAI_HEADERS_ENV, gcConfig.env),
    );
    this.client = new OpenAICompatibleClient({
      baseUrl: config.baseUrl ?? '',
      apiKey: config.apiKey ?? '',
      proxy: config.proxy,
      headers: { ...config.customHeaders, ...configuredHeaders },
    });
  }

  /**
   * Resolves the model to send to the endpoint.
   *
   * The model id is authoritative and required, taken from
   * `GEMINI_OPENAI_MODELID` or, failing that, `GEMINI_MODEL`. The rest of the
   * CLI still reasons in Gemini model names, so letting `request.model` through
   * would send something like `auto` or `gemini-3-pro` to an endpoint that has
   * never heard of it. `--model` therefore has no effect in this mode.
   */
  private resolveModelId(): string {
    if (!this.configuredModelId) {
      throw new Error(
        `${OPENAI_MODEL_ID_ENV} (or ${OPENAI_MODEL_ID_FALLBACK_ENV}) must be set when GEMINI_API_TYPE=openai.`,
      );
    }
    return this.configuredModelId;
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const modelId = this.resolveModelId();
    const body = toOpenAIRequest(request, modelId, false);
    const completion = await this.client.chatCompletion(
      body,
      request.config?.abortSignal,
    );
    if (completion.error) {
      throw new OpenAIHttpError(
        `OpenAI-compatible endpoint returned an error: ${completion.error.message ?? 'unknown error'}`,
        502,
      );
    }
    return toGeminiResponse(completion);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const modelId = this.resolveModelId();
    const body = toOpenAIRequest(request, modelId, true);
    // Issued eagerly so connection failures surface inside the caller's retry
    // loop rather than during iteration.
    const pending = await this.client.startChatCompletionStream(
      body,
      request.config?.abortSignal,
    );
    return this.consumeStream(pending.response.body!, pending.release);
  }

  /**
   * Reassembles SSE deltas into Gemini response chunks.
   *
   * Tool calls are buffered for the whole stream and emitted exactly once, in a
   * single terminal chunk. `geminiChat` accumulates `chunk.functionCalls` from
   * every chunk without deduplicating, so emitting a call more than once would
   * duplicate it in conversation history.
   */
  private async *consumeStream(
    body: ReadableStream<Uint8Array>,
    release: () => void,
  ): AsyncGenerator<GenerateContentResponse> {
    const pendingCalls = new Map<number, PartialToolCall>();
    let finishReason: FinishReason | undefined;
    let usage: GenerateContentResponseUsageMetadata | undefined;
    let producedOutput = false;

    try {
      for await (const payload of parseSseStream(body)) {
        let completion: OpenAIChatCompletion;
        try {
          const parsed: unknown = JSON.parse(payload);
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          completion = parsed as OpenAIChatCompletion;
        } catch {
          debugLogger.debug(
            `[OpenAI] Skipping unparseable stream frame: ${payload.slice(0, 120)}`,
          );
          continue;
        }

        if (completion.usage) {
          usage = toGeminiUsage(completion.usage) ?? usage;
        }

        const choice = completion.choices?.[0];
        if (!choice) {
          continue;
        }

        const parts: Part[] = [];
        const reasoning =
          choice.delta?.reasoning_content ?? choice.delta?.reasoning;
        if (reasoning) {
          parts.push({ text: reasoning, thought: true });
        }
        if (choice.delta?.content) {
          parts.push({ text: choice.delta.content });
        }
        for (const call of choice.delta?.tool_calls ?? []) {
          accumulateToolCall(pendingCalls, call);
        }
        if (choice.finish_reason) {
          finishReason = toGeminiFinishReason(choice.finish_reason);
        }

        if (parts.length > 0) {
          producedOutput = true;
          yield buildGeminiResponse(parts, undefined, undefined);
        }
      }
    } finally {
      release();
    }

    const toolCallParts = toGeminiToolCallParts(
      assembleToolCalls(pendingCalls),
    );
    if (toolCallParts.length > 0) {
      producedOutput = true;
    }

    // Some compatible servers close a perfectly good stream without ever
    // sending `finish_reason`. Synthesizing STOP keeps those usable, but only
    // when the stream actually produced something; an empty stream still fails
    // loudly in `geminiChat` rather than looking like a successful empty turn.
    if (!finishReason && producedOutput) {
      debugLogger.debug(
        '[OpenAI] Stream ended without a finish reason; treating it as a normal stop.',
      );
      finishReason = FinishReason.STOP;
    }

    yield buildGeminiResponse(toolCallParts, finishReason, usage);
  }

  /**
   * The OpenAI API has no token counting endpoint, so the shared local
   * estimator is used. `calculateRequestTokenCount` already falls back to this
   * same estimator whenever a counting request fails.
   */
  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const parts = normalizeContents(request.contents).flatMap(
      (content) => content.parts ?? [],
    );
    const response = new CountTokensResponse();
    response.totalTokens = estimateTokenCountSync(parts);
    return response;
  }

  /**
   * Embeddings are served by a different model than chat, so
   * `GEMINI_OPENAI_MODELID` is not substituted here. The requested embedding
   * model is passed through and the endpoint must recognize it.
   */
  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    const embeddingRequest = toOpenAIEmbeddingRequest(request);
    if (!embeddingRequest.model) {
      embeddingRequest.model = this.resolveModelId();
    } else if (embeddingRequest.model.startsWith('gemini-')) {
      debugLogger.debug(
        `[OpenAI] Requested embedding model "${embeddingRequest.model}" is a Gemini model name; the endpoint will most likely reject it.`,
      );
    }
    const result = await this.client.embeddings(
      embeddingRequest,
      request.config?.abortSignal,
    );
    const embeddings = (result.data ?? []).map((entry) => ({
      values: entry.embedding ?? [],
    }));
    if (embeddings.length === 0) {
      throw new Error(
        'OpenAI-compatible endpoint returned no embeddings for the request.',
      );
    }
    const response = new EmbedContentResponse();
    response.embeddings = embeddings;
    return response;
  }
}

/**
 * Merges one streamed `tool_calls` delta into the accumulator.
 *
 * Compatible servers vary in how they chunk a call: some resend the index and
 * id every time, some send the name only in the first fragment, and some omit
 * the index entirely for single-call responses.
 */
export function accumulateToolCall(
  pending: Map<number, PartialToolCall>,
  delta: OpenAIResponseToolCall,
): void {
  const index = delta.index ?? 0;
  const existing = pending.get(index) ?? { name: '', args: '' };
  if (delta.id) {
    existing.id = delta.id;
  }
  if (delta.function?.name) {
    existing.name = delta.function.name;
  }
  if (delta.function?.arguments) {
    existing.args += delta.function.arguments;
  }
  pending.set(index, existing);
}

export function assembleToolCalls(
  pending: Map<number, PartialToolCall>,
): OpenAIResponseToolCall[] {
  return [...pending.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.args },
    }));
}
