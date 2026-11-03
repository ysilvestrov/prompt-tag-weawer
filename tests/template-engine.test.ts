import { describe, expect, test } from 'vitest';
import {
  assemblePrompt,
  parseTemplate,
  resolveTemplateVariables,
} from '../src/shared/template-engine.ts';
import type { Category, PromptElement } from '../src/shared/types.ts';

const categories: Category[] = [
  {
    id: 'cat-models',
    name: 'Models',
    selectionMode: 'single',
    sortOrder: 0,
    updatedAt: 10,
    deletedAt: null,
  },
  {
    id: 'cat-clothing',
    name: 'Clothing',
    selectionMode: 'multi',
    sortOrder: 1,
    updatedAt: 10,
    deletedAt: null,
  },
  {
    id: 'cat-deleted',
    name: 'DeletedCat',
    selectionMode: 'single',
    sortOrder: 2,
    updatedAt: 20,
    deletedAt: 20,
  },
];

const elements: PromptElement[] = [
  {
    id: 'el-kateryna',
    categoryId: 'cat-models',
    label: 'Kateryna K',
    value: '1girl, Kateryna K, highly detailed face',
    sortOrder: 1,
    updatedAt: 10,
    deletedAt: null,
  },
  {
    id: 'el-android',
    categoryId: 'cat-models',
    label: 'Android',
    value: '1boy, android',
    sortOrder: 0,
    updatedAt: 10,
    deletedAt: null,
  },
  {
    id: 'el-jacket',
    categoryId: 'cat-clothing',
    label: 'Jacket',
    value: 'leather jacket',
    sortOrder: 0,
    updatedAt: 10,
    deletedAt: null,
  },
  {
    id: 'el-scarf',
    categoryId: 'cat-clothing',
    label: 'Scarf',
    value: 'neon scarf',
    sortOrder: 1,
    updatedAt: 10,
    deletedAt: null,
  },
  {
    id: 'el-deleted',
    categoryId: 'cat-clothing',
    label: 'Boots',
    value: 'heavy boots',
    sortOrder: 2,
    updatedAt: 15,
    deletedAt: 15,
  },
];

describe('parseTemplate', () => {
  test('returns empty array for empty template', () => {
    expect(parseTemplate('')).toEqual([]);
  });

  test('parses valid placeholders and preserves unclosed, empty, or whitespace-only brackets as text', () => {
    const template = 'Portrait of [ Models ], [] and [   ] with [Unclosed and [[Nested]]';
    expect(parseTemplate(template)).toEqual([
      { type: 'text', value: 'Portrait of ' },
      { type: 'variable', rawName: 'Models', normalizedName: 'models' },
      { type: 'text', value: ', [] and [   ] with [Unclosed and [' },
      { type: 'variable', rawName: 'Nested', normalizedName: 'nested' },
      { type: 'text', value: ']' },
    ]);
  });
});

describe('resolveTemplateVariables', () => {
  test('deduplicates repeated placeholders in order of first appearance and falls back to freetext for missing or deleted categories', () => {
    const content = 'A [models] wearing [CLOTHING] next to [Models] in [DeletedCat] with [Lighting]';
    expect(resolveTemplateVariables(content, categories, elements)).toEqual([
      {
        kind: 'category',
        rawName: 'models',
        normalizedName: 'models',
        categoryId: 'cat-models',
        categoryName: 'Models',
        selectionMode: 'single',
        elements: [elements[1], elements[0]],
      },
      {
        kind: 'category',
        rawName: 'CLOTHING',
        normalizedName: 'clothing',
        categoryId: 'cat-clothing',
        categoryName: 'Clothing',
        selectionMode: 'multi',
        elements: [elements[2], elements[3]],
      },
      {
        kind: 'freetext',
        rawName: 'DeletedCat',
        normalizedName: 'deletedcat',
      },
      {
        kind: 'freetext',
        rawName: 'Lighting',
        normalizedName: 'lighting',
      },
    ]);
  });
});

describe('assemblePrompt', () => {
  test('assembles single-select, multi-select in category order, repeated placeholders, and freetext', () => {
    const content = 'Portrait of [Models] (twin of [models]), wearing [Clothing], lit by [Lighting]';
    const result = assemblePrompt(
      content,
      categories,
      elements,
      {
        models: ['el-kateryna', 'el-android'],
        clothing: ['el-scarf', 'el-jacket'],
      },
      {
        lighting: 'soft rim light',
      },
    );
    expect(result).toBe(
      'Portrait of 1boy, android (twin of 1boy, android), wearing leather jacket, neon scarf, lit by soft rim light',
    );
  });

  test('substitutes empty string when nothing is selected or freetext is omitted', () => {
    const content = 'Portrait of [Models], wearing [Clothing] in [Unknown]';
    expect(assemblePrompt(content, categories, elements, {}, {})).toBe('Portrait of , wearing  in ');
  });
});
