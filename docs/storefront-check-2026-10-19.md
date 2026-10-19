# Перевірка бізнес-логіки Storefront Next — 2026-10-19

Чи знаходять діаграми archdiff бізнес-логіку реального проєкту: Salesforce Storefront Next (template-retail-rsc-app 2026.10.0, React Router 7, 2348 файлів TS/TSX, SFCC-картриджі). Перевірка прогнала кожну бізнес-точку входу через чотири картини — `sequence:`, `logic:`, `calls:`, `path:` — і порівняла, що вони показують. Скрипт перевірки — in-process над `analyze` → `drawPicture` (92 точки × 4 картини ≈ 1 хв).

## Головне

| Що | До | Після |
|---|---|---|
| Виклики SCAPI (`clients.shopperBaskets.getBasket()`) | гап `member-of-value`, жодної фігури | **операція**: фігура на дереві викликів, повідомлення в sequence, storage у `path`/`flow`, вид `apis`; 117 викликів, 61 операція, 12 сімейств |
| OCAPI-хуки (`hooks.json`) | entry point без зв'язку з API; вхід — кожен експорт скрипта | прив'язані до сімейства/операцій ресурсу (`modify GET response category` → `ShopperProducts.getCategory`); вхід — експорт, названий хуком |
| Sequence `action.place-order` | 40 кроків логера, 5 операцій видно | getBasket → validate → updateBasket → getCustomer → addPaymentInstrument → … → createOrder; **19 операцій** у 40 повідомленнях |
| Гілки в sequence | `opt [rush]`, `opt [not rush]`, `opt [try]`, `opt [catch]` окремо | `alt [rush] / else`, `alt [try] / catch`, `loop` — Mermaid `alt … else … end`, на канві рукави в рамці |
| Точки входу, що досягають SCAPI | — | 54 з 92: у `sequence` (глибина 4) ті самі 54, що й у `path` (глибина 8) |

## Як читати бізнес-логіку як sequence

- `sequence:<path>#<fn>` — потік від точки входу: модулі та **сімейства SCAPI** як lifelines, виклики й операції як повідомлення в порядку коду, гілки як фрагменти (`alt`/`else`, `loop`, `opt`), три рівні вкладення.
- `--depth 1` — власна логіка функції: її гілки як фрагменти, її виклики й операції як повідомлення.
- Хаби (логер, utils, api-clients — модулі, які імпортує ≥ 40 модулів) малюються як повідомлення й не розгортаються; модуль, чиї функції за три виклики доходять до операції (auth middleware, basket middleware), хабом не є. `--no-hubs` розгортає.
- За лімітом (40) залишаються операції API та ланцюжки викликів до них, найглибше з решти йде першим; за 12 lifelines згортаються модулі, не сімейства API. `--limit 200` показує все.
- Той самий потік як дерево: `calls:` (операції — зовнішні фігури у смузі SCAPI), як шлях до сховищ: `path:` (операції — кінці шляху), як список кроків: `flow` (`calls SCAPI: …` біля кроку), як правила: `logic:`.

## Що показала перевірка (92 бізнес-точки: 48 route actions, 43 loaders, 1 hook)

- **Усі 54 точки, що доходять до SCAPI у `path:` (глибина 8), доходять і в `sequence:` (глибина 4)** після правил хабів і зрізу. 38 точок не кличуть SCAPI взагалі: заглушки (`action()` → 405: `resource.category-products`, `resource.recommendations`, `resource.shipping-estimate`, `resource.shipping-destination`), UI-loaders без даних, редиректи.
- Найбільші потоки: `_checkout.checkout#action` (14 операцій у path, 21 повідомлення-операція в sequence, 26 фрагментів), `action.place-order#action` (14 / 19 / 18; logic: 29 рішень, 17 виходів), `checkout/loaders.server#loader` (12 / 21 / 13), `action.passkey-finish-authentication` (9 / 19 / 15), `action.verify-passwordless-otp` (9 / 19 / 17), `_app.cart#loader` (8 / 10 / 19), `_empty.login#action` (7 / 14 / 4; logic: 29 рішень, 13 виходів).
- `logic:` є для 81 з 92 точок (решта без гілок) — 656 фрагментів у sequence загалом; рішень і правил не бракує: `place-order` — 35 правил, `login` — 29 рішень.
- **Сліпі плями на деревах викликів**: 227 дірок у 50 точках, із них 45 з 47 різних — `logger.error/debug/warn/info` (причина `interface`: `Logger` реалізований об'єктним літералом у `createLogger`, класу немає). Решта: `ApiError` (unknown-member), `baseFetch` (dynamic). Тобто єдина системна сліпа пляма — логер; бізнес-виклики всі простежені.
- Coverage: `api` 117, blind 2576 (без змін — ці виклики й раніше не були blind, але були невидимі), followed 91.3 %.

## Що змінено в archdiff

1. `src/apis.ts` — адаптер SCAPI/OCAPI: `operationOf(call)` (форми `value`/`member` за іменем клієнта `shopper<Family>`, `typed` за типом `Shopper<Family>`), `hookOf(name)` (ресурс, метод, стадія, сімейства ресурсу). Граф записує `apiCalls` і гап причини `api` (не blind).
2. Вид `apis` / `apis:<Family>` / `apis:<module>`; операції як `external`-фігури на `calls:`, кінці `path:`, кроки `flow`, сторінки Markdown («Operations of external APIs», сторінка операції з «Called by»), Mermaid-учасники `Family (SCAPI)`.
3. Sequence: `alt` з рукавами (if/else, case, try/catch), хаби не розгортаються, зріз зберігає операції та ланцюжки до них, lifelines сімейств не згортаються.
4. Хук SFCC входить через експорт, названий у хуку (`exports.modifyGETResponse`), а не через всі експорти скрипта.
5. Фікстура `tests/fixtures/scapi`, тести CLI (вид `apis`, дерево/шлях/flow/coverage з операціями, фрагменти `alt`), документація: README, CHANGELOG, CONTEXT (термін **Operation**), спеки `views` і `analysis`.

## Межі й наступні кроки

- Адаптер знає SCAPI за конвенцією імен клієнтів (`AppClients` runtime-у та commerce-sdk-isomorphic); інший SDK потребує свого рядка в таблиці (`apis.ts`).
- Логер як `interface`-гап: об'єктний літерал, що реалізує інтерфейс, — відома межа резолвера (можливий наступний крок — читати літерал як реалізацію).
- `run` SFCC-хука під `"type": "module"` падає на `require` — платформа `dw/*` не Node; чесна помилка.
