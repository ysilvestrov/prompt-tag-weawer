import type { Category, LibrarySnapshot, PromptElement, PromptTemplate } from './types.ts';
import { normalizeName } from './validation.ts';

function canonicalJson(record: object): string {
  const entries = Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

/**
 * Returns > 0 if `a` wins over `b`, < 0 if `b` wins over `a`, 0 if identical.
 * Rule (§3.1):
 * 1. Larger `updatedAt` wins.
 * 2. On equal `updatedAt`, tombstone (`deletedAt !== null`) beats active (`deletedAt === null`).
 * 3. Deterministic tie-breaker by canonical serialized fields.
 */
export function compareVersions<T extends { id: string; updatedAt: number; deletedAt: number | null }>(
  a: T,
  b: T,
): number {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt - b.updatedAt;
  }
  const aDeleted = a.deletedAt !== null;
  const bDeleted = b.deletedAt !== null;
  if (aDeleted !== bDeleted) {
    return aDeleted ? 1 : -1;
  }
  return canonicalJson(a).localeCompare(canonicalJson(b));
}

export function clampTimestamps<T extends { updatedAt: number; deletedAt: number | null }>(
  record: T,
  maxNow: number,
): T {
  const clamp = (val: number) => Math.min(Math.max(0, Math.trunc(val)), maxNow);
  const updatedAt = clamp(record.updatedAt);
  const deletedAt = record.deletedAt !== null ? clamp(record.deletedAt) : null;
  return {
    ...record,
    updatedAt,
    deletedAt,
  };
}

export function deleteCategoryCascade(
  categoryId: string,
  deletedAt: number,
  categories: readonly Category[],
  elements: readonly PromptElement[],
): { categories: Category[]; elements: PromptElement[]; changedElementIds: string[] } {
  const nextCategories = categories.map((c) =>
    c.id === categoryId && c.deletedAt === null
      ? { ...c, deletedAt, updatedAt: Math.max(c.updatedAt, deletedAt) }
      : c,
  );
  const changedElementIds: string[] = [];
  const nextElements = elements.map((e) => {
    if (e.categoryId === categoryId && e.deletedAt === null) {
      changedElementIds.push(e.id);
      return { ...e, deletedAt, updatedAt: Math.max(e.updatedAt, deletedAt) };
    }
    return e;
  });
  return { categories: nextCategories, elements: nextElements, changedElementIds };
}

export interface MergeResult {
  snapshot: LibrarySnapshot;
  touchedCategoryIds: Set<string>;
  touchedElementIds: Set<string>;
  touchedTemplateIds: Set<string>;
}

/**
 * Pure two-way LWW merge between an existing library state and an incoming batch.
 */
export function mergeLibraries(
  existing: LibrarySnapshot,
  incoming: LibrarySnapshot,
  now: number,
  existingInitialized = false,
): MergeResult {
  const touchedCategoryIds = new Set<string>();
  const touchedElementIds = new Set<string>();
  const touchedTemplateIds = new Set<string>();

  const shouldIgnoreSeed = (r: { updatedAt: number; deletedAt: number | null }) =>
    existingInitialized && r.updatedAt === 0 && r.deletedAt === null;

  // Compute max active child updatedAt per categoryId in incoming elements so that
  // a starter category (updatedAt === 0) with customized/added active children is promoted
  // and never ignored during login merge.
  const maxActiveChildUpdatedByCat = new Map<string, number>();
  for (const rawEl of incoming.elements) {
    const clampedEl = clampTimestamps(rawEl, now);
    if (clampedEl.deletedAt === null && clampedEl.updatedAt > 0) {
      const prevMax = maxActiveChildUpdatedByCat.get(clampedEl.categoryId) ?? 0;
      if (clampedEl.updatedAt > prevMax) {
        maxActiveChildUpdatedByCat.set(clampedEl.categoryId, clampedEl.updatedAt);
      }
    }
  }

  // 1. Merge Categories by ID first
  const categoryMap = new Map<string, Category>();
  for (const c of existing.categories) {
    categoryMap.set(c.id, { ...c });
  }
  const existingActiveNameOwner = new Map<string, string>();
  for (const c of existing.categories) {
    if (c.deletedAt === null) {
      existingActiveNameOwner.set(normalizeName(c.name), c.id);
    }
  }

  for (const rawIn of incoming.categories) {
    const clamped = clampTimestamps(rawIn, now);
    const promotedUpdatedAt =
      clamped.updatedAt === 0 && clamped.deletedAt === null
        ? (maxActiveChildUpdatedByCat.get(clamped.id) ?? 0)
        : clamped.updatedAt;
    const cIn: Category = {
      ...clamped,
      name: rawIn.name.trim(),
      updatedAt: promotedUpdatedAt,
    };
    if (shouldIgnoreSeed(cIn)) continue;
    const prev = categoryMap.get(cIn.id);
    if (prev === undefined || compareVersions(cIn, prev) > 0) {
      categoryMap.set(cIn.id, cIn);
      touchedCategoryIds.add(cIn.id);
    }
  }

  // 2. Merge Elements by ID first
  const elementMap = new Map<string, PromptElement>();
  for (const e of existing.elements) {
    elementMap.set(e.id, { ...e });
  }
  for (const rawIn of incoming.elements) {
    const eIn = { ...clampTimestamps(rawIn, now), label: rawIn.label.trim() };
    if (shouldIgnoreSeed(eIn)) continue;
    const prev = elementMap.get(eIn.id);
    if (prev === undefined || compareVersions(eIn, prev) > 0) {
      elementMap.set(eIn.id, eIn);
      touchedElementIds.add(eIn.id);
    }
  }

  // 3. Canonicalize active categories with colliding normalized names
  const activeByNorm = new Map<string, Category[]>();
  for (const cat of categoryMap.values()) {
    if (cat.deletedAt !== null) continue;
    const norm = normalizeName(cat.name);
    const list = activeByNorm.get(norm) ?? [];
    list.push(cat);
    activeByNorm.set(norm, list);
  }

  const activeCanonicalByNorm = new Map<string, Category>();

  for (const [norm, group] of activeByNorm.entries()) {
    if (group.length === 1) {
      activeCanonicalByNorm.set(norm, group[0]!);
      continue;
    }
    const preferredId = existingActiveNameOwner.get(norm);
    const sortedGroup = [...group].sort((a, b) => {
      if (a.id === preferredId) return -1;
      if (b.id === preferredId) return 1;
      return a.id.localeCompare(b.id);
    });
    const canonical = sortedGroup[0]!;
    let winningMeta = canonical;
    for (const candidate of sortedGroup.slice(1)) {
      if (compareVersions(candidate, winningMeta) > 0) {
        winningMeta = candidate;
      }
    }

    const updatedCanonical: Category = {
      ...canonical,
      name: winningMeta.name,
      selectionMode: winningMeta.selectionMode,
      sortOrder: winningMeta.sortOrder,
      updatedAt: Math.max(canonical.updatedAt, winningMeta.updatedAt, now),
      deletedAt: null,
    };
    categoryMap.set(canonical.id, updatedCanonical);
    touchedCategoryIds.add(canonical.id);
    activeCanonicalByNorm.set(norm, updatedCanonical);

    for (const duplicate of sortedGroup.slice(1)) {
      const tombstonedDuplicate: Category = {
        ...duplicate,
        deletedAt: now,
        updatedAt: Math.max(duplicate.updatedAt, now),
      };
      categoryMap.set(duplicate.id, tombstonedDuplicate);
      touchedCategoryIds.add(duplicate.id);

      for (const el of elementMap.values()) {
        if (el.categoryId === duplicate.id) {
          const reassigned: PromptElement = {
            ...el,
            categoryId: canonical.id,
            updatedAt: Math.max(el.updatedAt, now),
          };
          elementMap.set(el.id, reassigned);
          touchedElementIds.add(el.id);
        }
      }
    }
  }

  // Build lookup of incoming category names for ignored seed categories too
  const incomingCatNameById = new Map<string, string>();
  for (const rawIn of incoming.categories) {
    incomingCatNameById.set(rawIn.id, normalizeName(rawIn.name));
  }

  // 4. Handle elements whose parent category is deleted or missing:
  // - If the element arrived in a later chunk of a canonicalized category (or under an ignored seed
  //   category) where an active canonical category with the same normalized name exists AND the parent
  //   category was tombstoned due to canonicalization (or ignored as seed), remap the element to the
  //   active canonical category only when the parent was part of a same-name canonicalization in this
  //   or a prior chunk. Wait: how do we distinguish "category was deleted by user" from "category was
  //   tombstoned by canonicalization"?
  //   Let's check: when a user deletes a category "Models" and never recreates it, `activeCanonicalByNorm.get('models')` is undefined!
  //   When an active category with the same normalized name DOES exist (`activeCanonicalByNorm.get(norm)` is defined),
  //   AND the element's `updatedAt >= parent.deletedAt` (or parent was an ignored seed category not in `categoryMap`),
  //   remapping to the active category of the same normalized name preserves children uploaded in subsequent chunks!
  for (const el of elementMap.values()) {
    if (el.deletedAt !== null) continue;
    const parent = categoryMap.get(el.categoryId);
    if (parent === undefined || parent.deletedAt !== null) {
      const parentNorm =
        parent !== undefined
          ? normalizeName(parent.name)
          : incomingCatNameById.get(el.categoryId);
      const activeReplacement =
        parentNorm !== undefined ? activeCanonicalByNorm.get(parentNorm) : undefined;

      if (
        activeReplacement !== undefined &&
        (parent === undefined || parent.deletedAt === parent.updatedAt) &&
        activeReplacement.updatedAt >= (parent?.deletedAt ?? 0)
      ) {
        elementMap.set(el.id, {
          ...el,
          categoryId: activeReplacement.id,
          updatedAt: Math.max(el.updatedAt, now),
        });
        touchedElementIds.add(el.id);
      } else {
        const tombstoneTime = Math.max(el.updatedAt, parent?.deletedAt ?? 0, now);
        elementMap.set(el.id, {
          ...el,
          deletedAt: tombstoneTime,
          updatedAt: tombstoneTime,
        });
        touchedElementIds.add(el.id);
      }
    }
  }

  // 5. Merge Templates by ID
  const templateMap = new Map<string, PromptTemplate>();
  for (const t of existing.templates) {
    templateMap.set(t.id, { ...t });
  }
  for (const rawIn of incoming.templates) {
    const tIn = { ...clampTimestamps(rawIn, now), name: rawIn.name.trim() };
    if (shouldIgnoreSeed(tIn)) continue;
    const prev = templateMap.get(tIn.id);
    if (prev === undefined || compareVersions(tIn, prev) > 0) {
      templateMap.set(tIn.id, tIn);
      touchedTemplateIds.add(tIn.id);
    }
  }

  return {
    snapshot: {
      categories: [...categoryMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
      elements: [...elementMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
      templates: [...templateMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    },
    touchedCategoryIds,
    touchedElementIds,
    touchedTemplateIds,
  };
}
