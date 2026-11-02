import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyDocuWareAuth } from '../auth.js';
import {
  ClassifierService,
  ClassifierValidationError,
  getDefaultClassifierService,
  validateAndNormalizeClassifyRequest,
  validateAndNormalizeTrainRequest,
} from '../classifier-service.js';
import { DocuWareServiceError } from '../docuware-client.js';
import type { StandardErrorResponse } from '../types.js';

function parseJsonBodyIfNeeded(rawBody: unknown): unknown {
  if (typeof rawBody === 'string' && rawBody.trim().startsWith('{')) {
    return JSON.parse(rawBody.trim());
  }
  return rawBody;
}

export async function registerClassifierRoutes(
  app: FastifyInstance,
  customService?: ClassifierService
): Promise<void> {
  const service = customService ?? getDefaultClassifierService();
  // Retoma quaisquer trabalhos que tenham ficado interrompidos num reinício anterior
  service.recoverAndResumeQueue();

  // --------------------------------------------------------------------------
  // 1. POST /ai-gateway/train
  // --------------------------------------------------------------------------
  const handleTrainRequest = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> => {
    let rawBody: unknown;
    try {
      rawBody = parseJsonBodyIfNeeded(request.body);
    } catch {
      const errPayload: StandardErrorResponse = {
        error: true,
        code: 'INVALID_REQUEST',
        message: 'O corpo JSON enviado para o endpoint /train é inválido.',
      };
      return reply.status(400).send(errPayload);
    }

    let normalized;
    try {
      normalized = validateAndNormalizeTrainRequest(rawBody);
    } catch (err) {
      const statusCode =
        err instanceof ClassifierValidationError ? err.statusCode : 400;
      const code =
        err instanceof ClassifierValidationError ? err.code : 'INVALID_REQUEST';
      const message =
        err instanceof Error
          ? err.message
          : 'Parâmetros inválidos na requisição de treino.';

      request.log.warn(
        { status: 'INVALID_REQUEST', code, httpStatus: statusCode, message },
        'Requisição /train rejeitada na validação de entrada.'
      );

      const errPayload: StandardErrorResponse = {
        error: true,
        code,
        message,
      };
      return reply.status(statusCode).send(errPayload);
    }

    const result = service.enqueueTrainingDocument(normalized);

    request.log.info(
      {
        status: 'QUEUED',
        httpStatus: 202,
        trainingId: result.trainingId,
        documentId: result.documentId,
        fileCabinetId: result.fileCabinetId,
        documentType: result.documentType,
      },
      'Exemplo documental recebido e enfileirado para aprendizagem supervisionada.'
    );

    return reply.status(200).send(result);
  };

  // --------------------------------------------------------------------------
  // 2. GET /ai-gateway/train/status
  // --------------------------------------------------------------------------
  const handleTrainStatusRequest = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const trainingId =
      typeof query.trainingId === 'string' ? query.trainingId : '';

    try {
      const statusResult = service.getTrainingStatus(trainingId);
      return reply.status(200).send(statusResult);
    } catch (err) {
      const statusCode =
        err instanceof ClassifierValidationError ? err.statusCode : 400;
      const code =
        err instanceof ClassifierValidationError ? err.code : 'INVALID_REQUEST';
      const message =
        err instanceof Error
          ? err.message
          : 'Não foi possível consultar o estado do trabalho de treino.';

      const errPayload: StandardErrorResponse = {
        error: true,
        code,
        message,
      };
      return reply.status(statusCode).send(errPayload);
    }
  };

  // --------------------------------------------------------------------------
  // 3. POST /ai-gateway/classify
  // --------------------------------------------------------------------------
  const handleClassifyRequest = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> => {
    let rawBody: unknown;
    try {
      rawBody = parseJsonBodyIfNeeded(request.body);
    } catch {
      const errPayload: StandardErrorResponse = {
        error: true,
        code: 'INVALID_REQUEST',
        message: 'O corpo JSON enviado para o endpoint /classify é inválido.',
      };
      return reply.status(400).send(errPayload);
    }

    let normalized;
    try {
      normalized = validateAndNormalizeClassifyRequest(rawBody);
    } catch (err) {
      const statusCode =
        err instanceof ClassifierValidationError ? err.statusCode : 400;
      const code =
        err instanceof ClassifierValidationError ? err.code : 'INVALID_REQUEST';
      const message =
        err instanceof Error
          ? err.message
          : 'Parâmetros inválidos na requisição de classificação.';

      const errPayload: StandardErrorResponse = {
        error: true,
        code,
        message,
      };
      return reply.status(statusCode).send(errPayload);
    }

    try {
      const result = await service.classifyDocument(normalized);

      request.log.info(
        {
          status: result.status,
          httpStatus: 200,
          documentId: result.documentId,
          fileCabinetId: result.fileCabinetId,
          documentType: result.classification.documentType,
          confidence: result.classification.confidence,
          requiresManualReview: result.classification.requiresManualReview,
          modelVersion: result.model.version,
          processingTimeMs: result.processingTimeMs,
        },
        'Documento avaliado pelo classificador local.'
      );

      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof ClassifierValidationError) {
        const errPayload: StandardErrorResponse = {
          error: true,
          code: err.code,
          message: err.message,
        };
        return reply.status(err.statusCode).send(errPayload);
      }

      if (err instanceof DocuWareServiceError) {
        const errPayload: StandardErrorResponse = {
          error: true,
          code: err.code,
          message: err.message,
        };
        return reply.status(err.statusCode).send(errPayload);
      }

      const message =
        err instanceof Error
          ? err.message
          : 'Erro inesperado durante a classificação documental.';

      request.log.error(
        {
          status: 'FAILED',
          code: 'CLASSIFICATION_FAILED',
          documentId: normalized.documentId,
          fileCabinetId: normalized.fileCabinetId,
          errorMessage: message,
        },
        'Falha ao classificar documento.'
      );

      const errPayload: StandardErrorResponse = {
        error: true,
        code: 'CLASSIFICATION_FAILED',
        message,
      };
      return reply.status(500).send(errPayload);
    }
  };

  const routeOptions = {
    preHandler: verifyDocuWareAuth,
  };

  // Registo das rotas com suporte a prefixo /ai-gateway, raiz e /api (compatível com Nginx proxy)
  app.post('/ai-gateway/train', routeOptions, handleTrainRequest);
  app.post('/train', routeOptions, handleTrainRequest);
  app.post('/api/train', routeOptions, handleTrainRequest);

  app.get('/ai-gateway/train/status', routeOptions, handleTrainStatusRequest);
  app.get('/train/status', routeOptions, handleTrainStatusRequest);
  app.get('/api/train/status', routeOptions, handleTrainStatusRequest);

  app.post('/ai-gateway/classify', routeOptions, handleClassifyRequest);
  app.post('/classify', routeOptions, handleClassifyRequest);
  app.post('/api/classify', routeOptions, handleClassifyRequest);
}

