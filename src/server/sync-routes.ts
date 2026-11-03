import type { FastifyInstance } from 'fastify';
import { validateSyncRequest } from '../shared/validation.ts';
import { resolveAuthenticatedUser, type AuthConfig } from './auth.ts';
import type { AppDatabase } from './db.ts';

export function registerSyncRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  authConfig: AuthConfig,
): void {
  const nowFn = authConfig.nowFn ?? (() => Date.now());

  app.post('/api/sync', async (req, reply) => {
    const user = resolveAuthenticatedUser(req, db, authConfig);
    if (user === null) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    const parsed = validateSyncRequest(req.body);
    if (!parsed.ok) {
      return reply.status(400).send({ error: parsed.error });
    }

    const now = nowFn();
    const result = db.syncUserLibrary(user.id, parsed.data, now);
    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }

    return result.response;
  });
}
