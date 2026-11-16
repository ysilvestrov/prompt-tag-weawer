import { describe, expect, test } from 'vitest';
import { filterCategories, filterElements, sortElements } from '../src/client/tag-controls.ts';
import type { Category, PromptElement } from '../src/shared/types.ts';

function makeElement(
  id: string,
  label: string,
  value: string,
  sortOrder: number,
  updatedAt: number,
): PromptElement {
  return {
    id,
    categoryId: 'cat-1',
    label,
    value,
    sortOrder,
    updatedAt,
    deletedAt: null,
  };
}

function makeCategory(id: string, name: string, sortOrder: number): Category {
  return {
    id,
    name,
    selectionMode: 'single',
    sortOrder,
    updatedAt: 100,
    deletedAt: null,
  };
}

describe('tag-controls: filterElements', () => {
  const items = [
    makeElement('e1', 'Leather Jacket', 'black weathered jacket', 0, 100),
    makeElement('e2', 'Neon Scarf', 'translucent scarf', 1, 200),
    makeElement('e3', 'Cyber Visor', 'glowing visor', 2, 300),
  ];

  test('returns all elements when query is empty or whitespace', () => {
    expect(filterElements(items, '').map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(filterElements(items, '   ').map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  test('matches case-insensitively on label or value', () => {
    expect(filterElements(items, '  SCARF ').map((e) => e.id)).toEqual(['e2']);
    expect(filterElements(items, 'WEATHERED').map((e) => e.id)).toEqual(['e1']);
  });

  test('returns empty array when no elements match or input is empty', () => {
    expect(filterElements(items, 'nonexistent')).toEqual([]);
    expect(filterElements([], 'jacket')).toEqual([]);
  });
});

describe('tag-controls: sortElements', () => {
  const alpha = makeElement('e1', 'Alpha', 'val-a', 0, 200);
  const charlie = makeElement('e2', 'Charlie', 'val-c', 1, 100);
  const bravo = makeElement('e3', 'Bravo', 'val-b', 2, 300);
  const bravoTie = makeElement('e4', 'Bravo', 'val-b2', 3, 300);
  const items = [alpha, charlie, bravo, bravoTie];

  test('default preserves input order without mutating input array', () => {
    const result = sortElements(items, 'default');
    expect(result.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(result).not.toBe(items);
  });

  test('alpha-asc and alpha-desc sort by label with deterministic tie-breaker', () => {
    expect(sortElements(items, 'alpha-asc').map((e) => e.id)).toEqual(['e1', 'e3', 'e4', 'e2']);
    expect(sortElements(items, 'alpha-desc').map((e) => e.id)).toEqual(['e2', 'e3', 'e4', 'e1']);
  });

  test('date-desc and date-asc sort by updatedAt with deterministic tie-breaker', () => {
    expect(sortElements(items, 'date-desc').map((e) => e.id)).toEqual(['e3', 'e4', 'e1', 'e2']);
    expect(sortElements(items, 'date-asc').map((e) => e.id)).toEqual(['e2', 'e1', 'e3', 'e4']);
  });

  test('handles empty array', () => {
    expect(sortElements([], 'alpha-asc')).toEqual([]);
  });
});

describe('tag-controls: filterCategories', () => {
  const categories = [
    makeCategory('c1', 'Models', 0),
    makeCategory('c2', 'Clothing', 1),
    makeCategory('c3', 'Camera Angle', 2),
  ];

  test('returns all categories when query is empty or whitespace', () => {
    expect(filterCategories(categories, '').map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(filterCategories(categories, '  ').map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  test('filters categories case-insensitively by name', () => {
    expect(filterCategories(categories, 'cam').map((c) => c.id)).toEqual(['c3']);
    expect(filterCategories(categories, 'missing')).toEqual([]);
  });
});
