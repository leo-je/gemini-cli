/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenCode-compatible request headers for the OpenAI backend.
 *
 * OpenCode Zen is an OpenAI-compatible endpoint, but some of its lanes gate on
 * the *client identity* rather than on the credential alone: a request that
 * does not look like it came from the OpenCode CLI is answered with 403, even
 * when the endpoint and API key are otherwise valid. The disguise is a fixed
 * header set plus a session id derived from the conversation.
 *
 * Two details make a naive port fail, and both are mirrored from
 * `opencode2dsh` (`packages/plugin/src/adapter/ids.ts`), which reverse
 * engineered them against the live service:
 *
 *   - The 12 hex characters in a session id are not a digest. They are a real
 *     millisecond clock, shifted left by 12 bits (the low bits hold a
 *     per-millisecond counter), then bitwise inverted and truncated to 48 bits
 *     so ids sort newest first as plain strings. The service decodes that
 *     segment and rejects ids whose low 12 bits are not a plausible counter
 *     (`invertedTimestampHex`).
 *   - The session id has to stay identical for the whole conversation. The
 *     service groups quota and prompt cache by session, so minting a fresh one
 *     per request both breaks cache affinity and looks like a different client
 *     every turn (`canonicalOpencodeSessionId` memoises by signal).
 *
 * Everything here is a pure function over the session signal, so the header set
 * can be built once when the request layer is constructed. The isolation
 * contract from `../README.md` applies: nothing outside this directory computes
 * these values, and the only hook is a call from `../integration.ts`.
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * The OpenCode release the disguise reports.
 *
 * Bump only against a real release: this string is part of the client identity
 * the endpoint sees, and an implausible version is the first thing a gate that
 * parses it would reject. Mirrors the value `opencode2dsh` ships with.
 */
export const OPENCODE_USER_AGENT_VERSION = '1.18.31';

/**
 * The canonical session shape: `ses_` + 12 lowercase hex clock characters + 14
 * Base62 characters. Anything else is rejected by the free lane.
 */
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Zero-padded Base62 rendering of `value`, most significant digit first. */
function base62Fixed(value: bigint, width: number): string {
  const base = 62n;
  let n = value;
  const out = new Array<string>(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base));
    n /= base;
  }
  return out.join('');
}

/**
 * The 12 hex characters a genuine OpenCode client emits.
 *
 * Ported from OpenCode's own identifier generator: take the millisecond clock,
 * append a per-millisecond sequence in the low 12 bits, then invert and keep
 * the low 48 bits so ids sort newest first as strings. The wire field is only
 * 48 bits wide, so the clock is truncated: decoding yields the clock modulo
 * 2^36, and the service only validates that the low 12 bits are a plausible
 * sequence, not the absolute time. Mirrored exactly from `opencode2dsh`, which
 * was validated against the live service.
 *
 * We always mint sequence 1: nothing else in this process writes sessions, so a
 * per-millisecond counter would only add state.
 *
 * Exported for the regression test that pins the encoding, not as a wire
 * contract — callers want `buildOpencodeDisguiseHeaders`.
 */
export function invertedTimestampHex(now: number = Date.now()): string {
  const current = BigInt(now) * 0x1000n + 1n;
  const inverted = ~current & 0xffffffffffffn;
  return inverted.toString(16).padStart(12, '0');
}

/**
 * The user agent the disguise sends, pinned to one exact string.
 *
 * Deliberately not derived from the current runtime. The endpoint was validated
 * against the reference OpenCode build, and requests claiming another platform
 * (a Termux `linux arm64` build, for instance) were observed to fail while the
 * identical request with this string succeeded. A platform claim that disagrees
 * with the client the service expects is a mismatch, not extra honesty, so the
 * reference value is reproduced verbatim.
 */
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_USER_AGENT_VERSION} (darwin x64; node26.10.0)`;

/**
 * The user agent header value.
 *
 * Kept as a function because the header set is assembled through it and the
 * value is part of the client identity: callers must not hand-assemble it.
 */
export function opencodeUserAgent(): string {
  return OPENCODE_USER_AGENT;
}

/**
 * Cap for the session-id memo below. Far past any realistic number of live
 * conversations in one CLI process; the bound exists so a long-lived process
 * cannot grow the map without limit.
 */
const SESSION_MEMO_LIMIT = 1024;

/**
 * Session ids by conversation signal. Insertion-ordered, oldest evicted first:
 * a hit returns early and is not re-inserted, so this is FIFO by first mint
 * rather than LRU. Re-minting a signal that fell out of the window only costs
 * cache affinity, which is why the simpler eviction is enough.
 */
const sessionMemo = new Map<string, string>();

/**
 * The session id sent upstream for `signal`.
 *
 * A signal that already is a canonical OpenCode session passes through
 * unchanged — that keeps prompt-cache affinity when a caller supplies a real
 * id. Any other identity (the CLI's session id) is expanded into a canonical
 * id: a real clock in the timestamp segment, with the signal folded into the
 * Base62 tail so distinct conversations never collide.
 *
 * `signal` must be stable for the life of the conversation. The caller is
 * responsible for that — an unstable signal would mint a new session per
 * request, which is the one thing this header must not do.
 *
 * `now` exists for tests; the memo means it only takes effect on the first mint
 * for a given signal.
 */
export function canonicalOpencodeSessionId(
  signal: string,
  now: number = Date.now(),
): string {
  if (SESSION_ID_PATTERN.test(signal)) {
    return signal;
  }

  const memoized = sessionMemo.get(signal);
  if (memoized !== undefined) {
    return memoized;
  }

  const digest = createHash('sha256')
    .update('ses\x00' + signal)
    .digest();
  const tail = base62Fixed(
    BigInt('0x' + digest.subarray(6, 16).toString('hex')),
    14,
  );
  const session = `ses_${invertedTimestampHex(now)}${tail}`;

  if (sessionMemo.size >= SESSION_MEMO_LIMIT) {
    const oldest = sessionMemo.keys().next();
    if (!oldest.done) {
      sessionMemo.delete(oldest.value);
    }
  }
  sessionMemo.set(signal, session);
  return session;
}

/**
 * A per-request correlation id (`req_` + 32 hex).
 *
 * Random on purpose: OpenCode mints one per model call, and nothing downstream
 * groups state by it. Callers that build the header set once per session reuse
 * one id for the session, which the endpoint does not appear to check.
 */
export function opencodeRequestId(): string {
  return `req_${randomBytes(16).toString('hex')}`;
}

/**
 * A stable project id (`prj_` + 24 hex) derived from `seed`.
 *
 * OpenCode derives it from the project directory. We deliberately do not: the
 * header is a correlation hint, and tying it to a path would leak the directory
 * layout to the endpoint for no benefit. One id per installation is enough.
 */
export function opencodeProjectId(
  seed: string = 'gemini-cli:default-project',
): string {
  const digest = createHash('sha256')
    .update('prj\x00' + seed)
    .digest();
  return `prj_${digest.subarray(0, 12).toString('hex')}`;
}

export interface OpencodeDisguiseOptions {
  /** Stable per-conversation signal, normally the CLI's session id. */
  sessionSignal: string;
  /** Test seam for the session id's clock segment. */
  now?: number;
}

/**
 * The full header set sent with every request when the user opts in
 * (`security.auth.openAiOpencodeHeaders`).
 *
 * `x-opencode-session`, `x-session-affinity`, and `X-Session-Id` carry the same
 * value: the service accepts any one of them, and real clients send all three,
 * so sending all three is the low-risk choice. Header names are kept in the
 * spelling a real client uses; the request layer folds them for lookup only.
 */
export function buildOpencodeDisguiseHeaders(
  options: OpencodeDisguiseOptions,
): Record<string, string> {
  const session = canonicalOpencodeSessionId(
    options.sessionSignal,
    options.now,
  );
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': session,
    'x-session-affinity': session,
    'X-Session-Id': session,
    'x-opencode-request': opencodeRequestId(),
    'x-opencode-project': opencodeProjectId(),
  };
}
