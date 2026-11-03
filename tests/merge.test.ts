import { describe, expect, test } from 'vitest';
import {
  compareVersions,
  deleteCategoryCascade,
  mergeLibraries,
} from '../src/shared/merge.ts';
import { createSeedData } from '../src/shared/seed.ts';
import type { Category, LibrarySnapshot, PromptElement } from '../src/shared/types.ts';

describe('compareVersions', () => {
  test('orders by updatedAt, then tombstone over active, then canonical JSON', () => {
    const older: Category = {
      id: 'c1',
      name: 'A',
      selectionMode: 'single',
      sortOrder: 0,
      updatedAt: 100,
      deletedAt: null,
    };
    const newer: Category = { ...older, updatedAt: 200 };
    expect(compareVersions(newer, older)).toBe(100);
    expect(compareVersions(older, newer)).toBe(-100);

    const activeSameTime: Category = { ...older, updatedAt: 200, deletedAt: null };
    const deletedSameTime: Category = { ...older, updatedAt: 200, deletedAt: 200 };
    expect(compareVersions(deletedSameTime, activeSameTime)).toBe(1);
    expect(compareVersions(activeSameTime, deletedSameTime)).toBe(-1);

    const tieA: Category = { ...older, name: 'Alpha', updatedAt: 200 };
    const tieB: Category = { ...older, name: 'Beta', updatedAt: 200 };
    expect(compareVersions(tieA, tieB)).toBe(-1);
    expect(compareVersions(tieB, tieA)).toBe(1);
    expect(compareVersions(tieA, { ...tieA })).toBe(0);
  });
});

describe('deleteCategoryCascade', () => {
  test('marks category and all its active elements as deleted with timestamp', () => {
    const categories: Category[] = [
      { id: 'c1', name: 'Models', selectionMode: 'single', sortOrder: 0, updatedAt: 10, deletedAt: null },
      { id: 'c2', name: 'Scenes', selectionMode: 'single', sortOrder: 1, updatedAt: 10, deletedAt: null },
    ];
    const elements: PromptElement[] = [
      { id: 'e1', categoryId: 'c1', label: 'L1', value: 'V1', sortOrder: 0, updatedAt: 10, deletedAt: null },
      { id: 'e2', categoryId: 'c2', label: 'L2', value: 'V2', sortOrder: 0, updatedAt: 10, deletedAt: null },
    ];

    const res = deleteCategoryCascade('c1', 50, categories, elements);
    expect(res).toEqual({
      categories: [
        { id: 'c1', name: 'Models', selectionMode: 'single', sortOrder: 0, updatedAt: 50, deletedAt: 50 },
        { id: 'c2', name: 'Scenes', selectionMode: 'single', sortOrder: 1, updatedAt: 10, deletedAt: null },
      ],
      elements: [
        { id: 'e1', categoryId: 'c1', label: 'L1', value: 'V1', sortOrder: 0, updatedAt: 50, deletedAt: 50 },
        { id: 'e2', categoryId: 'c2', label: 'L2', value: 'V2', sortOrder: 0, updatedAt: 10, deletedAt: null },
      ],
      changedElementIds: ['e1'],
    });
  });
});

describe('mergeLibraries', () => {
  test('ignores untouched starter seed records (updatedAt = 0) when merging into an initialized account', () => {
    const existing: LibrarySnapshot = {
      categories: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'Models',
          selectionMode: 'single',
          sortOrder: 0,
          updatedAt: 500,
          deletedAt: 500,
        },
      ],
      elements: [],
      templates: [],
    };
    const incomingSeed = createSeedData();
    const merged = mergeLibraries(existing, incomingSeed, 1000, true);
    expect(merged.snapshot.categories).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Models',
        selectionMode: 'single',
        sortOrder: 0,
        updatedAt: 500,
        deletedAt: 500,
      },
    ]);
    expect(merged.snapshot.elements).toEqual([]);
    expect(merged.snapshot.templates).toEqual([]);
  });

  test('canonicalizes colliding category names and reassigns both stored and incoming child elements', () => {
    const existing: LibrarySnapshot = {
      categories: [
        { id: 'cat-server', name: 'Models', selectionMode: 'single', sortOrder: 0, updatedAt: 100, deletedAt: null },
        { id: 'cat-renamed', name: 'OldName', selectionMode: 'single', sortOrder: 1, updatedAt: 100, deletedAt: null },
      ],
      elements: [
        {
          id: 'el-stored-under-renamed',
          categoryId: 'cat-renamed',
          label: 'Stored Child',
          value: 'stored val',
          sortOrder: 0,
          updatedAt: 100,
          deletedAt: null,
        },
      ],
      templates: [],
    };

    const incoming: LibrarySnapshot = {
      categories: [
        { id: 'cat-renamed', name: '  models ', selectionMode: 'multi', sortOrder: 2, updatedAt: 200, deletedAt: null },
      ],
      elements: [
        {
          id: 'el-incoming-under-renamed',
          categoryId: 'cat-renamed',
          label: 'New Child',
          value: 'new val',
          sortOrder: 1,
          updatedAt: 200,
          deletedAt: null,
        },
      ],
      templates: [],
    };

    const result = mergeLibraries(existing, incoming, 300, true);
    expect(result.snapshot.categories).toEqual([
      { id: 'cat-renamed', name: 'models', selectionMode: 'multi', sortOrder: 2, updatedAt: 300, deletedAt: 300 },
      { id: 'cat-server', name: 'models', selectionMode: 'multi', sortOrder: 2, updatedAt: 300, deletedAt: null },
    ]);
    expect(result.snapshot.elements).toEqual([
      {
        id: 'el-incoming-under-renamed',
        categoryId: 'cat-server',
        label: 'New Child',
        value: 'new val',
        sortOrder: 1,
        updatedAt: 300,
        deletedAt: null,
      },
      {
        id: 'el-stored-under-renamed',
        categoryId: 'cat-server',
        label: 'Stored Child',
        value: 'stored val',
        sortOrder: 0,
        updatedAt: 300,
        deletedAt: null,
      },
    ]);
  });

  test('tombstones incoming active element whose parent category is already deleted and clamps future timestamps', () => {
    const existing: LibrarySnapshot = {
      categories: [
        { id: 'cat-del', name: 'Scenes', selectionMode: 'single', sortOrder: 0, updatedAt: 200, deletedAt: 200 },
      ],
      elements: [],
      templates: [],
    };
    const incoming: LibrarySnapshot = {
      categories: [],
      elements: [
        {
          id: 'el-orphan',
          categoryId: 'cat-del',
          label: 'Late Child',
          value: 'val',
          sortOrder: 0,
          updatedAt: 999_999,
          deletedAt: null,
        },
      ],
      templates: [],
    };

    const result = mergeLibraries(existing, incoming, 500, true);
    expect(result.snapshot.elements).toEqual([
      {
        id: 'el-orphan',
        categoryId: 'cat-del',
        label: 'Late Child',
        value: 'val',
        sortOrder: 0,
        updatedAt: 500,
        deletedAt: 500,
      },
    ]);
  });
});
