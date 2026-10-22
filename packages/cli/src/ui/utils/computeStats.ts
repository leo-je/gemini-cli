/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { LlmRole } from '@google/gemini-cli-core';
import type {
  SessionMetrics,
  ComputedSessionStats,
  ModelMetrics,
} from '../contexts/SessionContext.js';

/**
 * Token totals for the work the user actually drove in this session.
 *
 * A model entry accumulates the whole process, background sub-agents included:
 * the auto-memory extraction run starts with the CLI and burns hundreds of
 * thousands of prompt tokens before the user types anything. Those tokens are
 * real, but they are not this session's, and counting them made the footer
 * report them as such. Requests made on behalf of the session itself — the main
 * loop and the utility calls it triggers — are kept.
 *
 * Metrics restored from a resumed session carry no role breakdown at all, so an
 * entry with no roles falls back to its bare totals.
 */
export function getSessionTokenTotals(metrics: SessionMetrics): {
  prompt: number;
  cached: number;
  total: number;
} {
  const totals = { prompt: 0, cached: 0, total: 0 };

  for (const model of Object.values(metrics.models)) {
    if (Object.keys(model.roles).length === 0) {
      totals.prompt += model.tokens.prompt;
      totals.cached += model.tokens.cached;
      totals.total += model.tokens.total;
      continue;
    }

    for (const [role, roleMetrics] of Object.entries(model.roles)) {
      if (role === LlmRole.SUBAGENT || !roleMetrics) continue;
      totals.prompt += roleMetrics.tokens.prompt;
      totals.cached += roleMetrics.tokens.cached;
      totals.total += roleMetrics.tokens.total;
    }
  }

  return totals;
}

export function calculateErrorRate(metrics: ModelMetrics): number {
  if (metrics.api.totalRequests === 0) {
    return 0;
  }
  return (metrics.api.totalErrors / metrics.api.totalRequests) * 100;
}

export function calculateAverageLatency(metrics: ModelMetrics): number {
  if (metrics.api.totalRequests === 0) {
    return 0;
  }
  return metrics.api.totalLatencyMs / metrics.api.totalRequests;
}

export function calculateCacheHitRate(metrics: ModelMetrics): number {
  if (metrics.tokens.prompt === 0) {
    return 0;
  }
  return (metrics.tokens.cached / metrics.tokens.prompt) * 100;
}

export const computeSessionStats = (
  metrics: SessionMetrics,
): ComputedSessionStats => {
  const { models, tools, files } = metrics;
  const totalApiTime = Object.values(models).reduce(
    (acc, model) => acc + model.api.totalLatencyMs,
    0,
  );
  const totalToolTime = tools.totalDurationMs;
  const agentActiveTime = totalApiTime + totalToolTime;
  const apiTimePercent =
    agentActiveTime > 0 ? (totalApiTime / agentActiveTime) * 100 : 0;
  const toolTimePercent =
    agentActiveTime > 0 ? (totalToolTime / agentActiveTime) * 100 : 0;

  const totalCachedTokens = Object.values(models).reduce(
    (acc, model) => acc + model.tokens.cached,
    0,
  );
  const totalInputTokens = Object.values(models).reduce(
    (acc, model) => acc + model.tokens.input,
    0,
  );
  const totalPromptTokens = Object.values(models).reduce(
    (acc, model) => acc + model.tokens.prompt,
    0,
  );
  const cacheEfficiency =
    totalPromptTokens > 0 ? (totalCachedTokens / totalPromptTokens) * 100 : 0;

  const totalDecisions =
    tools.totalDecisions.accept +
    tools.totalDecisions.reject +
    tools.totalDecisions.modify +
    tools.totalDecisions.auto_accept;
  const successRate =
    tools.totalCalls > 0 ? (tools.totalSuccess / tools.totalCalls) * 100 : 0;
  const agreementRate =
    totalDecisions > 0
      ? ((tools.totalDecisions.accept + tools.totalDecisions.auto_accept) /
          totalDecisions) *
        100
      : 0;

  return {
    totalApiTime,
    totalToolTime,
    agentActiveTime,
    apiTimePercent,
    toolTimePercent,
    cacheEfficiency,
    totalDecisions,
    successRate,
    agreementRate,
    totalCachedTokens,
    totalInputTokens,
    totalPromptTokens,
    totalLinesAdded: files.totalLinesAdded,
    totalLinesRemoved: files.totalLinesRemoved,
  };
};
