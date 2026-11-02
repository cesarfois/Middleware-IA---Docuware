import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyDocuWareAuth } from '../auth.js';
import {
  DocuWarePlatformClient,
  DocuWareServiceError,
  defaultDocuWareClient,
  validateAndNormalizeTextshotRequest,
} from '../docuware-client.js';
import type { StandardErrorResponse } from '../types.js';

export async function registerTextshotRoutes(
  app: FastifyInstance,
  client: DocuWarePlatformClient = defaultDocuWareClient
): Promise<void> {
  const handleTextshotRequest = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> => {
    let rawBody: unknown = request.body;

    // Caso o cliente envie text/plain contendo JSON
    if (typeof rawBody === 'string' && rawBody.trim().startsWith('{')) {
      try {
        rawBody = JSON.parse(rawBody.trim());
      } catch {
        const errPayload: StandardErrorResponse = {
          error: true,
          code: 'INVALID_REQUEST',
          message: 'O corpo JSON enviado para o endpoint /textshot é inválido.',
        };
        return reply.status(400).send(errPayload);
      }
    }

    let normalizedRequest;
    try {
      normalizedRequest = validateAndNormalizeTextshotRequest(rawBody);
    } catch (err) {
      const statusCode =
        err instanceof DocuWareServiceError ? err.statusCode : 400;
      const code =
        err instanceof DocuWareServiceError ? err.code : 'INVALID_REQUEST';
      const message =
        err instanceof Error
          ? err.message
          : 'Parâmetros inválidos na requisição de Textshot.';

      request.log.warn(
        { status: 'INVALID_REQUEST', code, httpStatus: statusCode, message },
        'Requisição /textshot rejeitada na validação de entrada.'
      );

      const errPayload: StandardErrorResponse = {
        error: true,
        code,
        message,
      };
      return reply.status(statusCode).send(errPayload);
    }

    try {
      const result = await client.retrieveDocumentTextshot(normalizedRequest);

      // Log seguro de métricas (sem gravar texto integral do documento ou credenciais)
      request.log.info(
        {
          status: 'SUCCESS',
          httpStatus: 200,
          documentId: result.documentId,
          fileCabinetId: result.fileCabinetId,
          sectionCount: result.sectionCount,
          pageCount: result.pageCount,
          textLength: result.textLength,
          originalTextLength: result.originalTextLength,
          truncated: result.truncated,
          processingTimeMs: result.processingTimeMs,
          timings: result.timings,
        },
        'Textshot recuperado com sucesso da DocuWare Platform API.'
      );

      return reply.status(200).send(result);
    } catch (err) {
      const statusCode =
        err instanceof DocuWareServiceError ? err.statusCode : 502;
      const code =
        err instanceof DocuWareServiceError ? err.code : 'DOCUWARE_API_ERROR';
      const message =
        err instanceof Error
          ? err.message
          : 'Erro inesperado ao recuperar Textshot na DocuWare Platform API.';

      request.log.error(
        {
          status: 'FAILED',
          code,
          httpStatus: statusCode,
          documentId: normalizedRequest.documentId,
          fileCabinetId: normalizedRequest.fileCabinetId,
          errorMessage: message,
        },
        'Falha ao recuperar Textshot na DocuWare Platform API.'
      );

      const errPayload: StandardErrorResponse = {
        error: true,
        code,
        message,
      };
      return reply.status(statusCode).send(errPayload);
    }
  };

  const routeOptions = {
    preHandler: verifyDocuWareAuth,
  };

  app.post('/ai-gateway/textshot', routeOptions, handleTextshotRequest);
  app.post('/textshot', routeOptions, handleTextshotRequest);
  app.post('/api/textshot', routeOptions, handleTextshotRequest);
}
