import {
  createHmac,
  createPublicKey,
  randomBytes,
  createHash,
  timingSafeEqual,
  verify as cryptoVerify,
  type JsonWebKey,
} from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDatabase } from './db.ts';
import type { AuthUser } from '../shared/types.ts';

export const SESSION_COOKIE_NAME = 'ptw_session';
export const OAUTH_STATE_COOKIE_NAME = 'ptw_oauth_state';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface AuthConfig {
  sessionSecret: string;
  googleClientId?: string;
  googleClientSecret?: string;
  appOrigin: string;
  fetchFn?: typeof fetch;
  nowFn?: () => number;
}

export function signCookieValue(payload: string, secret: string): string {
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const mac = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${mac}`;
}

export function verifyCookieValue(signed: string | undefined, secret: string): string | null {
  if (typeof signed !== 'string') return null;
  const dot = signed.indexOf('.');
  if (dot <= 0 || dot === signed.length - 1) return null;
  const encoded = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expectedMac = createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedMac, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export interface GoogleIdTokenClaims {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

export function verifyGoogleIdToken(
  idToken: string,
  jwks: { keys: readonly JsonWebKey[] },
  expectedClientId: string,
  nowMs: number,
): { ok: true; claims: GoogleIdTokenClaims } | { ok: false; error: string } {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    return { ok: false, error: 'Malformed JWT' };
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  if (headerB64.length === 0 || payloadB64.length === 0 || sigB64.length === 0) {
    return { ok: false, error: 'Empty JWT segment' };
  }

  let header: { alg?: unknown; kid?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as {
      alg?: unknown;
      kid?: unknown;
    };
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return { ok: false, error: 'Invalid JWT JSON encoding' };
  }

  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) {
    return { ok: false, error: 'Unsupported JWT algorithm or missing kid' };
  }

  const matchedKey = jwks.keys.find(
    (k) => k.kty === 'RSA' && (k as { kid?: unknown }).kid === header.kid,
  );
  if (matchedKey === undefined) {
    return { ok: false, error: 'Matching JWK not found for kid' };
  }

  try {
    const publicKey = createPublicKey({ key: matchedKey, format: 'jwk' });
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const signature = Buffer.from(sigB64, 'base64url');
    const valid = cryptoVerify('RSA-SHA256', signingInput, publicKey, signature);
    if (!valid) {
      return { ok: false, error: 'Invalid JWT signature' };
    }
  } catch {
    return { ok: false, error: 'JWT signature verification failed' };
  }

  const iss = payload.iss;
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
    return { ok: false, error: 'Invalid JWT issuer' };
  }
  if (payload.aud !== expectedClientId) {
    return { ok: false, error: 'Invalid JWT audience' };
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) {
    return { ok: false, error: 'JWT has expired' };
  }
  if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0) {
    return { ok: false, error: 'Invalid JWT subject' };
  }
  if (typeof payload.email !== 'string' || payload.email.trim().length === 0) {
    return { ok: false, error: 'Invalid JWT email' };
  }

  const name =
    typeof payload.name === 'string' && payload.name.trim().length > 0
      ? payload.name.trim()
      : payload.email.trim();
  const picture =
    typeof payload.picture === 'string' && payload.picture.trim().length > 0
      ? payload.picture.trim()
      : null;

  return {
    ok: true,
    claims: {
      sub: payload.sub.trim(),
      email: payload.email.trim(),
      name,
      picture,
    },
  };
}

export function createSessionToken(userId: string, nowMs: number, secret: string): string {
  const payload = JSON.stringify({ userId, exp: nowMs + SESSION_TTL_MS });
  return signCookieValue(payload, secret);
}

export function resolveAuthenticatedUser(
  req: FastifyRequest,
  db: AppDatabase,
  config: AuthConfig,
): AuthUser | null {
  const now = config.nowFn ? config.nowFn() : Date.now();
  const rawCookie = req.cookies[SESSION_COOKIE_NAME];
  const verified = verifyCookieValue(rawCookie, config.sessionSecret);
  if (verified === null) return null;
  try {
    const parsed = JSON.parse(verified) as { userId?: unknown; exp?: unknown };
    if (typeof parsed.userId !== 'string' || typeof parsed.exp !== 'number') return null;
    if (parsed.exp <= now) return null;
    const stored = db.getUserById(parsed.userId);
    if (stored === null) return null;
    return {
      id: stored.id,
      email: stored.email,
      name: stored.name,
      picture: stored.picture,
    };
  } catch {
    return null;
  }
}

export function registerAuthRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: AuthConfig,
): void {
  const fetchImpl = config.fetchFn ?? globalThis.fetch;
  const nowFn = config.nowFn ?? (() => Date.now());
  const isSecure = config.appOrigin.startsWith('https://');
  const redirectUri = `${config.appOrigin.replace(/\/$/, '')}/api/auth/google/callback`;

  const isGoogleConfigured = () =>
    typeof config.googleClientId === 'string' &&
    config.googleClientId.trim().length > 0 &&
    typeof config.googleClientSecret === 'string' &&
    config.googleClientSecret.trim().length > 0;

  app.get('/api/auth/providers', async () => {
    return { googleEnabled: isGoogleConfigured() };
  });

  app.get('/api/auth/me', async (req) => {
    const user = resolveAuthenticatedUser(req, db, config);
    return { user };
  });

  app.get('/api/auth/google', async (_req, reply) => {
    if (!isGoogleConfigured()) {
      return reply.status(503).send({ error: 'Google OAuth is not configured on this server' });
    }
    const state = generateOAuthState();
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const now = nowFn();
    const stateCookiePayload = JSON.stringify({
      state,
      codeVerifier,
      exp: now + OAUTH_STATE_TTL_MS,
    });
    const signedState = signCookieValue(stateCookiePayload, config.sessionSecret);

    reply.setCookie(OAUTH_STATE_COOKIE_NAME, signedState, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure,
      maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
    });

    const params = new URLSearchParams({
      client_id: config.googleClientId!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  app.get('/api/auth/google/callback', async (req, reply: FastifyReply) => {
    if (!isGoogleConfigured()) {
      return reply.status(503).send({ error: 'Google OAuth is not configured on this server' });
    }
    const query = req.query as Record<string, string | undefined>;
    const code = query.code;
    const stateParam = query.state;
    if (typeof code !== 'string' || code.length === 0 || typeof stateParam !== 'string' || stateParam.length === 0) {
      return reply.status(400).send({ error: 'Missing code or state parameter' });
    }

    const rawStateCookie = req.cookies[OAUTH_STATE_COOKIE_NAME];
    const verifiedStateJson = verifyCookieValue(rawStateCookie, config.sessionSecret);
    if (verifiedStateJson === null) {
      return reply.status(400).send({ error: 'Invalid or missing OAuth state cookie' });
    }

    let stateObj: { state?: unknown; codeVerifier?: unknown; exp?: unknown };
    try {
      stateObj = JSON.parse(verifiedStateJson) as {
        state?: unknown;
        codeVerifier?: unknown;
        exp?: unknown;
      };
    } catch {
      return reply.status(400).send({ error: 'Corrupted OAuth state cookie' });
    }

    const now = nowFn();
    if (
      typeof stateObj.state !== 'string' ||
      typeof stateObj.codeVerifier !== 'string' ||
      typeof stateObj.exp !== 'number' ||
      stateObj.exp <= now
    ) {
      return reply.status(400).send({ error: 'Expired OAuth state cookie' });
    }

    const expectedBuf = Buffer.from(stateObj.state, 'utf8');
    const actualBuf = Buffer.from(stateParam, 'utf8');
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      return reply.status(400).send({ error: 'OAuth state mismatch' });
    }

    const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId!,
        client_secret: config.googleClientSecret!,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: stateObj.codeVerifier,
      }).toString(),
    });

    if (!tokenRes.ok) {
      return reply.status(502).send({ error: 'Failed to exchange authorization code with Google' });
    }

    const tokenJson = (await tokenRes.json()) as { id_token?: unknown };
    if (typeof tokenJson.id_token !== 'string') {
      return reply.status(502).send({ error: 'Google token response did not include id_token' });
    }

    const certsRes = await fetchImpl('https://www.googleapis.com/oauth2/v3/certs');
    if (!certsRes.ok) {
      return reply.status(502).send({ error: 'Failed to fetch Google JWK certificates' });
    }
    const jwks = (await certsRes.json()) as { keys?: unknown };
    if (!Array.isArray(jwks.keys)) {
      return reply.status(502).send({ error: 'Invalid Google JWK certificates payload' });
    }

    const verifiedToken = verifyGoogleIdToken(
      tokenJson.id_token,
      { keys: jwks.keys as JsonWebKey[] },
      config.googleClientId!,
      now,
    );
    if (!verifiedToken.ok) {
      return reply.status(401).send({ error: verifiedToken.error });
    }

    const user = db.upsertGoogleUser(verifiedToken.claims, now);
    const sessionToken = createSessionToken(user.id, now, config.sessionSecret);

    reply.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/' });
    reply.setCookie(SESSION_COOKIE_NAME, sessionToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });

    return reply.redirect('/');
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });
}
