/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { OpenAIToolDefinition } from '../types.js';
import { ensureOpencodeFreeLaneShape } from './body.js';

function tool(name: string): OpenAIToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  };
}

function names(body: { tools?: OpenAIToolDefinition[] }): string[] {
  return (body.tools ?? []).map((entry) => entry.function.name);
}

describe('ensureOpencodeFreeLaneShape', () => {
  it('appends bash and read when the request has no tools', () => {
    const body: { tools?: OpenAIToolDefinition[] } = {};
    ensureOpencodeFreeLaneShape(body);
    expect(names(body)).toEqual(['bash', 'read']);
  });

  it('keeps the caller tools and appends only the missing gate names', () => {
    const body = { tools: [tool('run_shell_command'), tool('read')] };
    ensureOpencodeFreeLaneShape(body);
    // The caller's `read` keeps its schema; only the missing `bash` is added.
    expect(names(body)).toEqual(['run_shell_command', 'read', 'bash']);
    expect(body.tools[1]).toEqual(tool('read'));
  });

  it('is a no-op when both gate names are already declared', () => {
    const body = { tools: [tool('bash'), tool('read')] };
    ensureOpencodeFreeLaneShape(body);
    expect(names(body)).toEqual(['bash', 'read']);
    expect(body.tools).toHaveLength(2);
  });

  it('never replaces a real implementation of a gate name', () => {
    const realBash = tool('bash');
    const realRead = tool('read');
    const body = { tools: [realBash, realRead] };
    ensureOpencodeFreeLaneShape(body);
    expect(body.tools[0]).toBe(realBash);
    expect(body.tools[1]).toBe(realRead);
  });

  it('is idempotent', () => {
    const body: { tools?: OpenAIToolDefinition[] } = {};
    ensureOpencodeFreeLaneShape(body);
    ensureOpencodeFreeLaneShape(body);
    expect(names(body)).toEqual(['bash', 'read']);
  });

  it('gives the placeholders a call-disabled shape', () => {
    const body: { tools?: OpenAIToolDefinition[] } = {};
    ensureOpencodeFreeLaneShape(body);
    for (const entry of body.tools ?? []) {
      expect(entry.type).toBe('function');
      expect(entry.function.description).toContain('do not call');
      expect(entry.function.parameters).toEqual({
        type: 'object',
        properties: {},
      });
    }
  });
});
