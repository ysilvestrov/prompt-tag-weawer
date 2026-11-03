import {
  LIMITS,
  type Category,
  type PromptElement,
  type PromptTemplate,
  type SelectionMode,
  type SyncRequest,
} from './types.ts';

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: string };

export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function isNonEmptyId(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length >= 1 && v.length <= LIMITS.maxNameLength;
}

function isSelectionMode(v: unknown): v is SelectionMode {
  return v === 'single' || v === 'multi';
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

export function validateCategoryInput(
  input: { name: string; selectionMode: SelectionMode },
  existingCategories: readonly Category[],
  editingId?: string,
): ValidationResult<{ name: string; selectionMode: SelectionMode }> {
  const trimmed = input.name.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Category name is required' };
  }
  if (trimmed.length > LIMITS.maxNameLength) {
    return { ok: false, error: `Category name must be at most ${LIMITS.maxNameLength} characters` };
  }
  if (!isSelectionMode(input.selectionMode)) {
    return { ok: false, error: 'Selection mode must be single or multi' };
  }
  const activeCategories = existingCategories.filter((c) => c.deletedAt === null && c.id !== editingId);
  if (editingId === undefined && activeCategories.length >= LIMITS.maxCategories) {
    return { ok: false, error: `Maximum of ${LIMITS.maxCategories} categories reached` };
  }
  const norm = normalizeName(trimmed);
  if (activeCategories.some((c) => normalizeName(c.name) === norm)) {
    return { ok: false, error: `Category "${trimmed}" already exists` };
  }
  return { ok: true, data: { name: trimmed, selectionMode: input.selectionMode } };
}

export function validateElementInput(
  input: { label: string; value: string },
  existingElements: readonly PromptElement[],
  editingId?: string,
): ValidationResult<{ label: string; value: string }> {
  const label = input.label.trim();
  const value = input.value.trim();
  if (label.length === 0) {
    return { ok: false, error: 'Element label is required' };
  }
  if (label.length > LIMITS.maxNameLength) {
    return { ok: false, error: `Element label must be at most ${LIMITS.maxNameLength} characters` };
  }
  if (value.length === 0) {
    return { ok: false, error: 'Element value is required' };
  }
  if (value.length > LIMITS.maxValueLength) {
    return { ok: false, error: `Element value must be at most ${LIMITS.maxValueLength} characters` };
  }
  const activeCount = existingElements.filter((e) => e.deletedAt === null && e.id !== editingId).length;
  if (editingId === undefined && activeCount >= LIMITS.maxElements) {
    return { ok: false, error: `Maximum of ${LIMITS.maxElements} elements reached` };
  }
  return { ok: true, data: { label, value } };
}

export function validateTemplateInput(
  input: { name: string; content: string },
  existingTemplates: readonly PromptTemplate[],
  editingId?: string,
): ValidationResult<{ name: string; content: string }> {
  const name = input.name.trim();
  const content = input.content;
  if (name.length === 0) {
    return { ok: false, error: 'Template name is required' };
  }
  if (name.length > LIMITS.maxNameLength) {
    return { ok: false, error: `Template name must be at most ${LIMITS.maxNameLength} characters` };
  }
  if (content.length > LIMITS.maxValueLength) {
    return { ok: false, error: `Template content must be at most ${LIMITS.maxValueLength} characters` };
  }
  const activeCount = existingTemplates.filter((t) => t.deletedAt === null && t.id !== editingId).length;
  if (editingId === undefined && activeCount >= LIMITS.maxTemplates) {
    return { ok: false, error: `Maximum of ${LIMITS.maxTemplates} templates reached` };
  }
  return { ok: true, data: { name, content } };
}

function parseCategoryRecord(raw: unknown): ValidationResult<Category> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Category must be an object' };
  }
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyId(r.id)) return { ok: false, error: 'Invalid category id' };
  if (typeof r.name !== 'string') return { ok: false, error: 'Invalid category name' };
  const name = r.name.trim();
  if (name.length === 0 || name.length > LIMITS.maxNameLength) {
    return { ok: false, error: 'Category name length out of bounds' };
  }
  if (!isSelectionMode(r.selectionMode)) return { ok: false, error: 'Invalid category selectionMode' };
  if (!isSafeInt(r.sortOrder)) return { ok: false, error: 'Invalid category sortOrder' };
  if (!isNonNegativeInt(r.updatedAt)) return { ok: false, error: 'Invalid category updatedAt' };
  if (r.deletedAt !== null && !isNonNegativeInt(r.deletedAt)) {
    return { ok: false, error: 'Invalid category deletedAt' };
  }
  return {
    ok: true,
    data: {
      id: r.id,
      name,
      selectionMode: r.selectionMode,
      sortOrder: r.sortOrder,
      updatedAt: r.updatedAt,
      deletedAt: r.deletedAt,
    },
  };
}

function parseElementRecord(raw: unknown): ValidationResult<PromptElement> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Element must be an object' };
  }
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyId(r.id)) return { ok: false, error: 'Invalid element id' };
  if (!isNonEmptyId(r.categoryId)) return { ok: false, error: 'Invalid element categoryId' };
  if (typeof r.label !== 'string') return { ok: false, error: 'Invalid element label' };
  const label = r.label.trim();
  if (label.length === 0 || label.length > LIMITS.maxNameLength) {
    return { ok: false, error: 'Element label length out of bounds' };
  }
  if (typeof r.value !== 'string' || r.value.length > LIMITS.maxValueLength) {
    return { ok: false, error: 'Element value length out of bounds' };
  }
  if (r.deletedAt === null && r.value.trim().length === 0) {
    return { ok: false, error: 'Active element value cannot be empty' };
  }
  if (!isSafeInt(r.sortOrder)) return { ok: false, error: 'Invalid element sortOrder' };
  if (!isNonNegativeInt(r.updatedAt)) return { ok: false, error: 'Invalid element updatedAt' };
  if (r.deletedAt !== null && !isNonNegativeInt(r.deletedAt)) {
    return { ok: false, error: 'Invalid element deletedAt' };
  }
  return {
    ok: true,
    data: {
      id: r.id,
      categoryId: r.categoryId,
      label,
      value: r.value,
      sortOrder: r.sortOrder,
      updatedAt: r.updatedAt,
      deletedAt: r.deletedAt,
    },
  };
}

function parseTemplateRecord(raw: unknown): ValidationResult<PromptTemplate> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Template must be an object' };
  }
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyId(r.id)) return { ok: false, error: 'Invalid template id' };
  if (typeof r.name !== 'string') return { ok: false, error: 'Invalid template name' };
  const name = r.name.trim();
  if (name.length === 0 || name.length > LIMITS.maxNameLength) {
    return { ok: false, error: 'Template name length out of bounds' };
  }
  if (typeof r.content !== 'string' || r.content.length > LIMITS.maxValueLength) {
    return { ok: false, error: 'Template content length out of bounds' };
  }
  if (!isSafeInt(r.sortOrder)) return { ok: false, error: 'Invalid template sortOrder' };
  if (!isNonNegativeInt(r.updatedAt)) return { ok: false, error: 'Invalid template updatedAt' };
  if (r.deletedAt !== null && !isNonNegativeInt(r.deletedAt)) {
    return { ok: false, error: 'Invalid template deletedAt' };
  }
  return {
    ok: true,
    data: {
      id: r.id,
      name,
      content: r.content,
      sortOrder: r.sortOrder,
      updatedAt: r.updatedAt,
      deletedAt: r.deletedAt,
    },
  };
}

export function validateSyncRequest(body: unknown): ValidationResult<SyncRequest> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Sync request body must be an object' };
  }
  const b = body as Record<string, unknown>;
  if (!isNonNegativeInt(b.sinceSeq)) {
    return { ok: false, error: 'sinceSeq must be a non-negative integer' };
  }
  if (!Array.isArray(b.categories) || !Array.isArray(b.elements) || !Array.isArray(b.templates)) {
    return { ok: false, error: 'categories, elements, and templates must be arrays' };
  }
  const totalCount = b.categories.length + b.elements.length + b.templates.length;
  if (totalCount > LIMITS.maxSyncBatch) {
    return { ok: false, error: `Sync batch exceeds maximum of ${LIMITS.maxSyncBatch} records` };
  }

  const categories: Category[] = [];
  for (const item of b.categories) {
    const parsed = parseCategoryRecord(item);
    if (!parsed.ok) return parsed;
    categories.push(parsed.data);
  }

  const elements: PromptElement[] = [];
  for (const item of b.elements) {
    const parsed = parseElementRecord(item);
    if (!parsed.ok) return parsed;
    elements.push(parsed.data);
  }

  const templates: PromptTemplate[] = [];
  for (const item of b.templates) {
    const parsed = parseTemplateRecord(item);
    if (!parsed.ok) return parsed;
    templates.push(parsed.data);
  }

  return {
    ok: true,
    data: {
      sinceSeq: b.sinceSeq,
      categories,
      elements,
      templates,
    },
  };
}
