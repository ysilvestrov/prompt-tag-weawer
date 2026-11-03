import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildServer } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const dbPath = resolve(process.env.DB_PATH ?? 'data/prompt-tag-weaver.sqlite');
const staticDir = resolve(process.env.STATIC_DIR ?? 'dist');
const sessionSecret =
  process.env.SESSION_SECRET ?? 'dev-only-session-secret-change-in-production-32b';
const appOrigin = process.env.APP_ORIGIN ?? `http://localhost:${port}`;

mkdirSync(dirname(dbPath), { recursive: true });

const authConfig = {
  sessionSecret,
  appOrigin,
  ...(process.env.GOOGLE_CLIENT_ID !== undefined
    ? { googleClientId: process.env.GOOGLE_CLIENT_ID }
    : {}),
  ...(process.env.GOOGLE_CLIENT_SECRET !== undefined
    ? { googleClientSecret: process.env.GOOGLE_CLIENT_SECRET }
    : {}),
};

const { app } = await buildServer({
  dbPath,
  staticDir,
  auth: authConfig,
});

await app.listen({ port, host });
console.log(`Prompt Tag Weaver server listening on ${appOrigin}`);
