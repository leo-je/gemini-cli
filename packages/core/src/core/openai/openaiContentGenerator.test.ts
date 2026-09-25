/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { FinishReason, type GenerateContentResponse } from '@google/genai';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '../../config/config.js';
import { LlmRole } from '../../telemetry/llmRole.js';
import { AuthType, type ContentGeneratorConfig } from '../contentGenerator.js';
import { OpenAIHttpError } from './openaiClient.js';
import {
  OpenAIContentGenerator,
  accumulateToolCall,
  assembleToolCalls,
} from './openaiContentGenerator.js';

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function dataFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function makeGenerator(
  env: Record<string, string> = {},
  configOverrides: Partial<ContentGeneratorConfig> = {},
): OpenAIContentGenerator {
  const config: ContentGeneratorConfig = {
    authType: AuthType.USE_OPENAI,
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    ...configOverrides,
  };
  const gcConfig = { env } as unknown as Config;
  return new OpenAIContentGenerator(config, gcConfig);
}

async function collectChunks(
  generator: AsyncGenerator<GenerateContentResponse>,
): Promise<GenerateContentResponse[]> {
  const chunks: GenerateContentResponse[] = [];
  for await (const chunk of generator) {
    chunks.push(chunk);
  }
  return chunks;
}

const baseRequest = {
  model: 'gemini-3-pro',
  contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }],
};

describe('OpenAIContentGenerator', () => {
  beforeEach(() => {
    vi.stubEnv('GEMINI_OPENAI_MODELID', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('requires a model id', async () => {
    const generator = makeGenerator();
    await expect(
      generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    ).rejects.toThrow('GEMINI_OPENAI_MODELID');
  });

  it('sends the configured model id, not the Gemini one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        dataFrame({
          choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
        }),
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const generator = makeGenerator({ GEMINI_OPENAI_MODELID: 'gpt-4o' });
    await collectChunks(
      await generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect(JSON.parse(init.body as string).model).toBe('gpt-4o');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer test-key',
    );
  });

  it('sends headers configured through GEMINI_OPENAI_HEADERS', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        dataFrame({
          choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const generator = makeGenerator({
      GEMINI_OPENAI_MODELID: 'gpt-4o',
      GEMINI_OPENAI_HEADERS: '{"X-Tenant":"acme","X-Retries":3}',
    });
    await collectChunks(
      await generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    );

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers['X-Tenant']).toBe('acme');
    expect(headers['X-Retries']).toBe('3');
    // The defaults are still there alongside them.
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('lets a configured header replace a default one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        dataFrame({
          choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Azure-style endpoints authenticate with `api-key`, and a gateway may
    // want to replace the bearer token outright.
    const generator = makeGenerator({
      GEMINI_OPENAI_MODELID: 'gpt-4o',
      GEMINI_OPENAI_HEADERS:
        '{"Authorization":"Token abc","api-key":"secret","Content-Type":"application/json; charset=utf-8"}',
    });
    await collectChunks(
      await generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    );

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Token abc');
    expect(headers['api-key']).toBe('secret');
    expect(headers['Content-Type']).toBe('application/json; charset=utf-8');
  });

  // Regression: header names are case-insensitive, so a naive object spread let
  // `authorization` coexist with the default `Authorization` and `fetch` joined
  // them into `Bearer key, Token abc` — the endpoint then rejected a credential
  // the user had every reason to think they had replaced.
  it('replaces a default header even when the configured name differs in case', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        dataFrame({
          choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const generator = makeGenerator({
      GEMINI_OPENAI_MODELID: 'gpt-4o',
      GEMINI_OPENAI_HEADERS:
        '{"authorization":"Token abc","ACCEPT":"text/plain"}',
    });
    await collectChunks(
      await generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    );

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    const keys = Object.keys(headers);
    // Exactly one spelling, and it carries only the configured value.
    expect(keys.filter((k) => k.toLowerCase() === 'authorization')).toEqual([
      'authorization',
    ]);
    expect(headers['authorization']).toBe('Token abc');
    expect(keys.filter((k) => k.toLowerCase() === 'accept')).toEqual([
      'ACCEPT',
    ]);
    expect(headers['ACCEPT']).toBe('text/plain');
  });

  it('lets the environment variable beat config.customHeaders', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        dataFrame({
          choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const generator = makeGenerator(
      {
        GEMINI_OPENAI_MODELID: 'gpt-4o',
        GEMINI_OPENAI_HEADERS: '{"X-Tenant":"from-env","x-Only-Env":"e"}',
      },
      { customHeaders: { 'X-Tenant': 'from-config', 'X-Only-Config': 'c' } },
    );
    await collectChunks(
      await generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    );

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers['X-Tenant']).toBe('from-env');
    expect(headers['X-Only-Config']).toBe('c');
    expect(headers['x-Only-Env']).toBe('e');
  });

  it('rejects a malformed header configuration', () => {
    expect(() =>
      makeGenerator({
        GEMINI_OPENAI_MODELID: 'gpt-4o',
        GEMINI_OPENAI_HEADERS: '{not json',
      }),
    ).toThrow(/GEMINI_OPENAI_HEADERS must be valid JSON/);
  });

  it('appends /v1 to a bare origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        dataFrame({
          choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }],
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const generator = makeGenerator(
      { GEMINI_OPENAI_MODELID: 'gpt-4o' },
      { baseUrl: 'https://example.test' },
    );
    await collectChunks(
      await generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://example.test/v1/chat/completions',
    );
  });

  it('emits text chunks followed by a terminal chunk carrying the finish reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            dataFrame({ choices: [{ delta: { content: 'Hel' } }] }),
            dataFrame({ choices: [{ delta: { content: 'lo' } }] }),
            dataFrame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            'data: [DONE]\n\n',
          ]),
        ),
    );

    const generator = makeGenerator({ GEMINI_OPENAI_MODELID: 'gpt-4o' });
    const chunks = await collectChunks(
      await generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    );

    const texts = chunks
      .flatMap((chunk) => chunk.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text);
    expect(texts.join('')).toBe('Hello');

    const terminal = chunks.at(-1);
    // geminiChat throws NO_FINISH_REASON if the stream never reports one.
    expect(terminal?.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
  });

  it('synthesizes a finish reason when a lenient server omits one', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([dataFrame({ choices: [{ delta: { content: 'hi' } }] })]),
        ),
    );

    const generator = makeGenerator({ GEMINI_OPENAI_MODELID: 'gpt-4o' });
    const chunks = await collectChunks(
      await generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    );
    expect(chunks.at(-1)?.candidates?.[0]?.finishReason).toBe(
      FinishReason.STOP,
    );
  });

  it('leaves the finish reason unset when the stream produced nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n'])),
    );

    const generator = makeGenerator({ GEMINI_OPENAI_MODELID: 'gpt-4o' });
    const chunks = await collectChunks(
      await generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].candidates?.[0]?.finishReason).toBeUndefined();
  });

  it('assembles streamed tool calls and emits each exactly once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          dataFrame({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'c1',
                      function: { name: 'foo', arguments: '{"a"' },
                    },
                    {
                      index: 1,
                      id: 'c2',
                      function: { name: 'bar', arguments: '{' },
                    },
                  ],
                },
              },
            ],
          }),
          dataFrame({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: ':1}' } },
                    { index: 1, function: { arguments: '}' } },
                  ],
                },
              },
            ],
          }),
          dataFrame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const generator = makeGenerator({ GEMINI_OPENAI_MODELID: 'gpt-4o' });
    const chunks = await collectChunks(
      await generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    );

    // geminiChat accumulates chunk.functionCalls without deduplicating, so a
    // call appearing in two chunks would be duplicated in history.
    const calls = chunks.flatMap((chunk) => chunk.functionCalls ?? []);
    expect(calls).toEqual([
      { id: 'c1', name: 'foo', args: { a: 1 } },
      { id: 'c2', name: 'bar', args: {} },
    ]);
    expect(chunks.at(-1)?.candidates?.[0]?.finishReason).toBe(
      FinishReason.STOP,
    );
  });

  it('attaches usage from the trailing usage-only frame to the terminal chunk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          dataFrame({
            choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
          }),
          dataFrame({
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
          }),
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const generator = makeGenerator({ GEMINI_OPENAI_MODELID: 'gpt-4o' });
    const chunks = await collectChunks(
      await generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    );
    expect(chunks.at(-1)?.usageMetadata).toEqual({
      promptTokenCount: 5,
      candidatesTokenCount: 6,
      totalTokenCount: 11,
    });
  });

  it('skips unparseable frames instead of failing the turn', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {not json\n\n',
          dataFrame({
            choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
          }),
        ]),
      ),
    );

    const generator = makeGenerator({ GEMINI_OPENAI_MODELID: 'gpt-4o' });
    const chunks = await collectChunks(
      await generator.generateContentStream(baseRequest, 'p', LlmRole.MAIN),
    );
    expect(chunks[0].text).toBe('ok');
  });

  it('surfaces HTTP failures with a status the retry layer understands', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          statusText: 'Too Many Requests',
        }),
      ),
    );

    const generator = makeGenerator({ GEMINI_OPENAI_MODELID: 'gpt-4o' });
    const error = await generator
      .generateContentStream(baseRequest, 'p', LlmRole.MAIN)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAIHttpError);
    expect((error as OpenAIHttpError).status).toBe(429);
    expect((error as Error).message).toContain('rate limited');
  });

  it('issues a non-streaming request for generateContent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const generator = makeGenerator({ GEMINI_OPENAI_MODELID: 'gpt-4o' });
    const response = await generator.generateContent(
      baseRequest,
      'p',
      LlmRole.MAIN,
    );

    expect(response.text).toBe('hi');
    expect(
      JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
        .stream,
    ).toBeUndefined();
  });

  it('estimates token counts locally', async () => {
    const generator = makeGenerator({ GEMINI_OPENAI_MODELID: 'gpt-4o' });
    const response = await generator.countTokens({
      model: 'gpt-4o',
      contents: [{ role: 'user', parts: [{ text: 'hello world' }] }],
    });
    expect(response.totalTokens).toBeGreaterThan(0);
  });

  it('maps an embeddings response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3] }],
        }),
      ),
    );

    const generator = makeGenerator({ GEMINI_OPENAI_MODELID: 'gpt-4o' });
    const response = await generator.embedContent({
      model: 'text-embedding-3-small',
      contents: ['a', 'b'],
    });
    expect(response.embeddings).toEqual([
      { values: [0.1, 0.2] },
      { values: [0.3] },
    ]);
  });
});

describe('accumulateToolCall', () => {
  it('merges argument fragments across deltas', () => {
    const pending = new Map();
    accumulateToolCall(pending, {
      index: 0,
      id: 'c1',
      function: { name: 'foo', arguments: '{"a"' },
    });
    accumulateToolCall(pending, { index: 0, function: { arguments: ':1}' } });

    expect(assembleToolCalls(pending)).toEqual([
      {
        id: 'c1',
        type: 'function',
        function: { name: 'foo', arguments: '{"a":1}' },
      },
    ]);
  });

  it('treats a missing index as a single call', () => {
    const pending = new Map();
    accumulateToolCall(pending, {
      id: 'c1',
      function: { name: 'foo', arguments: '{}' },
    });
    expect(assembleToolCalls(pending)).toHaveLength(1);
  });

  it('orders calls by index regardless of arrival order', () => {
    const pending = new Map();
    accumulateToolCall(pending, {
      index: 1,
      id: 'c2',
      function: { name: 'b' },
    });
    accumulateToolCall(pending, {
      index: 0,
      id: 'c1',
      function: { name: 'a' },
    });
    expect(assembleToolCalls(pending).map((call) => call.id)).toEqual([
      'c1',
      'c2',
    ]);
  });
});
