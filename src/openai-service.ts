import OpenAI, { APIError } from 'openai';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import {
  buildOpenAIResponseFormat,
  enforceNonNullSchemaDefaults,
} from './schema-builder.js';
import type {
  ExtractionMetrics,
  NormalizedExtractionRequest,
} from './types.js';

export class ExtractionServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: 'EXTRACTION_FAILED';

  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = 'ExtractionServiceError';
    this.statusCode = statusCode;
    this.code = 'EXTRACTION_FAILED';
  }
}

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!config.openaiApiKey) {
    throw new ExtractionServiceError(
      'Variável de ambiente OPENAI_API_KEY não configurada no servidor.',
      500
    );
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.openaiApiKey,
      timeout: config.openaiTimeoutMs,
      // Desativa retry interno do SDK para controlar explicitamente o backoff exponencial e logs
      maxRetries: 0,
    });
  }
  return openaiClient;
}

/**
 * Verifica se o erro da OpenAI é transitório (Rate Limit 429, 500, 502, 503, 504 ou falha de rede)
 * e elegível para nova tentativa com backoff exponencial.
 */
function isRetryableOpenAIError(err: unknown): boolean {
  if (err instanceof APIError) {
    const status = err.status;
    if (!status) return true; // Erro de conexão/timeout sem HTTP status
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
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
 * Executa a chamada multimodal ao GPT-4o enviando o PDF em Base64 e o schema dinâmico,
 * com suporte a retry automático (backoff exponencial) e garantia de propriedades não-nulas.
 */
export async function extractDocumentWithOpenAI(
  pdfBuffer: Buffer,
  filename: string,
  request: NormalizedExtractionRequest,
  logger: FastifyBaseLogger
): Promise<OpenAIExtractionResult> {
  const startTime = Date.now();
  const client = getOpenAIClient();

  const base64Pdf = pdfBuffer.toString('base64');
  const responseFormat = buildOpenAIResponseFormat(request.schemaDefinition);

  // A API da OpenAI exige que a palavra "JSON" conste nas mensagens quando response_format = json_object
  const effectiveUserPrompt =
    request.mode === 'json_object'
      ? `${request.userPrompt}\n\nResponda exclusivamente com um objeto JSON plano contendo as chaves deduzidas da instrução e seus respectivos valores extraídos do PDF (use "" para campos ausentes).`
      : request.userPrompt;

  const maxRetries = config.openaiMaxRetries;
  let attempt = 0;
  let lastError: unknown = null;

  while (attempt <= maxRetries) {
    attempt++;
    try {
      const response = await client.chat.completions.create({
        model: config.openaiModel,
        temperature: 0,
        response_format: responseFormat as never,
        messages: [
          {
            role: 'system',
            content: request.systemInstruction,
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
                text: effectiveUserPrompt,
              },
            ],
          },
        ],
      });

      const choice = response.choices?.[0];
      const refusal = (choice?.message as unknown as { refusal?: string })?.refusal;
      if (refusal) {
        throw new ExtractionServiceError(
          `O modelo recusou a extração documental: ${refusal}`,
          422
        );
      }

      const rawContent = choice?.message?.content?.trim();
      if (!rawContent) {
        throw new ExtractionServiceError(
          'A OpenAI retornou uma resposta vazia para o documento enviado.',
          422
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawContent);
      } catch {
        throw new ExtractionServiceError(
          'Falha ao decodificar o JSON retornado pelo modelo OpenAI.',
          422
        );
      }

      if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
        throw new ExtractionServiceError(
          'O modelo não retornou um objeto JSON chave/valor válido.',
          422
        );
      }

      const normalizedData = enforceNonNullSchemaDefaults(
        parsedJson as Record<string, unknown>,
        request.schemaDefinition
      );

      const durationMs = Date.now() - startTime;
      const metrics: ExtractionMetrics = {
        durationMs,
        fileSizeBytes: pdfBuffer.byteLength,
        model: response.model || config.openaiModel,
        mode: request.mode,
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        attempts: attempt,
      };

      return { data: normalizedData, metrics };
    } catch (err) {
      lastError = err;

      if (attempt <= maxRetries && isRetryableOpenAIError(err)) {
        // Backoff exponencial: 1000ms na 1ª falha, 2500ms na 2ª falha (+ jitter de até 250ms)
        const baseDelay = attempt === 1 ? 1000 : 2500 * Math.pow(1.5, attempt - 2);
        const jitter = Math.floor(Math.random() * 250);
        const waitMs = Math.round(baseDelay + jitter);

        logger.warn(
          {
            attempt,
            maxRetries,
            waitMs,
            statusCode: err instanceof APIError ? err.status : undefined,
            errorName: err instanceof Error ? err.name : 'UnknownError',
          },
          'Falha transitória na chamada à OpenAI. Aguardando backoff para nova tentativa...'
        );

        await sleep(waitMs);
        continue;
      }

      break;
    }
  }

  // Tratamento de erro final após esgotar as tentativas
  if (lastError instanceof ExtractionServiceError) {
    throw lastError;
  }

  if (lastError instanceof APIError) {
    const status = lastError.status && lastError.status >= 500 ? 502 : 422;
    throw new ExtractionServiceError(
      `Erro na comunicação com a OpenAI (HTTP ${lastError.status ?? 'N/A'}): ${lastError.message}`,
      status
    );
  }

  const genericMessage =
    lastError instanceof Error ? lastError.message : 'Erro desconhecido ao processar documento na IA.';
  throw new ExtractionServiceError(genericMessage, 500);
}

