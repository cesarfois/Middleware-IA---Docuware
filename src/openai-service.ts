import OpenAI, { APIError } from 'openai';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import {
  buildOpenAIResponseFormat,
  buildSystemMessage,
  buildUserMessage,
  validateAndFilterResponse,
} from './schema-builder.js';
import type {
  ExtractionMetrics,
  NormalizedExtractionRequest,
  SupportedProvider,
} from './types.js';

export class ExtractionServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: 'EXTRACTION_FAILED' | 'PROVIDER_NOT_AVAILABLE';

  constructor(
    message: string,
    statusCode = 422,
    code: 'EXTRACTION_FAILED' | 'PROVIDER_NOT_AVAILABLE' = 'EXTRACTION_FAILED'
  ) {
    super(message);
    this.name = 'ExtractionServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const providerClients = new Map<string, OpenAI>();

/**
 * Resolve o cliente do provedor solicitado mantendo as credenciais e endpoints
 * estritamente protegidos no servidor (.env).
 */
function getProviderClient(
  provider: SupportedProvider,
  timeoutOverrideMs?: number
): OpenAI {
  const timeout = timeoutOverrideMs ?? config.openaiTimeoutMs;
  const cacheKey = `${provider}:${timeout}`;

  const cached = providerClients.get(cacheKey);
  if (cached) {
    return cached;
  }

  let apiKey = '';
  let baseURL: string | undefined;

  switch (provider) {
    case 'openai':
      apiKey = config.openaiApiKey;
      baseURL = config.openaiBaseUrl;
      if (!apiKey) {
        throw new ExtractionServiceError(
          'Provedor "openai" não está habilitado no servidor (OPENAI_API_KEY ausente).',
          422,
          'PROVIDER_NOT_AVAILABLE'
        );
      }
      break;

    case 'gemini':
      apiKey = config.geminiApiKey;
      baseURL = config.geminiBaseUrl;
      if (!apiKey) {
        throw new ExtractionServiceError(
          'Provedor "gemini" não está habilitado no servidor (GEMINI_API_KEY ausente).',
          422,
          'PROVIDER_NOT_AVAILABLE'
        );
      }
      break;

    case 'openai_compatible':
      apiKey = config.customAiApiKey;
      baseURL = config.customAiBaseUrl;
      if (!apiKey || !baseURL) {
        throw new ExtractionServiceError(
          'Provedor "openai_compatible" não está habilitado no servidor (CUSTOM_AI_API_KEY ou CUSTOM_AI_BASE_URL ausente).',
          422,
          'PROVIDER_NOT_AVAILABLE'
        );
      }
      break;

    default:
      throw new ExtractionServiceError(
        `Provedor "${String(provider)}" não suportado.`,
        422,
        'PROVIDER_NOT_AVAILABLE'
      );
  }

  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    timeout,
    maxRetries: 0,
  });

  providerClients.set(cacheKey, client);
  return client;
}

/**
 * Verifica se o erro do provedor de IA é transitório (Rate Limit 429, 500, 502, 503, 504 ou falha de rede).
 */
function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof APIError) {
    const status = err.status;
    if (!status) return true;
    return (
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504
    );
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('fetch failed')
    );
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OpenAIExtractionResult {
  data: Record<string, unknown>;
  metrics: ExtractionMetrics;
}

/**
 * Executa a chamada ao provedor de IA configurado no JSON `requestData`,
 * preservando integralmente as instruções do workflow, aplicando o JSON Schema dinâmico
 * e validando que a saída contenha exclusivamente os campos solicitados.
 */
export async function extractDocumentWithOpenAI(
  pdfBuffer: Buffer,
  filename: string,
  request: NormalizedExtractionRequest,
  logger: FastifyBaseLogger
): Promise<OpenAIExtractionResult> {
  const startTime = Date.now();
  const client = getProviderClient(
    request.provider,
    request.processing.timeoutMs
  );

  const base64Pdf = pdfBuffer.toString('base64');
  const responseFormat = buildOpenAIResponseFormat(request.fieldsMap);
  const systemMessage = buildSystemMessage(request);
  const userMessage = buildUserMessage(request);

  const maxRetries = config.openaiMaxRetries;
  let attempt = 0;
  let lastError: unknown = null;

  while (attempt <= maxRetries) {
    attempt++;
    try {
      const response = await client.chat.completions.create({
        model: request.model,
        temperature: request.processing.temperature,
        ...(request.processing.maxOutputTokens
          ? { max_completion_tokens: request.processing.maxOutputTokens }
          : {}),
        response_format: responseFormat as never,
        messages: [
          {
            role: 'system',
            content: systemMessage,
          },
          {
            role: 'user',
            content: [
              {
                type: 'file',
                file: {
                  filename: filename || 'document.pdf',
                  file_data: `data:application/pdf;base64,${base64Pdf}`,
                },
              } as never,
              {
                type: 'text',
                text: userMessage,
              },
            ],
          },
        ],
      });

      const choice = response.choices?.[0];
      const refusal = (choice?.message as unknown as { refusal?: string })
        ?.refusal;
      if (refusal) {
        throw new ExtractionServiceError(
          `O modelo recusou a extração documental: ${refusal}`,
          422
        );
      }

      const rawContent = choice?.message?.content?.trim();
      if (!rawContent) {
        throw new ExtractionServiceError(
          'O provedor de IA retornou uma resposta vazia para o documento enviado.',
          422
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawContent);
      } catch {
        throw new ExtractionServiceError(
          'Falha ao decodificar o JSON retornado pelo provedor de IA.',
          422
        );
      }

      if (
        !parsedJson ||
        typeof parsedJson !== 'object' ||
        Array.isArray(parsedJson)
      ) {
        throw new ExtractionServiceError(
          'O modelo não retornou um objeto JSON chave/valor válido.',
          422
        );
      }

      // Garante que o JSON de saída contenha EXCLUSIVAMENTE os campos solicitados na requisição
      const strictlyValidatedData = validateAndFilterResponse(
        parsedJson as Record<string, unknown>,
        request
      );

      const durationMs = Date.now() - startTime;
      const metrics: ExtractionMetrics = {
        durationMs,
        fileSizeBytes: pdfBuffer.byteLength,
        provider: request.provider,
        model: response.model || request.model,
        contractVersion: request.contractVersion,
        requestedFieldsCount: request.requestedFieldNames.length,
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        attempts: attempt,
      };

      return { data: strictlyValidatedData, metrics };
    } catch (err) {
      lastError = err;

      if (attempt <= maxRetries && isRetryableProviderError(err)) {
        const baseDelay =
          attempt === 1 ? 1000 : 2500 * Math.pow(1.5, attempt - 2);
        const jitter = Math.floor(Math.random() * 250);
        const waitMs = Math.round(baseDelay + jitter);

        logger.warn(
          {
            attempt,
            maxRetries,
            waitMs,
            provider: request.provider,
            model: request.model,
            statusCode: err instanceof APIError ? err.status : undefined,
            errorName: err instanceof Error ? err.name : 'UnknownError',
          },
          'Falha transitória na chamada ao provedor de IA. Aguardando backoff para nova tentativa...'
        );

        await sleep(waitMs);
        continue;
      }

      break;
    }
  }

  if (lastError instanceof ExtractionServiceError) {
    throw lastError;
  }

  if (lastError instanceof APIError) {
    const status =
      lastError.status && lastError.status >= 500 ? 502 : 422;
    throw new ExtractionServiceError(
      `Erro na comunicação com o provedor "${request.provider}" (HTTP ${lastError.status ?? 'N/A'}): ${lastError.message}`,
      status
    );
  }

  const genericMessage =
    lastError instanceof Error
      ? lastError.message
      : 'Erro desconhecido ao processar documento no provedor de IA.';
  throw new ExtractionServiceError(genericMessage, 500);
}
