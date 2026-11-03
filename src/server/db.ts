import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mergeLibraries } from '../shared/merge.ts';
import {
  LIMITS,
  type AuthUser,
  type Category,
  type LibrarySnapshot,
  type PromptElement,
  type PromptTemplate,
  type SelectionMode,
  type SyncRequest,
  type SyncResponse,
} from '../shared/types.ts';

export interface StoredUser extends AuthUser {
  lastSeq: number;
}

export interface AppDatabase {
  readonly sqlite: DatabaseSync;
  upsertGoogleUser(
    profile: { sub: string; email: string; name: string; picture: string | null },
    now: number,
  ): AuthUser;
  getUserById(userId: string): StoredUser | null;
  getUserLibrary(userId: string): LibrarySnapshot;
  syncUserLibrary(
    userId: string,
    request: SyncRequest,
    serverNow: number,
  ): { ok: true; response: SyncResponse } | { ok: false; error: string };
  close(): void;
}

interface CategoryRow {
  id: string;
  name: string;
  selection_mode: string;
  sort_order: number;
  updated_at: number;
  deleted_at: number | null;
  server_seq: number;
}

interface ElementRow {
  id: string;
  category_id: string;
  label: string;
  value: string;
  sort_order: number;
  updated_at: number;
  deleted_at: number | null;
  server_seq: number;
}

interface TemplateRow {
  id: string;
  name: string;
  content: string;
  sort_order: number;
  updated_at: number;
  deleted_at: number | null;
  server_seq: number;
}

function rowToCategory(r: CategoryRow): Category {
  return {
    id: r.id,
    name: r.name,
    selectionMode: r.selection_mode as SelectionMode,
    sortOrder: Number(r.sort_order),
    updatedAt: Number(r.updated_at),
    deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
  };
}

function rowToElement(r: ElementRow): PromptElement {
  return {
    id: r.id,
    categoryId: r.category_id,
    label: r.label,
    value: r.value,
    sortOrder: Number(r.sort_order),
    updatedAt: Number(r.updated_at),
    deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
  };
}

function rowToTemplate(r: TemplateRow): PromptTemplate {
  return {
    id: r.id,
    name: r.name,
    content: r.content,
    sortOrder: Number(r.sort_order),
    updatedAt: Number(r.updated_at),
    deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
  };
}

export function createDatabase(dbPath = ':memory:'): AppDatabase {
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      google_sub TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      picture TEXT,
      last_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      selection_mode TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      server_seq INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS elements (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      server_seq INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS templates (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      server_seq INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
  `);

  const findUserBySubStmt = sqlite.prepare(
    'SELECT id, email, name, picture FROM users WHERE google_sub = ?',
  );
  const insertUserStmt = sqlite.prepare(
    'INSERT INTO users (id, google_sub, email, name, picture, last_seq, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  );
  const updateUserStmt = sqlite.prepare(
    'UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?',
  );
  const getUserByIdStmt = sqlite.prepare(
    'SELECT id, email, name, picture, last_seq FROM users WHERE id = ?',
  );
  const updateUserLastSeqStmt = sqlite.prepare('UPDATE users SET last_seq = ? WHERE id = ?');

  const selectCategoriesStmt = sqlite.prepare(
    'SELECT id, name, selection_mode, sort_order, updated_at, deleted_at, server_seq FROM categories WHERE user_id = ? ORDER BY id ASC',
  );
  const selectElementsStmt = sqlite.prepare(
    'SELECT id, category_id, label, value, sort_order, updated_at, deleted_at, server_seq FROM elements WHERE user_id = ? ORDER BY id ASC',
  );
  const selectTemplatesStmt = sqlite.prepare(
    'SELECT id, name, content, sort_order, updated_at, deleted_at, server_seq FROM templates WHERE user_id = ? ORDER BY id ASC',
  );

  const upsertCategoryStmt = sqlite.prepare(`
    INSERT INTO categories (user_id, id, name, selection_mode, sort_order, updated_at, deleted_at, server_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      name = excluded.name,
      selection_mode = excluded.selection_mode,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at,
      server_seq = excluded.server_seq
  `);

  const upsertElementStmt = sqlite.prepare(`
    INSERT INTO elements (user_id, id, category_id, label, value, sort_order, updated_at, deleted_at, server_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      category_id = excluded.category_id,
      label = excluded.label,
      value = excluded.value,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at,
      server_seq = excluded.server_seq
  `);

  const upsertTemplateStmt = sqlite.prepare(`
    INSERT INTO templates (user_id, id, name, content, sort_order, updated_at, deleted_at, server_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      name = excluded.name,
      content = excluded.content,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at,
      server_seq = excluded.server_seq
  `);

  return {
    sqlite,
    upsertGoogleUser(profile, now) {
      const existing = findUserBySubStmt.get(profile.sub) as
        | { id: string; email: string; name: string; picture: string | null }
        | undefined;
      if (existing !== undefined) {
        updateUserStmt.run(profile.email, profile.name, profile.picture, existing.id);
        return {
          id: existing.id,
          email: profile.email,
          name: profile.name,
          picture: profile.picture,
        };
      }
      const id = randomUUID();
      insertUserStmt.run(id, profile.sub, profile.email, profile.name, profile.picture, now);
      return {
        id,
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
      };
    },

    getUserById(userId) {
      const row = getUserByIdStmt.get(userId) as
        | { id: string; email: string; name: string; picture: string | null; last_seq: number }
        | undefined;
      if (row === undefined) return null;
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        picture: row.picture ?? null,
        lastSeq: Number(row.last_seq),
      };
    },

    getUserLibrary(userId) {
      const catRows = selectCategoriesStmt.all(userId) as unknown as CategoryRow[];
      const elRows = selectElementsStmt.all(userId) as unknown as ElementRow[];
      const tmplRows = selectTemplatesStmt.all(userId) as unknown as TemplateRow[];
      return {
        categories: catRows.map(rowToCategory),
        elements: elRows.map(rowToElement),
        templates: tmplRows.map(rowToTemplate),
      };
    },

    syncUserLibrary(userId, request, serverNow) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const user = this.getUserById(userId);
        if (user === null) {
          sqlite.exec('ROLLBACK');
          return { ok: false, error: 'User not found' };
        }

        const catRows = selectCategoriesStmt.all(userId) as unknown as CategoryRow[];
        const elRows = selectElementsStmt.all(userId) as unknown as ElementRow[];
        const tmplRows = selectTemplatesStmt.all(userId) as unknown as TemplateRow[];

        const existingSnapshot: LibrarySnapshot = {
          categories: catRows.map(rowToCategory),
          elements: elRows.map(rowToElement),
          templates: tmplRows.map(rowToTemplate),
        };

        const merged = mergeLibraries(
          existingSnapshot,
          {
            categories: request.categories,
            elements: request.elements,
            templates: request.templates,
          },
          serverNow,
          user.lastSeq > 0,
        );

        const activeCats = merged.snapshot.categories.filter((c) => c.deletedAt === null).length;
        if (activeCats > LIMITS.maxCategories) {
          sqlite.exec('ROLLBACK');
          return { ok: false, error: `Maximum of ${LIMITS.maxCategories} active categories exceeded` };
        }
        const activeEls = merged.snapshot.elements.filter((e) => e.deletedAt === null).length;
        if (activeEls > LIMITS.maxElements) {
          sqlite.exec('ROLLBACK');
          return { ok: false, error: `Maximum of ${LIMITS.maxElements} active elements exceeded` };
        }
        const activeTmpls = merged.snapshot.templates.filter((t) => t.deletedAt === null).length;
        if (activeTmpls > LIMITS.maxTemplates) {
          sqlite.exec('ROLLBACK');
          return { ok: false, error: `Maximum of ${LIMITS.maxTemplates} active templates exceeded` };
        }

        let seq = user.lastSeq;

        for (const cat of merged.snapshot.categories) {
          if (merged.touchedCategoryIds.has(cat.id)) {
            seq += 1;
            upsertCategoryStmt.run(
              userId,
              cat.id,
              cat.name,
              cat.selectionMode,
              cat.sortOrder,
              cat.updatedAt,
              cat.deletedAt,
              seq,
            );
          }
        }

        for (const el of merged.snapshot.elements) {
          if (merged.touchedElementIds.has(el.id)) {
            seq += 1;
            upsertElementStmt.run(
              userId,
              el.id,
              el.categoryId,
              el.label,
              el.value,
              el.sortOrder,
              el.updatedAt,
              el.deletedAt,
              seq,
            );
          }
        }

        for (const tmpl of merged.snapshot.templates) {
          if (merged.touchedTemplateIds.has(tmpl.id)) {
            seq += 1;
            upsertTemplateStmt.run(
              userId,
              tmpl.id,
              tmpl.name,
              tmpl.content,
              tmpl.sortOrder,
              tmpl.updatedAt,
              tmpl.deletedAt,
              seq,
            );
          }
        }

        if (seq !== user.lastSeq) {
          updateUserLastSeqStmt.run(seq, userId);
        }

        const requestedCatIds = new Set(request.categories.map((c) => c.id));
        const requestedElIds = new Set(request.elements.map((e) => e.id));
        const requestedTmplIds = new Set(request.templates.map((t) => t.id));

        const updatedCatRows = selectCategoriesStmt.all(userId) as unknown as CategoryRow[];
        const updatedElRows = selectElementsStmt.all(userId) as unknown as ElementRow[];
        const updatedTmplRows = selectTemplatesStmt.all(userId) as unknown as TemplateRow[];

        const deltaCategories = updatedCatRows
          .filter((r) => Number(r.server_seq) > request.sinceSeq || requestedCatIds.has(r.id))
          .map(rowToCategory);
        const deltaElements = updatedElRows
          .filter((r) => Number(r.server_seq) > request.sinceSeq || requestedElIds.has(r.id))
          .map(rowToElement);
        const deltaTemplates = updatedTmplRows
          .filter((r) => Number(r.server_seq) > request.sinceSeq || requestedTmplIds.has(r.id))
          .map(rowToTemplate);

        sqlite.exec('COMMIT');

        return {
          ok: true,
          response: {
            serverSeq: seq,
            categories: deltaCategories,
            elements: deltaElements,
            templates: deltaTemplates,
          },
        };
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },

    close() {
      sqlite.close();
    },
  };
}
