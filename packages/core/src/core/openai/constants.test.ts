/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseHeaderJson,
  readEnvValue,
  readEnvWithFallback,
} from './constants.js';

describe('parseHeaderJson', () => {
  it('treats an absent value as no headers', () => {
    expect(parseHeaderJson(undefined)).toEqual({});
  });

  it('treats an empty or whitespace-only value as no headers', () => {
    expect(parseHeaderJson('')).toEqual({});
    expect(parseHeaderJson('   ')).toEqual({});
  });

  it('parses a flat object', () => {
    expect(parseHeaderJson('{"X-Tenant":"acme","X-Trace":"on"}')).toEqual({
      'X-Tenant': 'acme',
      'X-Trace': 'on',
    });
  });

  it('coerces numbers and booleans', () => {
    expect(parseHeaderJson('{"X-Retries":3,"X-Beta":true}')).toEqual({
      'X-Retries': '3',
      'X-Beta': 'true',
    });
  });

  it('keeps an empty string value', () => {
    expect(parseHeaderJson('{"X-Blank":""}')).toEqual({ 'X-Blank': '' });
  });

  it('accepts an api-key style header alongside a bearer token', () => {
    expect(parseHeaderJson('{"api-key":"secret"}')).toEqual({
      'api-key': 'secret',
    });
  });

  it('reports malformed JSON with the variable name', () => {
    expect(() => parseHeaderJson('{not json')).toThrow(
      /GEMINI_OPENAI_HEADERS must be valid JSON/,
    );
  });

  it('rejects a value that is not an object', () => {
    expect(() => parseHeaderJson('["X-A"]')).toThrow(
      /must be a JSON object of header names to values/,
    );
    expect(() => parseHeaderJson('"X-A"')).toThrow(
      /must be a JSON object of header names to values/,
    );
    expect(() => parseHeaderJson('null')).toThrow(
      /must be a JSON object of header names to values/,
    );
  });

  it('rejects a nested object or array value', () => {
    expect(() => parseHeaderJson('{"X-A":{"b":"c"}}')).toThrow(
      /header "X-A" must be a string, number, or boolean/,
    );
    expect(() => parseHeaderJson('{"X-A":["b"]}')).toThrow(
      /header "X-A" must be a string, number, or boolean/,
    );
    expect(() => parseHeaderJson('{"X-A":null}')).toThrow(
      /header "X-A" must be a string, number, or boolean/,
    );
  });

  it('rejects an invalid header name', () => {
    expect(() => parseHeaderJson('{"X A":"b"}')).toThrow(
      /invalid header name: "X A"/,
    );
    expect(() => parseHeaderJson('{"":"b"}')).toThrow(
      /invalid header name: ""/,
    );
  });

  it('rejects a value that would inject another header', () => {
    // The failure this guards against: a value carrying CRLF splits the
    // request into an extra, attacker-chosen header.
    expect(() => parseHeaderJson('{"X-A":"ok\\r\\nX-Injected: yes"}')).toThrow(
      /contains a control character/,
    );
  });

  it('rejects a NUL byte', () => {
    expect(() => parseHeaderJson('{"X-A":"a\\u0000b"}')).toThrow(
      /contains a control character/,
    );
  });

  it('allows a tab, which HTTP permits inside a field value', () => {
    expect(parseHeaderJson('{"X-A":"a\\tb"}')).toEqual({ 'X-A': 'a\tb' });
  });

  it('rejects a character with no Latin-1 representation', () => {
    // `fetch` encodes header values as a ByteString and throws a bare
    // `TypeError` on anything above U+00FF, at request time and without naming
    // the offending variable. Rejecting it here turns that into a startup error.
    expect(() => parseHeaderJson('{"X-A":"租户"}')).toThrow(
      /has no Latin-1 representation/,
    );
    // U+00FF itself is the last representable code point, so it must pass.
    expect(parseHeaderJson('{"X-A":"ÿ"}')).toEqual({ 'X-A': 'ÿ' });
  });

  it('rejects the same header written twice under different names', () => {
    // One header, two spellings: HTTP case-folds them, so this is a typo rather
    // than a merge. Picking one silently would send a value the user did not
    // necessarily intend.
    expect(() => parseHeaderJson('{"X-A":"1","x-a":"2"}')).toThrow(
      /sets the same header twice under different names: "X-A" and "x-a"/,
    );
  });

  it('keeps a header named __proto__', () => {
    // Assigning to a plain object's `__proto__` key invokes the inherited
    // setter and the entry disappears. A Map has no such trap.
    const headers = parseHeaderJson('{"__proto__":"x","X-A":"1"}');
    expect(Object.keys(headers)).toEqual(['__proto__', 'X-A']);
    expect(headers['__proto__']).toBe('x');
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
  });

  it('strips a leading byte-order mark', () => {
    // An editor that writes a BOM leaves it glued to the first key, which makes
    // `JSON.parse` reject the whole object for no visible reason.
    expect(parseHeaderJson('\uFEFF{"X-A":"1"}')).toEqual({ 'X-A': '1' });
  });
});

describe('readEnvValue', () => {
  it('prefers the injected config environment', () => {
    expect(
      readEnvValue('GEMINI_OPENAI_MODELID', { GEMINI_OPENAI_MODELID: 'a' }),
    ).toBe('a');
  });

  it('honours an explicitly empty injected value', () => {
    // `.env` loading writes empty strings for unset variables; treating that as
    // "absent" would silently fall back to an unrelated ambient value.
    expect(
      readEnvValue('GEMINI_OPENAI_HEADERS', { GEMINI_OPENAI_HEADERS: '' }),
    ).toBe('');
  });
});

describe('readEnvWithFallback', () => {
  it('prefers the OpenAI-named variable when both are set', () => {
    expect(
      readEnvWithFallback('GEMINI_OPENAI_MODELID', 'GEMINI_MODEL', {
        GEMINI_OPENAI_MODELID: 'openai-model',
        GEMINI_MODEL: 'gemini-model',
      }),
    ).toBe('openai-model');
  });

  it('falls back to the Gemini-named variable when the primary is absent', () => {
    expect(
      readEnvWithFallback('GEMINI_OPENAI_BASE_URL', 'GOOGLE_GEMINI_BASE_URL', {
        GOOGLE_GEMINI_BASE_URL: 'https://gateway.example',
      }),
    ).toBe('https://gateway.example');
  });

  it('treats an empty primary as unset so the fallback still applies', () => {
    // A shell script that clears an inherited variable exports it as empty.
    // Reading that as a deliberate blank endpoint would turn a missing setting
    // into a confusing network error instead of the documented fallback.
    expect(
      readEnvWithFallback('GEMINI_OPENAI_API_KEY', 'GEMINI_API_KEY', {
        GEMINI_OPENAI_API_KEY: '',
        GEMINI_API_KEY: 'fallback-key',
      }),
    ).toBe('fallback-key');
  });

  it('returns undefined when neither is set', () => {
    expect(
      readEnvWithFallback('GEMINI_OPENAI_MODELID', 'GEMINI_MODEL', {}),
    ).toBeUndefined();
  });

  it('falls back to the process environment', () => {
    const previous = process.env['GEMINI_MODEL'];
    process.env['GEMINI_MODEL'] = 'ambient-model';
    try {
      expect(readEnvWithFallback('GEMINI_OPENAI_MODELID', 'GEMINI_MODEL')).toBe(
        'ambient-model',
      );
    } finally {
      if (previous === undefined) {
        delete process.env['GEMINI_MODEL'];
      } else {
        process.env['GEMINI_MODEL'] = previous;
      }
    }
  });
});
