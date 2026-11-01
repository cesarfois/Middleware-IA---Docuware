import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerExtractRoutes } from './routes/extract.js';
import type { StandardErrorResponse } from './types.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === 'test' ? 'silent' : 'info',
      // Garante que credenciais nunca vazem nos logs de requisição
      redact: ['req.headers.authorization', 'req.headers["x-docuware-token"]'],
    },
    bodyLimit: config.maxFileSizeBytes + 2 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.maxFileSizeBytes,
      files: 2,
      fieldSize: 2 * 1024 * 1024, // Até 2 MB para o campo de texto requestData
      fields: 10,
    },
  });

  // Handler global de exceções padronizado
  app.setErrorHandler((error, request, reply) => {
    const errCode = (error as { code?: string })?.code;
    if (errCode === 'FST_REQ_FILE_TOO_LARGE') {
      const maxMb = (config.maxFileSizeBytes / (1024 * 1024)).toFixed(1);
      const payload: StandardErrorResponse = {
        error: true,
        code: 'FILE_TOO_LARGE',
        message: `O arquivo PDF excede o tamanho máximo permitido de ${maxMb} MB.`,
      };
      return reply.status(422).send(payload);
    }

    request.log.error(
      { errName: error instanceof Error ? error.name : 'UnknownError' },
      'Erro não tratado capturado pelo ErrorHandler global.'
    );

    const payload: StandardErrorResponse = {
      error: true,
      code: 'EXTRACTION_FAILED',
      message: error instanceof Error ? error.message : 'Erro interno inesperado no gateway.',
    };
    return reply.status(500).send(payload);
  });

  await registerHealthRoutes(app);
  await registerExtractRoutes(app);

  return app;
}

async function startServer(): Promise<void> {
  const app = await buildApp();

  const closeGracefully = async (signal: string) => {
    app.log.info(`Sinal ${signal} recebido. Encerrando servidor de forma segura...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void closeGracefully('SIGINT'));
  process.on('SIGTERM', () => void closeGracefully('SIGTERM'));

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      `Gateway Universal DocuWare <-> OpenAI (${config.openaiModel}) ativo em http://${config.host}:${config.port}`
    );
  } catch (err) {
    app.log.error(err, 'Falha crítica ao iniciar o servidor.');
    process.exit(1);
  }
}

// Inicia o servidor automaticamente quando executado diretamente
if (process.env.NODE_ENV !== 'test') {
  void startServer();
}

