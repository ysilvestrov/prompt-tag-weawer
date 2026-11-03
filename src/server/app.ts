import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { registerAuthRoutes, type AuthConfig } from './auth.ts';
import { createDatabase, type AppDatabase } from './db.ts';
import { registerSyncRoutes } from './sync-routes.ts';

export const MAX_SYNC_BODY_BYTES = 5 * 1024 * 1024;

export interface ServerOptions {
  db?: AppDatabase;
  dbPath?: string;
  auth: AuthConfig;
  staticDir?: string;
}

export async function buildServer(options: ServerOptions): Promise<{
  app: FastifyInstance;
  db: AppDatabase;
}> {
  const db = options.db ?? createDatabase(options.dbPath ?? ':memory:');
  const app = Fastify({
    bodyLimit: MAX_SYNC_BODY_BYTES,
  });

  await app.register(fastifyCookie);
  registerAuthRoutes(app, db, options.auth);
  registerSyncRoutes(app, db, options.auth);

  if (options.staticDir !== undefined && existsSync(options.staticDir)) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, db };
}
