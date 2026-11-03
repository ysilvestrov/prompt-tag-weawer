export type SelectionMode = 'single' | 'multi';

export interface Category {
  id: string;
  name: string;
  selectionMode: SelectionMode;
  sortOrder: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface PromptElement {
  id: string;
  categoryId: string;
  label: string;
  value: string;
  sortOrder: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  sortOrder: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface LibrarySnapshot {
  categories: Category[];
  elements: PromptElement[];
  templates: PromptTemplate[];
}

export interface SyncRequest {
  sinceSeq: number;
  categories: Category[];
  elements: PromptElement[];
  templates: PromptTemplate[];
}

export interface SyncResponse {
  serverSeq: number;
  categories: Category[];
  elements: PromptElement[];
  templates: PromptTemplate[];
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  picture: string | null;
}

export interface AuthMeResponse {
  user: AuthUser | null;
}

export interface AuthProvidersResponse {
  googleEnabled: boolean;
}

export interface LocalWorkspaceState {
  ownerUserId: string | null;
  lastSyncedSeq: number;
  categories: Category[];
  elements: PromptElement[];
  templates: PromptTemplate[];
  dirtyCategoryIds: string[];
  dirtyElementIds: string[];
  dirtyTemplateIds: string[];
}

export const LIMITS = {
  maxCategories: 100,
  maxElements: 500,
  maxTemplates: 100,
  maxNameLength: 120,
  maxValueLength: 10_000,
  maxSyncBatch: 1000,
  clientSyncChunkSize: 500,
} as const;
