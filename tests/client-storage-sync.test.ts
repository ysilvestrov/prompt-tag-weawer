import { describe, expect, test } from 'vitest';
import {
  addCategory,
  addElement,
  addTemplate,
  createInitialGuestState,
  loadWorkspaceState,
  reconcileAuthenticatedUser,
  removeCategory,
  updateCategory,
} from '../src/client/storage.ts';
import { buildSyncChunks, runSyncCycle } from '../src/client/sync-client.ts';
import { loadThemeMode, resolveEffectiveTheme, saveThemeMode } from '../src/client/theme.ts';
import { SEED_IDS } from '../src/shared/seed.ts';
import type { LocalWorkspaceState, SyncRequest, SyncResponse } from '../src/shared/types.ts';

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
