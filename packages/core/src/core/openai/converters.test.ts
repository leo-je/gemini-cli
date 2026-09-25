/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FinishReason,
  FunctionCallingConfigMode,
  type Content,
  type ContentListUnion,
  type Part,
} from '@google/genai';
import { describe, it, expect } from 'vitest';
import {
  buildGeminiResponse,
  extractSystemText,
  normalizeContents,
  sanitizeJsonSchema,
  toGeminiFinishReason,
  toGeminiResponse,
  toGeminiToolCallParts,
  toGeminiUsage,
  toOpenAIEmbeddingRequest,
  toOpenAIMessages,
  toOpenAIRequest,
  toOpenAITools,
} from './converters.js';

const text = (value: string): Part => ({ text: value });

describe('normalizeContents', () => {
  it('returns an empty list for undefined', () => {
    expect(normalizeContents(undefined)).toEqual([]);
  });

  it('wraps a bare string as a user turn', () => {
    expect(normalizeContents('hello')).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
    ]);
  });

  it('wraps a bare part as a user turn', () => {
    expect(normalizeContents(text('hello'))).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
    ]);
  });

  it('passes a content turn through unchanged', () => {
    const content: Content = { role: 'model', parts: [text('hi')] };
    expect(normalizeContents(content)).toEqual([content]);
  });

  it('handles a mixed array of turns and bare parts', () => {
    const mixed = [
      { role: 'model', parts: [text('a')] },
      text('b'),
    ] as ContentListUnion;
    expect(normalizeContents(mixed)).toEqual([
      { role: 'model', parts: [{ text: 'a' }] },
      { role: 'user', parts: [{ text: 'b' }] },
    ]);
  });
});

describe('extractSystemText', () => {
  it('returns an empty string when unset', () => {
    expect(extractSystemText(undefined)).toBe('');
  });

  it('accepts a plain string', () => {
    expect(extractSystemText('be nice')).toBe('be nice');
  });

  it('accepts a content turn', () => {
    expect(
      extractSystemText({ role: 'system', parts: [text('a'), text('b')] }),
    ).toBe('ab');
  });

  it('accepts a bare part list', () => {
    expect(extractSystemText([text('x'), 'y'])).toBe('xy');
  });
});

describe('toOpenAIMessages', () => {
  const options = { developerRole: false };

  it('places the system instruction first', () => {
    const messages = toOpenAIMessages([], 'sys', options);
    expect(messages).toEqual([{ role: 'system', content: 'sys' }]);
  });

  it('uses the developer role when requested', () => {
    const messages = toOpenAIMessages([], 'sys', { developerRole: true });
    expect(messages[0].role).toBe('developer');
  });

  it('maps user and model text turns', () => {
    const messages = toOpenAIMessages(
      [
        { role: 'user', parts: [text('hi')] },
        { role: 'model', parts: [text('hello')] },
      ],
      undefined,
      options,
    );
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('drops thought parts and thought signatures', () => {
    const messages = toOpenAIMessages(
      [
        {
          role: 'model',
          parts: [{ text: 'thinking...', thought: true }, { text: 'answer' }],
        },
      ],
      undefined,
      options,
    );
    expect(messages).toEqual([{ role: 'assistant', content: 'answer' }]);
  });

  it('collapses model function calls into one assistant message', () => {
    const messages = toOpenAIMessages(
      [
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'c1', name: 'foo', args: { a: 1 } } },
            { functionCall: { id: 'c2', name: 'bar', args: {} } },
          ],
        },
      ],
      undefined,
      options,
    );
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'foo', arguments: '{"a":1}' },
          },
          {
            id: 'c2',
            type: 'function',
            function: { name: 'bar', arguments: '{}' },
          },
        ],
      },
    ]);
  });

  it('turns function responses into standalone tool messages', () => {
    const messages = toOpenAIMessages(
      [
        {
          role: 'model',
          parts: [{ functionCall: { id: 'c1', name: 'foo', args: {} } }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'c1',
                name: 'foo',
                response: { ok: true },
              },
            },
          ],
        },
      ],
      undefined,
      options,
    );
    expect(messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"ok":true}',
    });
  });

  it('matches id-less function responses positionally', () => {
    const messages = toOpenAIMessages(
      [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'a', args: {} } },
            { functionCall: { name: 'b', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'a', response: { n: 1 } } },
            { functionResponse: { name: 'b', response: { n: 2 } } },
          ],
        },
      ],
      undefined,
      options,
    );
    const assistant = messages[0];
    const callIds = assistant.tool_calls?.map((call) => call.id);
    expect(callIds).toHaveLength(2);
    expect(messages[1].tool_call_id).toBe(callIds?.[0]);
    expect(messages[2].tool_call_id).toBe(callIds?.[1]);
  });

  it('converts inline images to data URIs', () => {
    const messages = toOpenAIMessages(
      [
        {
          role: 'user',
          parts: [
            text('look'),
            { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
      undefined,
      options,
    );
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('drops non-image inline data and file references', () => {
    const messages = toOpenAIMessages(
      [
        {
          role: 'user',
          parts: [
            text('listen'),
            { inlineData: { mimeType: 'audio/wav', data: 'AAAA' } },
            {
              fileData: { mimeType: 'application/pdf', fileUri: 'https://x/y' },
            },
          ],
        },
      ],
      undefined,
      options,
    );
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'listen' }] },
    ]);
  });
});

describe('sanitizeJsonSchema', () => {
  it('strips keys the OpenAI API rejects', () => {
    expect(
      sanitizeJsonSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'x',
        type: 'object',
        properties: { a: { type: 'string' } },
      }),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
  });

  it('lower-cases Gemini Type enum values', () => {
    expect(
      sanitizeJsonSchema({
        type: 'OBJECT',
        properties: { n: { type: 'INTEGER' } },
      }),
    ).toEqual({
      type: 'object',
      properties: { n: { type: 'integer' } },
    });
  });

  it('recurses into items and combinators', () => {
    expect(
      sanitizeJsonSchema({
        type: 'ARRAY',
        items: { type: 'STRING' },
        anyOf: [{ type: 'BOOLEAN' }],
      }),
    ).toEqual({
      type: 'array',
      items: { type: 'string' },
      anyOf: [{ type: 'boolean' }],
    });
  });

  it('defaults a non-object input to an empty object schema', () => {
    expect(sanitizeJsonSchema(undefined)).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('toOpenAITools', () => {
  const declarations = [
    {
      name: 'foo',
      description: 'does foo',
      parametersJsonSchema: { type: 'object', properties: {} },
    },
  ];

  it('returns nothing when there are no tools', () => {
    expect(toOpenAITools(undefined, undefined)).toEqual({});
    expect(toOpenAITools([], undefined)).toEqual({});
  });

  it('maps function declarations onto OpenAI tools', () => {
    const result = toOpenAITools(
      [{ functionDeclarations: declarations }],
      undefined,
    );
    expect(result.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'foo',
          description: 'does foo',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
  });

  it('skips tools with no OpenAI equivalent', () => {
    const result = toOpenAITools([{ googleSearch: {} } as never], undefined);
    expect(result).toEqual({});
  });

  it.each([
    [FunctionCallingConfigMode.AUTO, 'auto'],
    [FunctionCallingConfigMode.NONE, 'none'],
    [FunctionCallingConfigMode.VALIDATED, 'auto'],
  ])('maps %s mode to %s', (mode, expected) => {
    const result = toOpenAITools([{ functionDeclarations: declarations }], {
      functionCallingConfig: { mode },
    });
    expect(result.tool_choice).toBe(expected);
  });

  it('maps ANY with a single allowed name to a named tool choice', () => {
    const result = toOpenAITools([{ functionDeclarations: declarations }], {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.ANY,
        allowedFunctionNames: ['foo'],
      },
    });
    expect(result.tool_choice).toEqual({
      type: 'function',
      function: { name: 'foo' },
    });
  });

  it('maps ANY with multiple allowed names to required', () => {
    const result = toOpenAITools([{ functionDeclarations: declarations }], {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.ANY,
        allowedFunctionNames: ['foo', 'bar'],
      },
    });
    expect(result.tool_choice).toBe('required');
  });
});

describe('toGeminiFinishReason', () => {
  it.each([
    ['stop', FinishReason.STOP],
    ['length', FinishReason.MAX_TOKENS],
    ['content_filter', FinishReason.SAFETY],
  ])('maps %s to %s', (input, expected) => {
    expect(toGeminiFinishReason(input)).toBe(expected);
  });

  it('maps a completed tool call to STOP rather than a malformed call', () => {
    // Mapping to MALFORMED_FUNCTION_CALL would make geminiChat discard the turn.
    expect(toGeminiFinishReason('tool_calls')).toBe(FinishReason.STOP);
    expect(toGeminiFinishReason('function_call')).toBe(FinishReason.STOP);
  });

  it('returns undefined for a missing reason', () => {
    expect(toGeminiFinishReason(null)).toBeUndefined();
    expect(toGeminiFinishReason(undefined)).toBeUndefined();
    expect(toGeminiFinishReason('')).toBeUndefined();
  });
});

describe('toGeminiUsage', () => {
  it('maps token counts', () => {
    expect(
      toGeminiUsage({
        prompt_tokens: 3,
        completion_tokens: 4,
        total_tokens: 7,
      }),
    ).toEqual({
      promptTokenCount: 3,
      candidatesTokenCount: 4,
      totalTokenCount: 7,
    });
  });

  it('derives the total when the server omits it', () => {
    expect(toGeminiUsage({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({
      promptTokenCount: 3,
      candidatesTokenCount: 4,
      totalTokenCount: 7,
    });
  });

  it('returns undefined when there is no usage', () => {
    expect(toGeminiUsage(null)).toBeUndefined();
  });
});

describe('buildGeminiResponse', () => {
  it('produces a real GenerateContentResponse so prototype getters work', () => {
    const response = buildGeminiResponse(
      [{ functionCall: { id: 'c1', name: 'foo', args: { a: 1 } } }, text('hi')],
      FinishReason.STOP,
      undefined,
    );
    // `functionCalls` and `text` are getters on the SDK class; a plain object
    // literal would yield undefined here.
    expect(response.functionCalls).toEqual([
      { id: 'c1', name: 'foo', args: { a: 1 } },
    ]);
    expect(response.text).toBe('hi');
    expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
  });

  it('omits finishReason and usage when not provided', () => {
    const response = buildGeminiResponse([text('hi')], undefined, undefined);
    expect(response.candidates?.[0]?.finishReason).toBeUndefined();
    expect(response.usageMetadata).toBeUndefined();
  });
});

describe('toGeminiResponse', () => {
  it('maps a complete chat completion', () => {
    const response = toGeminiResponse({
      choices: [
        {
          message: {
            content: 'hello',
            tool_calls: [
              { id: 'c1', function: { name: 'foo', arguments: '{"a":1}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(response.text).toBe('hello');
    expect(response.functionCalls).toEqual([
      { id: 'c1', name: 'foo', args: { a: 1 } },
    ]);
    expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
    expect(response.usageMetadata?.totalTokenCount).toBe(3);
  });

  it('exposes reasoning content as thought parts', () => {
    const response = toGeminiResponse({
      choices: [
        {
          message: { content: 'answer', reasoning_content: 'because' },
          finish_reason: 'stop',
        },
      ],
    });
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    expect(parts[0]).toEqual({ text: 'because', thought: true });
    expect(parts[1]).toEqual({ text: 'answer' });
    expect(response.text).toBe('answer');
  });
});

describe('toGeminiToolCallParts', () => {
  it('parses JSON arguments', () => {
    expect(
      toGeminiToolCallParts([
        { id: 'c1', function: { name: 'foo', arguments: '{"a":1}' } },
      ]),
    ).toEqual([{ functionCall: { id: 'c1', name: 'foo', args: { a: 1 } } }]);
  });

  it('falls back to empty arguments when the server sends invalid JSON', () => {
    expect(
      toGeminiToolCallParts([
        { id: 'c1', function: { name: 'foo', arguments: '{not json' } },
      ]),
    ).toEqual([{ functionCall: { id: 'c1', name: 'foo', args: {} } }]);
  });

  it('synthesizes an id when the server omits one', () => {
    const parts = toGeminiToolCallParts([
      { function: { name: 'foo', arguments: '{}' } },
    ]);
    expect(parts[0].functionCall?.id).toBe('call_foo_0');
  });

  it('skips calls with no name', () => {
    expect(toGeminiToolCallParts([{ id: 'c1' }])).toEqual([]);
  });
});

describe('toOpenAIRequest', () => {
  const baseRequest = {
    model: 'gemini-3-pro',
    contents: [{ role: 'user', parts: [text('hi')] }],
  };

  it('uses the configured model id rather than the Gemini one', () => {
    const body = toOpenAIRequest(baseRequest, 'gpt-4o', false);
    expect(body.model).toBe('gpt-4o');
    expect(body.stream).toBeUndefined();
  });

  it('enables usage reporting when streaming', () => {
    const body = toOpenAIRequest(baseRequest, 'gpt-4o', true);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('forwards sampling parameters for ordinary models', () => {
    const body = toOpenAIRequest(
      {
        ...baseRequest,
        config: { temperature: 0.5, topP: 0.9, maxOutputTokens: 100 },
      },
      'gpt-4o',
      false,
    );
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
    expect(body.max_tokens).toBe(100);
  });

  it('drops sampling parameters and uses the developer role for reasoning models', () => {
    const body = toOpenAIRequest(
      {
        ...baseRequest,
        config: { temperature: 0.5, topP: 0.9, systemInstruction: 'sys' },
      },
      'o3-mini',
      false,
    );
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.messages[0].role).toBe('developer');
  });

  it('maps a JSON response mime type onto response_format', () => {
    const body = toOpenAIRequest(
      { ...baseRequest, config: { responseMimeType: 'application/json' } },
      'gpt-4o',
      false,
    );
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('passes tools and tool_choice through', () => {
    const body = toOpenAIRequest(
      {
        ...baseRequest,
        config: {
          tools: [
            {
              functionDeclarations: [
                { name: 'foo', parametersJsonSchema: { type: 'object' } },
              ],
            },
          ],
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
          },
        },
      },
      'gpt-4o',
      false,
    );
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe('none');
  });
});

describe('toOpenAIEmbeddingRequest', () => {
  it('joins text parts into a single input string', () => {
    expect(
      toOpenAIEmbeddingRequest({
        model: 'text-embedding-3-small',
        contents: [{ role: 'user', parts: [text('a'), text('b')] }],
      }),
    ).toEqual({ model: 'text-embedding-3-small', input: 'ab' });
  });

  it('produces an array for multiple contents', () => {
    expect(
      toOpenAIEmbeddingRequest({
        model: 'm',
        contents: [
          { role: 'user', parts: [text('a')] },
          { role: 'user', parts: [text('b')] },
        ],
      }),
    ).toEqual({ model: 'm', input: ['a', 'b'] });
  });
});
