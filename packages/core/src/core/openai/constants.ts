/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment variables that switch the CLI into OpenAI-compatible mode.
 *
 * This module intentionally has no imports. `contentGenerator.ts` needs these
 * names to decide which backend to construct, and importing them from a module
 * that reaches back into `contentGenerator.js` would create an import cycle.
 */

/** Explicit opt-in switch. Only the exact value `openai` enables this backend. */
export const GEMINI_API_TYPE_ENV = 'GEMINI_API_TYPE';
export const OPENAI_API_TYPE = 'openai';
export const OPENAI_BASE_URL_ENV = 'GEMINI_OPENAI_BASE_URL';
export const OPENAI_API_KEY_ENV = 'GEMINI_OPENAI_API_KEY';
export const OPENAI_MODEL_ID_ENV = 'GEMINI_OPENAI_MODELID';
export const OPENAI_HEADERS_ENV = 'GEMINI_OPENAI_HEADERS';

/**
 * Reads an environment variable, preferring values injected through
 * `Config.env` (which `.env` loading and settings populate) over the ambient
 * process environment.
 */
export function readEnvValue(
  key: string,
  configEnv?: Record<string, string>,
): string | undefined {
  const fromConfig = configEnv?.[key];
  if (fromConfig !== undefined) {
    return fromConfig;
  }
  return process.env[key];
}

/** RFC 9110 field-name: a `tchar` run. Anything else is rejected by `fetch`. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Parses `GEMINI_OPENAI_HEADERS`, a flat JSON object of header names to values.
 *
 * Invalid input throws rather than being ignored. A header configured here is
 * usually a credential or a required tenant identifier, so silently dropping a
 * malformed value turns a clear configuration error into an unexplained 401
 * from the endpoint.
 */
export function parseHeaderJson(
  raw: string | undefined,
): Record<string, string> {
  // A BOM survives `JSON.parse` into the first key and makes the whole object
  // unreadable, which is a confusing way to learn that an editor added one.
  const trimmed = raw?.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${OPENAI_HEADERS_ENV} must be valid JSON (${reason}). Expected a flat object, e.g. {"X-Tenant":"acme"}.`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${OPENAI_HEADERS_ENV} must be a JSON object of header names to values.`,
    );
  }

  // A Map, not an object literal: `headers['__proto__'] = ...` would hit the
  // inherited setter and the entry would vanish without a trace.
  const headers = new Map<string, string>();
  const spellings = new Map<string, string>();
  for (const [name, value] of Object.entries(parsed)) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new Error(
        `${OPENAI_HEADERS_ENV} contains an invalid header name: ${JSON.stringify(name)}.`,
      );
    }
    // HTTP header names are case-insensitive, so `{"X-A":"1","x-a":"2"}` is one
    // header written twice. That is a typo, not a merge, and guessing which
    // value the user meant would be worse than saying so.
    const folded = name.toLowerCase();
    const previous = spellings.get(folded);
    if (previous !== undefined) {
      throw new Error(
        `${OPENAI_HEADERS_ENV} sets the same header twice under different names: ${JSON.stringify(previous)} and ${JSON.stringify(name)}.`,
      );
    }
    spellings.set(folded, name);
    headers.set(name, toHeaderValue(name, value));
  }
  return Object.fromEntries(headers);
}

/**
 * Coerces a JSON value to a header value.
 *
 * Numbers and booleans are accepted because JSON has no other way to write them
 * and `{"X-Retries": 3}` is an easy thing to type. Objects and arrays are
 * rejected: there is no sensible header serialization for them.
 */
function toHeaderValue(name: string, value: unknown): string {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    throw new Error(
      `${OPENAI_HEADERS_ENV} header ${JSON.stringify(name)} must be a string, number, or boolean.`,
    );
  }

  const text = String(value);
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // C0 controls (bar HTAB) and DEL are never valid in a field value; CR and
    // LF are the header-injection vector, letting a value forge extra headers.
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      throw new Error(
        `${OPENAI_HEADERS_ENV} header ${JSON.stringify(name)} contains a control character, which is never valid in a header value.`,
      );
    }
    // Above U+00FF there is no byte to carry the character, and `fetch` throws
    // a bare ByteString `TypeError` at request time. Checking here turns that
    // into a named startup error; leaving it out would let a value pass
    // validation and then fail every single request with a message that names
    // neither the header nor the variable.
    if (code > 0xff) {
      throw new Error(
        `${OPENAI_HEADERS_ENV} header ${JSON.stringify(name)} contains ${JSON.stringify(char)}, which has no Latin-1 representation. Header values are bytes; encode it first (for example as percent-encoded UTF-8).`,
      );
    }
  }
  return text;
}
