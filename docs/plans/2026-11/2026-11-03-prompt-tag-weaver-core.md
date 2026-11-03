# Prompt Tag Weaver, ядро та бекенд: план реалізації

**Мета:** побудувати спільне доменне ядро (`src/shared/`), кореневу спеку (`spec.md`) та серверний API на Fastify + `node:sqlite` (`src/server/`) із двосторонньою LWW-синхронізацією та Google OAuth 2.0 (OIDC).

**Архітектура:** спільні типи, детермінований демо-набір і валідатори створюються в задачі 1; парсер шаблонів `[Variable]` і чистий алгоритм LWW-злиття з каскадним видаленням і канонізацією категорій — у задачі 2; репозиторій `node:sqlite` та Google OAuth 2.0 (PKCE, `state`, перевірка JWK `RS256` через `node:crypto`, сесійна cookie `ptw_session`) — у задачі 3; транзакційний маршрут `POST /api/sync` та Fastify-сервер — у задачі 4.

**Стек:** TypeScript, Node.js ≥ 24 (`node:sqlite`, `node:crypto`), Fastify, Vitest.

**Спека:** `docs/specs/2026-11/2026-11-03-prompt-tag-weaver-design.md`

Це план ядра за `detent-pr-slicing`. Клієнтський PWA-інтерфейс на React + Vite + Tailwind CSS, клієнт синхронізації, теми та Service Worker — окремий план обв'язки (периферії), який пишеться після наскрізного рев'ю ядра.

## Глобальні обмеження

- Правило 1 конституції: коренева `spec.md` створюється в задачі 1 і тримається в повній відповідності з кодом.
- Правило 5 конституції (якість тестів): лише точні перевірки (`toBe`, `toEqual`, `toStrictEqual`); жодних умовних переходів (`if`, тернарних операторів, ранніх `return`) у тестах; жодних тавтологій; обов'язкове покриття граничних випадків, порожніх входів і помилок.
- Правило 8 конституції (видалення): жодного рекурсивного видалення (`rmSync`, `rmdirSync` тощо). Тести SQLite використовують `:memory:`.
- Tombstones (`deletedAt !== null`) зберігаються безстроково.

## На що дивитись на рев'ю

1. Незмінені стартові демо-записи (`updatedAt === 0 && deletedAt === null`) ігноруються сервером при синхронізації у вже ініціалізований акаунт (`last_seq > 0`), щоб видалений демо-запис ніколи не з'являвся знову (задача 4).
2. Коли клієнт із повільним годинником надсилає запис, що програє серверній версії за LWW, сервер повертає авторитетну серверну версію у відповіді навіть якщо її `server_seq <= sinceSeq` (задача 4).
3. Канонізація категорій за `LOWER(TRIM(name))` переприв'язує до канонічного `id` як вхідні елементи із запиту клієнта, так і вже збережені на сервері елементи другої категорії, присвоюючи їм новий `server_seq` (задача 4).
4. Елемент, створений або відредагований офлайн для вже видаленої категорії (`deletedAt !== null`), при злитті й у `/api/sync` автоматично стає tombstone (задачі 2 і 4).
5. `updatedAt` та `deletedAt` із майбутнього на сервері обрізаються до `serverNow` (задача 4).

---

### Задача 1: конфігурація проєкту, коренева `spec.md`, типи, стартовий демо-набір та валідація

**Файли:**
- Створити: `spec.md`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/shared/types.ts`, `src/shared/seed.ts`, `src/shared/validation.ts`
- Тести: `tests/validation.test.ts`

**Інтерфейси:**
- `src/shared/types.ts`: `SelectionMode`, `Category`, `PromptElement`, `PromptTemplate`, `SyncRequest`, `SyncResponse`, `AuthUser`, `LocalWorkspaceState`, константи лімітів (`LIMITS`: `maxCategories = 100`, `maxElements = 500`, `maxTemplates = 100`, `maxNameLength = 120`, `maxValueLength = 10_000`, `maxSyncBatch = 1000`, `clientSyncChunkSize = 500`).
- `src/shared/seed.ts`: фіксовані UUID стартового набору, `createSeedData(): { categories: Category[]; elements: PromptElement[]; templates: PromptTemplate[] }` де кожен запис має `updatedAt: 0`, `deletedAt: null`.
- `src/shared/validation.ts`: `normalizeName(name: string): string`, `validateCategoryInput`, `validateElementInput`, `validateTemplateInput`, `validateSyncRequest(body: unknown): { ok: true; data: SyncRequest } | { ok: false; error: string }`.

- [x] **Крок 1:** встановити залежності (`fastify`, `@fastify/cookie`, `@fastify/static`, `react`, `react-dom`, `typescript`, `vite`, `@vitejs/plugin-react`, ` tailwindcss`, `@tailwindcss/vite`, `vite-plugin-pwa`, `vitest`, `@types/node`, `@types/react`, `@types/react-dom`), створити `tsconfig.json`, `vitest.config.ts`, `spec.md`.
- [x] **Крок 2:** написати тести `tests/validation.test.ts` для `normalizeName`, стартового набору (`updatedAt === 0`) і всіх меж валідації (порожні рядки, > 120 символів, > 10 000 символів, > 1000 записів у sync, невалідні типи).
- [x] **Крок 3:** реалізувати `src/shared/{types,seed,validation}.ts`.
- [x] **Крок 4:** запустити гейт `npm test && npm run typecheck` і зробити коміт.

---

### Задача 2: парсер шаблонів `[Variable]` і чиста логіка LWW-злиття

**Файли:**
- Створити: `src/shared/template-engine.ts`, `src/shared/merge.ts`
- Тести: `tests/template-engine.test.ts`, `tests/merge.test.ts`

**Інтерфейси:**
- `src/shared/template-engine.ts`:
  - `parseTemplate(content: string): TemplateToken[]`
  - `resolveTemplateVariables(content: string, categories: readonly Category[], elements: readonly PromptElement[]): ResolvedVariable[]`
  - `assemblePrompt(content: string, categories: readonly Category[], elements: readonly PromptElement[], selections: Readonly<Record<string, readonly string[]>>, freeText: Readonly<Record<string, string>>): string`
- `src/shared/merge.ts`:
  - `compareVersions<T extends { id: string; updatedAt: number; deletedAt: number | null }>(a: T, b: T): number`
  - `deleteCategoryCascade(categoryId: string, deletedAt: number, categories: readonly Category[], elements: readonly PromptElement[]): { categories: Category[]; elements: PromptElement[] }`
  - `mergeLibraries(existing: LibrarySnapshot, incoming: LibrarySnapshot, now: number): MergeResult`

- [x] **Крок 1:** написати `tests/template-engine.test.ts` та `tests/merge.test.ts` (включно з повторними плейсхолдерами, регістронезалежним збігом, `single`/`multi`, порожніми `[]`, незакритими `[`, tie-breaker у LWW, каскадним tombstone для елементів видаленої категорії та канонізацією одноіменних категорій із переприв'язкою існуючих і вхідних елементів).
- [x] **Крок 2:** реалізувати `src/shared/template-engine.ts` та `src/shared/merge.ts`.
- [x] **Крок 3:** запустити гейт `npm test && npm run typecheck` і зробити коміт.

---

### Задача 3: сховище `node:sqlite` та автентифікація Google OAuth 2.0

**Файли:**
- Створити: `src/server/db.ts`, `src/server/auth.ts`
- Тести: `tests/auth.test.ts`

**Інтерфейси:**
- `src/server/db.ts`: `createDatabase(path?: string): AppDatabase` із таблицями `users`, `categories`, `elements`, `templates`, методами для роботи з користувачами (`upsertGoogleUser`, `getUserById`) та транзакційною синхронізацією.
- `src/server/auth.ts`:
  - Підпис і перевірка cookie через `HMAC-SHA256` (`signCookieValue`, `verifyCookieValue`).
  - Генерація PKCE (`generatePkcePair`) та `state`.
  - Перевірка Google `id_token` (`verifyGoogleIdToken(idToken, jwks, expectedClientId, nowMs)`) через `crypto.createPublicKey({ key: jwk, format: 'jwk' })` і `crypto.verify('RSA-SHA256', ...)`.
  - Маршрути Fastify: `GET /api/auth/providers`, `GET /api/auth/me`, `GET /api/auth/google`, `GET /api/auth/google/callback`, `POST /api/auth/logout`.

- [x] **Крок 1:** написати `tests/auth.test.ts` (перевірка JWK `RS256` із реальною тестовою парою RSA-2048, відмова на змінений підпис, прострочений `exp`, чужий `aud`, невірний `iss`, перевірка PKCE та `state` у `/api/auth/google` і `/api/auth/google/callback`, вихід у `/api/auth/logout`).
- [x] **Крок 2:** реалізувати `src/server/db.ts` та `src/server/auth.ts`.
- [x] **Крок 3:** запустити гейт `npm test && npm run typecheck` і зробити коміт.

---

### Задача 4: транзакційний `POST /api/sync` та Fastify-сервер

**Файли:**
- Створити: `src/server/sync-routes.ts`, `src/server/app.ts`, `src/server/index.ts`
- Тести: `tests/sync-api.test.ts`

**Інтерфейси:**
- `src/server/sync-routes.ts`: реєстрація `POST /api/sync` (вимагає валідної сесії `ptw_session`, виконує злиття в транзакції `BEGIN IMMEDIATE`, обрізає майбутні `updatedAt`/`deletedAt` до `serverNow`, ігнорує незмінені демо-записи з `updatedAt === 0` для `user.last_seq > 0`, канонізує одноіменні активні категорії з переприв'язкою і вхідних, і вже збережених елементів, ставить tombstone на елементи видалених категорій, повертає дельту `server_seq > sinceSeq` у сумі з авторитетними серверними записами для всіх відхилених/скоригованих ID із запиту).
- `src/server/app.ts`: `buildServer(options)` з підключенням cookie, auth-маршрутів, sync-маршруту та роздачею статики клієнта.

- [x] **Крок 1:** написати `tests/sync-api.test.ts`, покривши всі 5 пунктів із «На що дивитись на рев'ю», ліміти активних записів (100/500/100) і помилки авторизації (`401`) та валідації (`400`).
- [x] **Крок 2:** реалізувати `src/server/sync-routes.ts`, `src/server/app.ts`, `src/server/index.ts`.
- [x] **Крок 3:** запустити гейт `npm test && npm run typecheck` і зробити коміт.
