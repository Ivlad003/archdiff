// The page's words in Ukrainian said by the modules of the review and the side panels (the branches, the commits, the board, the tours, the tabs, what a tap picks, the settings):
// each under the English the module writes (`t("…")`, i18n.ts), grouped by
// module. A text with a number in it is a function where the Ukrainian word
// turns on the number (`plural`). Joined into the one table by i18n-uk.ts.
//
// Entry point: `UK_PANELS`.

import { plural } from "./i18n-plural.ts";

type Values = Readonly<Record<string, string | number>>;

/** What a change did to a shape — the diagram's mark, or `context` for a shape it left alone — in the page's words. */
const MARKS: Readonly<Record<string, string>> = { added: "додано", removed: "видалено", changed: "змінено", warning: "попередження", planned: "заплановано", context: "контекст" };

export const UK_PANELS: Readonly<Record<string, string | ((values: Values) => string)>> = {
  // ── review.ts ──────────────────────────────────────────────────────────────
  // ("working tree" is index.html's, in i18n-uk.ts.)
  "checked out": "поточна",
  // A git word: the name of a group of branches and the tag on one branch alike.
  "remote": "remote",
  "{head}: press to untick it": "{head}: натисніть, щоб зняти позначку",
  "+{count} more": "ще {count}",
  "none ticked": "нічого не позначено",
  "{count} heads": "{count} heads",
  "{shown} of {count} heads": "{shown} з {count} heads",
  "{count} ticked": "позначено {count}",
  "{base} (default)": "{base} (типова)",
  "local": "локальні",
  "the files as they are now, committed or not": "файли, якими вони є зараз, закомічені чи ні",
  "The working tree: the files as they are on the disk now": "Робоче дерево: файли, якими вони зараз є на диску",
  "no branch has these words": "жодна гілка не містить цих слів",
  "{count} heads against {base}": "{count} heads проти {base}",
  "the merge-base": "merge-base",
  "tick at least one head": "позначте хоча б один head",

  // ── commits.ts ─────────────────────────────────────────────────────────────
  "Pause at this commit (k)": "Зупинитися на цьому коміті (k)",
  "Play: step through the commits of the range by itself, the picture drawn again at each (k)": "Відтворення: коміти діапазону змінюються самі, діаграма перемальовується на кожному (k)",
  "commit {n} of {count}": "коміт {n} з {count}",
  "no commits between the base and the head": "між базою та head немає комітів",
  "pick a commit to see its own change": "оберіть коміт, щоб побачити його власну зміну",
  "this commit against the one before it": "цей коміт проти попереднього",
  "this commit is not of the range": "цей коміт не з діапазону",
  "drag the slider or press ▶: the code as it was at each commit": "тягніть повзунок або натисніть ▶: код, яким він був на кожному коміті",
  "the code as it was then, what the commit did marked": "код, яким він був тоді, з позначками того, що зробив коміт",
  "whole range: {base} → {head} ({count} commits)": (v) => `увесь діапазон: ${v.base} → ${v.head} (${v.count} ${plural(v.count, "коміт", "коміти", "комітів")})`,
  "the last commit of the range": "останній коміт діапазону",
  // The place among the commits; the steps of the board's walk (board.ts) and of a tour (tours.ts) say theirs with it too.
  "{n} of {count}": "{n} з {count}",
  "the whole range": "увесь діапазон",

  // ── board.ts ───────────────────────────────────────────────────────────────
  "the whole board: {count} group": (v) => `уся дошка: ${v.count} ${plural(v.count, "група", "групи", "груп")}`,
  "the whole board: {count} groups": (v) => `уся дошка: ${v.count} ${plural(v.count, "група", "групи", "груп")}`,
  "{count} module": (v) => `${v.count} ${plural(v.count, "модуль", "модулі", "модулів")}`,
  "{count} modules": (v) => `${v.count} ${plural(v.count, "модуль", "модулі", "модулів")}`,
  "{group} — no longer changed": "{group} — змін уже немає",
  "against {base} · {count} source file changed": (v) => `проти ${v.base} · змінено ${v.count} ${plural(v.count, "файл коду", "файли коду", "файлів коду")}`,
  "against {base} · {count} source files changed": (v) => `проти ${v.base} · змінено ${v.count} ${plural(v.count, "файл коду", "файли коду", "файлів коду")}`,
  "the last group of the walk": "остання група обходу",
  "the whole board: the walk starts here": "уся дошка: обхід починається тут",

  // ── tours.ts ───────────────────────────────────────────────────────────────
  // ("keep the step" is index.html's, in i18n-uk.ts.)
  "no steps yet": "кроків ще немає",
  "pick a step": "оберіть крок",
  "_No note for this step._": "_До цього кроку немає нотатки._",
  "recording: add step keeps the picture shown, its selection and a note": "запис: «додати крок» зберігає показану діаграму, її виділення та нотатку",
  "away from step {step}: ‹ › or the list lead back": "не на кроці {step}: ‹ › або список повертають до нього",
  "the last step of the tour": "останній крок туру",
  "the first step of the tour": "перший крок туру",
  "keep the note": "зберегти нотатку",
  "step {step} of {count} kept in the tour {tour}": "крок {step} з {count} збережено в турі {tour}",
  "Take step {step} out of the tour {tour}?": "Прибрати крок {step} із туру {tour}?",
  "the link to step {step} is copied:": "посилання на крок {step} скопійовано:",
  "the link could not be copied": "посилання не вдалося скопіювати",
  "The title of the tour": "Назва туру",
  "Play the tour from its first step ({name})": "Відтворити тур від першого кроку ({name})",
  "{count} step": (v) => `${v.count} ${plural(v.count, "крок", "кроки", "кроків")}`,
  "{count} steps": (v) => `${v.count} ${plural(v.count, "крок", "кроки", "кроків")}`,
  "Remove the tour: its file is deleted": "Прибрати тур: його файл видаляється",
  "Remove the tour {title}? Its file {directory}/{name}.json is deleted.": "Прибрати тур {title}? Його файл {directory}/{name}.json буде видалено.",
  "no tours yet in {directory}/": "у {directory}/ ще немає турів",
  "kept in {directory}/": "зберігаються в {directory}/",
  "a name of letters, digits, . - _ (it is the file's name)": "назва з літер, цифр, . - _ (це назва файлу)",

  // ── panel.ts ───────────────────────────────────────────────────────────────
  // ("copy" is index.html's, in i18n-uk.ts.)
  "Open the function's view": "Відкрити подання функції",
  "Open the module's view": "Відкрити подання модуля",
  "The module's functions": "Функції модуля",
  "loading…": "завантаження…",
  "could not read its functions": "не вдалося прочитати його функції",
  "Show the code": "Показати код",
  "no function of its own": "власних функцій немає",
  "copied {size}": "скопійовано {size}",
  "copy failed": "не скопійовано",
  "Mermaid source": "Код Mermaid",
  "Open this view": "Відкрити це подання",
  "reading {place}…": "читається {place}…",
  "since {since}:": "від {since}:",
  "this file is as it was": "файл такий, як був",
  // Lines of code (рядки), not the lines of a picture (лінії): the word turns on how many came and went together.
  "+{added} −{removed} line": (v) => `+${v.added} −${v.removed} ${plural(Number(v.added) + Number(v.removed), "рядок", "рядки", "рядків")}`,
  "+{added} −{removed} lines": (v) => `+${v.added} −${v.removed} ${plural(Number(v.added) + Number(v.removed), "рядок", "рядки", "рядків")}`,
  "{shape} stands for no single file: there is no code to show for it. Its page is on the Markdown tab.": "{shape} не відповідає одному файлу: коду для цієї фігури немає. Її сторінка — на вкладці Markdown.",

  // ── picking.ts ─────────────────────────────────────────────────────────────
  // ("explain" is index.html's, in i18n-uk.ts.)
  // The mark is the diagram's word (added, removed, changed…), said here in the page's.
  "_{mark} in this change._": (v) => `_У цій зміні: ${MARKS[String(v.mark)] ?? v.mark}._`,
  "## Commits that touched it": "## Коміти, що змінювали цей файл",
  "imported or called by this shape: click picks it here, Shift+click opens its own view, ← → walk the neighbours": "його імпортує або викликає ця фігура: клік обирає його тут, Shift+клік відкриває його власне подання, ← → обходять сусідів",
  "imports or calls this shape: click picks it here, Shift+click opens its own view, ← → walk the neighbours": "імпортує або викликає цю фігуру: клік обирає його тут, Shift+клік відкриває його власне подання, ← → обходять сусідів",
  "{count} in:": (v) => `${v.count} ${plural(v.count, "вхідна", "вхідні", "вхідних")}:`,
  "{count} out:": (v) => `${v.count} ${plural(v.count, "вихідна", "вихідні", "вихідних")}:`,
  "{id}: imports or calls this shape beyond this picture — click opens its own picture, Shift+click everything joined to it": "{id}: імпортує або викликає цю фігуру за межами цієї діаграми — клік відкриває його власну діаграму, Shift+клік — усе, що з ним пов'язане",
  "{id}: imported or called by this shape beyond this picture — click opens its own picture, Shift+click everything joined to it": "{id}: його імпортує або викликає ця фігура за межами цієї діаграми — клік відкриває його власну діаграму, Shift+клік — усе, що з ним пов'язане",
  "Past the depth of this picture: the next step of depth, or the shape's focus view, draws them": "За межами глибини цієї діаграми: їх намалює наступний крок глибини або фокус-подання фігури",
  "beyond ◂ {count}:": "за межами ◂ {count}:",
  "beyond {count} ▸:": "за межами {count} ▸:",
  "+{count} more (the Markdown lists them)": "ще {count} (усі є в Markdown)",
  "{count} selected:": "виділено {count}:",
  "Centre on it; Shift+click takes it out of the selection": "Центрувати на ній; Shift+клік прибирає її з виділення",
  "Ask the agent about the selected shapes (the Chat tab): their code and calls go along as context": "Запитати агента про виділені фігури (вкладка Чат): їхній код і виклики йдуть разом як контекст",
  "ask about them": "запитати про них",
  "Have the agent explain the selected shapes as a tour: steps through the pictures, each with what it shows and why": "Попросити агента пояснити виділені фігури як тур: кроки діаграмами, кожен із тим, що він показує і чому",
  "Dim everything but the selected shapes and their neighbours": "Приглушити все, крім виділених фігур та їхніх сусідів",
  "dim others": "приглушити інші",
  "Clear the selection (Esc)": "Зняти виділення (Esc)",
  "clear": "очистити",
  "# {count} shapes selected": (v) => `# Виділено ${v.count} ${plural(v.count, "фігуру", "фігури", "фігур")}`,
  "## Lines among them ({count})": "## Лінії між ними ({count})",
  "none in this picture": "на цій діаграмі жодної",
  "_Shift+tap or Ctrl+tap adds or removes a shape; **ask about them** sends them to the agent; **dim others** keeps their neighbourhood._": "_Shift+клік або Ctrl+клік додає чи прибирає фігуру; **запитати про них** надсилає їх агентові; **приглушити інші** лишає їхнє оточення._",
  "# Path: {shapes}": "# Шлях: {shapes}",
  "- no chain of lines joins {from} and {to} in this picture": "- на цій діаграмі жоден ланцюжок ліній не з'єднує {from} і {to}",
  "# Chain: {from} → {to}": "# Ланцюжок: {from} → {to}",
  "No chain of lines joins them in this picture, in either direction.": "На цій діаграмі їх не з'єднує жоден ланцюжок ліній, у жодному напрямку.",
  "{count} line": (v) => `${v.count} ${plural(v.count, "лінія", "лінії", "ліній")}`,
  "{count} lines": (v) => `${v.count} ${plural(v.count, "лінія", "лінії", "ліній")}`,
  ", read against the arrows where needed": ", де потрібно — проти стрілок",
  "## Chain onward ({lines} lines, {shapes} shapes)": (v) => `## Ланцюжок далі (${v.lines} ${plural(v.lines, "лінія", "лінії", "ліній")}, ${v.shapes} ${plural(v.shapes, "фігура", "фігури", "фігур")})`,
  "Nothing leads on from here in this view.": "У цьому поданні звідси ніщо далі не веде.",
  "- … cut at 300 lines": "- … обрізано на 300 лініях",
  "{count} lines under the tap:": (v) => `${v.count} ${plural(v.count, "лінія", "лінії", "ліній")} під кліком:`,
  "Show this line ({kind})": "Показати цю лінію ({kind})",
  "Light only this line again": "Знову підсвітити лише цю лінію",
  "Light every line and shape the arrows lead on to from here (Shift+tap does the same)": "Підсвітити всі лінії та фігури, до яких звідси ведуть стрілки (Shift+клік робить те саме)",
  "stop following": "не простежувати",
  "follow →": "простежити →",
  "{shape}: nothing opens from this shape — a tap shows it on the right, a right click lists its other pictures": "{shape}: із цієї фігури нічого не відкривається — клік показує її праворуч, правий клік — перелік інших її діаграм",

  // ── settings.ts ────────────────────────────────────────────────────────────
  // ("the page is drawn again…" and "remove" are in i18n-uk.ts.)
  "What is started for it": "Що для нього запускається",
  "not installed": "не встановлено",
  "{name}: kept": "{name}: збережено",
  "from archdiff.json or --agent": "з archdiff.json або --agent",
  ", resumes by {flag}": ", продовжує через {flag}",
  "Take this agent out of the settings": "Прибрати цього агента з налаштувань",
  "{name}: removed": "{name}: прибрано",
  "The program itself, when it is not found by its name: its full path": "Сама програма, якщо вона не знаходиться за назвою: повний шлях до неї",
  "program": "програма",
  "found by its name: {program}": "знаходиться за назвою: {program}",
  "The model it is told to use; empty: its own": "Модель, яку йому задано використовувати; порожньо — його власна",
  "model": "модель",
  "its own, or openrouter/…": "власна або openrouter/…",
  "its own": "власна",
  "Run Claude Code on OpenRouter's key (OPENROUTER_API_KEY) instead of Anthropic's own": "Запускати Claude Code з ключем OpenRouter (OPENROUTER_API_KEY) замість власного ключа Anthropic",
  "through OpenRouter": "через OpenRouter",
  "set, empty": "задано, порожній",
  "set {hint}": "задано {hint}",
  "Take this key out of the settings": "Прибрати цей ключ із налаштувань",
  "{name}: forgotten": "{name}: забуто",
  "forget": "забути",
  "from the environment archdiff was started in": "із середовища, в якому запущено archdiff",
  "⚠ name the key: the environment variable the agent reads it from": "⚠ назвіть ключ: змінну середовища, з якої агент його читає",
  "{name}: set": "{name}: задано",
  "{name}: added": "{name}: додано",

  // ── busy.ts ────────────────────────────────────────────────────────────────
  "Loading": "Завантаження",

  // ── api.ts ─────────────────────────────────────────────────────────────────
  "cannot read {path}": "не вдалося прочитати {path}",
};
