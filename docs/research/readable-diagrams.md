# Зрозумілі діаграми: ресерч, 2026-10-17

Що кажуть практики, дослідження й обговорення розробників про читабельність архітектурних діаграм; з якими проблемами стикаються люди; які є рішення; і що з цього вже є в archdiff, а що варто додати. Перевірені факти посилаються на джерела; рекомендації для archdiff у кінці — мої висновки.

## Коротко

1. **Одна діаграма — одне питання.** Хто читає і яке рішення приймає, визначає, що на ній є. Універсальної діаграми не існує (Nordmann; Rozanski & Woods; Azure WAF).
2. **Рівні, а не все одразу.** Контекст → контейнери → компоненти → код; змішування рівнів — найчастіша помилка (C4; Visual Paradigm).
3. **Межа елементів.** 7–10 фігур на картинці, у sequence — 10–12 lifelines; далі — ділити або згортати (Archbee; Visual Paradigm).
4. **Перетини — найгірше.** З усіх естетик графу на розуміння найбільше впливає кількість перетинів ребер; вигини й симетрія — менше; сітка — статистично незначуща (Purchase).
5. **Стрілки мають одне значення.** «A → B» читають як «викликає», «залежить», «шле дані» — треба легенда, підпис, напрямок, без двосторонніх стрілок (C4 notation; Azure WAF; Taverna).
6. **Заголовок, легенда, метадані.** Кожна діаграма самодостатня: тип, обсяг, легенда, дата/коміт (C4 review checklist).
7. **Щільний граф — не малювати як є.** Відрізати слабкі ребра, згортати групи, матриця замість графу, bundling (Edge et al.; Holten; Lattix).
8. **Згенероване стабільне, намальоване — окремо.** Структура з коду, намір — руками, в окремих файлах; автогенерація без фільтра дає «спагеті», а дрібна зміна коду не повинна перевертати картинку (dev.to/libme; HN).

## Проблеми, з якими стикаються люди

| Проблема | Як проявляється | Джерела |
| --- | --- | --- |
| «Hairball» / спагеті | Сотні вузлів і ребер, кожен import і log-виклик; картинка займає A4 без читабельного тексту | [Trimming the Hairball], [bswen], [HN 31620002] |
| Змішані рівні абстракції | Таблиця БД на контекстній діаграмі, методи на діаграмі контейнерів | [C4 pitfalls], [C4 misconceptions] |
| Двозначні стрілки | «uses» без деталей; двосторонні стрілки; залежність чи потік даних — незрозуміло | [C4 notation], [Azure WAF], [Taverna] |
| Немає легенди/заголовка | Колір і пунктир без пояснення; акроніми | [C4 notation] |
| Діаграма бреше | Вікі/PNG не пов'язані з кодом; після рефакторингу ніхто не оновлює; новачків вводить в оману | [libme], [erajasekar] |
| Нестабільний автолейаут | Додали одне ребро — картинка перевернулася; не можна використати як живий документ | [HN 34322130] |
| Хибне відчуття розуміння | Автозгенерована картинка «обманює, що ти розумієш систему»; «навчання відбувається, коли малюєш сам» | [HN 31620002] |
| Перетини й лінії крізь вузли | Шлях ребра не простежити; найсильніший негативний чинник у дослідженнях | [Purchase 1997/2002], [GD Handbook ch. 13] |
| Перевантажені sequence | Забагато lifelines, усі гілки, технічний «plumbing» | [Creately], [Visual Paradigm seq] |
| Одна діаграма для всіх | Для менеджера — забагато, для розробника — замало | [Nordmann] |
| Доступність | Лише колір розрізняє типи; не читається в ч/б і при дальтонізмі | [Azure WAF], [C4 notation] |

## Рішення

### Рівні й питання

- **C4-рівні з прогресивним розкриттям**: кожен рівень окрема картинка, з верхньої можна зайти у нижню. «Layer, don't overload» ([Azure WAF]).
- **Viewpoints за аудиторією**: Rozanski & Woods — Context, Functional, Information, Concurrency, Development, Deployment, Operational; перспективи (security, performance) — лінза над видами, не окремий вид. Дозволено пропускати вид із задокументованою причиною ([Nordmann]).
- **Одна модель — багато видів**: тримати модель, генерувати види під питання, а не малювати кожну руками ([Nordmann], Structurizr).

### Менше фігур

- Ліміт 7–10 елементів, A4-тест на читабельність тексту ([Archbee]).
- Групувати: понад п'ять сервісів — один контейнер «Payment Processing» і окрема діаграма всередину ([C4 pitfalls]).
- **Semantic zoom**: рівень деталізації залежить від масштабу — агрегувати ребра, ховати підписи; у дослідженні з 12 учасниками версія із semantic zoom виграла за читабельністю й ясністю ([Wiens et al. via arXiv 2510.00003]).

### Менше ребер

- **Edge cutting**: ребра відрізають за метрикою (вага, mutual information, degree) до «скелета», потім повертають ребра всередині спільнот. Усі стратегії значно кращі за сирий граф; вибір залежить від даних і задачі ([Trimming the Hairball]).
- **K-core / pruning** за вагою для зважених графів ([Medium hairball]).
- **Hierarchical edge bundling**: ребра згинаються вздовж ієрархії (директорій), клубок стає пучками; показує неявні залежності між батьками ([Holten 2006]).
- **DSM замість графу** для 20–100+ вузлів: матриця масштабується, цикли видно як червоні трикутники; графи UML-пакетів «не окупаються» на великих системах ([Lattix], [DZone DSM], [oopsla05]). Для графів 20–100 вузлів матриці обходять node-link на всіх задачах, крім пошуку шляху ([Trimming the Hairball], related work).

### Лейаут і маршрутизація

- **Sugiyama/layered**: ребра в одному напрямку, короткі, вузли рівномірно, мінімум перетинів, прямі ребра ([GD Handbook ch. 13]). Confluent-малюнки зменшують перетини ще більше ([arXiv cs/0507051]).
- **Ортогональна маршрутизація з фіксованими вузлами**: libavoid (у ELK) обводить ребра навколо нерухомих вузлів; порти задають сторону виходу ([ELK libavoid]). Це те, що потрібно, коли користувач сам розставляє фігури.
- **Стабільність**: зберігати позиції між версіями; текстові підказки положення; draw.io з метаданими як гібрид ([HN 34322130]).

### Нотація

- Кожна лінія — одна однонаправлена залежність, підписана: напрямок, намір, протокол. Без «Uses». Без двосторонніх стрілок: або два потоки, або примітка request/response ([C4 notation], [Azure WAF]).
- Легенда для кожної семантики лінії (суцільна = sync, пунктир = async); не покладатися лише на колір — парити з патерном ([Azure WAF]).
- Чекліст C4: заголовок із типом і обсягом, легенда, тип і технологія кожного елемента, опис відповідальності, акроніми пояснені ([C4 notation]).
- Метадані: призначення, дата, автор/коміт, посилання; після публікації — журнал змін ([Azure WAF]).

### Sequence-діаграми

- 10–12 lifelines максимум; ініціатор зліва; учасників групувати за підсистемою; повідомлення однієї функції разом; `alt`/`opt`/`loop` замість усіх гілок; високорівневі sequence живуть довше ([Visual Paradigm seq], [Creately]).

### Генерація з коду

- Структуру генерувати, намір писати руками, тримати в окремих файлах; правила меж перевіряти в CI (dependency-cruiser) ([libme]).
- Діаграми в репозиторії поруч із кодом, щоб PR оновлював обидва ([Catio]; [todiagram]).
- Для ревю PR: «побачити форму зміни до читання коду»; змінені компоненти й залежності, до/після ([CodeBoarding], [CodeViz], [todiagram]).

## Що з цього є в archdiff і що варто додати

Звірено з кодом станом на коміт `79f8248`.

| Принцип | Стан в archdiff | Що варто зробити |
| --- | --- | --- |
| Рівні з розкриттям | ✅ layers → layer → dir → module → inside → fn; подвійний тап | — |
| Одна картинка — одне питання | ✅ 20 views, кожен під питання | Підписувати у title саме питання («who imports whom») — частково є |
| Ліміт фігур | ⚠️ `MAX_SHAPES = 80`, fold за директорією | 80 — забагато за дослідженнями. Знизити типовий ліміт до ~30 для layer/dir, 40 для inside; для `inside:` з 100+ функцій згортати за префіксом імені або за блоком файлу |
| Менше ребер | ⚠️ є `calls:` з глибиною, `path:` обрізає гілки без storages | Опція **min weight** (ховати ребра з 1 викликом), **hub-вузли** (модуль, який імпортують усі — `log.ts`, `types.ts` — показувати як бейдж «+ log» на вузлах, а не 20 стрілок), k-core для `cycles` |
| DSM для великих | ✅ `matrix` для шарів | `matrix:dir` для директорій і `matrix` для циклу; у `cycles` підсвічувати трикутники над діагоналлю |
| Edge bundling | ❌ | У Excalidraw-експорті складно; дешевий еквівалент — злити паралельні ребра між парою вузлів в одне з лічильником (у `inside:` і `calls:`) |
| Мінімум перетинів | ⚠️ barycentre по рангах | Додати ітерації barycentre вгору-вниз (2–4 проходи) і підрахунок перетинів у тесті як регресійну метрику |
| Лінії не крізь вузли | ✅ коридори між рядами, тест-інваріант | — |
| Ортогональні ребра при ручному розміщенні | ⚠️ після `re-layout` маршрути перераховуються за нашими колонками | Для довільно переміщених фігур колонкування за x працює, але не гарантує; варіант — libavoid-подібний роутер по сітці перешкод |
| Стабільність лейаута | ✅ детермінований layout, збережені позиції `.archdiff/layouts`, merge при re-layout | У `compare` і `--changes` фіксувати позиції за base-ревізією, щоб diff не рухав фігури |
| Стрілки з одним значенням | ⚠️ dependency / call / ref різняться кольором і стилем, легенда є | Підписати в легенді напрямок словами: «A → B: A imports B», «A → B: A calls B»; лічильник на ребрі (`×12`) замість кількох паралельних |
| Легенда не лише колором | ✅ removed — пунктир, more — крапки, heat — ще й число в підписі | — |
| Заголовок, метадані | ⚠️ title + reason + «N shapes, M lines; K files» | У експорти додавати коміт/дату (`%% archdiff: <sha> <date>`) |
| Sequence-ліміти | ⚠️ `sequence:` з глибиною | Ліміт 12 учасників з `… N more`; повтори одного виклику згортати в `loop ×N` |
| Структура vs намір | ✅ згенеровані фігури + намальовані нотатки у layouts, план із малюнка | — |
| Ревю PR | ✅ review, compare, overlay changes, GitHub Action | — |
| Аудиторії | ⚠️ є всі види, нема пресетів | Пресети в панелі опцій: *reviewer* (changes + tests), *newcomer* (layers, depth 1), *architect* (cycles, matrix, hotspots) |
| Хибне відчуття розуміння | ✅ coverage: що діаграми не покривають, `hole` з причиною | — |

### Пріоритет (мій висновок)

1. **Hub-вузли як бейджі** і **min weight** — прибирають більшість «каші» у великих `inside:` і `layer:` без втрати інформації (Markdown лишає все).
2. **Нижчий типовий ліміт фігур** (30/40) — найпростіша зміна з найбільшим ефектом за дослідженнями.
3. **Злиття паралельних ребер з лічильником** — менше ліній, більше сенсу.
4. **Ітеративний barycentre + метрика перетинів у тестах** — закріплює якість, як зробили з лініями крізь вузли.
5. **Пресети аудиторій** у панелі опцій.
6. **Коміт/дата в експортах** і підписи напрямків у легенді — дешево, прибирає двозначність.

## Чекліст для нового view

- Яке одне питання він відповідає? Це в заголовку?
- Не більше ~30 фігур без згортання; згортання має зрозумілий підпис і відкривається тапом.
- Усі ребра одного значення або розрізнені стилем і пояснені в легенді; напрямок однозначний.
- Жодна лінія крізь вузол (тест), перетинів мінімум, ребра зліва направо.
- Не лише колір: стиль лінії або знак у підписі.
- Markdown панелі містить усе, що картинка згорнула.
- Є `reason`, коли картинку обрізано, і `coverage`, коли щось не покрито.

## Джерела

- [C4 notation]: https://c4model.com/diagrams/notation — нотація, чекліст ревю діаграм.
- [C4 pitfalls]: https://skills.visual-paradigm.com/?p=971 — типові помилки початківців у C4.
- [C4 misconceptions]: https://2026.dddeurope.com/program/the-c4-model-misconceptions-misuses-and-mistakes — Simon Brown про неправильне вживання C4.
- [Azure WAF]: https://learn.microsoft.com/en-us/azure/well-architected/architect-role/design-diagrams — практики: стрілки, легенда, доступність, типи діаграм.
- [Archbee]: https://www.archbee.com/blog/diagrams-in-developer-documentation — 7–10 елементів, A4-тест.
- [Nordmann]: https://kore-nordmann.de/blog/there-is-no-audience-independent-architecture-view.html — нема універсального виду; Rozanski & Woods.
- [Purchase 1997/2002]: https://www.springerprofessional.de/en/which-aesthetic-has-the-greatest-effect-on-human-understanding/13633544 , https://innovis.cpsc.ucalgary.ca/innovis/uploads/Courses/InformationVisualizationDetails2009/Purchase2002.pdf — перетини важать найбільше.
- [GD Handbook ch. 13]: https://cs.brown.edu/people/rtamassi/gdhandbook/chapters/hierarchical.pdf — Sugiyama, естетики layered-лейаутів.
- [arXiv cs/0507051]: https://arxiv.org/pdf/cs/0507051 — confluent layered drawings.
- [ELK libavoid]: https://eclipse.dev/elk/blog/posts/2022/22-11-17-libavoid.html — ортогональна маршрутизація з фіксованими вузлами.
- [Trimming the Hairball]: https://www.microsoft.com/en-us/research/uploads/prod/2018/12/TrimmingTheHairball.pdf — edge cutting, матриці vs node-link.
- [Medium hairball]: https://medium.com/@harikrishnank497/hairball-graph-problem-a8ce62d324d5 — k-core, bundling, pruning.
- [Holten 2006]: https://research.tue.nl/nl/publications/hierarchical-edge-bundles-visualization-of-adjacency-relations-in/ — hierarchical edge bundles для залежностей ПЗ.
- [Lattix]: https://lattix.com/dependency-structure-matrix ; [DZone DSM]: https://dzone.com/articles/dependency-structure-matrix-for-software-architect ; [oopsla05]: https://groups.csail.mit.edu/sdg/pubs/2005/oopsla05-dsm.pdf — DSM для великих систем і циклів.
- [arXiv 2510.00003]: https://arxiv.org/abs/2510.00003 — semantic zoom, дослідження з користувачами.
- [Visual Paradigm seq]: https://skills.visual-paradigm.com/?p=2926 — 10–12 lifelines, фрагменти.
- [Creately]: https://creately.com/blog/diagrams/10-common-mistakes-to-avoid-in-sequence-diagrams/ — помилки sequence-діаграм.
- [Taverna]: https://dev.to/ctaverna/software-architecture-diagram-arrows-30lb — значення стрілок.
- [libme]: https://dev.to/libme/the-architecture-diagram-in-your-wiki-is-lying-how-to-generate-one-from-the-code-instead-5cc8 — генерація з коду, структура vs намір.
- [erajasekar]: https://dev.to/erajasekar/the-real-reason-architecture-diagrams-go-stale-35ok — чому діаграми старіють.
- [HN 31620002]: https://news.ycombinator.com/item?id=31620002 — чому code-to-diagram не прижилось.
- [HN 34322130]: https://news.ycombinator.com/item?id=34322130 — diagrams-as-code: лейаут, стабільність, D2/Structurizr/ELK.
- [bswen]: https://docs.bswen.com/blog/2026-02-25-auto-generate-architecture-diagrams/ — спагеті від статичного аналізу.
- [Catio]: https://www.catio.tech/blog/architecture-diagram ; [todiagram]: https://todiagram.com/blog/visualize-pull-requests-as-diagrams ; [CodeBoarding]: https://github.com/CodeBoarding/CodeBoarding ; [CodeViz]: https://www.codeviz.ai/use-cases/code-review — діаграми в ревю PR.
