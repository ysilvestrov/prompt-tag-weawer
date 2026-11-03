# Prompt Tag Weaver

A mobile-first Progressive Web Application (PWA) for modular AI prompt construction with offline-first `LocalStorage` persistence, Google OAuth 2.0 authentication, and two-way Last-Write-Wins cloud synchronization.

## Features

- **Core Entities & CRUD:** Manage **Categories** (`single` or `multi` selection mode), **Elements** (`label` button text and `value` prompt snippet), and **Templates** (`[Variable]` placeholders).
- **Dynamic Prompt Generator:**
  - Automatically parses `[Variable]` placeholders in the selected template.
  - Renders touch-friendly toggle buttons (`single` or `multi` select) when a matching Category exists (case-insensitive trimmed name match).
  - Falls back to a standard free-text input field when no matching Category exists.
  - Real-time prompt assembly and one-tap **Copy to Clipboard**.
- **Mobile-First UI & PWA:**
  - Light / Dark / System theme switcher.
  - Bottom tab navigation (`Generator`, `Categories & Elements`, `Templates`) with $\ge 48\text{px}$ touch targets.
  - Offline-ready Service Worker & Web App Manifest via `vite-plugin-pwa`.
- **Guest Mode & Two-Way Cloud Synchronization:**
  - Zero-friction offline Guest Mode backed by `LocalStorage` with a starter demo dataset.
  - Google OAuth 2.0 (OpenID Connect with PKCE + JWK `RS256` signature verification) and SQLite (`node:sqlite`) backend.
  - Two-way per-record Last-Write-Wins synchronization (`POST /api/sync`) with monotonic `serverSeq` cursor, category name canonicalization, and cross-account isolation guards.

## Scripts

```bash
npm run dev        # Start Vite frontend dev server
npm run build      # Typecheck and build production PWA into dist/
npm start          # Start Fastify + SQLite server on PORT (default 3000)
npm test           # Run Vitest unit & integration test suite
npm run typecheck  # Run TypeScript compiler check
npm run gate       # Run full verification gate (npm test && npm run typecheck)
```

## Environment Variables (Server)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `DB_PATH` | `data/prompt-tag-weaver.sqlite` | SQLite database file path |
| `STATIC_DIR` | `dist` | Built frontend directory |
| `APP_ORIGIN` | `http://localhost:3000` | Public origin for OAuth redirect URI |
| `SESSION_SECRET` | dev fallback | 32+ byte secret for signing `ptw_session` and `ptw_oauth_state` cookies |
| `GOOGLE_CLIENT_ID` | unset | Google OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | unset | Google OAuth 2.0 Client Secret |

When `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are omitted, the server runs in standalone guest mode (`/api/auth/providers` returns `{ googleEnabled: false }`).
