import type { Category, PromptElement, SelectionMode } from './types.ts';
import { normalizeName } from './validation.ts';

export type TemplateToken =
  | { type: 'text'; value: string }
  | { type: 'variable'; rawName: string; normalizedName: string };

export type ResolvedVariable =
  | {
      kind: 'category';
      rawName: string;
      normalizedName: string;
      categoryId: string;
      categoryName: string;
      selectionMode: SelectionMode;
      elements: PromptElement[];
    }
  | {
      kind: 'freetext';
      rawName: string;
      normalizedName: string;
    };

const PLACEHOLDER_RE = /\[([^\[\]\r\n]+)\]/g;

export function parseTemplate(content: string): TemplateToken[] {
  if (content.length === 0) return [];
  const tokens: TemplateToken[] = [];
  let lastIndex = 0;

  const appendText = (text: string) => {
    if (text.length === 0) return;
    const prev = tokens[tokens.length - 1];
    if (prev !== undefined && prev.type === 'text') {
      prev.value += text;
    } else {
      tokens.push({ type: 'text', value: text });
    }
  };

  for (const match of content.matchAll(PLACEHOLDER_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      appendText(content.slice(lastIndex, index));
    }
    const inner = match[1] ?? '';
    const trimmed = inner.trim();
    if (trimmed.length === 0) {
      appendText(match[0]);
    } else {
      tokens.push({
        type: 'variable',
        rawName: trimmed,
        normalizedName: normalizeName(trimmed),
      });
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < content.length) {
    appendText(content.slice(lastIndex));
  }

  return tokens;
}

export function sortByOrderAndId<T extends { sortOrder: number; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id.localeCompare(b.id);
  });
}

export function resolveTemplateVariables(
  content: string,
  categories: readonly Category[],
  elements: readonly PromptElement[],
): ResolvedVariable[] {
  const tokens = parseTemplate(content);
  const activeCategories = categories.filter((c) => c.deletedAt === null);
  const activeElements = elements.filter((e) => e.deletedAt === null);

  const categoryByNormalizedName = new Map<string, Category>();
  for (const cat of sortByOrderAndId(activeCategories)) {
    const norm = normalizeName(cat.name);
    if (!categoryByNormalizedName.has(norm)) {
      categoryByNormalizedName.set(norm, cat);
    }
  }

  const seen = new Set<string>();
  const resolved: ResolvedVariable[] = [];

  for (const token of tokens) {
    if (token.type !== 'variable') continue;
    if (seen.has(token.normalizedName)) continue;
    seen.add(token.normalizedName);

    const matchedCategory = categoryByNormalizedName.get(token.normalizedName);
    if (matchedCategory !== undefined) {
      const catElements = sortByOrderAndId(
        activeElements.filter((e) => e.categoryId === matchedCategory.id),
      );
      resolved.push({
        kind: 'category',
        rawName: token.rawName,
        normalizedName: token.normalizedName,
        categoryId: matchedCategory.id,
        categoryName: matchedCategory.name,
        selectionMode: matchedCategory.selectionMode,
        elements: catElements,
      });
    } else {
      resolved.push({
        kind: 'freetext',
        rawName: token.rawName,
        normalizedName: token.normalizedName,
      });
    }
  }

  return resolved;
}

export function assemblePrompt(
  content: string,
  categories: readonly Category[],
  elements: readonly PromptElement[],
  selections: Readonly<Record<string, readonly string[]>>,
  freeText: Readonly<Record<string, string>>,
): string {
  const tokens = parseTemplate(content);
  const resolved = resolveTemplateVariables(content, categories, elements);
  const valueByNormalizedName = new Map<string, string>();

  for (const variable of resolved) {
    if (variable.kind === 'category') {
      const selectedIds = new Set(selections[variable.normalizedName] ?? []);
      const matchingElements = variable.elements.filter(
        (el) => selectedIds.has(el.id) && el.value.trim().length > 0,
      );
      if (variable.selectionMode === 'single') {
        const first = matchingElements[0];
        valueByNormalizedName.set(variable.normalizedName, first !== undefined ? first.value : '');
      } else {
        valueByNormalizedName.set(
          variable.normalizedName,
          matchingElements.map((el) => el.value).join(', '),
        );
      }
    } else {
      const text = freeText[variable.normalizedName] ?? '';
      valueByNormalizedName.set(variable.normalizedName, text);
    }
  }

  return tokens
    .map((t) => (t.type === 'text' ? t.value : (valueByNormalizedName.get(t.normalizedName) ?? '')))
    .join('');
}
