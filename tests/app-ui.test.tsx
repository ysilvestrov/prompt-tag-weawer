// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
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
});
