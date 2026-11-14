/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type * as osActual from 'node:os';

vi.mock('node:os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof osActual>();
  return {
    ...actualOs,
    homedir: vi.fn(() => path.resolve('/mock/home')),
    platform: vi.fn(() => 'linux'),
  };
});

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    homedir: vi.fn(() => path.resolve('/mock/home')),
  };
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { loadEnvironment, type Settings } from './settings.js';
import { GEMINI_DIR, homedir as coreHomedir } from '@google/gemini-cli-core';

vi.mock('node:fs');

describe('Environment Isolation', () => {
  const mockHome = path.resolve('/mock/home');
  const mockWorkspace = path.resolve('/mock/workspace');
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    vi.mocked(coreHomedir).mockReturnValue(mockHome);
    // Default to no files existing
    vi.mocked(fs.existsSync).mockReturnValue(false);
    process.argv = ['node', 'gemini'];

    // Clear env vars that might leak from the host environment
    delete process.env['GEMINI_API_KEY'];
    delete process.env['OTHER_VAR'];
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = { ...originalEnv };
  });

  it('should load local .env by default', () => {
    const workspaceEnv = path.join(mockWorkspace, '.env');
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p.toString() === workspaceEnv,
    );
    vi.mocked(fs.readFileSync).mockReturnValue('GEMINI_API_KEY=local');

    const settings = { advanced: { ignoreLocalEnv: false } } as Settings;
    loadEnvironment(settings, mockWorkspace, () => ({
      isTrusted: true,
      source: 'file',
    }));

    expect(process.env['GEMINI_API_KEY']).toBe('local');
    delete process.env['GEMINI_API_KEY'];
  });

  it('should ignore local .env when ignoreLocalEnv is true', () => {
    const workspaceEnv = path.join(mockWorkspace, '.env');
    const homeEnv = path.join(mockHome, '.env');

    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const ps = p.toString();
      return ps === workspaceEnv || ps === homeEnv;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const ps = p.toString();
      if (ps === workspaceEnv) return 'GEMINI_API_KEY=local';
      if (ps === homeEnv) return 'GEMINI_API_KEY=home';
      return '';
    });

    const settings = { advanced: { ignoreLocalEnv: true } } as Settings;
    loadEnvironment(settings, mockWorkspace, () => ({
      isTrusted: true,
      source: 'file',
    }));

    // Should skip local and find home
    expect(process.env['GEMINI_API_KEY']).toBe('home');
    delete process.env['GEMINI_API_KEY'];
  });

  it('should still load .gemini/.env even if ignoreLocalEnv is true', () => {
    const workspaceGeminiEnv = path.join(mockWorkspace, GEMINI_DIR, '.env');
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p.toString() === workspaceGeminiEnv,
    );
    vi.mocked(fs.readFileSync).mockReturnValue('GEMINI_API_KEY=gemini-local');

    const settings = { advanced: { ignoreLocalEnv: true } } as Settings;
    loadEnvironment(settings, mockWorkspace, () => ({
      isTrusted: true,
      source: 'file',
    }));

    expect(process.env['GEMINI_API_KEY']).toBe('gemini-local');
    delete process.env['GEMINI_API_KEY'];
  });

  it('should respect --ignore-env flag', () => {
    const workspaceEnv = path.join(mockWorkspace, '.env');
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p.toString() === workspaceEnv,
    );
    vi.mocked(fs.readFileSync).mockReturnValue('GEMINI_API_KEY=local');

    process.argv = ['node', 'gemini', '--ignore-env'];
    const settings = { advanced: { ignoreLocalEnv: false } } as Settings;
    loadEnvironment(settings, mockWorkspace, () => ({
      isTrusted: true,
      source: 'file',
    }));

    expect(process.env['GEMINI_API_KEY']).toBeUndefined();
  });

  it('should allow home .env even with ignoreLocalEnv true', () => {
    const homeEnv = path.join(mockHome, '.env');
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p.toString() === homeEnv,
    );
    vi.mocked(fs.readFileSync).mockReturnValue('GEMINI_API_KEY=home');

    const settings = { advanced: { ignoreLocalEnv: true } } as Settings;
    // Running from home dir
    loadEnvironment(settings, mockHome, () => ({
      isTrusted: true,
      source: 'file',
    }));

    expect(process.env['GEMINI_API_KEY']).toBe('home');
    delete process.env['GEMINI_API_KEY'];
  });

  it('should skip local .env and its parents until home when ignoreLocalEnv is true', () => {
    const deepProject = path.join(mockWorkspace, 'deep', 'dir');
    const deepEnv = path.join(deepProject, '.env');
    const parentEnv = path.join(mockWorkspace, '.env');
    const homeEnv = path.join(mockHome, '.env');

    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const ps = p.toString();
      return ps === deepEnv || ps === parentEnv || ps === homeEnv;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const ps = p.toString();
      if (ps === deepEnv) return 'GEMINI_API_KEY=deep';
      if (ps === parentEnv) return 'GEMINI_API_KEY=parent';
      if (ps === homeEnv) return 'GEMINI_API_KEY=home';
      return '';
    });

    const settings = { advanced: { ignoreLocalEnv: true } } as Settings;
    loadEnvironment(settings, deepProject, () => ({
      isTrusted: true,
      source: 'file',
    }));

    expect(process.env['GEMINI_API_KEY']).toBe('home');
    delete process.env['GEMINI_API_KEY'];
  });

  it('should respect trust whitelist even when loading from home .env', () => {
    const homeEnv = path.join(mockHome, '.env');
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p.toString() === homeEnv,
    );
    // Include one whitelisted and one non-whitelisted variable
    vi.mocked(fs.readFileSync).mockReturnValue(
      'GEMINI_API_KEY=home\nOTHER_VAR=secret',
    );

    const settings = { advanced: { ignoreLocalEnv: true } } as Settings;
    // Running from an UNTRUSTED workspace
    loadEnvironment(settings, mockWorkspace, () => ({
      isTrusted: false,
      source: 'file',
    }));

    expect(process.env['GEMINI_API_KEY']).toBe('home');
    expect(process.env['OTHER_VAR']).toBeUndefined();
    delete process.env['GEMINI_API_KEY'];
  });

  it('should prioritize --ignore-env flag even if setting is false', () => {
    const workspaceEnv = path.join(mockWorkspace, '.env');
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p.toString() === workspaceEnv,
    );
    vi.mocked(fs.readFileSync).mockReturnValue('GEMINI_API_KEY=local');

    process.argv = ['node', 'gemini', '--ignore-env'];
    const settings = { advanced: { ignoreLocalEnv: false } } as Settings;
    loadEnvironment(settings, mockWorkspace, () => ({
      isTrusted: true,
      source: 'file',
    }));

    expect(process.env['GEMINI_API_KEY']).toBeUndefined();
  });

  it('should respect both -s and --ignore-env flags simultaneously', () => {
    const workspaceEnv = path.join(mockWorkspace, '.env');
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p.toString() === workspaceEnv,
    );
    vi.mocked(fs.readFileSync).mockReturnValue('GEMINI_API_KEY=local');

    process.argv = ['node', 'gemini', '-s', '--ignore-env'];
    const settings = { advanced: { ignoreLocalEnv: false } } as Settings;
    loadEnvironment(settings, mockWorkspace, () => ({
      isTrusted: true,
      source: 'file',
    }));

    expect(process.env['GEMINI_API_KEY']).toBeUndefined();
  });
});

/**
 * A project `.env` must not make the user-level file unreadable.
 *
 * `findEnvFile` returns the first match walking up from the workspace, so a
 * project `.env` containing one unrelated variable hid `~/.gemini/.env`
 * entirely. Every credential defined only there then looked unset, and the
 * failure surfaced against whichever OpenAI provider was consulted first —
 * which is how a missing key produced an error naming a different endpoint.
 *
 * The user-level file is now read afterwards as a fallback: it only fills keys
 * that are still unset, so the precedence `findEnvFile` chose is preserved.
 */
describe('user-level .env fallback', () => {
  const mockHome = path.resolve('/mock/home');
  const mockWorkspace = path.resolve('/mock/workspace');
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  const homeGeminiEnv = path.join(mockHome, GEMINI_DIR, '.env');
  const workspaceEnv = path.join(mockWorkspace, '.env');

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    vi.mocked(coreHomedir).mockReturnValue(mockHome);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    process.argv = ['node', 'gemini'];
    delete process.env['GEMINI_API_KEY'];
    delete process.env['SHARED_KEY'];
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = { ...originalEnv };
  });

  it('fills keys the project .env does not define', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const ps = p.toString();
      return ps === workspaceEnv || ps === homeGeminiEnv;
    });
    // The project file holds an unrelated variable only — the reported case.
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const ps = p.toString();
      if (ps === workspaceEnv) return 'NGROK_AUTHTOKEN=abc';
      if (ps === homeGeminiEnv) return 'GEMINI_API_KEY=home-key';
      return '';
    });

    loadEnvironment({} as Settings, mockWorkspace, () => ({
      isTrusted: true,
      source: 'file',
    }));

    expect(process.env['NGROK_AUTHTOKEN']).toBe('abc');
    expect(process.env['GEMINI_API_KEY']).toBe('home-key');
    delete process.env['NGROK_AUTHTOKEN'];
  });

  it('keeps the project value when both define the same key', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const ps = p.toString();
      return ps === workspaceEnv || ps === homeGeminiEnv;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const ps = p.toString();
      if (ps === workspaceEnv) return 'SHARED_KEY=project';
      if (ps === homeGeminiEnv) return 'SHARED_KEY=home';
      return '';
    });

    loadEnvironment({} as Settings, mockWorkspace, () => ({
      isTrusted: true,
      source: 'file',
    }));

    // Precedence is unchanged: what findEnvFile picked still wins.
    expect(process.env['SHARED_KEY']).toBe('project');
  });

  it('still loads the home file when ignoreLocalEnv skips the project one', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const ps = p.toString();
      return ps === workspaceEnv || ps === homeGeminiEnv;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const ps = p.toString();
      if (ps === workspaceEnv) return 'GEMINI_API_KEY=project';
      if (ps === homeGeminiEnv) return 'GEMINI_API_KEY=home-key';
      return '';
    });

    loadEnvironment(
      { advanced: { ignoreLocalEnv: true } } as Settings,
      mockWorkspace,
      () => ({ isTrusted: true, source: 'file' }),
    );

    expect(process.env['GEMINI_API_KEY']).toBe('home-key');
  });

  it('does not read the home file twice when it was the primary file', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p.toString() === homeGeminiEnv,
    );
    const readFileSync = vi.mocked(fs.readFileSync);
    readFileSync.mockReturnValue('GEMINI_API_KEY=home-key');

    loadEnvironment({} as Settings, mockHome, () => ({
      isTrusted: true,
      source: 'file',
    }));

    expect(process.env['GEMINI_API_KEY']).toBe('home-key');
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });
});
