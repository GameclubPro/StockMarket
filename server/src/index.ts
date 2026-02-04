import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from './config';
import { registerRoutes } from './routes';

const app = Fastify({
  logger: true,
});

await app.register(helmet, { global: true });
await app.register(rateLimit, {
  max: 120,
  timeWindow: '1 minute',
});
await app.register(cors, {
  origin: config.corsOrigins.length ? config.corsOrigins : true,
  credentials: true,
});

registerRoutes(app);

const start = async () => {
  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`API ready on http://${config.host}:${config.port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

start();
