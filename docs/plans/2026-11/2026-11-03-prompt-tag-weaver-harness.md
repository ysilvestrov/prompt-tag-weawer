# Prompt Tag Weaver, клієнтський PWA (обв'язка): план реалізації

**Мета:** побудувати mobile-first PWA-клієнт на React + Vite + Tailwind CSS із локальним сховищем `LocalStorage`, клієнтом двосторонньої синхронізації, динамічним генератором промптів, CRUD для категорій, елементів і шаблонів, перемикачем теми (`Light`/`Dark`/`System`) та Service Worker.

**Архітектура:** спирається на готове ядро (`src/shared/*`, `src/server/*`) та висновки наскрізного рев'ю ядра (`docs/plans/2026-11/2026-11-03-prompt-tag-weaver-core-review.md`). У задачі 1 створюються клієнтське сховище `LocalStorage` (`src/client/storage.ts`), клієнт синхронізації з пакетуванням по 500 записів (`src/client/sync-client.ts`) і менеджер теми (`src/client/theme.ts`). У задачі 2 створюються React-компоненти mobile-first інтерфейсу (`Generator`, `Categories & Elements`, `Templates`, шапка з керуванням темою, входом через Google та попередженням при несинхронізованих змінах), точка входу Vite та конфігурація PWA (`vite.config.ts`, `index.html`).

**Стек:** TypeScript, React 19, Vite 6, Tailwind CSS 4, `vite-plugin-pwa`, Vitest + `@testing-library/react` (`jsdom`).

**Спека:** `docs/specs/2026-11/2026-11-03-prompt-tag-weaver-design.md` та `spec.md`

## Глобальні обмеження

- Правило 5 конституції: точні перевірки в тестах, жодних умовних переходів у тестах, покриття граничних станів і помилок.
- Висота інтерактивних кнопок у мобільній навігації та перемикачах $\ge 48\text{px}$ (`min-h-12`).
- Категорії в пакетах синхронізації відправляються перед елементами (висновок 2 наскрізного рев'ю ядра).
- Додавання елемента в демо-категорію з `updatedAt === 0` піднімає `category.updatedAt = now` (висновок 1 наскрізного рев'ю ядра).

---

### Задача 1: локальне сховище `LocalStorage`, клієнт синхронізації та менеджер теми

**Файли:**
- Створити: `src/client/storage.ts`, `src/client/sync-client.ts`, `src/client/theme.ts`
- Тести: `tests/client-storage-sync.test.ts`

**Інтерфейси:**
- `src/client/storage.ts`:
  - `loadWorkspaceState(storage: Pick<Storage, 'getItem' | 'setItem'>): LocalWorkspaceState`
  - `saveWorkspaceState(storage: Pick<Storage, 'getItem' | 'setItem'>, state: LocalWorkspaceState): void`
  - Чисті редьюсери мутацій: `addCategory`, `updateCategory`, `removeCategory`, `addElement`, `updateElement`, `removeElement`, `addTemplate`, `updateTemplate`, `removeTemplate`, `prepareLoginMerge`, `resetToGuestWorkspace`, `detectAccountSwitchConflict`, `applySyncResponse`.
- `src/client/sync-client.ts`:
  - `buildSyncChunks(state: LocalWorkspaceState, chunkSize?: number): SyncRequest[]`
  - `runSyncCycle(state: LocalWorkspaceState, sendSync: (req: SyncRequest) => Promise<SyncResponse>): Promise<LocalWorkspaceState>`
- `src/client/theme.ts`:
  - `type ThemeMode = 'light' | 'dark' | 'system'`
  - `resolveEffectiveTheme(mode: ThemeMode, systemPrefersDark: boolean): 'light' | 'dark'`
  - `loadThemeMode(storage: Pick<Storage, 'getItem'>): ThemeMode`
  - `saveThemeMode(storage: Pick<Storage, 'setItem'>, mode: ThemeMode): void`

- [x] **Крок 1:** написати `tests/client-storage-sync.test.ts` (ініціалізація демо-набору, CRUD-операції з підняттям `updatedAt` демо-категорії при додаванні елемента, каскадне видалення категорії в локальному стані, пакетування > 500 `dirty`-записів у `buildSyncChunks` і `runSyncCycle`, виявлення конфлікту при зміні `userId` з несинхронізованими правками, визначення теми `light`/`dark`/`system`).
- [x] **Крок 2:** реалізувати `src/client/storage.ts`, `src/client/sync-client.ts`, `src/client/theme.ts`.
- [x] **Крок 3:** запустити гейт `npm test && npm run typecheck` і зробити коміт.

---

### Задача 2: mobile-first PWA інтерфейс (React + Vite + Tailwind + `vite-plugin-pwa`) та тести UI

**Файли:**
- Створити: `index.html`, `vite.config.ts`, `src/client/styles.css`, `src/client/main.tsx`, `src/client/App.tsx`, `public/icon.svg`
- Тести: `tests/app-ui.test.tsx`

**Інтерфейси:**
- 3 нижні вкладки (`Generator`, `Categories & Elements`, `Templates`) з `min-h-12` кнопками.
- У `Generator`: вибір шаблону, кнопки-перемикачі елементів (`single` / `multi`) для змінних із категоріями, текстові поля для змінних без категорій, живий попередній перегляд промпту, кнопка `Copy to Clipboard` зі станом `"Copied!"` (або повідомленням про помилку).
- У `Categories & Elements`: створення, редагування назви, перемикання `single`/`multi` та видалення категорій; створення, редагування (`label`, `value`) та видалення елементів.
- У `Templates`: створення, редагування (`name`, `content` із чіпами підказок `[Category]`), видалення та кнопка `"Use in Generator"`.
- У верхній панелі: перемикач теми (`Light` / `Dark` / `System`), індикатор режиму/синхронізації, кнопка `Sign in with Google` / `Log Out`, модальне вікно підтвердження при несинхронізованих змінах під час виходу або зміни акаунта.

- [x] **Крок 1:** написати `tests/app-ui.test.tsx` (перевірка рендерингу стартового демо-набору в генераторі, перемикання `single` та `multi` елементів і вводу в `[Camera Angle]`, копіювання в буфер обміну, створення нової категорії й елемента через вкладку `Categories & Elements` і миттєва поява кнопок у генераторі, попередження при виході з несинхронізованими змінами).
- [x] **Крок 2:** реалізувати `index.html`, `vite.config.ts`, `src/client/styles.css`, `src/client/App.tsx`, `src/client/main.tsx`, `public/icon.svg`.
- [x] **Крок 3:** запустити гейт `npm test && npm run typecheck` та перевірити збірку PWA `npm run build`, після чого зробити коміт.
