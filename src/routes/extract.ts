import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyDocuWareAuth } from '../auth.js';
import { config } from '../config.js';
import {
  ExtractionServiceError,
  extractDocumentWithOpenAI,
} from '../openai-service.js';
import { parseRequestData } from '../schema-builder.js';
import type { StandardErrorResponse } from '../types.js';

/**
 * Valida se o Buffer corresponde a um arquivo PDF válido verificando os magic bytes "%PDF-"
 * nos primeiros 1024 bytes do binário (conforme especificação ISO 32000-1).
 */
export function isValidPdfBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.byteLength < 5) {
    return false;
  }
  const headerSlice = buffer.subarray(0, Math.min(buffer.byteLength, 1024)).toString('latin1');
  return headerSlice.includes('%PDF-');
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
      message: 'A requisição deve ser enviada com Content-Type: multipart/form-data.',
    };
    return reply.status(422).send(payload);
  }

  let pdfBuffer: Buffer | null = null;
  let pdfFilename = 'document.pdf';
  let fileTruncated = false;
  let rawRequestData: string | null = null;

  try {
    const parts = request.parts();

    for await (const part of parts) {
      if (part.type === 'file') {
        // Prioriza o campo 'file' enviado pelo DocuWare (ou aceita o primeiro arquivo anexado)
        if (part.fieldname === 'file' || pdfBuffer === null) {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          if (part.file.truncated) {
            fileTruncated = true;
          }
          pdfBuffer = Buffer.concat(chunks);
          if (part.filename) {
            pdfFilename = part.filename;
          }
        } else {
          // Drena streams extras caso existam para não travar o parser multipart
          part.file.resume();
        }
      } else {
        // Campo de texto do multipart: DocuWare envia o conteúdo do HTTP Body em `requestData`
        const fieldNameLower = part.fieldname.toLowerCase();
        if (
          part.fieldname === 'requestData' ||
          fieldNameLower === 'requestdata' ||
          (rawRequestData === null &&
            ['request_data', 'body', 'instructions', 'payload'].includes(fieldNameLower))
        ) {
          rawRequestData = typeof part.value === 'string' ? part.value : String(part.value ?? '');
        }
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

    request.log.error({ errName: err instanceof Error ? err.name : 'Unknown' }, 'Erro ao ler multipart/form-data.');
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
      message: 'O arquivo enviado no campo "file" não possui assinatura binária de um PDF válido (%PDF-).',
    };
    return reply.status(422).send(payload);
  }

  // Interpreta e normaliza as instruções dinâmicas enviadas pelo DocuWare em `requestData`
  const extractionRequest = parseRequestData(rawRequestData);

  try {
    const { data, metrics } = await extractDocumentWithOpenAI(
      pdfBuffer,
      pdfFilename,
      extractionRequest,
      request.log
    );

    // Log seguro de auditoria/métricas (sem gravar conteúdo confidencial do documento)
    request.log.info(
      {
        status: 'SUCCESS',
        httpStatus: 200,
        totalDurationMs: Date.now() - requestStartTime,
        openaiDurationMs: metrics.durationMs,
        fileSizeBytes: metrics.fileSizeBytes,
        model: metrics.model,
        mode: metrics.mode,
        schemaFieldsCount: extractionRequest.schemaDefinition
          ? Object.keys(extractionRequest.schemaDefinition).length
          : 0,
        promptTokens: metrics.promptTokens,
        completionTokens: metrics.completionTokens,
        totalTokens: metrics.totalTokens,
        attempts: metrics.attempts,
      },
      'Extração documental concluída com sucesso.'
    );

    // Retorna o JSON diretamente na raiz para mapeamento imediato no DocuWare Workflow Designer
    return reply.status(200).send(data);
  } catch (err) {
    const statusCode = err instanceof ExtractionServiceError ? err.statusCode : 500;
    const message =
      err instanceof Error ? err.message : 'Erro interno durante a extração documental.';

    request.log.error(
      {
        status: 'FAILED',
        httpStatus: statusCode,
        totalDurationMs: Date.now() - requestStartTime,
        fileSizeBytes: pdfBuffer.byteLength,
        mode: extractionRequest.mode,
        errorMessage: message,
      },
      'Falha na extração documental.'
    );

    const payload: StandardErrorResponse = {
      error: true,
      code: 'EXTRACTION_FAILED',
      message,
    };
    return reply.status(statusCode).send(payload);
  }
}

export async function registerExtractRoutes(app: FastifyInstance): Promise<void> {
  const routeOptions = {
    preHandler: verifyDocuWareAuth,
  };

  // Endpoint principal e aliases para facilitar configuração no Web Service do DocuWare
  app.post('/extract', routeOptions, handleDocumentExtraction);
  app.post('/api/extract', routeOptions, handleDocumentExtraction);
  app.post('/', routeOptions, handleDocumentExtraction);
}

