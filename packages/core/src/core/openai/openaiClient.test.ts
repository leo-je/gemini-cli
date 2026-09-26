/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { gzipSync } from 'node:zlib';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OpenAICompatibleClient,
  OpenAIHttpError,
  parseSseStream,
  resolveEndpointUrl,
} from './openaiClient.js';

function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(stream: AsyncGenerator<string>): Promise<string[]> {
  const values: string[] = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values;
}

describe('resolveEndpointUrl', () => {
  it('appends /v1 to a bare origin', () => {
    expect(
      resolveEndpointUrl('https://api.openai.com', '/chat/completions'),
    ).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('preserves an explicit path', () => {
    expect(
      resolveEndpointUrl('https://api.openai.com/v1', '/chat/completions'),
    ).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('keeps a non-standard mount path intact', () => {
    expect(
      resolveEndpointUrl(
        'https://gateway.example.com/openai/v1/',
        '/embeddings',
      ),
    ).toBe('https://gateway.example.com/openai/v1/embeddings');
  });

  it('supports local endpoints', () => {
    expect(
      resolveEndpointUrl('http://localhost:11434/v1', '/chat/completions'),
    ).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('rejects an unparseable URL', () => {
    expect(() => resolveEndpointUrl('not a url', '/chat/completions')).toThrow(
      'Invalid OpenAI base URL',
    );
  });
});

describe('parseSseStream', () => {
  it('yields each data payload', async () => {
    const stream = parseSseStream(
      byteStream(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']),
    );
    expect(await collect(stream)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('skips the [DONE] sentinel', async () => {
    const stream = parseSseStream(
      byteStream(['data: {"a":1}\n\n', 'data: [DONE]\n\n']),
    );
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  it('reassembles a frame split across chunks', async () => {
    const stream = parseSseStream(byteStream(['data: {"hel', 'lo":true}\n\n']));
    expect(await collect(stream)).toEqual(['{"hello":true}']);
  });

  it('handles CRLF line endings', async () => {
    const stream = parseSseStream(byteStream(['data: {"a":1}\r\n\r\n']));
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  it('emits a final frame with no trailing newline', async () => {
    const stream = parseSseStream(byteStream(['data: {"a":1}']));
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  it('ignores comment and non-data lines', async () => {
    const stream = parseSseStream(
      byteStream([': keep-alive\n', 'event: message\n', 'data: {"a":1}\n\n']),
    );
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  it('propagates consumer cancellation to the reader', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'));
      },
      cancel,
    });

    for await (const value of parseSseStream(stream)) {
      expect(value).toBe('{"a":1}');
      break;
    }
    expect(cancel).toHaveBeenCalled();
  });
});

describe('OpenAICompatibleClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires a base URL', () => {
    expect(
      () => new OpenAICompatibleClient({ baseUrl: '', apiKey: 'k' }),
    ).toThrow('GEMINI_OPENAI_BASE_URL');
  });

  it('sends a bearer token only when a key is configured', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
    }).chatCompletion({ model: 'm', messages: [] });

    const headers = (fetchMock.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('does not attach a proxy dispatcher when no proxy is configured', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
    }).chatCompletion({ model: 'm', messages: [] });

    expect(
      (fetchMock.mock.calls[0][1] as { dispatcher?: unknown }).dispatcher,
    ).toBeUndefined();
  });

  it('ignores an ambient proxy for a loopback endpoint', async () => {
    // HTTPS_PROXY is commonly set on developer machines (Clash, Charles,
    // corporate gateways); routing a local server through it fails every time.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      proxy: 'http://127.0.0.1:7890',
    }).chatCompletion({ model: 'm', messages: [] });

    expect(
      (fetchMock.mock.calls[0][1] as { dispatcher?: unknown }).dispatcher,
    ).toBeUndefined();
  });

  it('applies the proxy to a remote endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAICompatibleClient({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      proxy: 'http://127.0.0.1:7890',
    }).chatCompletion({ model: 'm', messages: [] });

    expect(
      (fetchMock.mock.calls[0][1] as { dispatcher?: unknown }).dispatcher,
    ).toBeDefined();
  });

  it('reports a non-JSON body as an HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('<html>nope</html>', { status: 200 })),
    );

    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
    });
    const error = await client
      .chatCompletion({ model: 'm', messages: [] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAIHttpError);
    expect((error as Error).message).toContain('non-JSON');
  });

  it('extracts the message from an error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'bad model' } }), {
          status: 404,
        }),
      ),
    );

    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
    });
    const error = await client
      .chatCompletion({ model: 'm', messages: [] })
      .catch((e: unknown) => e);

    expect((error as OpenAIHttpError).status).toBe(404);
    expect((error as Error).message).toContain('bad model');
  });

  it('reports the whole body when error.message hides the cause', async () => {
    // Observed against OpenRouter: `message` is a fixed string and the real
    // reason ("content is not a supported image type") lives in a sibling
    // field. Reporting only the message left the user with no way to diagnose it.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'Provider returned error',
              code: 400,
              metadata: {
                provider_name: 'Thinking Machines',
                raw: '{"error":{"message":"content is not a supported image type (png, jpeg, gif, webp)","type":"airlock_error"}}',
              },
            },
          }),
          { status: 400 },
        ),
      ),
    );

    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
    });
    const error = await client
      .chatCompletion({ model: 'm', messages: [] })
      .catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain('Provider returned error');
    // The nested cause must survive into the message the user sees.
    expect(message).toContain('content is not a supported image type');
    // The untruncated body is kept for a debug dump.
    expect((error as OpenAIHttpError).body).toContain('airlock_error');
  });

  it('truncates a very large error body in the message but keeps it on the error', async () => {
    const huge = 'x'.repeat(5000);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(huge, { status: 500 })),
    );

    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
    });
    const error = await client
      .chatCompletion({ model: 'm', messages: [] })
      .catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain('truncated');
    expect(message.length).toBeLessThan(huge.length);
    expect((error as OpenAIHttpError).body).toHaveLength(5000);
  });

  it('collapses newlines in the body so the message stays a single line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{\n  "error": {\n    "message": "boom"\n  }\n}', {
          status: 500,
        }),
      ),
    );

    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
    });
    const error = await client
      .chatCompletion({ model: 'm', messages: [] })
      .catch((e: unknown) => e);

    expect((error as Error).message).not.toContain('\n');
  });

  it('omits the body suffix when the response has no readable body', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 502, statusText: 'Bad Gateway' }),
        ),
    );

    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
    });
    const error = await client
      .chatCompletion({ model: 'm', messages: [] })
      .catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      'OpenAI-compatible endpoint returned HTTP 502',
    );
    expect((error as OpenAIHttpError).body).toBeUndefined();
  });

  it('decodes a gzip error body that arrived without a content-encoding header', async () => {
    // Observed against a Cloudflare-fronted endpoint reached through a proxy
    // dispatcher: the body arrives gzipped but the header is absent, so the
    // status line is all the caller would otherwise see.
    const payload = JSON.stringify({
      error: { message: 'this model is gated', code: 403 },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(gzipSync(Buffer.from(payload))), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
    });
    const error = await client
      .chatCompletion({ model: 'm', messages: [] })
      .catch((e: unknown) => e);

    expect((error as OpenAIHttpError).status).toBe(403);
    expect((error as Error).message).toContain('this model is gated');
  });

  it('leaves an unrecognized binary body untouched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03]), {
          status: 500,
        }),
      ),
    );

    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
    });
    const error = await client
      .chatCompletion({ model: 'm', messages: [] })
      .catch((e: unknown) => e);

    expect((error as OpenAIHttpError).status).toBe(500);
  });

  it('opens the stream eagerly so connection errors are retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
    });
    // The rejection must happen on the call, not on first iteration of the
    // returned generator: retryWithBackoff only wraps the call.
    await expect(
      client.startChatCompletionStream({ model: 'm', messages: [] }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
