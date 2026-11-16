# План ядра: розширене керування тегами в генераторі та редагування категорій

Специфікація: `docs/specs/2026-11/2026-11-16-generator-tag-controls-and-category-editing.md`
Мова: uk
Спосіб виконання: послідовне виконання малих задач inline (кожну задачу перевіряємо повним гейтом `npm test && npm run typecheck` і фіксуємо окремим комітом).

## Задачі ядра

### Задача 1. Чисті функції фільтрації та сортування (`src/client/tag-controls.ts` + `tests/tag-controls.test.ts`)
- Створити модуль `src/client/tag-controls.ts` із типами й функціями:
  - `ElementSortMode = 'default' | 'alpha-asc' | 'alpha-desc' | 'date-desc' | 'date-asc'`
  - `filterElements(elements: readonly PromptElement[], query: string): PromptElement[]` — фільтрує за `label` або `value` (без урахування регістру та крайніх пробілів запиту).
  - `sortElements(elements: readonly PromptElement[], mode: ElementSortMode): PromptElement[]` — сортує за алфавітом (`localeCompare`), за `updatedAt` (новіші / старіші; при рівних `updatedAt` зберігає відносний порядок через індекс / `id`) або повертає копію без змін для `'default'`.
  - `filterCategories(categories: readonly Category[], query: string): Category[]` — фільтрує за `name` (без урахування регістру та крайніх пробілів).
- Додати юніт-тести у `tests/tag-controls.test.ts` (порожні запити, фільтрація по label і value, усі 5 режимів сортування, граничні випадки).
- Перевірити гейт та закомітити.

### Задача 2. Контроли тегів у генераторі (`src/client/App.tsx`)
- Додати локальний стан генератора для кожної змінної (за `normalizedName`):
  - `tagSearch: Record<string, string>`
  - `tagCollapsed: Record<string, boolean>`
  - `tagSort: Record<string, ElementSortMode>`
- У шапці картки категорійної змінної:
  - Кнопка переходу `Edit` / іконка переходу (`navigateToCategory(variable.categoryId)`), яка перемикає `activeTab` на `'categories'`, виставляє `selectedCategoryId` і після рендеру викликає `document.getElementById('selected-category-elements')?.scrollIntoView({ behavior: 'smooth', block: 'start' })`.
  - Кнопка-іконка згортання/розгортання (`aria-label` для перемикання `Collapse` / `Expand`).
  - Селект або кнопка сортування (`aria-label` для `Sort elements`) з 5 режимами (`Default`, `A → Z`, `Z → A`, `Newest`, `Oldest`).
- Над кнопками елементів додати компактне поле пошуку `Search elements...` із кнопкою швидкого очищення (`✕`), якщо запит не порожній.
- Для контейнера кнопок:
  - Якщо `isCollapsed === true`: `flex flex-nowrap overflow-x-auto py-1 gap-2`, а кожна кнопка має `shrink-0 whitespace-nowrap`.
  - Якщо `isCollapsed === false`: `flex flex-wrap gap-2`.
- Якщо після фільтрації список порожній — вивести повідомлення `"No matching elements"`. Вибір у `selections` зберігається незалежно від фільтра.
- Перевірити гейт та закомітити.

### Задача 3. Покращення вкладки Categories & Elements (`src/client/App.tsx`)
- Додати поля стану `categoryFilter` і `elementFilter`.
- Над списком категорій додати поле фільтрації `Search categories...` (з кнопкою очищення), застосувати `filterCategories`.
- При кліку на рядок категорії у списку категорій встановлювати `selectedCategoryId` і плавно скролити до `#selected-category-elements`.
- На контейнері секції «Elements in ...» задати `id="selected-category-elements"`.
- Над списком елементів вибраної категорії додати поле фільтрації `Search elements in category...`, застосувати `filterElements`.
- Замінити `<input type="text">` на `<textarea rows={3}>` для `newElementValue` (створення елемента) та `editingElementValue` (редагування елемента), а в картці відображення елемента додати `whitespace-pre-wrap` для `el.value`.
- Перевірити гейт та закомітити.

### Задача 4. Оновлення `spec.md` (`specFile`)
- Оновити розділ 3 та 4 у `spec.md`, зафіксувавши:
  - наявність локального пошуку, згортання в 1 лінію та візуального сортування тегів у генераторі без зміни правила `assemblePrompt`;
  - швидкий перехід із генератора до редактора елементів категорії, фільтрацію списків категорій та елементів і багаторядкове редагування `value` елементів.
- Перевірити гейт та закомітити.

---

Після виконання Задач 1–4 провести наскрізне рев'ю ядра, після чого скласти окремий план обв'язки (`docs/plans/2026-11/2026-11-16-generator-tag-controls-harness.md`) для розширених UI-тестів у `tests/app-ui.test.tsx`.
