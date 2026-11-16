import type { Category, PromptElement } from '../shared/types.ts';

export type ElementSortMode = 'default' | 'alpha-asc' | 'alpha-desc' | 'date-desc' | 'date-asc';

/**
 * Filter prompt elements by substring match on label or value (case-insensitive).
 */
export function filterElements(elements: readonly PromptElement[], query: string): PromptElement[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...elements];
  return elements.filter(
    (el) => el.label.toLowerCase().includes(q) || el.value.toLowerCase().includes(q),
  );
}

/**
 * Sort prompt elements for UI display according to the selected mode.
 * Ties in label or timestamp fall back deterministically to (sortOrder, id).
 */
export function sortElements(
  elements: readonly PromptElement[],
  mode: ElementSortMode,
): PromptElement[] {
  if (mode === 'default') return [...elements];
  return [...elements].sort((a, b) => {
    switch (mode) {
      case 'alpha-asc': {
        const cmp = a.label.localeCompare(b.label);
        if (cmp !== 0) return cmp;
        break;
      }
      case 'alpha-desc': {
        const cmp = b.label.localeCompare(a.label);
        if (cmp !== 0) return cmp;
        break;
      }
      case 'date-desc': {
        if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
        break;
      }
      case 'date-asc': {
        if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
        break;
      }
    }
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Filter categories by substring match on category name (case-insensitive).
 */
export function filterCategories(categories: readonly Category[], query: string): Category[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...categories];
  return categories.filter((cat) => cat.name.toLowerCase().includes(q));
}
