import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

async function handleHealthCheck(_request: FastifyRequest, reply: FastifyReply) {
  return reply.status(200).send({
    status: 'UP',
    service: 'docuware-ai-gateway',
    model: config.openaiModel,
    maxFileSizeMb: Math.round((config.maxFileSizeBytes / (1024 * 1024)) * 100) / 100,
    timestamp: new Date().toISOString(),
  });
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', handleHealthCheck);
  app.get('/ai-gateway/health', handleHealthCheck);
}
