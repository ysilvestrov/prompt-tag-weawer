# План обв'язки (Harness): інтеграційні UI-тести контролів тегів та редагування категорій

Специфікація: `docs/specs/2026-11/2026-11-16-generator-tag-controls-and-category-editing.md`
База: ядро (`872899a`..`bbc1449`), наскрізне рев'ю пройдено без блокувальних зауважень.

## Задачі обв'язки

### Задача 1. UI-тести контролів генератора (`tests/app-ui.test.tsx`)
Додати інтеграційні тести в `tests/app-ui.test.tsx`, які перевіряють:
1. **Фільтрація в генераторі та збереження вибору:**
   - вибір елемента у категорії (`Clothing` -> `Leather Jacket`);
   - введення пошукового запиту (`Scarf`), який ховає `Leather Jacket` і показує `Neon Scarf`;
   - перевірка, що `Leather Jacket` не зник із `Assembled Prompt`, і при виборі `Neon Scarf` обидва значення склеюються в промпті;
   - очищення пошуку кнопкою `Clear search ...` та перевірка стану `"No matching elements."` для неіснуючого запиту.
2. **Згортання / розгортання в 1 лінію:**
   - натискання `Collapse Models` змінює `aria-expanded` на `false`, контейнер отримує `flex-nowrap overflow-x-auto`, а кнопки — `shrink-0 whitespace-nowrap`;
   - повторне натискання `Expand Models` повертає `aria-expanded="true"` і `flex-wrap`.
3. **Сортування в генераторі:**
   - перемикання `Sort Models` на `alpha-desc`, `alpha-asc`, `date-desc`, `date-asc` змінює порядок кнопок у DOM, при цьому порядок склеювання в `assemblePrompt` залишається канонічним (`(sortOrder, id)`).

### Задача 2. UI-тести переходу, фільтрації та багаторядкового редагування категорій (`tests/app-ui.test.tsx`)
Додати інтеграційний тест у `tests/app-ui.test.tsx`, який перевіряє:
1. **Перехід із генератора до редагування категорії зі скролом:**
   - мок `Element.prototype.scrollIntoView`;
   - натискання `Edit category Clothing` у генераторі перемикає вкладку на `Categories & Elements`, обирає категорію `Clothing` та викликає `scrollIntoView` на `#selected-category-elements`.
2. **Фільтрація категорій та елементів у вкладці `Categories & Elements`:**
   - фільтр `Search categories` залишає лише збіги;
   - фільтр `Search elements in category` фільтрує елементи вибраної категорії.
3. **Багаторядковий ввід і редагування (`textarea`):**
   - створення елемента з внутрішнім переносом рядка (`line1\nline2`) через `<textarea>` `New element value`;
   - редагування елемента через `<textarea>` `Edit element value` зі збереженням внутрішнього переносу рядка.

### Задача 3. Фінальна перевірка гейту, оновлення «Фактично» у спеці, `cross-review`
- Запустити `npm test && npm run typecheck` і `npm run build`.
- Запустити `npx -y @ysilvestrov/detent cross-review --author agy` на гілці.
