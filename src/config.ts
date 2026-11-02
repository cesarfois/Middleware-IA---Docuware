import dotenv from 'dotenv';

dotenv.config();

export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
}

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  apiAuthToken: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiBaseUrl?: string;
  geminiApiKey: string;
  geminiModel: string;
  geminiBaseUrl: string;
  customAiApiKey: string;
  customAiBaseUrl?: string;
  customAiModel: string;
  openaiTimeoutMs: number;
  openaiMaxRetries: number;
  maxFileSizeBytes: number;
  // Configurações da DocuWare Platform REST API (Endpoint Textshot)
  docuwarePlatformUrl: string;
  docuwareUsername: string;
  docuwarePassword: string;
  docuwareBearerToken: string;
  docuwareHostId: string;
  docuwareTimeoutMs: number;
  docuwareMaxConcurrency: number;
  docuwareMaxTextshotChars: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export const config: AppConfig = {
  port: parsePositiveInt(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'production',
  apiAuthToken: (process.env.API_AUTH_TOKEN || '').trim(),
  openaiApiKey: (process.env.OPENAI_API_KEY || '').trim(),
  openaiModel: (process.env.OPENAI_MODEL || 'gpt-4o').trim(),
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || '').trim() || undefined,
  geminiApiKey: (process.env.GEMINI_API_KEY || '').trim(),
  geminiModel: (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
  geminiBaseUrl:
    (process.env.GEMINI_BASE_URL || '').trim() ||
    'https://generativelanguage.googleapis.com/v1beta/openai/',
  customAiApiKey: (process.env.CUSTOM_AI_API_KEY || '').trim(),
  customAiBaseUrl: (process.env.CUSTOM_AI_BASE_URL || '').trim() || undefined,
  customAiModel: (process.env.CUSTOM_AI_MODEL || 'gpt-4o').trim(),
  openaiTimeoutMs: parsePositiveInt(process.env.OPENAI_TIMEOUT_MS, 45000),
  openaiMaxRetries: parsePositiveInt(process.env.OPENAI_MAX_RETRIES, 2),
  // Padrão: 30 MB (31.457.280 bytes)
  maxFileSizeBytes: parsePositiveInt(process.env.MAX_FILE_SIZE, 30 * 1024 * 1024),
  // DocuWare Cloud 7.14 Platform REST API
  docuwarePlatformUrl: normalizeBaseUrl(
    process.env.DOCUWARE_PLATFORM_URL ||
      'https://rcsangola.docuware.cloud/DocuWare/Platform'
  ),
  docuwareUsername: (process.env.DOCUWARE_USERNAME || '').trim(),
  docuwarePassword: (process.env.DOCUWARE_PASSWORD || '').trim(),
  docuwareBearerToken: (
    process.env.DOCUWARE_BEARER_TOKEN ||
    process.env.DOCUWARE_API_KEY ||
    ''
  ).trim(),
  docuwareHostId: (process.env.DOCUWARE_HOST_ID || '').trim(),
  docuwareTimeoutMs: parsePositiveInt(process.env.DOCUWARE_TIMEOUT_MS, 30000),
  docuwareMaxConcurrency: parsePositiveInt(
    process.env.DOCUWARE_MAX_CONCURRENCY,
    5
  ),
  docuwareMaxTextshotChars: parsePositiveInt(
    process.env.DOCUWARE_MAX_TEXTSHOT_CHARS,
    2_000_000
  ),
};
