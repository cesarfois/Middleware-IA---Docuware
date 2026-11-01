import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    return reply.status(200).send({
      status: 'UP',
      service: 'docuware-ai-gateway',
      model: config.openaiModel,
      maxFileSizeMb: Math.round((config.maxFileSizeBytes / (1024 * 1024)) * 100) / 100,
      timestamp: new Date().toISOString(),
    });
  });
}

