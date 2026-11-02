import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyDocuWareAuth } from '../auth.js';
import { config } from '../config.js';
import {
  ExtractionServiceError,
  extractDocumentWithOpenAI,
} from '../openai-service.js';
import {
  RequestValidationError,
  parseRequestData,
} from '../schema-builder.js';
import type {
  NormalizedExtractionRequest,
  StandardErrorResponse,
} from '../types.js';

/**
 * Valida se o Buffer corresponde a um arquivo PDF válido verificando os magic bytes "%PDF-"
 * nos primeiros 1024 bytes do binário (conforme especificação ISO 32000-1).
 */
export function isValidPdfBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.byteLength < 5) {
    return false;
  }
  const headerSlice = buffer
    .subarray(0, Math.min(buffer.byteLength, 1024))
    .toString('latin1');
  return headerSlice.includes('%PDF-');
}

/**
 * Tenta fazer o parse de uma string JSON caso ela represente um objeto ou array.
 */
function tryParseJsonValue(val: string): unknown {
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      try {
        const sanitized = trimmed
          .replace(/[\u201C\u201D]/g, '"')
          .replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(sanitized);
      } catch {
        return val;
      }
    }
  }
  return val;
}

/**
 * Resolve o JSON de configuração a partir dos campos multipart recebidos do DocuWare.
 * Suporta:
 * 1. Campo `requestData` contendo o JSON completo (padrão HTTP Body do DocuWare).
 * 2. Qualquer campo único cujo valor seja o JSON completo do contrato.
 * 3. Chaves do contrato (`instructions`, `extraction`, `prompt`, `schema`, etc.) enviadas
 *    individualmente como campos de formulário multipart no DocuWare.
 */
function resolveRequestDataFromMultipartFields(
  fields: Record<string, string>
): string | null {
  const fieldEntries = Object.entries(fields);
  if (fieldEntries.length === 0) {
    return null;
  }

  // 1. Prioriza `requestData` (case-insensitive) se não estiver vazio
  for (const [key, val] of fieldEntries) {
    if (key.toLowerCase() === 'requestdata' && val.trim().length > 0) {
      return val.trim();
    }
  }

  // 2. Verifica se algum campo único contém um objeto JSON completo com instructions/extraction ou prompt/schema
  for (const [, val] of fieldEntries) {
    const trimmed = val.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const parsed = tryParseJsonValue(trimmed);
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        ('instructions' in parsed ||
          'extraction' in parsed ||
          'prompt' in parsed ||
          'schema' in parsed)
      ) {
        return JSON.stringify(parsed);
      }
    }
  }

  // 3. Caso o DocuWare tenha enviado as chaves do contrato como campos multipart separados
  const contractRootKeys = new Set([
    'provider',
    'model',
    'processing',
    'instructions',
    'extraction',
    'response',
    'system_instruction',
    'prompt',
    'schema',
  ]);

  const hasSeparateContractKeys = fieldEntries.some(([k]) =>
    contractRootKeys.has(k)
  );

  if (hasSeparateContractKeys) {
    const reconstructed: Record<string, unknown> = {};
    for (const [key, val] of fieldEntries) {
      if (contractRootKeys.has(key) && val.trim().length > 0) {
        reconstructed[key] = tryParseJsonValue(val);
      }
    }
    if (Object.keys(reconstructed).length > 0) {
      return JSON.stringify(reconstructed);
    }
  }

  return null;
}

async function handleDocumentExtraction(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const requestStartTime = Date.now();

  if (!request.isMultipart()) {
    const payload: StandardErrorResponse = {
      error: true,
      code: 'INVALID_MULTIPART',
      message:
        'A requisição deve ser enviada com Content-Type: multipart/form-data.',
    };
    return reply.status(422).send(payload);
  }

  let pdfBuffer: Buffer | null = null;
  let pdfFilename = 'document.pdf';
  let fileTruncated = false;
  const receivedFields: Record<string, string> = {};
  const receivedPartSummary: string[] = [];

  try {
    const parts = request.parts();

    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (part.file.truncated) {
          fileTruncated = true;
        }
        const buf = Buffer.concat(chunks);
        receivedPartSummary.push(
          `file:${part.fieldname}(${part.mimetype},${buf.byteLength}b)`
        );

        // Verifica se este arquivo é o PDF ou se é um part JSON enviado como arquivo pelo cliente HTTP
        if (isValidPdfBuffer(buf) || part.fieldname === 'file' || pdfBuffer === null) {
          if (isValidPdfBuffer(buf) || pdfBuffer === null) {
            pdfBuffer = buf;
            if (part.filename) {
              pdfFilename = part.filename;
            }
          } else {
            const textContent = buf.toString('utf8').trim();
            if (textContent.startsWith('{')) {
              receivedFields[part.fieldname || 'requestData'] = textContent;
            }
          }
        } else {
          const textContent = buf.toString('utf8').trim();
          if (textContent.startsWith('{')) {
            receivedFields[part.fieldname || 'requestData'] = textContent;
          }
        }
      } else {
        const strVal =
          typeof part.value === 'string'
            ? part.value
            : String(part.value ?? '');
        receivedFields[part.fieldname] = strVal;
        receivedPartSummary.push(
          `field:${part.fieldname}(${strVal.trim().length}chars)`
        );
      }
    }
  } catch (err) {
    const errCode = (err as { code?: string })?.code;
    if (errCode === 'FST_REQ_FILE_TOO_LARGE' || fileTruncated) {
      const maxMb = (config.maxFileSizeBytes / (1024 * 1024)).toFixed(1);
      const payload: StandardErrorResponse = {
        error: true,
        code: 'FILE_TOO_LARGE',
        message: `O arquivo PDF excede o tamanho máximo permitido de ${maxMb} MB.`,
      };
      return reply.status(422).send(payload);
    }

    request.log.error(
      { errName: err instanceof Error ? err.name : 'Unknown' },
      'Erro ao ler multipart/form-data.'
    );
    const payload: StandardErrorResponse = {
      error: true,
      code: 'INVALID_MULTIPART',
      message: 'Falha ao processar o payload multipart/form-data enviado.',
    };
    return reply.status(422).send(payload);
  }

  if (fileTruncated) {
    const maxMb = (config.maxFileSizeBytes / (1024 * 1024)).toFixed(1);
    const payload: StandardErrorResponse = {
      error: true,
      code: 'FILE_TOO_LARGE',
      message: `O arquivo PDF excede o tamanho máximo permitido de ${maxMb} MB.`,
    };
    return reply.status(422).send(payload);
  }

  if (!pdfBuffer || pdfBuffer.byteLength === 0) {
    const payload: StandardErrorResponse = {
      error: true,
      code: 'MISSING_FILE',
      message: 'Nenhum arquivo PDF foi recebido no campo multipart "file".',
    };
    return reply.status(422).send(payload);
  }

  if (!isValidPdfBuffer(pdfBuffer)) {
    const payload: StandardErrorResponse = {
      error: true,
      code: 'INVALID_PDF',
      message:
        'O arquivo enviado no campo "file" não possui assinatura binária de um PDF válido (%PDF-).',
    };
    return reply.status(422).send(payload);
  }

  const rawRequestData = resolveRequestDataFromMultipartFields(receivedFields);

  // Valida estritamente o JSON requestData (sem fallback silencioso)
  let extractionRequest: NormalizedExtractionRequest;
  try {
    extractionRequest = parseRequestData(rawRequestData);
  } catch (err) {
    const statusCode =
      err instanceof RequestValidationError ? err.statusCode : 422;
    const baseMessage =
      err instanceof Error
        ? err.message
        : 'Configuração inválida no campo requestData.';
    const diagnosticSuffix =
      receivedPartSummary.length > 0
        ? ` [Partes multipart recebidas: ${receivedPartSummary.join(', ')}]`
        : '';

    request.log.warn(
      {
        status: 'INVALID_CONFIGURATION',
        httpStatus: statusCode,
        receivedParts: receivedPartSummary,
        message: baseMessage,
      },
      'Requisição rejeitada por configuração inválida em requestData.'
    );

    const payload: StandardErrorResponse = {
      error: true,
      code: 'INVALID_CONFIGURATION',
      message: `${baseMessage}${diagnosticSuffix}`,
    };
    return reply.status(statusCode).send(payload);
  }

  try {
    const { data, metrics } = await extractDocumentWithOpenAI(
      pdfBuffer,
      pdfFilename,
      extractionRequest,
      request.log
    );

    request.log.info(
      {
        status: 'SUCCESS',
        httpStatus: 200,
        totalDurationMs: Date.now() - requestStartTime,
        providerDurationMs: metrics.durationMs,
        fileSizeBytes: metrics.fileSizeBytes,
        provider: metrics.provider,
        model: metrics.model,
        contractVersion: metrics.contractVersion,
        requestedFieldsCount: metrics.requestedFieldsCount,
        promptTokens: metrics.promptTokens,
        completionTokens: metrics.completionTokens,
        totalTokens: metrics.totalTokens,
        attempts: metrics.attempts,
      },
      'Extração documental concluída com sucesso.'
    );

    return reply.status(200).send(data);
  } catch (err) {
    const statusCode =
      err instanceof ExtractionServiceError ? err.statusCode : 500;
    const errorCode =
      err instanceof ExtractionServiceError ? err.code : 'EXTRACTION_FAILED';
    const message =
      err instanceof Error
        ? err.message
        : 'Erro interno durante a extração documental.';

    request.log.error(
      {
        status: 'FAILED',
        httpStatus: statusCode,
        totalDurationMs: Date.now() - requestStartTime,
        fileSizeBytes: pdfBuffer.byteLength,
        provider: extractionRequest.provider,
        model: extractionRequest.model,
        contractVersion: extractionRequest.contractVersion,
        errorMessage: message,
      },
      'Falha na extração documental.'
    );

    const payload: StandardErrorResponse = {
      error: true,
      code: errorCode,
      message,
    };
    return reply.status(statusCode).send(payload);
  }
}

export async function registerExtractRoutes(
  app: FastifyInstance
): Promise<void> {
  const routeOptions = {
    preHandler: verifyDocuWareAuth,
  };

  app.post('/extract', routeOptions, handleDocumentExtraction);
  app.post('/api/extract', routeOptions, handleDocumentExtraction);
  app.post('/ai-gateway/extract', routeOptions, handleDocumentExtraction);
  app.post('/ai-gateway', routeOptions, handleDocumentExtraction);
  app.post('/', routeOptions, handleDocumentExtraction);
}
