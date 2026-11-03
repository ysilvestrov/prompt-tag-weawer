import { describe, expect, test } from 'vitest';
import { buildServer } from '../src/server/app.ts';
import { createSessionToken, SESSION_COOKIE_NAME } from '../src/server/auth.ts';
import { createSeedData, SEED_IDS } from '../src/shared/seed.ts';
import type { Category } from '../src/shared/types.ts';

const SECRET = '0123456789abcdef0123456789abcdef';

describe('POST /api/sync', () => {
  test('rejects unauthenticated requests with 401 and invalid payload with 400', async () => {
    const { app, db } = await buildServer({
      auth: { sessionSecret: SECRET, appOrigin: 'http://localhost:3000', nowFn: () => 100 },
    });

    const unauth = await app.inject({
      method: 'POST',
      url: '/api/sync',
      payload: { sinceSeq: 0, categories: [], elements: [], templates: [] },
    });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.json()).toEqual({ error: 'Authentication required' });

    const user = db.upsertGoogleUser(
      { sub: 'sub-1', email: 'u1@example.com', name: 'U1', picture: null },
      100,
    );
    const cookie = createSessionToken(user.id, 100, SECRET);

    const badReq = await app.inject({
      method: 'POST',
      url: '/api/sync',
      cookies: { [SESSION_COOKIE_NAME]: cookie },
      payload: { sinceSeq: -5 },
    });
    expect(badReq.statusCode).toBe(400);
    expect(badReq.json()).toEqual({ error: 'sinceSeq must be a non-negative integer' });

    await app.close();
    db.close();
  });

  test('returns authoritative server version when slow-clock client upload loses LWW even if server_seq <= sinceSeq', async () => {
    let serverNow = 1000;
    const { app, db } = await buildServer({
      auth: {
        sessionSecret: SECRET,
        appOrigin: 'http://localhost:3000',
        nowFn: () => serverNow,
      },
    });

    const user = db.upsertGoogleUser(
      { sub: 'sub-2', email: 'u2@example.com', name: 'U2', picture: null },
      serverNow,
    );
    const cookie = createSessionToken(user.id, serverNow, SECRET);

    // Step 1: Insert category C1 (seq 1) and template T1 (seq 2)
    const firstSync = await app.inject({
      method: 'POST',
      url: '/api/sync',
      cookies: { [SESSION_COOKIE_NAME]: cookie },
      payload: {
        sinceSeq: 0,
        categories: [
          { id: 'c1', name: 'Models', selectionMode: 'single', sortOrder: 0, updatedAt: 500, deletedAt: null },
        ],
        elements: [],
        templates: [
          { id: 't1', name: 'Base', content: '[Models]', sortOrder: 0, updatedAt: 500, deletedAt: null },
        ],
      },
    });
    expect(firstSync.statusCode).toBe(200);
    expect(firstSync.json()).toEqual({
      serverSeq: 2,
      categories: [
        { id: 'c1', name: 'Models', selectionMode: 'single', sortOrder: 0, updatedAt: 500, deletedAt: null },
      ],
      elements: [],
      templates: [
        { id: 't1', name: 'Base', content: '[Models]', sortOrder: 0, updatedAt: 500, deletedAt: null },
      ],
    });

    // Step 2: Client already at sinceSeq = 2 sends a stale edit to c1 (updatedAt: 400 < 500)
    const staleSync = await app.inject({
      method: 'POST',
      url: '/api/sync',
      cookies: { [SESSION_COOKIE_NAME]: cookie },
      payload: {
        sinceSeq: 2,
        categories: [
          { id: 'c1', name: 'StaleName', selectionMode: 'multi', sortOrder: 0, updatedAt: 400, deletedAt: null },
        ],
        elements: [],
        templates: [],
      },
    });
    expect(staleSync.statusCode).toBe(200);
    expect(staleSync.json()).toEqual({
      serverSeq: 2,
      categories: [
        { id: 'c1', name: 'Models', selectionMode: 'single', sortOrder: 0, updatedAt: 500, deletedAt: null },
      ],
      elements: [],
      templates: [],
    });

    await app.close();
    db.close();
  });

  test('ignores untouched seed records on initialized account, canonicalizes duplicate category names with stored children, and tombstones children of deleted categories', async () => {
    let serverNow = 2000;
    const { app, db } = await buildServer({
      auth: {
        sessionSecret: SECRET,
        appOrigin: 'http://localhost:3000',
        nowFn: () => serverNow,
      },
    });

    const user = db.upsertGoogleUser(
      { sub: 'sub-3', email: 'u3@example.com', name: 'U3', picture: null },
      serverNow,
    );
    const cookie = createSessionToken(user.id, serverNow, SECRET);

    // Initialize account on Device A: delete starter Models category, create category B with element E-B, and delete category C-del
    await app.inject({
      method: 'POST',
      url: '/api/sync',
      cookies: { [SESSION_COOKIE_NAME]: cookie },
      payload: {
        sinceSeq: 0,
        categories: [
          {
            id: SEED_IDS.categories.models,
            name: 'Models',
            selectionMode: 'single',
            sortOrder: 0,
            updatedAt: 1500,
            deletedAt: 1500,
          },
          { id: 'cat-a', name: 'Lighting', selectionMode: 'single', sortOrder: 1, updatedAt: 1500, deletedAt: null },
          { id: 'cat-b', name: 'TempCat', selectionMode: 'single', sortOrder: 2, updatedAt: 1500, deletedAt: null },
          { id: 'cat-del', name: 'Gone', selectionMode: 'single', sortOrder: 3, updatedAt: 1500, deletedAt: 1500 },
        ],
        elements: [
          {
            id: 'el-stored-b',
            categoryId: 'cat-b',
            label: 'Rim',
            value: 'rim light',
            sortOrder: 0,
            updatedAt: 1500,
            deletedAt: null,
          },
        ],
        templates: [],
      },
    });

    // Device B logs in with untouched starter seed (updatedAt = 0), renames cat-b to "lighting" (colliding with cat-a),
    // and uploads an offline element under deleted cat-del with a future timestamp 999999
    serverNow = 3000;
    const seed = createSeedData();
    const secondSync = await app.inject({
      method: 'POST',
      url: '/api/sync',
      cookies: { [SESSION_COOKIE_NAME]: cookie },
      payload: {
        sinceSeq: 5,
        categories: [
          ...seed.categories,
          { id: 'cat-b', name: 'Lighting', selectionMode: 'multi', sortOrder: 2, updatedAt: 2500, deletedAt: null },
        ],
        elements: [
          ...seed.elements,
          {
            id: 'el-under-del',
            categoryId: 'cat-del',
            label: 'Orphan',
            value: 'orphan val',
            sortOrder: 0,
            updatedAt: 999_999,
            deletedAt: null,
          },
        ],
        templates: seed.templates,
      },
    });

    expect(secondSync.statusCode).toBe(200);
    const body = secondSync.json();
    expect(body).toEqual({
      serverSeq: 9,
      categories: [
        {
          id: SEED_IDS.categories.models,
          name: 'Models',
          selectionMode: 'single',
          sortOrder: 0,
          updatedAt: 1500,
          deletedAt: 1500,
        },
        { id: 'cat-a', name: 'Lighting', selectionMode: 'multi', sortOrder: 2, updatedAt: 3000, deletedAt: null },
        { id: 'cat-b', name: 'Lighting', selectionMode: 'multi', sortOrder: 2, updatedAt: 3000, deletedAt: 3000 },
      ],
      elements: [
        {
          id: 'el-stored-b',
          categoryId: 'cat-a',
          label: 'Rim',
          value: 'rim light',
          sortOrder: 0,
          updatedAt: 3000,
          deletedAt: null,
        },
        {
          id: 'el-under-del',
          categoryId: 'cat-del',
          label: 'Orphan',
          value: 'orphan val',
          sortOrder: 0,
          updatedAt: 3000,
          deletedAt: 3000,
        },
      ],
      templates: [],
    });

    await app.close();
    db.close();
  });

  test('enforces library limit of 100 active categories on sync', async () => {
    const { app, db } = await buildServer({
      auth: { sessionSecret: SECRET, appOrigin: 'http://localhost:3000', nowFn: () => 1000 },
    });

    const user = db.upsertGoogleUser(
      { sub: 'sub-4', email: 'u4@example.com', name: 'U4', picture: null },
      1000,
    );
    const cookie = createSessionToken(user.id, 1000, SECRET);

    const tooManyCategories: Category[] = Array.from({ length: 101 }, (_, i) => ({
      id: `cat-${i}`,
      name: `Category ${i}`,
      selectionMode: 'single',
      sortOrder: i,
      updatedAt: 100,
      deletedAt: null,
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/sync',
      cookies: { [SESSION_COOKIE_NAME]: cookie },
      payload: {
        sinceSeq: 0,
        categories: tooManyCategories,
        elements: [],
        templates: [],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Maximum of 100 active categories exceeded' });

    await app.close();
    db.close();
  });
});
