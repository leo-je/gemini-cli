/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPENAI_API_KEY_ENV,
  OPENAI_BASE_URL_ENV,
  OPENAI_MODEL_ID_ENV,
} from '@google/gemini-cli-core';
import { applyOpenAiEndpointEnv } from './openAiEndpointEnv.js';

const SETTINGS = {
  baseUrl: 'https://openrouter.ai/api/v1',
  modelId: 'z-ai/glm-4.6',
};

describe('applyOpenAiEndpointEnv', () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-openai-env-'));
    envPath = path.join(dir, 'nested', '.env');
    for (const key of [
      OPENAI_BASE_URL_ENV,
      OPENAI_MODEL_ID_ENV,
      OPENAI_API_KEY_ENV,
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    for (const key of [
      OPENAI_BASE_URL_ENV,
      OPENAI_MODEL_ID_ENV,
      OPENAI_API_KEY_ENV,
    ]) {
      delete process.env[key];
    }
  });

  it('writes the endpoint to a new file, creating parent directories', () => {
    const written = applyOpenAiEndpointEnv(SETTINGS, envPath);

    expect(written).toBe(envPath);
    expect(fs.readFileSync(envPath, 'utf8')).toBe(
      `${OPENAI_BASE_URL_ENV}=https://openrouter.ai/api/v1\n` +
        `${OPENAI_MODEL_ID_ENV}=z-ai/glm-4.6\n`,
    );
  });

  it('applies the values to the current session', () => {
    applyOpenAiEndpointEnv({ ...SETTINGS, apiKey: 'sk-test' }, envPath);

    expect(process.env[OPENAI_BASE_URL_ENV]).toBe(
      'https://openrouter.ai/api/v1',
    );
    expect(process.env[OPENAI_MODEL_ID_ENV]).toBe('z-ai/glm-4.6');
    expect(process.env[OPENAI_API_KEY_ENV]).toBe('sk-test');
  });

  it('leaves unrelated lines and comments alone', () => {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(
      envPath,
      '# my settings\nGEMINI_MODEL=gemini-2.5-pro\n',
      'utf8',
    );

    applyOpenAiEndpointEnv(SETTINGS, envPath);

    expect(fs.readFileSync(envPath, 'utf8')).toBe(
      '# my settings\n' +
        'GEMINI_MODEL=gemini-2.5-pro\n' +
        `${OPENAI_BASE_URL_ENV}=https://openrouter.ai/api/v1\n` +
        `${OPENAI_MODEL_ID_ENV}=z-ai/glm-4.6\n`,
    );
  });

  it('rewrites an existing key instead of appending a duplicate', () => {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(
      envPath,
      `${OPENAI_BASE_URL_ENV}=http://localhost:11434/v1\nOTHER=1\n`,
      'utf8',
    );

    applyOpenAiEndpointEnv(SETTINGS, envPath);

    const contents = fs.readFileSync(envPath, 'utf8');
    expect(contents).toBe(
      `${OPENAI_BASE_URL_ENV}=https://openrouter.ai/api/v1\n` +
        'OTHER=1\n' +
        `${OPENAI_MODEL_ID_ENV}=z-ai/glm-4.6\n`,
    );
    expect(contents.match(new RegExp(OPENAI_BASE_URL_ENV, 'g'))).toHaveLength(
      1,
    );
  });

  it('keeps the stored API key when the dialog did not collect one', () => {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, `${OPENAI_API_KEY_ENV}=sk-existing\n`, 'utf8');

    applyOpenAiEndpointEnv(SETTINGS, envPath);

    expect(fs.readFileSync(envPath, 'utf8')).toContain(
      `${OPENAI_API_KEY_ENV}=sk-existing`,
    );
  });

  it('quotes values dotenv would otherwise mangle', () => {
    applyOpenAiEndpointEnv({ ...SETTINGS, apiKey: 'with space #1' }, envPath);

    expect(fs.readFileSync(envPath, 'utf8')).toContain(
      `${OPENAI_API_KEY_ENV}="with space #1"`,
    );
  });

  it('restricts the file to the owner', () => {
    applyOpenAiEndpointEnv({ ...SETTINGS, apiKey: 'sk-test' }, envPath);

    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('reports failure without throwing, leaving the session usable', () => {
    // A directory sitting where the file belongs makes the write fail on any
    // platform, without having to stub node:fs (not stubable under ESM).
    fs.mkdirSync(envPath, { recursive: true });

    expect(applyOpenAiEndpointEnv(SETTINGS, envPath)).toBeNull();
    // The session variables are what unblock the current run.
    expect(process.env[OPENAI_BASE_URL_ENV]).toBe(
      'https://openrouter.ai/api/v1',
    );
  });
});
