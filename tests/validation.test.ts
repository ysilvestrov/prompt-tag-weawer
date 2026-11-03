import { describe, expect, test } from 'vitest';
import { createSeedData, SEED_IDS } from '../src/shared/seed.ts';
import type { Category, PromptElement, PromptTemplate } from '../src/shared/types.ts';
import {
  normalizeName,
  validateCategoryInput,
  validateElementInput,
  validateSyncRequest,
  validateTemplateInput,
} from '../src/shared/validation.ts';

describe('seed and normalization', () => {
  test('normalizeName trims and lowercases', () => {
    expect(normalizeName('  MoDeLs  ')).toBe('models');
    expect(normalizeName('')).toBe('');
  });

  test('createSeedData returns deterministic starter records with updatedAt = 0', () => {
    const seed = createSeedData();
    expect(seed.categories.map((c) => ({ id: c.id, name: c.name, mode: c.selectionMode, updatedAt: c.updatedAt }))).toEqual([
      { id: SEED_IDS.categories.models, name: 'Models', mode: 'single', updatedAt: 0 },
      { id: SEED_IDS.categories.clothing, name: 'Clothing', mode: 'multi', updatedAt: 0 },
      { id: SEED_IDS.categories.scenes, name: 'Scenes', mode: 'single', updatedAt: 0 },
    ]);
    expect(seed.elements.map((e) => ({ id: e.id, label: e.label, updatedAt: e.updatedAt, deletedAt: e.deletedAt }))).toEqual([
      { id: SEED_IDS.elements.kateryna, label: 'Kateryna K', updatedAt: 0, deletedAt: null },
      { id: SEED_IDS.elements.android, label: 'Cyberpunk Android', updatedAt: 0, deletedAt: null },
      { id: SEED_IDS.elements.jacket, label: 'Leather Jacket', updatedAt: 0, deletedAt: null },
      { id: SEED_IDS.elements.scarf, label: 'Neon Scarf', updatedAt: 0, deletedAt: null },
      { id: SEED_IDS.elements.alley, label: 'Rainy Alley', updatedAt: 0, deletedAt: null },
      { id: SEED_IDS.elements.studio, label: 'Studio Rim Light', updatedAt: 0, deletedAt: null },
    ]);
    expect(seed.templates).toEqual([
      {
        id: SEED_IDS.templates.portrait,
        name: 'Character Portrait',
        content: 'Portrait of [Models], wearing [Clothing] in [Scenes], [Camera Angle]',
        sortOrder: 0,
        updatedAt: 0,
        deletedAt: null,
      },
    ]);
  });
});

describe('entity input validation', () => {
  const existingCategory: Category = {
    id: 'cat-1',
    name: 'Models',
    selectionMode: 'single',
    sortOrder: 0,
    updatedAt: 10,
    deletedAt: null,
  };

  test('validateCategoryInput accepts valid input and rejects empty, duplicate, or oversized names', () => {
    expect(validateCategoryInput({ name: '  Lighting ', selectionMode: 'multi' }, [existingCategory])).toEqual({
      ok: true,
      data: { name: 'Lighting', selectionMode: 'multi' },
    });
    expect(validateCategoryInput({ name: '   ', selectionMode: 'single' }, [])).toEqual({
      ok: false,
      error: 'Category name is required',
    });
    expect(validateCategoryInput({ name: 'mOdElS', selectionMode: 'single' }, [existingCategory])).toEqual({
      ok: false,
      error: 'Category "mOdElS" already exists',
    });
    expect(validateCategoryInput({ name: 'MODELS', selectionMode: 'multi' }, [existingCategory], 'cat-1')).toEqual({
      ok: true,
      data: { name: 'MODELS', selectionMode: 'multi' },
    });
    expect(validateCategoryInput({ name: 'x'.repeat(121), selectionMode: 'single' }, [])).toEqual({
      ok: false,
      error: 'Category name must be at most 120 characters',
    });
  });

  test('validateCategoryInput enforces maxCategories = 100 for new categories', () => {
    const hundred: Category[] = Array.from({ length: 100 }, (_, i) => ({
      id: `c-${i}`,
      name: `Cat ${i}`,
      selectionMode: 'single',
      sortOrder: i,
      updatedAt: 1,
      deletedAt: null,
    }));
    expect(validateCategoryInput({ name: 'Cat 101', selectionMode: 'single' }, hundred)).toEqual({
      ok: false,
      error: 'Maximum of 100 categories reached',
    });
  });

  test('validateElementInput checks label, value, and maxElements = 500', () => {
    expect(validateElementInput({ label: ' Hero ', value: ' 1girl, hero ' }, [])).toEqual({
      ok: true,
      data: { label: 'Hero', value: '1girl, hero' },
    });
    expect(validateElementInput({ label: '', value: 'abc' }, [])).toEqual({
      ok: false,
      error: 'Element label is required',
    });
    expect(validateElementInput({ label: 'Hero', value: '   ' }, [])).toEqual({
      ok: false,
      error: 'Element value is required',
    });
    expect(validateElementInput({ label: 'Hero', value: 'v'.repeat(10_001) }, [])).toEqual({
      ok: false,
      error: 'Element value must be at most 10000 characters',
    });
    const fiveHundred: PromptElement[] = Array.from({ length: 500 }, (_, i) => ({
      id: `e-${i}`,
      categoryId: 'cat-1',
      label: `L${i}`,
      value: `V${i}`,
      sortOrder: i,
      updatedAt: 1,
      deletedAt: null,
    }));
    expect(validateElementInput({ label: 'Extra', value: 'Val' }, fiveHundred)).toEqual({
      ok: false,
      error: 'Maximum of 500 elements reached',
    });
  });

  test('validateTemplateInput checks name, content bounds, and maxTemplates = 100', () => {
    expect(validateTemplateInput({ name: ' Portrait ', content: '[Models]' }, [])).toEqual({
      ok: true,
      data: { name: 'Portrait', content: '[Models]' },
    });
    expect(validateTemplateInput({ name: '   ', content: '[Models]' }, [])).toEqual({
      ok: false,
      error: 'Template name is required',
    });
    expect(validateTemplateInput({ name: 'T', content: 'c'.repeat(10_001) }, [])).toEqual({
      ok: false,
      error: 'Template content must be at most 10000 characters',
    });
    const hundred: PromptTemplate[] = Array.from({ length: 100 }, (_, i) => ({
      id: `t-${i}`,
      name: `T${i}`,
      content: '',
      sortOrder: i,
      updatedAt: 1,
      deletedAt: null,
    }));
    expect(validateTemplateInput({ name: 'Extra', content: '' }, hundred)).toEqual({
      ok: false,
      error: 'Maximum of 100 templates reached',
    });
  });
});

describe('validateSyncRequest', () => {
  test('accepts valid payload and rejects malformed or oversized batches', () => {
    const valid = validateSyncRequest({
      sinceSeq: 5,
      categories: [
        { id: 'c1', name: 'Models', selectionMode: 'single', sortOrder: 0, updatedAt: 100, deletedAt: null },
      ],
      elements: [
        {
          id: 'e1',
          categoryId: 'c1',
          label: 'Kateryna',
          value: '1girl',
          sortOrder: 0,
          updatedAt: 100,
          deletedAt: null,
        },
      ],
      templates: [
        { id: 't1', name: 'Main', content: '[Models]', sortOrder: 0, updatedAt: 100, deletedAt: null },
      ],
    });
    expect(valid).toEqual({
      ok: true,
      data: {
        sinceSeq: 5,
        categories: [
          { id: 'c1', name: 'Models', selectionMode: 'single', sortOrder: 0, updatedAt: 100, deletedAt: null },
        ],
        elements: [
          {
            id: 'e1',
            categoryId: 'c1',
            label: 'Kateryna',
            value: '1girl',
            sortOrder: 0,
            updatedAt: 100,
            deletedAt: null,
          },
        ],
        templates: [
          { id: 't1', name: 'Main', content: '[Models]', sortOrder: 0, updatedAt: 100, deletedAt: null },
        ],
      },
    });

    expect(validateSyncRequest(null)).toEqual({
      ok: false,
      error: 'Sync request body must be an object',
    });
    expect(validateSyncRequest({ sinceSeq: -1, categories: [], elements: [], templates: [] })).toEqual({
      ok: false,
      error: 'sinceSeq must be a non-negative integer',
    });
    const oversizedCategories = Array.from({ length: 1001 }, (_, i) => ({
      id: `c-${i}`,
      name: `C${i}`,
      selectionMode: 'single',
      sortOrder: i,
      updatedAt: 1,
      deletedAt: null,
    }));
    expect(
      validateSyncRequest({ sinceSeq: 0, categories: oversizedCategories, elements: [], templates: [] }),
    ).toEqual({
      ok: false,
      error: 'Sync batch exceeds maximum of 1000 records',
    });
  });
});
