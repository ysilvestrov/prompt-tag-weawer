import { deleteCategoryCascade } from '../shared/merge.ts';
import { createSeedData } from '../shared/seed.ts';
import type {
  Category,
  LocalWorkspaceState,
  PromptElement,
  PromptTemplate,
  SelectionMode,
  SyncResponse,
} from '../shared/types.ts';
import {
  validateCategoryInput,
  validateElementInput,
  validateTemplateInput,
  type ValidationResult,
} from '../shared/validation.ts';

export const WORKSPACE_STORAGE_KEY = 'ptw_workspace_v1';

export type SimpleStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function createInitialGuestState(): LocalWorkspaceState {
  const seed = createSeedData();
  return {
    ownerUserId: null,
    lastSyncedSeq: 0,
    categories: seed.categories,
    elements: seed.elements,
    templates: seed.templates,
    dirtyCategoryIds: [],
    dirtyElementIds: [],
    dirtyTemplateIds: [],
  };
}

function addUniqueId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? [...ids] : [...ids, id];
}

export function hasUnsyncedChanges(state: LocalWorkspaceState): boolean {
  return (
    state.dirtyCategoryIds.length > 0 ||
    state.dirtyElementIds.length > 0 ||
    state.dirtyTemplateIds.length > 0
  );
}

export function loadWorkspaceState(storage: SimpleStorage): LocalWorkspaceState {
  const raw = storage.getItem(WORKSPACE_STORAGE_KEY);
  if (raw === null) {
    const initial = createInitialGuestState();
    saveWorkspaceState(storage, initial);
    return initial;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LocalWorkspaceState>;
    if (
      !Array.isArray(parsed.categories) ||
      !Array.isArray(parsed.elements) ||
      !Array.isArray(parsed.templates)
    ) {
      const initial = createInitialGuestState();
      saveWorkspaceState(storage, initial);
      return initial;
    }
    return {
      ownerUserId: typeof parsed.ownerUserId === 'string' ? parsed.ownerUserId : null,
      lastSyncedSeq: typeof parsed.lastSyncedSeq === 'number' ? parsed.lastSyncedSeq : 0,
      categories: parsed.categories,
      elements: parsed.elements,
      templates: parsed.templates,
      dirtyCategoryIds: Array.isArray(parsed.dirtyCategoryIds) ? parsed.dirtyCategoryIds : [],
      dirtyElementIds: Array.isArray(parsed.dirtyElementIds) ? parsed.dirtyElementIds : [],
      dirtyTemplateIds: Array.isArray(parsed.dirtyTemplateIds) ? parsed.dirtyTemplateIds : [],
    };
  } catch {
    const initial = createInitialGuestState();
    saveWorkspaceState(storage, initial);
    return initial;
  }
}

export function saveWorkspaceState(storage: SimpleStorage, state: LocalWorkspaceState): void {
  storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(state));
}

export function addCategory(
  state: LocalWorkspaceState,
  input: { id: string; name: string; selectionMode: SelectionMode },
  now: number,
): ValidationResult<LocalWorkspaceState> {
  const validated = validateCategoryInput(input, state.categories);
  if (!validated.ok) return validated;

  const nextSortOrder =
    state.categories.reduce((max, c) => (c.sortOrder > max ? c.sortOrder : max), -1) + 1;
  const newCategory: Category = {
    id: input.id,
    name: validated.data.name,
    selectionMode: validated.data.selectionMode,
    sortOrder: nextSortOrder,
    updatedAt: now,
    deletedAt: null,
  };

  return {
    ok: true,
    data: {
      ...state,
      categories: [...state.categories, newCategory],
      dirtyCategoryIds: addUniqueId(state.dirtyCategoryIds, newCategory.id),
    },
  };
}

export function updateCategory(
  state: LocalWorkspaceState,
  categoryId: string,
  input: { name: string; selectionMode: SelectionMode },
  now: number,
): ValidationResult<LocalWorkspaceState> {
  const existing = state.categories.find((c) => c.id === categoryId && c.deletedAt === null);
  if (existing === undefined) {
    return { ok: false, error: 'Category not found' };
  }
  const validated = validateCategoryInput(input, state.categories, categoryId);
  if (!validated.ok) return validated;

  const updated: Category = {
    ...existing,
    name: validated.data.name,
    selectionMode: validated.data.selectionMode,
    updatedAt: Math.max(existing.updatedAt + 1, now),
  };

  return {
    ok: true,
    data: {
      ...state,
      categories: state.categories.map((c) => (c.id === categoryId ? updated : c)),
      dirtyCategoryIds: addUniqueId(state.dirtyCategoryIds, categoryId),
    },
  };
}

export function removeCategory(
  state: LocalWorkspaceState,
  categoryId: string,
  now: number,
): LocalWorkspaceState {
  const cascaded = deleteCategoryCascade(categoryId, now, state.categories, state.elements);
  let dirtyElementIds = [...state.dirtyElementIds];
  for (const elId of cascaded.changedElementIds) {
    dirtyElementIds = addUniqueId(dirtyElementIds, elId);
  }
  return {
    ...state,
    categories: cascaded.categories,
    elements: cascaded.elements,
    dirtyCategoryIds: addUniqueId(state.dirtyCategoryIds, categoryId),
    dirtyElementIds,
  };
}

export function addElement(
  state: LocalWorkspaceState,
  input: { id: string; categoryId: string; label: string; value: string },
  now: number,
): ValidationResult<LocalWorkspaceState> {
  const parent = state.categories.find((c) => c.id === input.categoryId && c.deletedAt === null);
  if (parent === undefined) {
    return { ok: false, error: 'Parent category not found' };
  }
  const validated = validateElementInput(input, state.elements);
  if (!validated.ok) return validated;

  const nextSortOrder =
    state.elements
      .filter((e) => e.categoryId === input.categoryId)
      .reduce((max, e) => (e.sortOrder > max ? e.sortOrder : max), -1) + 1;

  const newElement: PromptElement = {
    id: input.id,
    categoryId: input.categoryId,
    label: validated.data.label,
    value: validated.data.value,
    sortOrder: nextSortOrder,
    updatedAt: now,
    deletedAt: null,
  };

  // Core review finding #1: adding an element to an untouched seed category (updatedAt === 0)
  // touches the category so it is marked active during account merge.
  const categories = state.categories.map((c) =>
    c.id === parent.id && c.updatedAt === 0 ? { ...c, updatedAt: now } : c,
  );
  const dirtyCategoryIds =
    parent.updatedAt === 0
      ? addUniqueId(state.dirtyCategoryIds, parent.id)
      : [...state.dirtyCategoryIds];

  return {
    ok: true,
    data: {
      ...state,
      categories,
      elements: [...state.elements, newElement],
      dirtyCategoryIds,
      dirtyElementIds: addUniqueId(state.dirtyElementIds, newElement.id),
    },
  };
}

export function updateElement(
  state: LocalWorkspaceState,
  elementId: string,
  input: { label: string; value: string },
  now: number,
): ValidationResult<LocalWorkspaceState> {
  const existing = state.elements.find((e) => e.id === elementId && e.deletedAt === null);
  if (existing === undefined) {
    return { ok: false, error: 'Element not found' };
  }
  const validated = validateElementInput(input, state.elements, elementId);
  if (!validated.ok) return validated;

  const updated: PromptElement = {
    ...existing,
    label: validated.data.label,
    value: validated.data.value,
    updatedAt: Math.max(existing.updatedAt + 1, now),
  };

  return {
    ok: true,
    data: {
      ...state,
      elements: state.elements.map((e) => (e.id === elementId ? updated : e)),
      dirtyElementIds: addUniqueId(state.dirtyElementIds, elementId),
    },
  };
}

export function removeElement(
  state: LocalWorkspaceState,
  elementId: string,
  now: number,
): LocalWorkspaceState {
  return {
    ...state,
    elements: state.elements.map((e) =>
      e.id === elementId && e.deletedAt === null
        ? { ...e, deletedAt: now, updatedAt: Math.max(e.updatedAt, now) }
        : e,
    ),
    dirtyElementIds: addUniqueId(state.dirtyElementIds, elementId),
  };
}

export function addTemplate(
  state: LocalWorkspaceState,
  input: { id: string; name: string; content: string },
  now: number,
): ValidationResult<LocalWorkspaceState> {
  const validated = validateTemplateInput(input, state.templates);
  if (!validated.ok) return validated;

  const nextSortOrder =
    state.templates.reduce((max, t) => (t.sortOrder > max ? t.sortOrder : max), -1) + 1;
  const newTemplate: PromptTemplate = {
    id: input.id,
    name: validated.data.name,
    content: validated.data.content,
    sortOrder: nextSortOrder,
    updatedAt: now,
    deletedAt: null,
  };

  return {
    ok: true,
    data: {
      ...state,
      templates: [...state.templates, newTemplate],
      dirtyTemplateIds: addUniqueId(state.dirtyTemplateIds, newTemplate.id),
    },
  };
}

export function updateTemplate(
  state: LocalWorkspaceState,
  templateId: string,
  input: { name: string; content: string },
  now: number,
): ValidationResult<LocalWorkspaceState> {
  const existing = state.templates.find((t) => t.id === templateId && t.deletedAt === null);
  if (existing === undefined) {
    return { ok: false, error: 'Template not found' };
  }
  const validated = validateTemplateInput(input, state.templates, templateId);
  if (!validated.ok) return validated;

  const updated: PromptTemplate = {
    ...existing,
    name: validated.data.name,
    content: validated.data.content,
    updatedAt: Math.max(existing.updatedAt + 1, now),
  };

  return {
    ok: true,
    data: {
      ...state,
      templates: state.templates.map((t) => (t.id === templateId ? updated : t)),
      dirtyTemplateIds: addUniqueId(state.dirtyTemplateIds, templateId),
    },
  };
}

export function removeTemplate(
  state: LocalWorkspaceState,
  templateId: string,
  now: number,
): LocalWorkspaceState {
  return {
    ...state,
    templates: state.templates.map((t) =>
      t.id === templateId && t.deletedAt === null
        ? { ...t, deletedAt: now, updatedAt: Math.max(t.updatedAt, now) }
        : t,
    ),
    dirtyTemplateIds: addUniqueId(state.dirtyTemplateIds, templateId),
  };
}

export type AccountReconciliation =
  | { kind: 'ready'; state: LocalWorkspaceState }
  | { kind: 'conflict_unsynced_previous_user'; previousUserId: string; newUserId: string };

/**
 * Reconciles local workspace state when an authenticated user session `userId` is detected (§3.5):
 * - If `ownerUserId === null` (Guest Mode), marks all local records as dirty so they merge into `userId` on sync.
 * - If `ownerUserId === userId`, keeps state as is.
 * - If `ownerUserId !== userId`:
 *   - when there are no unsynced dirty edits, resets local cache to empty for `userId` (`lastSyncedSeq = 0`) so `userId`'s server data is pulled cleanly without leaking the previous user's data;
 *   - when there ARE unsynced dirty edits for `ownerUserId`, returns `'conflict_unsynced_previous_user'` so UI prompts the user before discarding.
 */
export function reconcileAuthenticatedUser(
  state: LocalWorkspaceState,
  userId: string,
): AccountReconciliation {
  if (state.ownerUserId === null) {
    return {
      kind: 'ready',
      state: {
        ...state,
        ownerUserId: userId,
        lastSyncedSeq: 0,
        dirtyCategoryIds: state.categories.map((c) => c.id),
        dirtyElementIds: state.elements.map((e) => e.id),
        dirtyTemplateIds: state.templates.map((t) => t.id),
      },
    };
  }

  if (state.ownerUserId === userId) {
    return { kind: 'ready', state };
  }

  if (hasUnsyncedChanges(state)) {
    return {
      kind: 'conflict_unsynced_previous_user',
      previousUserId: state.ownerUserId,
      newUserId: userId,
    };
  }

  return {
    kind: 'ready',
    state: {
      ownerUserId: userId,
      lastSyncedSeq: 0,
      categories: [],
      elements: [],
      templates: [],
      dirtyCategoryIds: [],
      dirtyElementIds: [],
      dirtyTemplateIds: [],
    },
  };
}

export function forceSwitchToUser(userId: string): LocalWorkspaceState {
  return {
    ownerUserId: userId,
    lastSyncedSeq: 0,
    categories: [],
    elements: [],
    templates: [],
    dirtyCategoryIds: [],
    dirtyElementIds: [],
    dirtyTemplateIds: [],
  };
}

export function applySyncResponse(
  state: LocalWorkspaceState,
  sentCategoryIds: readonly string[],
  sentElementIds: readonly string[],
  sentTemplateIds: readonly string[],
  response: SyncResponse,
): LocalWorkspaceState {
  const catMap = new Map(state.categories.map((c) => [c.id, c]));
  for (const c of response.categories) {
    catMap.set(c.id, c);
  }

  const elMap = new Map(state.elements.map((e) => [e.id, e]));
  for (const e of response.elements) {
    elMap.set(e.id, e);
  }

  const tmplMap = new Map(state.templates.map((t) => [t.id, t]));
  for (const t of response.templates) {
    tmplMap.set(t.id, t);
  }

  const sentCats = new Set(sentCategoryIds);
  const sentEls = new Set(sentElementIds);
  const sentTmpls = new Set(sentTemplateIds);

  return {
    ...state,
    lastSyncedSeq: response.serverSeq,
    categories: [...catMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    elements: [...elMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    templates: [...tmplMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    dirtyCategoryIds: state.dirtyCategoryIds.filter((id) => !sentCats.has(id)),
    dirtyElementIds: state.dirtyElementIds.filter((id) => !sentEls.has(id)),
    dirtyTemplateIds: state.dirtyTemplateIds.filter((id) => !sentTmpls.has(id)),
  };
}
