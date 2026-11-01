import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  apiAuthToken: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiTimeoutMs: number;
  openaiMaxRetries: number;
  maxFileSizeBytes: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config: AppConfig = {
  port: parsePositiveInt(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'production',
  apiAuthToken: (process.env.API_AUTH_TOKEN || '').trim(),
  openaiApiKey: (process.env.OPENAI_API_KEY || '').trim(),
  openaiModel: (process.env.OPENAI_MODEL || 'gpt-4o').trim(),
  openaiTimeoutMs: parsePositiveInt(process.env.OPENAI_TIMEOUT_MS, 45000),
  openaiMaxRetries: parsePositiveInt(process.env.OPENAI_MAX_RETRIES, 2),
  // Padrão: 30 MB (31.457.280 bytes)
  maxFileSizeBytes: parsePositiveInt(process.env.MAX_FILE_SIZE, 30 * 1024 * 1024),
};

