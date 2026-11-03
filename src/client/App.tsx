import React, { useEffect, useMemo, useState } from 'react';
import {
  assemblePrompt,
  resolveTemplateVariables,
  sortByOrderAndId,
} from '../shared/template-engine.ts';
import type {
  AuthMeResponse,
  AuthProvidersResponse,
  AuthUser,
  LocalWorkspaceState,
  SelectionMode,
  SyncRequest,
  SyncResponse,
} from '../shared/types.ts';
import {
  addCategory,
  addElement,
  addTemplate,
  createInitialGuestState,
  forceSwitchToUser,
  hasUnsyncedChanges,
  loadWorkspaceState,
  reconcileAuthenticatedUser,
  removeCategory,
  removeElement,
  removeTemplate,
  saveWorkspaceState,
  type SimpleStorage,
  updateCategory,
  updateElement,
  updateTemplate,
} from './storage.ts';
import { runSyncCycle } from './sync-client.ts';
import {
  loadThemeMode,
  resolveEffectiveTheme,
  saveThemeMode,
  type ThemeMode,
} from './theme.ts';

export type ActiveTab = 'generator' | 'categories' | 'templates';

export interface AppProps {
  storage?: SimpleStorage;
  fetchFn?: typeof fetch;
  nowFn?: () => number;
  idFn?: () => string;
  clipboardWrite?: (text: string) => Promise<void>;
}

export function App({
  storage = window.localStorage,
  fetchFn = window.fetch.bind(window),
  nowFn = () => Date.now(),
  idFn = () => crypto.randomUUID(),
  clipboardWrite = (text: string) => navigator.clipboard.writeText(text),
}: AppProps) {
  const [workspace, setWorkspace] = useState<LocalWorkspaceState>(() =>
    loadWorkspaceState(storage),
  );
  const [activeTab, setActiveTab] = useState<ActiveTab>('generator');
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode(storage));

  // Auth & sync state
  const [user, setUser] = useState<AuthUser | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'offline'>('idle');
  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState<boolean>(false);
  const [accountConflict, setAccountConflict] = useState<{
    previousUserId: string;
    newUserId: string;
  } | null>(null);

  // Generator state
  const activeTemplates = useMemo(
    () => sortByOrderAndId(workspace.templates.filter((t) => t.deletedAt === null)),
    [workspace.templates],
  );
  const activeCategories = useMemo(
    () => sortByOrderAndId(workspace.categories.filter((c) => c.deletedAt === null)),
    [workspace.categories],
  );
  const activeElements = useMemo(
    () => sortByOrderAndId(workspace.elements.filter((e) => e.deletedAt === null)),
    [workspace.elements],
  );

  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    () => activeTemplates[0]?.id ?? '',
  );
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  // Categories & Elements CRUD state
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(
    () => activeCategories[0]?.id ?? '',
  );
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryMode, setNewCategoryMode] = useState<SelectionMode>('single');
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  const [editingCategoryMode, setEditingCategoryMode] = useState<SelectionMode>('single');
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const [newElementLabel, setNewElementLabel] = useState('');
  const [newElementValue, setNewElementValue] = useState('');
  const [editingElementId, setEditingElementId] = useState<string | null>(null);
  const [editingElementLabel, setEditingElementLabel] = useState('');
  const [editingElementValue, setEditingElementValue] = useState('');
  const [elementError, setElementError] = useState<string | null>(null);

  // Templates CRUD state
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateContent, setNewTemplateContent] = useState('');
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editingTemplateName, setEditingTemplateName] = useState('');
  const [editingTemplateContent, setEditingTemplateContent] = useState('');
  const [templateError, setTemplateError] = useState<string | null>(null);

  const commitWorkspace = (next: LocalWorkspaceState) => {
    setWorkspace(next);
    saveWorkspaceState(storage, next);
  };

  // Apply theme
  useEffect(() => {
    saveThemeMode(storage, themeMode);
    const prefersDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = resolveEffectiveTheme(themeMode, prefersDark);
    document.documentElement.classList.toggle('dark', effective === 'dark');
  }, [themeMode, storage]);

  const performSync = async (stateToSync: LocalWorkspaceState) => {
    setSyncStatus('syncing');
    try {
      const next = await runSyncCycle(stateToSync, async (req: SyncRequest) => {
        const res = await fetchFn('/api/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        });
        if (!res.ok) {
          throw new Error(`Sync failed: ${res.status}`);
        }
        return (await res.json()) as SyncResponse;
      });
      commitWorkspace(next);
      setSyncStatus('synced');
    } catch {
      setSyncStatus('offline');
    }
  };

  // Check auth session and providers on mount
  useEffect(() => {
    let cancelled = false;
    const initAuth = async () => {
      try {
        const [provRes, meRes] = await Promise.all([
          fetchFn('/api/auth/providers'),
          fetchFn('/api/auth/me'),
        ]);
        if (cancelled) return;
        if (provRes.ok) {
          const prov = (await provRes.json()) as AuthProvidersResponse;
          setGoogleEnabled(prov.googleEnabled);
        }
        if (meRes.ok) {
          const me = (await meRes.json()) as AuthMeResponse;
          setUser(me.user);
          if (me.user !== null) {
            const current = loadWorkspaceState(storage);
            const rec = reconcileAuthenticatedUser(current, me.user.id);
            if (rec.kind === 'conflict_unsynced_previous_user') {
              setAccountConflict({
                previousUserId: rec.previousUserId,
                newUserId: rec.newUserId,
              });
            } else {
              commitWorkspace(rec.state);
              await performSync(rec.state);
            }
          }
        }
      } catch {
        // Offline guest mode works without server reachability
      }
    };
    void initAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  const currentTemplate =
    activeTemplates.find((t) => t.id === selectedTemplateId) ?? activeTemplates[0] ?? null;

  const resolvedVariables = useMemo(
    () =>
      currentTemplate
        ? resolveTemplateVariables(currentTemplate.content, activeCategories, activeElements)
        : [],
    [currentTemplate, activeCategories, activeElements],
  );

  const assembledPrompt = useMemo(
    () =>
      currentTemplate
        ? assemblePrompt(
            currentTemplate.content,
            activeCategories,
            activeElements,
            selections,
            freeText,
          )
        : '',
    [currentTemplate, activeCategories, activeElements, selections, freeText],
  );

  const toggleElementSelection = (
    normalizedVarName: string,
    elementId: string,
    mode: SelectionMode,
  ) => {
    setSelections((prev) => {
      const current = prev[normalizedVarName] ?? [];
      const exists = current.includes(elementId);
      if (mode === 'single') {
        return {
          ...prev,
          [normalizedVarName]: exists ? [] : [elementId],
        };
      }
      return {
        ...prev,
        [normalizedVarName]: exists
          ? current.filter((id) => id !== elementId)
          : [...current, elementId],
      };
    });
  };

  const handleCopyPrompt = async () => {
    try {
      await clipboardWrite(assembledPrompt);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  };

  const mutateAndMaybeSync = (nextState: LocalWorkspaceState) => {
    commitWorkspace(nextState);
    if (user !== null && accountConflict === null) {
      void performSync(nextState);
    }
  };

  // Category CRUD handlers
  const handleAddCategory = (e: React.FormEvent) => {
    e.preventDefault();
    const res = addCategory(
      workspace,
      { id: idFn(), name: newCategoryName, selectionMode: newCategoryMode },
      nowFn(),
    );
    if (!res.ok) {
      setCategoryError(res.error);
      return;
    }
    setCategoryError(null);
    setNewCategoryName('');
    const created = res.data.categories[res.data.categories.length - 1];
    if (created !== undefined) {
      setSelectedCategoryId(created.id);
    }
    mutateAndMaybeSync(res.data);
  };

  const handleSaveCategoryEdit = (categoryId: string) => {
    const res = updateCategory(
      workspace,
      categoryId,
      { name: editingCategoryName, selectionMode: editingCategoryMode },
      nowFn(),
    );
    if (!res.ok) {
      setCategoryError(res.error);
      return;
    }
    setCategoryError(null);
    setEditingCategoryId(null);
    mutateAndMaybeSync(res.data);
  };

  const handleDeleteCategory = (categoryId: string) => {
    const next = removeCategory(workspace, categoryId, nowFn());
    mutateAndMaybeSync(next);
    if (selectedCategoryId === categoryId) {
      const remaining = next.categories.filter((c) => c.deletedAt === null);
      setSelectedCategoryId(remaining[0]?.id ?? '');
    }
  };

  // Element CRUD handlers
  const effectiveSelectedCategoryId =
    activeCategories.find((c) => c.id === selectedCategoryId)?.id ?? activeCategories[0]?.id ?? '';

  const handleAddElement = (e: React.FormEvent) => {
    e.preventDefault();
    const res = addElement(
      workspace,
      {
        id: idFn(),
        categoryId: effectiveSelectedCategoryId,
        label: newElementLabel,
        value: newElementValue,
      },
      nowFn(),
    );
    if (!res.ok) {
      setElementError(res.error);
      return;
    }
    setElementError(null);
    setNewElementLabel('');
    setNewElementValue('');
    mutateAndMaybeSync(res.data);
  };

  const handleSaveElementEdit = (elementId: string) => {
    const res = updateElement(
      workspace,
      elementId,
      { label: editingElementLabel, value: editingElementValue },
      nowFn(),
    );
    if (!res.ok) {
      setElementError(res.error);
      return;
    }
    setElementError(null);
    setEditingElementId(null);
    mutateAndMaybeSync(res.data);
  };

  const handleDeleteElement = (elementId: string) => {
    const next = removeElement(workspace, elementId, nowFn());
    mutateAndMaybeSync(next);
  };

  // Template CRUD handlers
  const handleAddTemplate = (e: React.FormEvent) => {
    e.preventDefault();
    const res = addTemplate(
      workspace,
      { id: idFn(), name: newTemplateName, content: newTemplateContent },
      nowFn(),
    );
    if (!res.ok) {
      setTemplateError(res.error);
      return;
    }
    setTemplateError(null);
    setNewTemplateName('');
    setNewTemplateContent('');
    const created = res.data.templates[res.data.templates.length - 1];
    if (created !== undefined) {
      setSelectedTemplateId(created.id);
    }
    mutateAndMaybeSync(res.data);
  };

  const handleSaveTemplateEdit = (templateId: string) => {
    const res = updateTemplate(
      workspace,
      templateId,
      { name: editingTemplateName, content: editingTemplateContent },
      nowFn(),
    );
    if (!res.ok) {
      setTemplateError(res.error);
      return;
    }
    setTemplateError(null);
    setEditingTemplateId(null);
    mutateAndMaybeSync(res.data);
  };

  const handleDeleteTemplate = (templateId: string) => {
    const next = removeTemplate(workspace, templateId, nowFn());
    mutateAndMaybeSync(next);
  };

  // Logout & account conflict handlers
  const executeLogout = async () => {
    try {
      await fetchFn('/api/auth/logout', { method: 'POST' });
    } catch {
      // Proceed with local cleanup even if offline
    }
    const freshGuest = createInitialGuestState();
    commitWorkspace(freshGuest);
    setUser(null);
    setConfirmLogoutOpen(false);
    setAccountConflict(null);
    setSyncStatus('idle');
  };

  const handleLogoutClick = () => {
    if (hasUnsyncedChanges(workspace)) {
      setConfirmLogoutOpen(true);
    } else {
      void executeLogout();
    }
  };

  const handleDiscardAndSwitchUser = async () => {
    if (accountConflict === null) return;
    const switched = forceSwitchToUser(accountConflict.newUserId);
    setAccountConflict(null);
    commitWorkspace(switched);
    await performSync(switched);
  };

  const handleKeepLocalAndSignOutNewUser = async () => {
    try {
      await fetchFn('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore offline
    }
    setUser(null);
    setAccountConflict(null);
  };

  const selectedCategoryElements = activeElements.filter(
    (e) => e.categoryId === effectiveSelectedCategoryId,
  );

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 pb-20">
      {/* Top Header */}
      <header className="sticky top-0 z-20 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-4 py-3">
        <div className="max-w-3xl mx-auto flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold tracking-tight">Prompt Tag Weaver</h1>
            <div className="text-xs text-slate-500 dark:text-slate-400" data-testid="auth-status-badge">
              {user === null
                ? 'Offline Guest Mode'
                : syncStatus === 'syncing'
                  ? `Signed in as ${user.name} · Syncing…`
                  : syncStatus === 'offline' || hasUnsyncedChanges(workspace)
                    ? `Signed in as ${user.name} · Offline — changes saved locally`
                    : `Signed in as ${user.name} · Synced`}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Theme selector */}
            <div className="inline-flex rounded-lg border border-slate-300 dark:border-slate-700 p-0.5 bg-slate-100 dark:bg-slate-800">
              {(['light', 'dark', 'system'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setThemeMode(mode)}
                  aria-pressed={themeMode === mode}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md capitalize transition ${
                    themeMode === mode
                      ? 'bg-white dark:bg-slate-950 text-sky-600 dark:text-sky-400 shadow-xs'
                      : 'text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>

            {user === null ? (
              googleEnabled ? (
                <a
                  href="/api/auth/google"
                  className="min-h-10 inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 text-white hover:bg-sky-500"
                >
                  Sign in with Google
                </a>
              ) : (
                <button
                  type="button"
                  disabled
                  title="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on server"
                  className="min-h-10 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-200 dark:bg-slate-800 text-slate-500 cursor-not-allowed"
                >
                  Sign in with Google
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={handleLogoutClick}
                className="min-h-10 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Log Out
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Modals for unsynced data protection */}
      {confirmLogoutOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="max-w-md w-full rounded-xl bg-white dark:bg-slate-900 p-5 shadow-xl border border-slate-200 dark:border-slate-800 space-y-4">
            <h2 className="text-base font-bold">Unsynchronized Changes</h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              You have local offline edits that have not been synchronized with the server yet.
              Logging out will reset local storage to a clean guest state and discard these edits.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmLogoutOpen(false)}
                className="min-h-12 px-4 rounded-lg border border-slate-300 dark:border-slate-700 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void executeLogout()}
                className="min-h-12 px-4 rounded-lg bg-rose-600 text-white text-sm font-semibold"
              >
                Confirm Log Out
              </button>
            </div>
          </div>
        </div>
      )}

      {accountConflict !== null && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="max-w-md w-full rounded-xl bg-white dark:bg-slate-900 p-5 shadow-xl border border-slate-200 dark:border-slate-800 space-y-4">
            <h2 className="text-base font-bold">Account Switch Conflict</h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              This browser has unsynchronized offline changes belonging to a previous account. To
              prevent data leaks across accounts, choose whether to keep the local data (and sign
              out of the new account) or discard the previous account&apos;s unsynchronized edits.
            </p>
            <div className="flex flex-col sm:flex-row justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleKeepLocalAndSignOutNewUser()}
                className="min-h-12 px-4 rounded-lg border border-slate-300 dark:border-slate-700 text-sm font-medium"
              >
                Keep Local Data &amp; Sign Out
              </button>
              <button
                type="button"
                onClick={() => void handleDiscardAndSwitchUser()}
                className="min-h-12 px-4 rounded-lg bg-rose-600 text-white text-sm font-semibold"
              >
                Discard Unsaved Edits &amp; Switch
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 max-w-3xl w-full mx-auto p-4 space-y-6">
        {activeTab === 'generator' && (
          <section className="space-y-5" aria-label="Prompt Generator">
            {/* Template selector */}
            <div className="rounded-xl bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 space-y-2">
              <label
                htmlFor="template-select"
                className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
              >
                Active Template
              </label>
              {activeTemplates.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No templates available. Create one in the Templates tab.
                </p>
              ) : (
                <select
                  id="template-select"
                  value={currentTemplate?.id ?? ''}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                  className="w-full min-h-12 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 text-sm font-medium"
                >
                  {activeTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
              {currentTemplate !== null && (
                <p className="text-xs font-mono text-slate-500 dark:text-slate-400 break-words">
                  {currentTemplate.content}
                </p>
              )}
            </div>

            {/* Dynamic Variable Controls */}
            {currentTemplate !== null && (
              <div className="space-y-4">
                {resolvedVariables.map((variable) => (
                  <div
                    key={variable.normalizedName}
                    className="rounded-xl bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold">[{variable.rawName}]</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                        {variable.kind === 'category'
                          ? `${variable.selectionMode === 'single' ? 'Single' : 'Multi'} select`
                          : 'Free text'}
                      </span>
                    </div>

                    {variable.kind === 'category' ? (
                      variable.elements.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          No elements in category &ldquo;{variable.categoryName}&rdquo; yet.
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {variable.elements.map((el) => {
                            const isSelected = (
                              selections[variable.normalizedName] ?? []
                            ).includes(el.id);
                            return (
                              <button
                                key={el.id}
                                type="button"
                                aria-pressed={isSelected}
                                onClick={() =>
                                  toggleElementSelection(
                                    variable.normalizedName,
                                    el.id,
                                    variable.selectionMode,
                                  )
                                }
                                className={`min-h-12 px-4 py-2 rounded-xl text-sm font-medium transition border ${
                                  isSelected
                                    ? 'bg-sky-600 text-white border-sky-600 shadow-xs'
                                    : 'bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 border-slate-300 dark:border-slate-700 hover:border-sky-400'
                                }`}
                              >
                                {el.label}
                              </button>
                            );
                          })}
                        </div>
                      )
                    ) : (
                      <input
                        type="text"
                        aria-label={`Free text for ${variable.rawName}`}
                        placeholder={`Enter value for [${variable.rawName}]...`}
                        value={freeText[variable.normalizedName] ?? ''}
                        onChange={(e) =>
                          setFreeText((prev) => ({
                            ...prev,
                            [variable.normalizedName]: e.target.value,
                          }))
                        }
                        className="w-full min-h-12 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 text-sm"
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Real-time Assembled Prompt & One-Tap Copy */}
            <div className="rounded-xl bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Assembled Prompt
                </h2>
              </div>
              <div
                data-testid="assembled-prompt"
                className="min-h-20 p-3 rounded-lg bg-slate-100 dark:bg-slate-950 font-mono text-sm whitespace-pre-wrap break-words"
              >
                {assembledPrompt}
              </div>
              <button
                type="button"
                onClick={() => void handleCopyPrompt()}
                className="w-full min-h-12 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-sm transition"
              >
                {copyStatus === 'copied'
                  ? 'Copied!'
                  : copyStatus === 'error'
                    ? 'Copy failed'
                    : 'Copy to Clipboard'}
              </button>
            </div>
          </section>
        )}

        {activeTab === 'categories' && (
          <section className="space-y-6" aria-label="Categories and Elements">
            {/* Create Category */}
            <form
              onSubmit={handleAddCategory}
              className="rounded-xl bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 space-y-3"
            >
              <h2 className="text-sm font-bold">New Category</h2>
              {categoryError !== null && (
                <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
                  {categoryError}
                </p>
              )}
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  aria-label="New category name"
                  placeholder="Category name (e.g. Lighting)"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  className="flex-1 min-h-12 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 text-sm"
                />
                <select
                  aria-label="New category selection mode"
                  value={newCategoryMode}
                  onChange={(e) => setNewCategoryMode(e.target.value as SelectionMode)}
                  className="min-h-12 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 text-sm"
                >
                  <option value="single">Single select</option>
                  <option value="multi">Multi select</option>
                </select>
                <button
                  type="submit"
                  className="min-h-12 px-4 rounded-lg bg-sky-600 text-white text-sm font-semibold"
                >
                  Add Category
                </button>
              </div>
            </form>

            {/* Category List */}
            <div className="rounded-xl bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 space-y-3">
              <h2 className="text-sm font-bold">Categories</h2>
              <div className="space-y-2">
                {activeCategories.map((cat) => {
                  const isCurrent = cat.id === effectiveSelectedCategoryId;
                  const isEditing = editingCategoryId === cat.id;
                  return (
                    <div
                      key={cat.id}
                      className={`p-3 rounded-lg border ${
                        isCurrent
                          ? 'border-sky-500 bg-sky-50/40 dark:bg-sky-950/20'
                          : 'border-slate-200 dark:border-slate-800'
                      }`}
                    >
                      {isEditing ? (
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            aria-label="Edit category name"
                            value={editingCategoryName}
                            onChange={(e) => setEditingCategoryName(e.target.value)}
                            className="flex-1 min-h-10 rounded-lg border border-slate-300 dark:border-slate-700 px-2 text-sm bg-white dark:bg-slate-950"
                          />
                          <select
                            aria-label="Edit category selection mode"
                            value={editingCategoryMode}
                            onChange={(e) =>
                              setEditingCategoryMode(e.target.value as SelectionMode)
                            }
                            className="min-h-10 rounded-lg border border-slate-300 dark:border-slate-700 px-2 text-sm bg-white dark:bg-slate-950"
                          >
                            <option value="single">Single</option>
                            <option value="multi">Multi</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => handleSaveCategoryEdit(cat.id)}
                            className="min-h-10 px-3 rounded-lg bg-sky-600 text-white text-xs font-semibold"
                          >
                            Save Category
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingCategoryId(null)}
                            className="min-h-10 px-3 rounded-lg border border-slate-300 dark:border-slate-700 text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => setSelectedCategoryId(cat.id)}
                            className="text-left flex-1 min-h-10 flex items-center gap-2"
                          >
                            <span className="font-semibold text-sm">{cat.name}</span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-800">
                              {cat.selectionMode}
                            </span>
                          </button>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingCategoryId(cat.id);
                                setEditingCategoryName(cat.name);
                                setEditingCategoryMode(cat.selectionMode);
                              }}
                              className="min-h-10 px-3 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete category ${cat.name}`}
                              onClick={() => handleDeleteCategory(cat.id)}
                              className="min-h-10 px-3 rounded-lg bg-rose-600/10 text-rose-600 dark:text-rose-400 text-xs font-medium"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Elements for Selected Category */}
            {effectiveSelectedCategoryId !== '' && (
              <div className="rounded-xl bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 space-y-4">
                <h2 className="text-sm font-bold">
                  Elements in &ldquo;
                  {activeCategories.find((c) => c.id === effectiveSelectedCategoryId)?.name}
                  &rdquo;
                </h2>
                {elementError !== null && (
                  <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
                    {elementError}
                  </p>
                )}

                <form onSubmit={handleAddElement} className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      type="text"
                      aria-label="New element label"
                      placeholder="Button label (e.g. Golden Hour)"
                      value={newElementLabel}
                      onChange={(e) => setNewElementLabel(e.target.value)}
                      className="min-h-12 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 text-sm"
                    />
                    <input
                      type="text"
                      aria-label="New element value"
                      placeholder="Prompt value (e.g. warm golden hour sunlight)"
                      value={newElementValue}
                      onChange={(e) => setNewElementValue(e.target.value)}
                      className="min-h-12 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 text-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    className="min-h-12 px-4 rounded-lg bg-sky-600 text-white text-sm font-semibold"
                  >
                    Add Element
                  </button>
                </form>

                <div className="space-y-2">
                  {selectedCategoryElements.map((el) => (
                    <div
                      key={el.id}
                      className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 space-y-2"
                    >
                      {editingElementId === el.id ? (
                        <div className="space-y-2">
                          <input
                            type="text"
                            aria-label="Edit element label"
                            value={editingElementLabel}
                            onChange={(e) => setEditingElementLabel(e.target.value)}
                            className="w-full min-h-10 rounded-lg border border-slate-300 dark:border-slate-700 px-2 text-sm bg-white dark:bg-slate-950"
                          />
                          <input
                            type="text"
                            aria-label="Edit element value"
                            value={editingElementValue}
                            onChange={(e) => setEditingElementValue(e.target.value)}
                            className="w-full min-h-10 rounded-lg border border-slate-300 dark:border-slate-700 px-2 text-sm bg-white dark:bg-slate-950"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => handleSaveElementEdit(el.id)}
                              className="min-h-10 px-3 rounded-lg bg-sky-600 text-white text-xs font-semibold"
                            >
                              Save Element
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingElementId(null)}
                              className="min-h-10 px-3 rounded-lg border border-slate-300 dark:border-slate-700 text-xs"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="font-semibold text-sm">{el.label}</div>
                            <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
                              {el.value}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingElementId(el.id);
                                setEditingElementLabel(el.label);
                                setEditingElementValue(el.value);
                              }}
                              className="min-h-10 px-3 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete element ${el.label}`}
                              onClick={() => handleDeleteElement(el.id)}
                              className="min-h-10 px-3 rounded-lg bg-rose-600/10 text-rose-600 dark:text-rose-400 text-xs font-medium"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {activeTab === 'templates' && (
          <section className="space-y-6" aria-label="Templates">
            <form
              onSubmit={handleAddTemplate}
              className="rounded-xl bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 space-y-3"
            >
              <h2 className="text-sm font-bold">New Template</h2>
              {templateError !== null && (
                <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
                  {templateError}
                </p>
              )}
              <input
                type="text"
                aria-label="New template name"
                placeholder="Template name"
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value)}
                className="w-full min-h-12 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 text-sm"
              />
              <textarea
                rows={3}
                aria-label="New template content"
                placeholder="Blueprint with [Category] placeholders..."
                value={newTemplateContent}
                onChange={(e) => setNewTemplateContent(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-3 text-sm font-mono"
              />
              <button
                type="submit"
                className="min-h-12 px-4 rounded-lg bg-sky-600 text-white text-sm font-semibold"
              >
                Add Template
              </button>
            </form>

            <div className="rounded-xl bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 space-y-3">
              <h2 className="text-sm font-bold">Saved Templates</h2>
              <div className="space-y-3">
                {activeTemplates.map((tmpl) => (
                  <div
                    key={tmpl.id}
                    className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 space-y-2"
                  >
                    {editingTemplateId === tmpl.id ? (
                      <div className="space-y-2">
                        <input
                          type="text"
                          aria-label="Edit template name"
                          value={editingTemplateName}
                          onChange={(e) => setEditingTemplateName(e.target.value)}
                          className="w-full min-h-10 rounded-lg border border-slate-300 dark:border-slate-700 px-2 text-sm bg-white dark:bg-slate-950"
                        />
                        <textarea
                          rows={3}
                          aria-label="Edit template content"
                          value={editingTemplateContent}
                          onChange={(e) => setEditingTemplateContent(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 p-2 text-sm font-mono bg-white dark:bg-slate-950"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleSaveTemplateEdit(tmpl.id)}
                            className="min-h-10 px-3 rounded-lg bg-sky-600 text-white text-xs font-semibold"
                          >
                            Save Template
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingTemplateId(null)}
                            className="min-h-10 px-3 rounded-lg border border-slate-300 dark:border-slate-700 text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-sm">{tmpl.name}</span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedTemplateId(tmpl.id);
                                setActiveTab('generator');
                              }}
                              className="min-h-10 px-3 rounded-lg bg-sky-600/10 text-sky-600 dark:text-sky-400 text-xs font-semibold"
                            >
                              Use in Generator
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingTemplateId(tmpl.id);
                                setEditingTemplateName(tmpl.name);
                                setEditingTemplateContent(tmpl.content);
                              }}
                              className="min-h-10 px-3 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete template ${tmpl.name}`}
                              onClick={() => handleDeleteTemplate(tmpl.id)}
                              className="min-h-10 px-3 rounded-lg bg-rose-600/10 text-rose-600 dark:text-rose-400 text-xs font-medium"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        <p className="text-xs font-mono text-slate-500 dark:text-slate-400 break-words">
                          {tmpl.content}
                        </p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </main>

      {/* Bottom Tab Navigation (Mobile-First) */}
      <nav
        aria-label="Bottom Navigation"
        className="fixed bottom-0 inset-x-0 z-20 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1"
      >
        <div className="max-w-3xl mx-auto grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('generator')}
            aria-current={activeTab === 'generator' ? 'page' : undefined}
            className={`min-h-12 rounded-xl text-xs font-semibold transition ${
              activeTab === 'generator'
                ? 'bg-sky-600 text-white'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            Generator
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('categories')}
            aria-current={activeTab === 'categories' ? 'page' : undefined}
            className={`min-h-12 rounded-xl text-xs font-semibold transition ${
              activeTab === 'categories'
                ? 'bg-sky-600 text-white'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            Categories &amp; Elements
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('templates')}
            aria-current={activeTab === 'templates' ? 'page' : undefined}
            className={`min-h-12 rounded-xl text-xs font-semibold transition ${
              activeTab === 'templates'
                ? 'bg-sky-600 text-white'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            Templates
          </button>
        </div>
      </nav>
    </div>
  );
}
