/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A dependency-free HTTP client for OpenAI-compatible Chat Completions and
 * Embeddings endpoints.
 *
 * Deliberately uses the platform `fetch` rather than `utils/fetch.ts`. That
 * helper applies a fail-closed SSRF guard which rejects every private and
 * loopback destination, and OpenAI-compatible servers routinely run on
 * localhost (Ollama, vLLM, LM Studio) or inside a private network. The base URL
 * here comes from the user's own environment, the same trust level as the
 * existing `GOOGLE_GEMINI_BASE_URL` gateway override.
 *
 * Requests are issued eagerly (the call resolves once response headers arrive)
 * rather than lazily inside the stream generator. `retryWithBackoff` only wraps
 * the call itself, so a lazily-issued request would let 429 and 5xx responses
 * escape the CLI's retry layer entirely.
 */

import { gunzipSync, inflateSync } from 'node:zlib';
import type * as undici from 'undici';
import { createSafeProxyAgent, isLoopbackHost } from '../../utils/fetch.js';
import { debugLogger } from '../../utils/debugLogger.js';
import type {
  OpenAIChatCompletion,
  OpenAIChatCompletionRequest,
  OpenAIEmbeddingResponse,
} from './types.js';

/** Mirrors the header timeout used by `utils/fetch.ts`. */
const HEADERS_TIMEOUT_MS = 60_000;
/** Mirrors the body timeout used by `utils/fetch.ts`, applied per streamed event. */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * An HTTP failure from an OpenAI-compatible endpoint.
 *
 * Carries `status` so the CLI's retry layer (`isRetryableError`, which reads
 * `error.status`) retries 429 and 5xx exactly as it does for Gemini.
 *
 * `body` holds the decoded response body. Endpoints routinely bury the actual
 * cause away from `error.message` — a gateway may report a generic
 * "Provider returned error" and put the real reason in a nested field, so
 * dropping the body would leave the user with a message that names the status
 * and nothing else.
 */
export class OpenAIHttpError extends Error {
  readonly status: number;
  /** The decoded response body, or `undefined` when it could not be read. */
  readonly body?: string;

  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = 'OpenAIHttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Renders a response body for an error message.
 *
 * The whole body is included rather than just `error.message`, because the
 * useful text is often one level deeper — an OpenAI-compatible gateway will
 * report `{"error":{"message":"Provider returned error","metadata":{"raw":
 * "..."}}}` where only `metadata.raw` says what actually went wrong.
 *
 * Truncated because an error body can be arbitrarily large (a proxy echoing a
 * failed request, say) and this text is rendered into a single UI line. The
 * debug log keeps the untruncated body.
 */
const MAX_ERROR_BODY_CHARS = 2000;

function formatErrorBody(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_ERROR_BODY_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated, ${collapsed.length} chars total)`;
}

type FetchOptions = RequestInit & { dispatcher?: undici.Dispatcher };

/**
 * Normalizes the user-provided base URL and appends the API path.
 *
 * A bare origin gains a `/v1` segment, which is the overwhelmingly common
 * convention. Anything that already carries a path is used verbatim, so
 * `/v1`-suffixed URLs, Azure-style deployment URLs, and root-mounted proxies
 * all work without special-casing.
 */
export function resolveEndpointUrl(baseUrl: string, path: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error(`Invalid OpenAI base URL: ${baseUrl}`);
  }
  const trimmed = parsed.toString().replace(/\/+$/, '');
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const base = pathname === '' ? `${trimmed}/v1` : trimmed;
  return `${base}${path}`;
}

/**
 * An in-flight response together with the teardown for its headers timer.
 *
 * The timer stays armed until the body has been fully consumed, so a server
 * that sends headers promptly but then stalls forever still fails the request.
 */
interface PendingResponse {
  response: Response;
  release: () => void;
}

/**
 * Links the caller's abort signal to a controller that also fires when the
 * headers timeout elapses.
 */
function buildBoundedSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Request headers timed out')),
    timeoutMs,
  );
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener(
        'abort',
        () => controller.abort(callerSignal.reason),
        { once: true },
      );
    }
  }
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Decodes a body that arrived compressed despite carrying no usable
 * `Content-Encoding` header.
 *
 * `fetch` normally decompresses responses for us, but that depends on the
 * header surviving the trip. Behind a proxy dispatcher it can be dropped, and a
 * Cloudflare-fronted error then surfaces as raw gzip bytes — turning a readable
 * "403: this model is unavailable" into mojibake that hides the real cause. The
 * magic-byte check recovers the original text; anything unrecognized is
 * returned untouched, so genuine binary payloads are never mangled.
 */
function decodeCompressedBody(bytes: Buffer): Buffer {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return gunzipSync(bytes);
    } catch {
      return bytes;
    }
  }
  // 0x78 is the zlib CMF byte for a 32K window; the second byte is the check.
  if (bytes[0] === 0x78 && [0x01, 0x9c, 0xda].includes(bytes[1] ?? -1)) {
    try {
      return inflateSync(bytes);
    } catch {
      return bytes;
    }
  }
  return bytes;
}

/**
 * Reads a response body as text, tolerating an undecoded compressed payload.
 */
async function readResponseText(response: Response): Promise<string> {
  const bytes = Buffer.from(await response.arrayBuffer());
  return decodeCompressedBody(bytes).toString('utf8');
}

/**
 * Builds an `OpenAIHttpError` from a failed response.
 *
 * `error.message` alone is often not enough to act on. An OpenAI-compatible
 * gateway can answer `{"error":{"message":"Provider returned error","metadata":
 * {"raw":"...content is not a supported image type..."}}}` — the message is a
 * fixed string and the actual cause sits in a sibling field. So the full body
 * is reported rather than just the extracted message, and kept on the error so
 * a debug dump can show it untruncated.
 */
async function toHttpError(response: Response): Promise<OpenAIHttpError> {
  let body = '';
  try {
    body = await readResponseText(response);
  } catch {
    // A body that cannot be read (already consumed, truncated connection) still
    // leaves the status worth reporting.
    body = '';
  }

  const summary = body ? formatErrorBody(body) : '';
  const message = summary
    ? `OpenAI-compatible endpoint returned HTTP ${response.status}: ${summary}`
    : `OpenAI-compatible endpoint returned HTTP ${response.status}`;

  return new OpenAIHttpError(message, response.status, body || undefined);
}

export class OpenAICompatibleClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly dispatcher: undici.Dispatcher | undefined;

  constructor(options: {
    baseUrl: string;
    apiKey: string;
    proxy?: string;
    headers?: Record<string, string>;
  }) {
    if (!options.baseUrl) {
      throw new Error(
        'OpenAI-compatible mode requires GEMINI_OPENAI_BASE_URL to be set.',
      );
    }
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    this.dispatcher = this.resolveDispatcher(options.proxy);
  }

  /**
   * Builds the proxy dispatcher for the request, if one is needed.
   *
   * `HTTPS_PROXY` is commonly set on developer machines (Clash, Charles,
   * corporate gateways) and the CLI forwards it here. Applying it to a loopback
   * endpoint would route local traffic — Ollama, LM Studio, vLLM — through a
   * proxy that cannot serve it, so loopback always connects directly. Only
   * `NO_PROXY` would normally express this, and it is frequently unset.
   */
  private resolveDispatcher(
    proxy: string | undefined,
  ): undici.Dispatcher | undefined {
    const trimmed = proxy?.trim();
    if (!trimmed) {
      return undefined;
    }
    let hostname: string;
    try {
      hostname = new URL(this.baseUrl).hostname;
    } catch {
      // The URL is validated when the endpoint is resolved.
      return undefined;
    }
    if (isLoopbackHost(hostname)) {
      debugLogger.debug(
        `[OpenAI] Ignoring proxy for loopback endpoint ${hostname}.`,
      );
      return undefined;
    }
    return createSafeProxyAgent(trimmed);
  }

  private buildHeaders(accept: string): Record<string, string> {
    // Header names are case-insensitive on the wire, but a plain object spread
    // treats `authorization` and `Authorization` as different keys — and `fetch`
    // then *joins* both into one comma-separated value instead of replacing it,
    // so `{"authorization":"Token abc"}` would send `Bearer key, Token abc` and
    // the endpoint would reject the combined credential. Fold to lowercase for
    // lookup so a configured header always replaces its default; keep the
    // winning spelling for the emitted name.
    const merged = new Map<string, [string, string]>();
    const set = (name: string, value: string) =>
      merged.set(name.toLowerCase(), [name, value]);

    set('Content-Type', 'application/json');
    set('Accept', accept);
    set('User-Agent', 'gemini-cli (openai-compatible)');
    if (this.apiKey) {
      set('Authorization', `Bearer ${this.apiKey}`);
    }
    // Configured headers are applied last so they win. An endpoint that
    // authenticates with `api-key` instead of a bearer token, or that wants a
    // different Content-Type, has no other way to say so.
    for (const [name, value] of Object.entries(this.extraHeaders)) {
      set(name, value);
    }
    return Object.fromEntries([...merged.values()]);
  }

  private async post(
    path: string,
    body: unknown,
    accept: string,
    signal: AbortSignal | undefined,
  ): Promise<PendingResponse> {
    const url = resolveEndpointUrl(this.baseUrl, path);
    const bounded = buildBoundedSignal(signal, HEADERS_TIMEOUT_MS);
    const options: FetchOptions = {
      method: 'POST',
      headers: this.buildHeaders(accept),
      body: JSON.stringify(body),
      signal: bounded.signal,
    };
    if (this.dispatcher) {
      options.dispatcher = this.dispatcher;
    }
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        bounded.clear();
        throw await toHttpError(response);
      }
      return { response, release: bounded.clear };
    } catch (error) {
      bounded.clear();
      throw error;
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await readResponseText(response);
    try {
      return JSON.parse(text);
    } catch {
      // The body is not JSON, so it is the only description of the failure
      // available — report it in full rather than a 200-character glimpse.
      throw new OpenAIHttpError(
        `OpenAI-compatible endpoint returned a non-JSON response: ${formatErrorBody(text)}`,
        response.status,
        text || undefined,
      );
    }
  }

  /**
   * Issues a non-streaming Chat Completion.
   */
  async chatCompletion(
    body: OpenAIChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<OpenAIChatCompletion> {
    const { response, release } = await this.post(
      '/chat/completions',
      body,
      'application/json',
      signal,
    );
    try {
      const parsed = await this.readJson(response);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return parsed as OpenAIChatCompletion;
    } finally {
      release();
    }
  }

  /**
   * Starts a streaming Chat Completion and returns the open response body.
   *
   * Resolves once response headers arrive, so connection-level failures are
   * observable by the caller's retry loop.
   */
  async startChatCompletionStream(
    body: OpenAIChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<PendingResponse> {
    const pending = await this.post(
      '/chat/completions',
      body,
      'text/event-stream',
      signal,
    );
    if (!pending.response.body) {
      pending.release();
      throw new OpenAIHttpError(
        'OpenAI-compatible endpoint returned an empty streaming response.',
        pending.response.status,
      );
    }
    return pending;
  }

  /**
   * Issues an embeddings request.
   */
  async embeddings(
    body: { model: string; input: string | string[] },
    signal?: AbortSignal,
  ): Promise<OpenAIEmbeddingResponse> {
    const { response, release } = await this.post(
      '/embeddings',
      body,
      'application/json',
      signal,
    );
    try {
      const parsed = await this.readJson(response);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return parsed as OpenAIEmbeddingResponse;
    } finally {
      release();
    }
  }
}

/**
 * Parses an SSE byte stream into individual `data:` payloads.
 *
 * `[DONE]` sentinels and comment lines are dropped. Cancelling the consumer
 * (Ctrl+C, an abort, a `break`) propagates into the underlying reader so the
 * socket is released promptly.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const idleError = new OpenAIHttpError(
        `OpenAI-compatible stream was idle for more than ${STREAM_IDLE_TIMEOUT_MS}ms.`,
        408,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(idleError), STREAM_IDLE_TIMEOUT_MS);
      });

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), idle]);
      } catch (error) {
        if (error === idleError) {
          debugLogger.debug('[OpenAI] Aborting stream after idle timeout.');
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }

      if (result.done) {
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload && payload !== '[DONE]') {
            yield payload;
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }

    // A final frame may arrive without a trailing newline.
    const tail = buffer.replace(/\r$/, '');
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        yield payload;
      }
    }
  } finally {
    await reader.cancel().catch(() => {
      // The stream may already be closed or errored; nothing to clean up.
    });
  }
}
