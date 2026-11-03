import { generateKeyPairSync, sign as cryptoSign, type JsonWebKey } from 'node:crypto';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { describe, expect, test } from 'vitest';
import {
  OAUTH_STATE_COOKIE_NAME,
  registerAuthRoutes,
  SESSION_COOKIE_NAME,
  signCookieValue,
  verifyCookieValue,
  verifyGoogleIdToken,
} from '../src/server/auth.ts';
import { createDatabase } from '../src/server/db.ts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const testJwk = {
  ...(publicKey.export({ format: 'jwk' }) as JsonWebKey),
  kid: 'test-kid-1',
  alg: 'RS256',
  use: 'sig',
};

function makeTestJwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = cryptoSign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf8'), privateKey).toString(
    'base64url',
  );
  return `${h}.${p}.${sig}`;
}

describe('cookie signing and verification', () => {
  const secret = '0123456789abcdef0123456789abcdef';

  test('signs and verifies payload and rejects tampered or malformed values', () => {
    const signed = signCookieValue('{"userId":"u1"}', secret);
    expect(verifyCookieValue(signed, secret)).toBe('{"userId":"u1"}');
    expect(verifyCookieValue(`${signed}x`, secret)).toBeNull();
    expect(verifyCookieValue('no-dot-here', secret)).toBeNull();
    expect(verifyCookieValue(undefined, secret)).toBeNull();
  });
});

describe('verifyGoogleIdToken', () => {
  const jwks = { keys: [testJwk] };
  const clientId = 'my-google-client-id';
  const nowMs = 1_700_000_000_000;

  test('verifies valid RS256 Google ID token against JWK', () => {
    const token = makeTestJwt(
      { alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' },
      {
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-user-123',
        email: 'kateryna@example.com',
        name: 'Kateryna K',
        picture: 'https://example.com/avatar.png',
        exp: Math.floor(nowMs / 1000) + 3600,
      },
    );

    expect(verifyGoogleIdToken(token, jwks, clientId, nowMs)).toEqual({
      ok: true,
      claims: {
        sub: 'google-user-123',
        email: 'kateryna@example.com',
        name: 'Kateryna K',
        picture: 'https://example.com/avatar.png',
      },
    });
  });

  test('rejects tampered signature, expired token, wrong audience, wrong issuer, and unknown kid', () => {
    const validClaims = {
      iss: 'https://accounts.google.com',
      aud: clientId,
      sub: 'google-user-123',
      email: 'kateryna@example.com',
      exp: Math.floor(nowMs / 1000) + 3600,
    };

    const validToken = makeTestJwt({ alg: 'RS256', kid: 'test-kid-1' }, validClaims);
    const tampered = `${validToken.slice(0, -2)}AA`;
    expect(verifyGoogleIdToken(tampered, jwks, clientId, nowMs)).toEqual({
      ok: false,
      error: 'Invalid JWT signature',
    });

    const expired = makeTestJwt(
      { alg: 'RS256', kid: 'test-kid-1' },
      { ...validClaims, exp: Math.floor(nowMs / 1000) - 10 },
    );
    expect(verifyGoogleIdToken(expired, jwks, clientId, nowMs)).toEqual({
      ok: false,
      error: 'JWT has expired',
    });

    const wrongAud = makeTestJwt(
      { alg: 'RS256', kid: 'test-kid-1' },
      { ...validClaims, aud: 'other-client' },
    );
    expect(verifyGoogleIdToken(wrongAud, jwks, clientId, nowMs)).toEqual({
      ok: false,
      error: 'Invalid JWT audience',
    });

    const wrongIss = makeTestJwt(
      { alg: 'RS256', kid: 'test-kid-1' },
      { ...validClaims, iss: 'https://evil.example.com' },
    );
    expect(verifyGoogleIdToken(wrongIss, jwks, clientId, nowMs)).toEqual({
      ok: false,
      error: 'Invalid JWT issuer',
    });

    const unknownKid = makeTestJwt({ alg: 'RS256', kid: 'unknown-kid' }, validClaims);
    expect(verifyGoogleIdToken(unknownKid, jwks, clientId, nowMs)).toEqual({
      ok: false,
      error: 'Matching JWK not found for kid',
    });
  });
});

describe('Google OAuth 2.0 Fastify flow', () => {
  test('reports googleEnabled = false and returns 503 when credentials are missing', async () => {
    const db = createDatabase(':memory:');
    const app = Fastify();
    await app.register(fastifyCookie);
    registerAuthRoutes(app, db, {
      sessionSecret: '0123456789abcdef0123456789abcdef',
      appOrigin: 'http://localhost:3000',
    });

    const providersRes = await app.inject({ method: 'GET', url: '/api/auth/providers' });
    expect(providersRes.statusCode).toBe(200);
    expect(providersRes.json()).toEqual({ googleEnabled: false });

    const loginRes = await app.inject({ method: 'GET', url: '/api/auth/google' });
    expect(loginRes.statusCode).toBe(503);
    expect(loginRes.json()).toEqual({ error: 'Google OAuth is not configured on this server' });

    await app.close();
    db.close();
  });

  test('completes full OAuth login, establishes session, rejects state mismatch, and logs out', async () => {
    const db = createDatabase(':memory:');
    const existingUser = db.upsertGoogleUser(
      { sub: 'sub-777', email: 'old@example.com', name: 'Old Name', picture: null },
      100,
    );

    const app = Fastify();
    await app.register(fastifyCookie);

    const nowMs = 1_700_000_000_000;
    const clientId = 'google-client-id-1';
    const idToken = makeTestJwt(
      { alg: 'RS256', kid: 'test-kid-1' },
      {
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'sub-777',
        email: 'user@example.com',
        name: 'Test User',
        picture: null,
        exp: Math.floor(nowMs / 1000) + 3600,
      },
    );

    const fakeResponses: Record<string, string> = {
      'https://oauth2.googleapis.com/token': JSON.stringify({ id_token: idToken }),
      'https://www.googleapis.com/oauth2/v3/certs': JSON.stringify({ keys: [testJwk] }),
    };

    const fakeFetch: typeof fetch = async (input) =>
      new Response(fakeResponses[String(input)], {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    registerAuthRoutes(app, db, {
      sessionSecret: '0123456789abcdef0123456789abcdef',
      googleClientId: clientId,
      googleClientSecret: 'google-secret-1',
      appOrigin: 'http://localhost:3000',
      fetchFn: fakeFetch,
      nowFn: () => nowMs,
    });

    const startRes = await app.inject({ method: 'GET', url: '/api/auth/google' });
    expect(startRes.statusCode).toBe(302);
    const location = String(startRes.headers.location);
    const redirectUrl = new URL(location);
    expect(redirectUrl.origin).toBe('https://accounts.google.com');
    expect(redirectUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const state = redirectUrl.searchParams.get('state')!;
    const stateCookie = startRes.cookies.find((c) => c.name === OAUTH_STATE_COOKIE_NAME)!;

    const badCallback = await app.inject({
      method: 'GET',
      url: '/api/auth/google/callback?code=auth-code-1&state=wrong-state',
      cookies: { [OAUTH_STATE_COOKIE_NAME]: stateCookie.value },
    });
    expect(badCallback.statusCode).toBe(400);
    expect(badCallback.json()).toEqual({ error: 'OAuth state mismatch' });

    const okCallback = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      cookies: { [OAUTH_STATE_COOKIE_NAME]: stateCookie.value },
    });
    expect(okCallback.statusCode).toBe(302);
    expect(okCallback.headers.location).toBe('/');
    const sessionCookie = okCallback.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!;

    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie.value },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toEqual({
      user: {
        id: existingUser.id,
        email: 'user@example.com',
        name: 'Test User',
        picture: null,
      },
    });

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie.value },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json()).toEqual({ ok: true });

    await app.close();
    db.close();
  });
});
