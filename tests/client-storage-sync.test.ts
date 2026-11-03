import { describe, expect, test } from 'vitest';
import {
  addCategory,
  addElement,
  addTemplate,
  applySyncResponse,
  createInitialGuestState,
  loadWorkspaceState,
  reconcileAuthenticatedUser,
  removeCategory,
  updateCategory,
  updateElement,
} from '../src/client/storage.ts';
import { buildSyncChunks, DEFAULT_MAX_CHUNK_BYTES, runSyncCycle } from '../src/client/sync-client.ts';
import { loadThemeMode, resolveEffectiveTheme, saveThemeMode } from '../src/client/theme.ts';
import { mergeLibraries } from '../src/shared/merge.ts';
import { SEED_IDS } from '../src/shared/seed.ts';
import type { LibrarySnapshot, LocalWorkspaceState, SyncRequest, SyncResponse } from '../src/shared/types.ts';

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('client workspace storage and CRUD reducers', () => {
  test('initializes guest state with starter seed data when storage is empty or corrupted', () => {
    const storage = createMemoryStorage();
    const initial = loadWorkspaceState(storage);
    expect(initial.ownerUserId).toBeNull();
    expect(initial.lastSyncedSeq).toBe(0);
    expect(initial.categories.map((c) => c.name)).toEqual(['Models', 'Clothing', 'Scenes']);
    expect(initial.dirtyCategoryIds).toEqual([]);

    storage.setItem('ptw_workspace_v1', '{invalid-json');
    const recovered = loadWorkspaceState(storage);
    expect(recovered.categories.map((c) => c.name)).toEqual(['Models', 'Clothing', 'Scenes']);
  });

  test('adding an element to a starter seed category (updatedAt = 0) touches the parent category updatedAt and dirty list', () => {
    const state = createInitialGuestState();
    const added = addElement(
      state,
      {
        id: 'el-custom-1',
        categoryId: SEED_IDS.categories.models,
        label: 'Custom Model',
        value: '1girl, custom portrait',
      },
      1500,
    );

    const expectedState = (added as { ok: true; data: LocalWorkspaceState }).data;
    const modelsCategory = expectedState.categories.find(
      (c) => c.id === SEED_IDS.categories.models,
    );
    expect(modelsCategory).toEqual({
      id: SEED_IDS.categories.models,
      name: 'Models',
      selectionMode: 'single',
      sortOrder: 0,
      updatedAt: 1500,
      deletedAt: null,
    });
    expect(expectedState.dirtyCategoryIds).toEqual([SEED_IDS.categories.models]);
    expect(expectedState.dirtyElementIds).toEqual(['el-custom-1']);
  });

  test('removeCategory cascades tombstone to child elements and marks all as dirty', () => {
    const state = createInitialGuestState();
    const next = removeCategory(state, SEED_IDS.categories.models, 2000);
    const modelsCat = next.categories.find((c) => c.id === SEED_IDS.categories.models);
    expect(modelsCat?.deletedAt).toBe(2000);
    expect(next.dirtyCategoryIds).toEqual([SEED_IDS.categories.models]);
    expect(next.dirtyElementIds).toEqual([
      SEED_IDS.elements.kateryna,
      SEED_IDS.elements.android,
    ]);
  });

  test('addCategory, updateCategory, and addTemplate validate inputs and update dirty queues', () => {
    const state = createInitialGuestState();
    const catAdded = addCategory(
      state,
      { id: 'cat-light', name: 'Lighting', selectionMode: 'multi' },
      100,
    ) as { ok: true; data: LocalWorkspaceState };

    const catUpdated = updateCategory(
      catAdded.data,
      'cat-light',
      { name: 'Studio Lighting', selectionMode: 'single' },
      200,
    ) as { ok: true; data: LocalWorkspaceState };

    const tmplAdded = addTemplate(
      catUpdated.data,
      { id: 'tmpl-2', name: 'New Template', content: 'Shot in [Studio Lighting]' },
      300,
    ) as { ok: true; data: LocalWorkspaceState };

    expect(tmplAdded.data.dirtyCategoryIds).toEqual(['cat-light']);
    expect(tmplAdded.data.dirtyTemplateIds).toEqual(['tmpl-2']);
    expect(tmplAdded.data.categories.find((c) => c.id === 'cat-light')).toEqual({
      id: 'cat-light',
      name: 'Studio Lighting',
      selectionMode: 'single',
      sortOrder: 3,
      updatedAt: 200,
      deletedAt: null,
    });
  });
});

describe('account reconciliation and isolation', () => {
  test('marks guest records dirty on first login and blocks silent discard when switching users with unsynced changes', () => {
    const guest = createInitialGuestState();
    const reconciledGuest = reconcileAuthenticatedUser(guest, 'user-1');
    expect(reconciledGuest).toEqual({
      kind: 'ready',
      state: {
        ...guest,
        ownerUserId: 'user-1',
        lastSyncedSeq: 0,
        dirtyCategoryIds: guest.categories.map((c) => c.id),
        dirtyElementIds: guest.elements.map((e) => e.id),
        dirtyTemplateIds: guest.templates.map((t) => t.id),
      },
    });

    const user1WithDirty: LocalWorkspaceState = {
      ...guest,
      ownerUserId: 'user-1',
      lastSyncedSeq: 10,
      dirtyCategoryIds: [SEED_IDS.categories.models],
      dirtyElementIds: [],
      dirtyTemplateIds: [],
    };
    expect(reconcileAuthenticatedUser(user1WithDirty, 'user-2')).toEqual({
      kind: 'conflict_unsynced_previous_user',
      previousUserId: 'user-1',
      newUserId: 'user-2',
    });

    const user1Clean: LocalWorkspaceState = {
      ...guest,
      ownerUserId: 'user-1',
      lastSyncedSeq: 10,
      dirtyCategoryIds: [],
      dirtyElementIds: [],
      dirtyTemplateIds: [],
    };
    expect(reconcileAuthenticatedUser(user1Clean, 'user-2')).toEqual({
      kind: 'ready',
      state: {
        ownerUserId: 'user-2',
        lastSyncedSeq: 0,
        categories: [],
        elements: [],
        templates: [],
        dirtyCategoryIds: [],
        dirtyElementIds: [],
        dirtyTemplateIds: [],
      },
    });
  });
});

describe('sync chunking and cycle', () => {
  test('chunks dirty queue with categories before elements and applies server responses sequentially', async () => {
    const guest = createInitialGuestState();
    const ready = (reconcileAuthenticatedUser(guest, 'user-1') as { kind: 'ready'; state: LocalWorkspaceState }).state;

    // Total dirty items in starter seed = 3 categories + 6 elements + 1 template = 10 items.
    // With chunkSize = 4, we get 3 chunks: [3 cats + 1 el], [4 els], [1 el + 1 tmpl].
    const chunks = buildSyncChunks(ready, 4);
    expect(chunks.map((c) => ({
      cats: c.categories.length,
      els: c.elements.length,
      tmpls: c.templates.length,
    }))).toEqual([
      { cats: 3, els: 1, tmpls: 0 },
      { cats: 0, els: 4, tmpls: 0 },
      { cats: 0, els: 1, tmpls: 1 },
    ]);

    let seq = 0;
    const sentSinceSeqs: number[] = [];
    const sendSync = async (req: SyncRequest): Promise<SyncResponse> => {
      sentSinceSeqs.push(req.sinceSeq);
      seq += req.categories.length + req.elements.length + req.templates.length;
      return {
        serverSeq: seq,
        categories: req.categories,
        elements: req.elements,
        templates: req.templates,
      };
    };

    const syncedState = await runSyncCycle(ready, sendSync, 4);
    expect(sentSinceSeqs).toEqual([0, 4, 8]);
    expect(syncedState.lastSyncedSeq).toBe(10);
    expect(syncedState.dirtyCategoryIds).toEqual([]);
    expect(syncedState.dirtyElementIds).toEqual([]);
    expect(syncedState.dirtyTemplateIds).toEqual([]);
  });

  test('editing a starter element touches its starter parent category, and applySyncResponse evicts ignored starter records while preserving concurrent local edits', () => {
    const initial = createInitialGuestState();
    const editedRes = updateElement(
      initial,
      SEED_IDS.elements.kateryna,
      { label: 'Kateryna Custom', value: 'custom portrait' },
      500,
    ) as { ok: true; data: LocalWorkspaceState };

    const modelsCat = editedRes.data.categories.find((c) => c.id === SEED_IDS.categories.models)!;
    expect(modelsCat.updatedAt).toBe(500);
    expect(editedRes.data.dirtyCategoryIds).toEqual([SEED_IDS.categories.models]);
    expect(editedRes.data.dirtyElementIds).toEqual([SEED_IDS.elements.kateryna]);

    // Simulate login into an initialized account that has its own "Models" category (id: 'server-models')
    const reconciled = (
      reconcileAuthenticatedUser(editedRes.data, 'user-init') as {
        kind: 'ready';
        state: LocalWorkspaceState;
      }
    ).state;

    // Concurrent local edit to Kateryna (updatedAt = 900) happens while sync request (sent at updatedAt = 500) is in flight
    const concurrentState = (
      updateElement(
        reconciled,
        SEED_IDS.elements.kateryna,
        { label: 'Kateryna Concurrent', value: 'newer value' },
        900,
      ) as { ok: true; data: LocalWorkspaceState }
    ).data;

    // Server response canonicalized SEED_IDS.categories.models into 'server-models', returned Kateryna at updatedAt=600,
    // and omitted untouched seed categories/templates (Clothing, Scenes, Character Portrait)
    const afterSync = applySyncResponse(
      concurrentState,
      {
        categories: reconciled.categories,
        elements: reconciled.elements,
        templates: reconciled.templates,
      },
      {
        serverSeq: 12,
        categories: [
          {
            id: SEED_IDS.categories.models,
            name: 'Models',
            selectionMode: 'single',
            sortOrder: 0,
            updatedAt: 600,
            deletedAt: 600,
          },
          {
            id: 'server-models',
            name: 'Models',
            selectionMode: 'single',
            sortOrder: 0,
            updatedAt: 600,
            deletedAt: null,
          },
        ],
        elements: [
          {
            id: SEED_IDS.elements.kateryna,
            categoryId: 'server-models',
            label: 'Kateryna Custom',
            value: 'custom portrait',
            sortOrder: 0,
            updatedAt: 600,
            deletedAt: null,
          },
        ],
        templates: [],
      },
    );

    // Ignored untouched seed categories (Clothing, Scenes) and template (Character Portrait) are evicted
    expect(afterSync.categories.filter((c) => c.deletedAt === null).map((c) => c.id)).toEqual([
      'server-models',
    ]);
    expect(afterSync.templates).toEqual([]);

    // Concurrent local edit (updatedAt = 900 > sent 500) is preserved and stays in dirtyElementIds,
    // and its categoryId is remapped from tombstoned SEED_IDS.categories.models to 'server-models'
    const katerynaLocal = afterSync.elements.find((e) => e.id === SEED_IDS.elements.kateryna);
    expect(katerynaLocal).toEqual({
      id: SEED_IDS.elements.kateryna,
      categoryId: 'server-models',
      label: 'Kateryna Concurrent',
      value: 'newer value',
      sortOrder: 0,
      updatedAt: 900,
      deletedAt: null,
    });
    expect(afterSync.dirtyElementIds).toEqual([SEED_IDS.elements.kateryna]);
  });

  test('multi-chunk sync with duplicate category canonicalization remaps child elements in subsequent chunks instead of tombstoning them', async () => {
    let serverSnapshot: LibrarySnapshot = {
      categories: [
        {
          id: 'cat-server-a',
          name: 'Models',
          selectionMode: 'single',
          sortOrder: 0,
          updatedAt: 100,
          deletedAt: null,
        },
      ],
      elements: [],
      templates: [],
    };
    let serverSeq = 1;

    const clientState: LocalWorkspaceState = {
      ownerUserId: 'u1',
      lastSyncedSeq: 0,
      categories: [
        {
          id: 'cat-client-b',
          name: 'Models',
          selectionMode: 'single',
          sortOrder: 0,
          updatedAt: 200,
          deletedAt: null,
        },
      ],
      elements: [
        {
          id: 'el-1',
          categoryId: 'cat-client-b',
          label: 'E1',
          value: 'V1',
          sortOrder: 0,
          updatedAt: 200,
          deletedAt: null,
        },
        {
          id: 'el-2',
          categoryId: 'cat-client-b',
          label: 'E2',
          value: 'V2',
          sortOrder: 1,
          updatedAt: 200,
          deletedAt: null,
        },
      ],
      templates: [],
      dirtyCategoryIds: ['cat-client-b'],
      dirtyElementIds: ['el-1', 'el-2'],
      dirtyTemplateIds: [],
    };

    const synced = await runSyncCycle(
      clientState,
      async (req) => {
        const merged = mergeLibraries(serverSnapshot, req, 300, true);
        serverSnapshot = merged.snapshot;
        serverSeq += 1;
        return {
          serverSeq,
          categories: serverSnapshot.categories,
          elements: serverSnapshot.elements,
          templates: serverSnapshot.templates,
        };
      },
      2,
    );

    expect(synced.elements.filter((e) => e.deletedAt === null).map((e) => ({
      id: e.id,
      categoryId: e.categoryId,
    }))).toEqual([
      { id: 'el-1', categoryId: 'cat-server-a' },
      { id: 'el-2', categoryId: 'cat-server-a' },
    ]);
  });

  test('buildSyncChunks splits large multibyte records so each chunk stays below maxChunkBytes', () => {
    const cjkValue = '漢'.repeat(10_000); // 30,000 UTF-8 bytes per element
    const elements = Array.from({ length: 150 }, (_, i) => ({
      id: `el-${i}`,
      categoryId: 'c1',
      label: `L${i}`,
      value: cjkValue,
      sortOrder: i,
      updatedAt: 100,
      deletedAt: null,
    }));
    const state: LocalWorkspaceState = {
      ownerUserId: 'u1',
      lastSyncedSeq: 0,
      categories: [],
      elements,
      templates: [],
      dirtyCategoryIds: [],
      dirtyElementIds: elements.map((e) => e.id),
      dirtyTemplateIds: [],
    };

    const chunks = buildSyncChunks(state, 500, DEFAULT_MAX_CHUNK_BYTES);
    expect(chunks.map((c) => c.elements.length)).toEqual([116, 34]);
  });
});

describe('theme manager', () => {
  test('resolves light, dark, and system modes and persists selection', () => {
    expect(resolveEffectiveTheme('light', true)).toBe('light');
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
    expect(resolveEffectiveTheme('system', false)).toBe('light');

    const storage = createMemoryStorage();
    expect(loadThemeMode(storage)).toBe('system');
    saveThemeMode(storage, 'dark');
    expect(loadThemeMode(storage)).toBe('dark');
  });
});
