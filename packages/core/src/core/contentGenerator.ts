/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GoogleGenAI,
  type CountTokensResponse,
  type GenerateContentResponse,
  type GenerateContentParameters,
  type CountTokensParameters,
  type EmbedContentResponse,
  type EmbedContentParameters,
} from '@google/genai';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as os from 'node:os';
import { createCodeAssistContentGenerator } from '../code_assist/codeAssist.js';
import { isCloudShell } from '../ide/detect-ide.js';
import type { Config } from '../config/config.js';
import { loadApiKey } from './apiKeyCredentialStorage.js';

import type { UserTierId, GeminiUserTier } from '../code_assist/types.js';
import { LoggingContentGenerator } from './loggingContentGenerator.js';
import { InstallationManager } from '../utils/installationManager.js';
import { FakeContentGenerator } from './fakeContentGenerator.js';
import { parseCustomHeaders } from '../utils/customHeaderUtils.js';
import { determineSurface } from '../utils/surface.js';
import { RecordingContentGenerator } from './recordingContentGenerator.js';
import { getVersion, resolveModel } from '../../index.js';
import type { LlmRole } from '../telemetry/llmRole.js';
import { ModelMappingContentGenerator } from './modelMappingContentGenerator.js';
import { getBackendModelMappings } from '../config/models.js';
import { OpenAIContentGenerator } from './openai/openaiContentGenerator.js';
import {
  OPENAI_API_KEY_ENV,
  OPENAI_API_KEY_FALLBACK_ENV,
  OPENAI_BASE_URL_ENV,
  OPENAI_BASE_URL_FALLBACK_ENV,
  GEMINI_API_TYPE_ENV,
  OPENAI_API_TYPE,
} from './openai/constants.js';

/**
 * Interface abstracting the core functionalities for generating content and counting tokens.
 */
export interface ContentGenerator {
  generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse>;

  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;

  userTier?: UserTierId;

  userTierName?: string;

  paidTier?: GeminiUserTier;
}

export enum AuthType {
  LOGIN_WITH_GOOGLE = 'oauth-personal',
  USE_GEMINI = 'gemini-api-key',
  USE_VERTEX_AI = 'vertex-ai',
  LEGACY_CLOUD_SHELL = 'cloud-shell',
  COMPUTE_ADC = 'compute-default-credentials',
  GATEWAY = 'gateway',
  USE_OPENAI = 'openai',
}

/**
 * Detects the best authentication type based on environment variables.
 *
 * Checks in order:
 * 1. GEMINI_API_TYPE=openai -> USE_OPENAI
 * 2. GOOGLE_GENAI_USE_GCA=true -> LOGIN_WITH_GOOGLE
 * 3. GOOGLE_GENAI_USE_VERTEXAI=true -> USE_VERTEX_AI
 * 4. GEMINI_API_KEY -> USE_GEMINI
 *
 * GEMINI_API_TYPE is checked first because it is an explicit opt-in switch: a
 * machine that also happens to carry GEMINI_API_KEY should still reach the
 * OpenAI-compatible endpoint the user asked for.
 */
export function getAuthTypeFromEnv(): AuthType | undefined {
  if (process.env[GEMINI_API_TYPE_ENV] === OPENAI_API_TYPE) {
    return AuthType.USE_OPENAI;
  }
  if (process.env['GOOGLE_GENAI_USE_GCA'] === 'true') {
    return AuthType.LOGIN_WITH_GOOGLE;
  }
  if (process.env['GOOGLE_GENAI_USE_VERTEXAI'] === 'true') {
    return AuthType.USE_VERTEX_AI;
  }
  if (process.env['GOOGLE_GEMINI_BASE_URL']) {
    return AuthType.GATEWAY;
  }
  if (process.env['GEMINI_API_KEY']) {
    return AuthType.USE_GEMINI;
  }
  if (
    process.env['CLOUD_SHELL'] === 'true' ||
    process.env['GEMINI_CLI_USE_COMPUTE_ADC'] === 'true'
  ) {
    return AuthType.COMPUTE_ADC;
  }
  return undefined;
}

/**
 * True when `GEMINI_API_TYPE=openai` has switched the CLI to the
 * OpenAI-compatible backend.
 *
 * Callers use this where the distinction matters: unlike an ambient
 * `GEMINI_API_KEY`, this switch is an explicit choice, so it authorises
 * authenticating without a persisted selection and skipping the auth dialog.
 */
export function isOpenAiApiTypeSwitch(): boolean {
  return process.env[GEMINI_API_TYPE_ENV] === OPENAI_API_TYPE;
}

/**
 * Resolves the auth type the user actually asked for, from the persisted
 * selection and the environment.
 *
 * `GEMINI_API_TYPE=openai` outranks the persisted selection. Every other
 * environment variable is a fallback that an explicit choice in `settings.json`
 * still overrides, but this one is a deliberate, single-purpose switch: a user
 * who exports it has just asked for the OpenAI-compatible backend, and silently
 * honouring a stale selection instead makes the switch look broken.
 *
 * An enforced auth type is deliberately not consulted here. Callers check it
 * against the returned value, so an administrator's policy still wins.
 */
export function resolveAuthType(
  configuredAuthType: AuthType | undefined,
): AuthType | undefined {
  // Built on `getExplicitAuthType` so the switch's precedence is defined once.
  return getExplicitAuthType(configuredAuthType) || getAuthTypeFromEnv();
}

/**
 * Returns the auth type, but only when the user made an explicit choice;
 * otherwise `undefined`.
 *
 * Use this where "nothing was chosen" has its own meaning — showing the auth
 * dialog, or falling through to a caller-specific default. An ambient
 * `GEMINI_API_KEY` counts as an unstated preference rather than a choice, which
 * is why it is excluded here even though {@link resolveAuthType} honours it.
 */
export function getExplicitAuthType(
  configuredAuthType: AuthType | undefined,
): AuthType | undefined {
  if (isOpenAiApiTypeSwitch()) {
    return AuthType.USE_OPENAI;
  }
  return configuredAuthType || undefined;
}

export type ContentGeneratorConfig = {
  apiKey?: string;
  vertexai?: boolean;
  authType?: AuthType;
  proxy?: string;
  baseUrl?: string;
  customHeaders?: Record<string, string>;
  vertexAiRouting?: VertexAiRoutingConfig;
};

export type VertexAiRequestType = 'dedicated' | 'shared';
export type VertexAiSharedRequestType = 'priority' | 'flex';

export interface VertexAiRoutingConfig {
  requestType?: VertexAiRequestType;
  sharedRequestType?: VertexAiSharedRequestType;
}

const VERTEX_AI_REQUEST_TYPE_HEADER = 'X-Vertex-AI-LLM-Request-Type';
const VERTEX_AI_SHARED_REQUEST_TYPE_HEADER =
  'X-Vertex-AI-LLM-Shared-Request-Type';

/**
 * Vertex AI Representative Endpoints (REP) for US and EU multi-regions.
 * These are used as a workaround for the client dynamically
 * constructing default legacy hostnames (e.g., 'us-aiplatform.googleapis.com')
 * instead of routing to the official REP endpoints.
 */
const VERTEX_AI_US_REP_ENDPOINT = 'https://aiplatform.us.rep.googleapis.com';
const VERTEX_AI_EU_REP_ENDPOINT = 'https://aiplatform.eu.rep.googleapis.com';

function validateBaseUrl(baseUrl: string): void {
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`Invalid custom base URL: ${baseUrl}`);
  }
}

export async function createContentGeneratorConfig(
  config: Config,
  authType: AuthType | undefined,
  apiKey?: string,
  baseUrl?: string,
  customHeaders?: Record<string, string>,
  vertexAiRouting?: VertexAiRoutingConfig,
): Promise<ContentGeneratorConfig> {
  const contentGeneratorConfig: ContentGeneratorConfig = {
    authType,
    proxy: config?.getProxy(),
    baseUrl,
    customHeaders,
    vertexAiRouting,
  };

  const getEnv = (key: string) => {
    if (config?.env && config.env[key] !== undefined) {
      return config.env[key];
    }
    return process.env[key];
  };

  // If we are using Google auth or we are in Cloud Shell, there is nothing else to validate for now.
  // Return before touching the API-key keychain: on Linux without a Secret Service
  // (WSL/SSH/Docker/CI) keytar can block indefinitely on its functional probe.
  if (
    authType === AuthType.LOGIN_WITH_GOOGLE ||
    authType === AuthType.COMPUTE_ADC ||
    authType === AuthType.USE_OPENAI
  ) {
    if (authType === AuthType.USE_OPENAI) {
      // Credentials come from their own env vars. An empty key is legitimate
      // here because local servers (Ollama, LM Studio) usually accept
      // unauthenticated requests. Each value falls back to the name the Gemini
      // path already uses, so a configuration written before the
      // `GEMINI_OPENAI_*` prefix keeps working; the OpenAI-named variable wins
      // whenever it is set.
      contentGeneratorConfig.apiKey =
        apiKey ||
        getEnv(OPENAI_API_KEY_ENV) ||
        getEnv(OPENAI_API_KEY_FALLBACK_ENV) ||
        '';
      contentGeneratorConfig.baseUrl =
        baseUrl ||
        getEnv(OPENAI_BASE_URL_ENV) ||
        getEnv(OPENAI_BASE_URL_FALLBACK_ENV) ||
        '';
      contentGeneratorConfig.vertexai = false;
    }
    return contentGeneratorConfig;
  }

  const geminiApiKey =
    apiKey || getEnv('GEMINI_API_KEY') || (await loadApiKey()) || undefined;
  const googleApiKey = getEnv('GOOGLE_API_KEY') || undefined;
  const googleCloudProject =
    getEnv('GOOGLE_CLOUD_PROJECT') ||
    getEnv('GOOGLE_CLOUD_PROJECT_ID') ||
    undefined;
  const googleCloudLocation = getEnv('GOOGLE_CLOUD_LOCATION') || undefined;

  if (authType === AuthType.USE_GEMINI && geminiApiKey) {
    contentGeneratorConfig.apiKey = geminiApiKey;
    contentGeneratorConfig.vertexai = false;

    return contentGeneratorConfig;
  }

  if (
    authType === AuthType.USE_VERTEX_AI &&
    (googleApiKey || (googleCloudProject && googleCloudLocation))
  ) {
    contentGeneratorConfig.apiKey = googleApiKey;
    contentGeneratorConfig.vertexai = true;

    return contentGeneratorConfig;
  }

  if (authType === AuthType.GATEWAY) {
    contentGeneratorConfig.apiKey = apiKey || getEnv('GEMINI_API_KEY') || '';
    contentGeneratorConfig.vertexai = false;

    return contentGeneratorConfig;
  }

  return contentGeneratorConfig;
}

export async function createContentGenerator(
  config: ContentGeneratorConfig,
  gcConfig: Config,
  sessionId?: string,
): Promise<ContentGenerator> {
  const generator = await (async () => {
    if (gcConfig.fakeResponsesNonStrict) {
      const fakeGenerator = await FakeContentGenerator.fromFile(
        gcConfig.fakeResponsesNonStrict,
        { nonStrict: true },
      );
      return new LoggingContentGenerator(fakeGenerator, gcConfig);
    }
    if (gcConfig.fakeResponses) {
      const fakeGenerator = await FakeContentGenerator.fromFile(
        gcConfig.fakeResponses,
      );
      return new LoggingContentGenerator(fakeGenerator, gcConfig);
    }
    if (config.authType === AuthType.USE_OPENAI) {
      // Handled before `resolveModel` and before any Google-specific client
      // setup, since none of that applies to an OpenAI-compatible endpoint.
      return new LoggingContentGenerator(
        new OpenAIContentGenerator(config, gcConfig),
        gcConfig,
      );
    }
    const version = await getVersion();
    const model = resolveModel(
      gcConfig.getModel(),
      config.authType === AuthType.USE_GEMINI ||
        config.authType === AuthType.USE_VERTEX_AI ||
        ((await gcConfig.getGemini31Launched?.()) ?? false),
      false,
      gcConfig.getHasAccessToPreviewModel?.() ?? true,
      gcConfig,
      gcConfig.hasGemini35FlashGAAccess?.() ?? false,
    );
    const customHeadersEnv =
      process.env['GEMINI_CLI_CUSTOM_HEADERS'] || undefined;
    const clientName = gcConfig.getClientName();
    const surface = determineSurface();

    let userAgent: string;
    // Use unified format for VS Code traffic.
    // Note: We don't automatically assume a2a-server is VS Code,
    // as it could be used by other clients unless the surface explicitly says 'vscode'.
    if (clientName === 'acp-vscode' || surface === 'vscode') {
      const osTypeMap: Record<string, string> = {
        darwin: 'macOS',
        win32: 'Windows',
        linux: 'Linux',
      };
      const osType = osTypeMap[process.platform] || process.platform;
      const osVersion = os.release();
      const arch = process.arch;

      const vscodeVersion = process.env['TERM_PROGRAM_VERSION'] || 'unknown';
      let hostPath = `VSCode/${vscodeVersion}`;
      if (isCloudShell()) {
        const cloudShellVersion =
          process.env['CLOUD_SHELL_VERSION'] || 'unknown';
        hostPath += ` > CloudShell/${cloudShellVersion}`;
      }

      userAgent = `CloudCodeVSCode/${version} (aidev_client; os_type=${osType}; os_version=${osVersion}; arch=${arch}; host_path=${hostPath}; proxy_client=geminicli)`;
    } else {
      const userAgentPrefix = clientName
        ? `GeminiCLI-${clientName}`
        : 'GeminiCLI';
      userAgent = `${userAgentPrefix}/${version}/${model} (${process.platform}; ${process.arch}; ${surface})`;
    }

    const customHeadersMap = parseCustomHeaders(customHeadersEnv);
    const apiKeyAuthMechanism =
      process.env['GEMINI_API_KEY_AUTH_MECHANISM'] || 'x-goog-api-key';
    const apiVersionEnv = process.env['GOOGLE_GENAI_API_VERSION'];

    const baseHeaders: Record<string, string> = {
      'User-Agent': userAgent,
      ...customHeadersMap,
    };

    if (
      apiKeyAuthMechanism === 'bearer' &&
      (config.authType === AuthType.USE_GEMINI ||
        config.authType === AuthType.USE_VERTEX_AI) &&
      config.apiKey
    ) {
      baseHeaders['Authorization'] = `Bearer ${config.apiKey}`;
    }
    if (
      config.authType === AuthType.LOGIN_WITH_GOOGLE ||
      config.authType === AuthType.COMPUTE_ADC
    ) {
      const httpOptions = { headers: baseHeaders };
      return new LoggingContentGenerator(
        new ModelMappingContentGenerator(
          await createCodeAssistContentGenerator(
            httpOptions,
            config.authType,
            gcConfig,
            sessionId,
          ),
          () => getBackendModelMappings(gcConfig, true),
        ),
        gcConfig,
      );
    }

    if (
      config.authType === AuthType.USE_GEMINI ||
      config.authType === AuthType.USE_VERTEX_AI ||
      config.authType === AuthType.GATEWAY
    ) {
      let headers: Record<string, string> = { ...baseHeaders };
      if (config.customHeaders) {
        headers = { ...headers, ...config.customHeaders };
      }
      if (
        config.authType === AuthType.USE_VERTEX_AI &&
        config.vertexAiRouting
      ) {
        const { requestType, sharedRequestType } = config.vertexAiRouting;
        headers = {
          ...headers,
          ...(requestType
            ? { [VERTEX_AI_REQUEST_TYPE_HEADER]: requestType }
            : {}),
          ...(sharedRequestType
            ? { [VERTEX_AI_SHARED_REQUEST_TYPE_HEADER]: sharedRequestType }
            : {}),
        };
      }
      if (gcConfig?.getUsageStatisticsEnabled()) {
        const installationManager = new InstallationManager();
        const installationId = installationManager.getInstallationId();
        headers = {
          ...headers,
          'x-gemini-api-privileged-user-id': `${installationId}`,
        };
      }
      if (config.authType === AuthType.GATEWAY && config.apiKey === '') {
        headers['x-goog-api-key'] = '';
      }
      let baseUrl = config.baseUrl;
      if (!baseUrl) {
        const envBaseUrl =
          config.authType === AuthType.USE_VERTEX_AI
            ? process.env['GOOGLE_VERTEX_BASE_URL']
            : process.env['GOOGLE_GEMINI_BASE_URL'];
        if (envBaseUrl) {
          validateBaseUrl(envBaseUrl);
          baseUrl = envBaseUrl;
        } else if (config.authType === AuthType.USE_VERTEX_AI) {
          const location = process.env['GOOGLE_CLOUD_LOCATION'];
          if (location === 'us') {
            baseUrl = VERTEX_AI_US_REP_ENDPOINT;
          } else if (location === 'eu') {
            baseUrl = VERTEX_AI_EU_REP_ENDPOINT;
          }
        }
      } else {
        validateBaseUrl(baseUrl);
      }

      const httpOptions: {
        baseUrl?: string;
        headers: Record<string, string>;
      } = { headers };

      if (baseUrl) {
        httpOptions.baseUrl = baseUrl;
      }

      const proxyUrl = config.proxy?.trim();
      const proxyAgent = proxyUrl
        ? baseUrl?.startsWith('http://')
          ? new HttpProxyAgent(proxyUrl)
          : new HttpsProxyAgent(proxyUrl)
        : undefined;
      const useVertex =
        config.vertexai ?? config.authType === AuthType.USE_VERTEX_AI;
      const googleGenAI = new GoogleGenAI({
        apiKey:
          config.authType === AuthType.GATEWAY
            ? config.apiKey
            : config.apiKey === ''
              ? undefined
              : config.apiKey,
        vertexai: config.vertexai ?? config.authType === AuthType.USE_VERTEX_AI,
        httpOptions,
        ...(apiVersionEnv && { apiVersion: apiVersionEnv }),
        // Merge proxy and GDCH endpoint into googleAuthOptions if either exists
        ...((proxyAgent || (useVertex && baseUrl)) && {
          googleAuthOptions: {
            clientOptions: {
              ...(proxyAgent && {
                transporterOptions: { agent: proxyAgent },
              }),
              ...(useVertex &&
                baseUrl && {
                  apiEndpoint: baseUrl,
                }),
            },
          },
        }),
      });
      return new LoggingContentGenerator(
        new ModelMappingContentGenerator(googleGenAI.models, () =>
          getBackendModelMappings(gcConfig, false),
        ),
        gcConfig,
      );
    }
    throw new Error(
      `Error creating contentGenerator: Unsupported authType: ${config.authType}`,
    );
  })();

  if (gcConfig.recordResponses) {
    return new RecordingContentGenerator(generator, gcConfig.recordResponses);
  }

  return generator;
}
