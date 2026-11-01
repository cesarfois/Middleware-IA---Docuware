import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import type { StandardErrorResponse } from './types.js';

/**
 * Compara dois tokens em tempo constante para prevenir ataques de timing.
 */
function safeCompareTokens(provided: string, expected: string): boolean {
  if (!expected) return false;
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Extrai o token de autenticação dos cabeçalhos HTTP suportados:
 * - `X-DocuWare-Token: <TOKEN>`
 * - `Authorization: Bearer <TOKEN>` (ou `Authorization: <TOKEN>`)
 */
export function extractTokenFromHeaders(headers: FastifyRequest['headers']): string | null {
  const docuwareHeader = headers['x-docuware-token'];
  if (typeof docuwareHeader === 'string' && docuwareHeader.trim().length > 0) {
    return docuwareHeader.trim();
  }

  const authHeader = headers.authorization;
  if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      return trimmed.slice(7).trim();
    }
    return trimmed;
  }

  return null;
}

/**
 * PreHandler do Fastify para proteger os endpoints de extração.
 * Rejeita com HTTP 401 Unauthorized caso o token esteja ausente ou inválido.
 */
export async function verifyDocuWareAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!config.apiAuthToken) {
    request.log.error('API_AUTH_TOKEN não configurado nas variáveis de ambiente.');
    const errorPayload: StandardErrorResponse = {
      error: true,
      code: 'UNAUTHORIZED',
      message: 'Serviço sem token de autenticação configurado no servidor.',
    };
    return reply.status(401).send(errorPayload);
  }

  const providedToken = extractTokenFromHeaders(request.headers);
  if (!providedToken || !safeCompareTokens(providedToken, config.apiAuthToken)) {
    request.log.warn(
      { ip: request.ip, url: request.url },
      'Tentativa de acesso não autorizado rejeitada (401).'
    );
    const errorPayload: StandardErrorResponse = {
      error: true,
      code: 'UNAUTHORIZED',
      message:
        'Acesso negado. Forneça um token válido no cabeçalho X-DocuWare-Token ou Authorization: Bearer <TOKEN>.',
    };
    return reply.status(401).send(errorPayload);
  }
}

