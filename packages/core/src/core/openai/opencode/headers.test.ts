/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../config/config.js';
import {
  AuthType,
  type ContentGeneratorConfig,
} from '../../contentGenerator.js';
import { applyProviderToContentGeneratorConfig } from '../integration.js';
import {
  OPENCODE_USER_AGENT,
  OPENCODE_USER_AGENT_VERSION,
  buildOpencodeDisguiseHeaders,
  canonicalOpencodeSessionId,
  invertedTimestampHex,
  opencodeProjectId,
  opencodeRequestId,
  opencodeUserAgent,
} from './headers.js';

/**
 * Decode the clock segment of a canonical session id the way the service does.
 *
 * This is the assertion that matters: the header shape can look right while the
 * timestamp is unusable, and an unusable timestamp is exactly what the endpoint
 * rejects. See `invertedTimestampHex` for the encoding.
 */
function decodeSessionTimestamp(session: string): {
  millis: number;
  counter: bigint;
} {
  const inverted = BigInt('0x' + session.slice(4, 16));
  const value = ~inverted & 0xffffffffffffn;
  return { millis: Number(value >> 12n), counter: value & 0xfffn };
}

describe('invertedTimestampHex', () => {
  it('encodes a millisecond clock as 12 lowercase hex characters', () => {
    const now = 1_700_000_000_123;
    const encoded = invertedTimestampHex(now);

    expect(encoded).toMatch(/^[0-9a-f]{12}$/);
    const inverted = BigInt('0x' + encoded);
    const value = ~inverted & 0xffffffffffffn;
    // The wire field is 48 bits, so only the clock's low 36 bits survive.
    expect(Number(value >> 12n)).toBe(now % 2 ** 36);
  });

  it('uses a nonzero sequence in the low 12 bits', () => {
    // A zero sequence would look like a stale counter to the gate that decodes
    // the segment; the reference client always starts at 1.
    const encoded = invertedTimestampHex(1_700_000_000_123);
    const value = ~BigInt('0x' + encoded) & 0xffffffffffffn;
    expect(value & 0xfffn).toBe(1n);
  });
});

describe('canonicalOpencodeSessionId', () => {
  it('passes an already canonical session id through unchanged', () => {
    const canonical = 'ses_0123456789abABCDEFGHIJKLMN';
    expect(canonicalOpencodeSessionId(canonical)).toBe(canonical);
  });

  it('derives a canonical id from a request id', () => {
    const session = canonicalOpencodeSessionId(
      'request-abc',
      1_700_000_000_123,
    );

    expect(session).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    const decoded = decodeSessionTimestamp(session);
    // Clock is truncated to the field's 36 usable bits (see headers.ts).
    expect(decoded.millis).toBe(1_700_000_000_123 % 2 ** 36);
    expect(decoded.counter).toBe(1n);
  });

  it('keeps one id for the life of a conversation', () => {
    // Cache affinity and quota grouping both key off this value, so a second
    // call must not mint a new id even when the clock moved.
    const first = canonicalOpencodeSessionId(
      'same-conversation',
      1_700_000_000_000,
    );
    const second = canonicalOpencodeSessionId(
      'same-conversation',
      1_800_000_000_000,
    );

    expect(second).toBe(first);
  });

  it('derives different ids for different conversations', () => {
    const a = canonicalOpencodeSessionId('conversation-a', 1_700_000_000_000);
    const b = canonicalOpencodeSessionId('conversation-b', 1_700_000_000_000);

    expect(a).not.toBe(b);
  });

  it('stamps the wall clock when no clock is supplied', () => {
    const before = Date.now();
    const session = canonicalOpencodeSessionId('default-clock');
    const after = Date.now();

    const { millis } = decodeSessionTimestamp(session);
    // Modulo, because the 48-bit segment cannot carry the whole clock.
    expect(millis).toBeGreaterThanOrEqual(before % 2 ** 36);
    expect(millis).toBeLessThanOrEqual(after % 2 ** 36);
  });
});

describe('opencodeUserAgent', () => {
  it('pins the reference client identity instead of the local runtime', () => {
    // Regression: deriving the platform from `process` made a Termux build
    // claim `linux arm64`, and the endpoint rejected those requests. The value
    // must be identical on every platform the CLI runs on.
    expect(opencodeUserAgent()).toBe(
      `opencode/${OPENCODE_USER_AGENT_VERSION} (darwin x64; node26.10.0)`,
    );
    expect(opencodeUserAgent()).toBe(OPENCODE_USER_AGENT);
  });
});

describe('buildOpencodeDisguiseHeaders', () => {
  it('sends the full client header set', () => {
    const headers = buildOpencodeDisguiseHeaders({
      sessionSignal: 'session-signal',
      now: 1_700_000_000_123,
    });

    expect(headers['x-opencode-client']).toBe('cli');
    expect(headers['user-agent']).toBe(opencodeUserAgent());
    // Real clients send the session under three names; the service accepts any
    // one of them, so all three must agree.
    expect(headers['x-opencode-session']).toBe(headers['x-session-affinity']);
    expect(headers['x-opencode-session']).toBe(headers['X-Session-Id']);
    expect(headers['x-opencode-session']).toMatch(
      /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    );
    expect(headers['x-opencode-request']).toMatch(/^req_[0-9a-f]{32}$/);
    expect(headers['x-opencode-project']).toMatch(/^prj_[0-9a-f]{24}$/);
  });

  it('derives the project id deterministically', () => {
    expect(opencodeProjectId()).toBe(opencodeProjectId());
    expect(opencodeProjectId('a')).not.toBe(opencodeProjectId('b'));
  });

  it('mints a fresh random request id per call', () => {
    expect(opencodeRequestId()).toMatch(/^req_[0-9a-f]{32}$/);
    expect(opencodeRequestId()).not.toBe(opencodeRequestId());
  });
});

describe('applyProviderToContentGeneratorConfig', () => {
  let fakeHome: string;

  beforeEach(() => {
    // A real default path keeps the test independent of whatever provider file
    // the machine running it happens to have.
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-headers-home-'));
    vi.stubEnv('HOME', fakeHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  function buildConfig(options: {
    opencodeHeaders: boolean;
    sessionId?: string;
  }): Config {
    return {
      getActiveOpenAiProviderId: () => undefined,
      getOpenAiOpencodeHeaders: () => options.opencodeHeaders,
      getSessionId: () => options.sessionId ?? 'cli-session-id',
      env: {},
    } as unknown as Config;
  }

  function apply(options: {
    opencodeHeaders: boolean;
    sessionId?: string;
    customHeaders?: Record<string, string>;
  }): ContentGeneratorConfig {
    const contentGeneratorConfig = {
      authType: AuthType.USE_OPENAI,
    } as ContentGeneratorConfig;
    applyProviderToContentGeneratorConfig({
      config: buildConfig(options),
      authType: AuthType.USE_OPENAI,
      contentGeneratorConfig,
      customHeaders: options.customHeaders,
      getEnv: () => undefined,
    });
    return contentGeneratorConfig;
  }

  it('injects the disguise headers when the setting is on', () => {
    const { customHeaders } = apply({ opencodeHeaders: true });

    expect(customHeaders).toBeDefined();
    expect(customHeaders?.['x-opencode-client']).toBe('cli');
    expect(customHeaders?.['x-opencode-session']).toMatch(
      /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    );
  });

  it('sends nothing when the setting is off', () => {
    const { customHeaders } = apply({ opencodeHeaders: false });

    expect(customHeaders).toBeUndefined();
  });

  it('lets an explicitly configured header win over the disguise', () => {
    const { customHeaders } = apply({
      opencodeHeaders: true,
      customHeaders: { 'x-opencode-client': 'configured' },
    });

    expect(customHeaders?.['x-opencode-client']).toBe('configured');
    // The rest of the set is still filled in.
    expect(customHeaders?.['x-opencode-session']).toBeDefined();
  });

  it('skips the disguise when the session has no id to derive one from', () => {
    // A random per-request session would break cache affinity and look like a
    // different client every turn, so an absent signal means no headers at all.
    const { customHeaders } = apply({ opencodeHeaders: true, sessionId: '' });

    expect(customHeaders).toBeUndefined();
  });
});
