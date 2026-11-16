// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/client/App.tsx';
import { createInitialGuestState, saveWorkspaceState } from '../src/client/storage.ts';
import { SEED_IDS } from '../src/shared/seed.ts';

afterEach(() => {
  cleanup();
});

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const offlineFetch: typeof fetch = async () => {
  throw new Error('Offline');
};

describe('App UI: Generator, CRUD, Theme, and Unsynced Logout Guard', () => {
  test('renders starter template, toggles single and multi category buttons, handles freetext fallback, and copies assembled prompt', async () => {
    const storage = createMemoryStorage();
    let copiedText = '';

    render(
      <App
        storage={storage}
        fetchFn={offlineFetch}
        nowFn={() => 1000}
        idFn={() => 'id-1'}
        clipboardWrite={async (text) => {
          copiedText = text;
        }}
      />,
    );

    expect(screen.getByTestId('assembled-prompt').textContent).toBe(
      'Portrait of , wearing  in , ',
    );

    // Models is single-select: clicking Kateryna K then Cyberpunk Android replaces Kateryna K
    fireEvent.click(screen.getByRole('button', { name: 'Kateryna K' }));
    expect(screen.getByTestId('assembled-prompt').textContent).toBe(
      'Portrait of 1girl, Kateryna K, highly detailed face, wearing  in , ',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cyberpunk Android' }));
    expect(screen.getByTestId('assembled-prompt').textContent).toBe(
      'Portrait of 1boy, bionic chrome portrait, glowing optics, wearing  in , ',
    );

    // Clothing is multi-select: clicking both Leather Jacket and Neon Scarf joins them with ", "
    fireEvent.click(screen.getByRole('button', { name: 'Leather Jacket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Neon Scarf' }));

    // Scenes is single-select
    fireEvent.click(screen.getByRole('button', { name: 'Rainy Alley' }));

    // [Camera Angle] has no matching Category -> renders freetext input
    fireEvent.change(screen.getByLabelText('Free text for Camera Angle'), {
      target: { value: 'low angle shot' },
    });

    const expectedPrompt =
      'Portrait of 1boy, bionic chrome portrait, glowing optics, wearing black weathered leather jacket, translucent neon fiber scarf in neon-lit rainy cyberpunk alley at night, low angle shot';
    expect(screen.getByTestId('assembled-prompt').textContent).toBe(expectedPrompt);

    fireEvent.click(screen.getByRole('button', { name: 'Copy to Clipboard' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied!' }).textContent).toBe('Copied!');
    });
    expect(copiedText).toBe(expectedPrompt);
  });

  test('turning a freetext variable into a Category via CRUD dynamically switches the Generator control to toggle buttons', () => {
    const storage = createMemoryStorage();
    let counter = 0;

    render(
      <App
        storage={storage}
        fetchFn={offlineFetch}
        nowFn={() => 2000}
        idFn={() => {
          counter += 1;
          return `gen-id-${counter}`;
        }}
      />,
    );

    // Navigate to Categories & Elements tab and create "Camera Angle" category + element
    fireEvent.click(screen.getByRole('button', { name: 'Categories & Elements' }));
    fireEvent.change(screen.getByLabelText('New category name'), {
      target: { value: 'Camera Angle' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Category' }));

    fireEvent.change(screen.getByLabelText('New element label'), {
      target: { value: 'Dutch Tilt' },
    });
    fireEvent.change(screen.getByLabelText('New element value'), {
      target: { value: 'dynamic dutch angle shot' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Element' }));

    // Switch back to Generator: [Camera Angle] now renders the "Dutch Tilt" button instead of freetext
    fireEvent.click(screen.getByRole('button', { name: 'Generator' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dutch Tilt' }));

    expect(screen.getByTestId('assembled-prompt').textContent).toBe(
      'Portrait of , wearing  in , dynamic dutch angle shot',
    );
  });

  test('switches theme class on documentElement and guards Log Out when unsynchronized changes exist', async () => {
    const storage = createMemoryStorage();
    const dirtyState = {
      ...createInitialGuestState(),
      ownerUserId: 'u-1',
      lastSyncedSeq: 3,
      dirtyCategoryIds: [SEED_IDS.categories.models],
    };
    saveWorkspaceState(storage, dirtyState);

    const fakeResponses: Record<string, { status: number; body: string }> = {
      '/api/auth/providers': { status: 200, body: JSON.stringify({ googleEnabled: true }) },
      '/api/auth/me': {
        status: 200,
        body: JSON.stringify({
          user: { id: 'u-1', email: 'u1@example.com', name: 'Kateryna', picture: null },
        }),
      },
      '/api/sync': { status: 500, body: JSON.stringify({ error: 'Offline' }) },
    };

    const fakeFetch: typeof fetch = async (input) => {
      const entry = fakeResponses[String(input)]!;
      return new Response(entry.body, {
        status: entry.status,
        headers: { 'content-type': 'application/json' },
      });
    };

    render(<App storage={storage} fetchFn={fakeFetch} nowFn={() => 3000} />);

    fireEvent.click(screen.getByRole('button', { name: 'dark' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    await waitFor(() => {
      expect(screen.getByTestId('auth-status-badge').textContent).toBe(
        'Signed in as Kateryna · Offline — changes saved locally',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Log Out' }));
    expect(screen.getByRole('heading', { name: 'Unsynchronized Changes' }).textContent).toBe(
      'Unsynchronized Changes',
    );
  });

  test('triggers sync on window online event and ignores stale in-flight sync after logout', async () => {
    const storage = createMemoryStorage();
    let resolveDelayedSync: ((res: Response) => void) | null = null;
    let syncCallCount = 0;

    const syncResponses: Array<() => Promise<Response>> = [
      async () => new Response('offline', { status: 503 }),
      () =>
        new Promise<Response>((resolve) => {
          resolveDelayedSync = resolve;
        }),
    ];

    const routeHandlers: Record<string, () => Promise<Response>> = {
      '/api/auth/providers': async () =>
        new Response(JSON.stringify({ googleEnabled: true }), { status: 200 }),
      '/api/auth/me': async () =>
        new Response(
          JSON.stringify({
            user: { id: 'u1', email: 'k@example.com', name: 'Kateryna', picture: null },
          }),
          { status: 200 },
        ),
      '/api/auth/logout': async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      '/api/sync': () => {
        const idx = syncCallCount;
        syncCallCount += 1;
        return syncResponses[idx]!();
      },
    };

    const fakeFetch: typeof fetch = (input) => routeHandlers[String(input)]!();

    render(<App storage={storage} fetchFn={fakeFetch} nowFn={() => 4000} />);

    await waitFor(() => {
      expect(screen.getByTestId('auth-status-badge').textContent).toBe(
        'Signed in as Kateryna · Offline — changes saved locally',
      );
    });
    expect(syncCallCount).toBe(1);

    fireEvent.online(window);
    await waitFor(() => {
      expect(syncCallCount).toBe(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Log Out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Log Out' }));
    await waitFor(() => {
      expect(screen.getByTestId('auth-status-badge').textContent).toBe('Offline Guest Mode');
    });

    resolveDelayedSync!(
      new Response(
        JSON.stringify({
          serverSeq: 99,
          categories: [
            {
              id: 'cat-leaked',
              name: 'LeakedServerCat',
              selectionMode: 'single',
              sortOrder: 0,
              updatedAt: 9000,
              deletedAt: null,
            },
          ],
          elements: [],
          templates: [],
        }),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-status-badge').textContent).toBe('Offline Guest Mode');
    });
    expect(storage.getItem('ptw_workspace_v1')?.includes('LeakedServerCat')).toBe(false);
  });

  test('Generator tag controls: search preserves selections, collapse toggles 1-line strip, and sort reorders display without altering prompt order', () => {
    const storage = createMemoryStorage();
    const state = createInitialGuestState();
    state.elements.push({
      id: 'el-new-model',
      categoryId: SEED_IDS.categories.models,
      label: 'Android Zeta',
      value: 'zeta android',
      sortOrder: 2,
      updatedAt: 5000,
      deletedAt: null,
    });
    saveWorkspaceState(storage, state);

    render(<App storage={storage} fetchFn={offlineFetch} nowFn={() => 6000} />);

    // 1. Search filter in Clothing preserves previously selected element
    fireEvent.click(screen.getByRole('button', { name: 'Leather Jacket' }));
    fireEvent.change(screen.getByLabelText('Search Clothing'), {
      target: { value: 'scarf' },
    });
    expect(screen.queryByRole('button', { name: 'Leather Jacket' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Neon Scarf' }).textContent).toBe('Neon Scarf');

    fireEvent.click(screen.getByRole('button', { name: 'Neon Scarf' }));
    expect(screen.getByTestId('assembled-prompt').textContent).toBe(
      'Portrait of , wearing black weathered leather jacket, translucent neon fiber scarf in , ',
    );

    // No-match state & clear search
    fireEvent.change(screen.getByLabelText('Search Clothing'), {
      target: { value: 'does-not-exist' },
    });
    expect(screen.getByText('No matching elements.').textContent).toBe('No matching elements.');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search Clothing' }));
    expect(screen.getByRole('button', { name: 'Leather Jacket' }).textContent).toBe('Leather Jacket');

    // 2. Collapse / Expand toggle for Models
    const collapseBtn = screen.getByRole('button', { name: 'Collapse Models' });
    expect(collapseBtn.getAttribute('aria-expanded')).toBe('true');
    const modelsContainer = screen.getByTestId('tag-elements-models');
    expect(modelsContainer.className).toContain('flex-wrap');

    fireEvent.click(collapseBtn);
    const expandBtn = screen.getByRole('button', { name: 'Expand Models' });
    expect(expandBtn.getAttribute('aria-expanded')).toBe('false');
    expect(modelsContainer.className).toContain('flex-nowrap overflow-x-auto');
    expect(screen.getByRole('button', { name: 'Kateryna K' }).className).toContain(
      'shrink-0 whitespace-nowrap',
    );

    fireEvent.click(expandBtn);
    expect(modelsContainer.className).toContain('flex-wrap');

    // 3. Sort modes for Models
    const getModelLabels = () =>
      Array.from(modelsContainer.querySelectorAll('button')).map((b) => b.textContent);

    expect(getModelLabels()).toEqual(['Kateryna K', 'Cyberpunk Android', 'Android Zeta']);

    fireEvent.change(screen.getByLabelText('Sort Models'), { target: { value: 'alpha-asc' } });
    expect(getModelLabels()).toEqual(['Android Zeta', 'Cyberpunk Android', 'Kateryna K']);

    fireEvent.change(screen.getByLabelText('Sort Models'), { target: { value: 'alpha-desc' } });
    expect(getModelLabels()).toEqual(['Kateryna K', 'Cyberpunk Android', 'Android Zeta']);

    fireEvent.change(screen.getByLabelText('Sort Models'), { target: { value: 'date-desc' } });
    expect(getModelLabels()).toEqual(['Android Zeta', 'Kateryna K', 'Cyberpunk Android']);

    fireEvent.change(screen.getByLabelText('Sort Models'), { target: { value: 'date-asc' } });
    expect(getModelLabels()).toEqual(['Kateryna K', 'Cyberpunk Android', 'Android Zeta']);

    // Multi-select visual sorting must not alter canonical (sortOrder, id) prompt assembly
    fireEvent.change(screen.getByLabelText('Sort Clothing'), { target: { value: 'alpha-desc' } });
    const clothingContainer = screen.getByTestId('tag-elements-clothing');
    const clothingLabels = Array.from(clothingContainer.querySelectorAll('button')).map(
      (b) => b.textContent,
    );
    expect(clothingLabels).toEqual(['Neon Scarf', 'Leather Jacket']);
    expect(screen.getByTestId('assembled-prompt').textContent).toBe(
      'Portrait of , wearing black weathered leather jacket, translucent neon fiber scarf in , ',
    );
  });

  test('Edit category jump scrolls to element editor, filters categories/elements, and supports multi-line textarea editing', async () => {
    const storage = createMemoryStorage();
    let counter = 0;
    const scrollSpy = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (
      this: HTMLElement,
      options?: boolean | ScrollIntoViewOptions,
    ) {
      scrollSpy(this.id, options);
    };

    try {
      render(
        <App
          storage={storage}
          fetchFn={offlineFetch}
          nowFn={() => 7000}
          idFn={() => {
            counter += 1;
            return `harness-id-${counter}`;
          }}
        />,
      );

      // Jump from Generator's [Clothing] card to Categories & Elements
      fireEvent.click(screen.getByRole('button', { name: 'Edit category Clothing' }));

      expect(screen.getByText('Elements in “Clothing”').textContent).toBe('Elements in “Clothing”');

      await waitFor(() => {
        expect(scrollSpy).toHaveBeenCalledWith('selected-category-elements', {
          behavior: 'smooth',
          block: 'start',
        });
      });

      // Filter categories list
      fireEvent.change(screen.getByLabelText('Search categories'), {
        target: { value: 'Scen' },
      });
      expect(screen.getByRole('button', { name: /^Scenes/ }).textContent).toContain('Scenes');
      expect(screen.queryByRole('button', { name: /^Clothing/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Clear search categories' }));
      expect(screen.getByRole('button', { name: /^Clothing/ }).textContent).toContain('Clothing');

      // Add multi-line element via textarea
      const newValueInput = screen.getByLabelText('New element value');
      expect(newValueInput.tagName).toBe('TEXTAREA');
      fireEvent.change(screen.getByLabelText('New element label'), {
        target: { value: 'MultiLine Suit' },
      });
      fireEvent.change(newValueInput, {
        target: { value: 'line one\nline two' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add Element' }));

      expect(screen.getByText('MultiLine Suit').textContent).toBe('MultiLine Suit');
      expect(screen.getByText(/line one\s+line two/).textContent).toBe('line one\nline two');

      // Filter elements inside category
      fireEvent.change(screen.getByLabelText('Search elements in category'), {
        target: { value: 'MultiLine' },
      });
      expect(screen.getByText('MultiLine Suit').textContent).toBe('MultiLine Suit');
      expect(screen.queryByText('Leather Jacket')).toBeNull();

      // Edit multi-line element via textarea
      const editButtons = screen.getAllByRole('button', { name: 'Edit' });
      fireEvent.click(editButtons[editButtons.length - 1]!);
      const editValueInput = screen.getByLabelText('Edit element value');
      expect(editValueInput.tagName).toBe('TEXTAREA');
      fireEvent.change(editValueInput, {
        target: { value: 'updated line 1\nupdated line 2' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save Element' }));

      expect(screen.getByText(/updated line 1\s+updated line 2/).textContent).toBe(
        'updated line 1\nupdated line 2',
      );
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
