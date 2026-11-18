// The builds page: the builds of archdiff's extensions to download — the one
// for Chrome (a .zip to load unpacked) and the one for VS Code (a .vsix) —
// which no store carries. They are the files attached to the repository's
// releases on GitHub: one release per version of archdiff, and one that
// holds the build of master's last commit, replaced on every push
// (.github/workflows/builds.yml). The page asks GitHub's API for the
// releases when it is opened, so it is never behind them, and is served
// twice from these same files: by GitHub Pages, and inside the Chrome
// extension, which opens it with the version it carries (`?have=`) to say
// whether a newer build is out.
//
// On GitHub Pages it is also an app to install, on a phone too: sw.js keeps
// its files, and the last list of releases read is kept here, so without a
// network the page still opens with the versions it knew and says how old
// that list is. The downloads themselves need a connection.
//
// Plain JavaScript, with no build step. The functions that read GitHub's
// answer and keep it are pure and exported for the tests
// (chrome/tests/builds.test.ts); the rest draws, and runs in a browser only.
//
// Entry points: `buildOf`, `releasesOf`, `arranged`, `newerBuild`,
// `compareVersions`, `sizeText`, `remember`, `recalled`, `REPOSITORY`,
// `DEVELOPMENT_TAG`.

/** The repository whose releases hold the builds. */
export const REPOSITORY = "Ivlad003/archdiff";

/** The tag of the release that holds the build of master's last commit. */
export const DEVELOPMENT_TAG = "dev";

/**
 * @typedef {"chrome" | "vscode"} Kind
 * @typedef {{ kind: Kind, version: string, name: string, size: number, url: string }} Build
 * @typedef {{ tag: string, title: string, date: string, development: boolean, page: string, builds: Build[] }} Release
 */

/** The files that are builds, by their names: what each is, and the version its name carries. */
const NAMES = /** @type {const} */ ([
  ["chrome", /^archdiff-chrome-(\d+(?:\.\d+){0,3})\.zip$/],
  ["vscode", /^archdiff-vscode-(\d+(?:\.\d+){0,3})\.vsix$/],
]);

/**
 * The build a file attached to a release is; null for any other file.
 * @param {unknown} asset
 * @returns {Build | null}
 */
export function buildOf(asset) {
  if (typeof asset !== "object" || asset === null) return null;
  const { name, size, browser_download_url: url } = /** @type {Record<string, unknown>} */ (asset);

  if (typeof name !== "string" || typeof url !== "string") return null;

  for (const [kind, pattern] of NAMES) {
    const version = pattern.exec(name)?.[1];

    if (version !== undefined) return { kind, version, name, size: typeof size === "number" ? size : 0, url };
  }

  return null;
}

/**
 * Two versions compared number by number (`0.1.0.57` is after `0.1.0` and before `0.1.1`): negative, zero or positive.
 * @param {string} one
 * @param {string} other
 */
export function compareVersions(one, other) {
  const left = one.split(".").map(Number);
  const right = other.split(".").map(Number);

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);

    if (difference !== 0) return difference;
  }

  return 0;
}

/**
 * The releases that hold a build, newest first, from the answer of `GET /repos/{repository}/releases`; a draft is
 * nobody's to download, and a release with no build of an extension has nothing for this page.
 * @param {unknown} answer
 * @returns {Release[]}
 */
export function releasesOf(answer) {
  if (!Array.isArray(answer)) return [];
  /** @type {Release[]} */
  const releases = [];

  for (const release of answer) {
    if (typeof release !== "object" || release === null || release.draft === true || typeof release.tag_name !== "string") continue;
    const builds = (Array.isArray(release.assets) ? release.assets : []).map(buildOf).filter((/** @type {Build | null} */ build) => build !== null);

    if (builds.length === 0) continue;
    const kinds = NAMES.map(([kind]) => /** @type {string} */ (kind));
    builds.sort((/** @type {Build} */ one, /** @type {Build} */ other) => kinds.indexOf(one.kind) - kinds.indexOf(other.kind));
    const development = release.tag_name === DEVELOPMENT_TAG;
    const published = typeof release.published_at === "string" ? release.published_at : "";
    // The build of the last commit is one release whose files are replaced: its day is its newest file's, not the day it was first made.
    const date = development ? release.assets.reduce((/** @type {string} */ newest, /** @type {any} */ asset) => (typeof asset?.updated_at === "string" && asset.updated_at > newest ? asset.updated_at : newest), published) : published;
    releases.push({ tag: release.tag_name, title: typeof release.name === "string" && release.name !== "" ? release.name : release.tag_name, date, development, page: typeof release.html_url === "string" ? release.html_url : `https://github.com/${REPOSITORY}/releases`, builds });
  }

  return releases.sort((one, other) => other.date.localeCompare(one.date));
}

/**
 * The releases as the page lays them out: the newest version, the build of master's last commit, and the versions before.
 * @param {Release[]} releases
 * @returns {{ latest: Release | null, development: Release | null, earlier: Release[] }}
 */
export function arranged(releases) {
  const versions = releases.filter((release) => !release.development);

  return { latest: versions[0] ?? null, development: releases.find((release) => release.development) ?? null, earlier: versions.slice(1) };
}

/**
 * The build of a kind that is newer than the one a reader has: the newest version's when that is newer, else the
 * development build when that is; null when theirs is the newest there is.
 * @param {string} have
 * @param {Kind} kind
 * @param {{ latest: Release | null, development: Release | null }} releases
 * @returns {Build | null}
 */
export function newerBuild(have, kind, releases) {
  for (const release of [releases.latest, releases.development]) {
    const build = release?.builds.find((candidate) => candidate.kind === kind);

    if (build && compareVersions(build.version, have) > 0) return build;
  }

  return null;
}

/**
 * A size for people: `182 kB`, `1.4 MB`.
 * @param {number} bytes
 */
export function sizeText(bytes) {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} kB`;
}

/** Where the last list of releases read is kept in this browser. */
const SAVED_KEY = "archdiff.builds.releases";

/**
 * Keeps GitHub's answer for when it cannot be asked. Storage that is full or refused keeps nothing.
 * @param {Pick<Storage, "setItem"> | null} storage
 * @param {unknown} answer
 * @param {number} at
 */
export function remember(storage, answer, at) {
  if (!Array.isArray(answer)) return;

  try {
    storage?.setItem(SAVED_KEY, JSON.stringify({ at, answer }));
  } catch {
    // Nothing kept: the next visit without a network says the list could not be read.
  }
}

/**
 * The answer kept, and when it was read; null when there is none that can be read.
 * @param {Pick<Storage, "getItem"> | null} storage
 * @returns {{ at: number, answer: unknown[] } | null}
 */
export function recalled(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(SAVED_KEY) ?? "null");

    return Number.isFinite(saved?.at) && Array.isArray(saved?.answer) ? { at: saved.at, answer: saved.answer } : null;
  } catch {
    return null;
  }
}

// ── The page ─────────────────────────────────────────────────────────────────

/** The page's texts in Ukrainian, by their English; a text without one shows in English. */
const UK = /** @type {Record<string, string>} */ ({
  "archdiff — builds": "archdiff — білди",
  "Builds": "Білди",
  "The extensions of archdiff, built and ready to download. No store carries them: each is installed from its file.": "Розширення archdiff, зібрані й готові до завантаження. Їх немає в жодній крамниці: кожне встановлюється зі свого файла.",
  "Reading the builds from GitHub…": "Читаю білди з GitHub…",
  "Newest version": "Найновіша версія",
  "Build of the last commit": "Білд останнього коміту",
  "What master holds now, built on every push: newer than the newest version, and not a release.": "Те, що зараз у master, зібране після кожного push: новіше за найновішу версію, але не реліз.",
  "Earlier versions": "Попередні версії",
  "Chrome extension": "Розширення для Chrome",
  "VS Code extension": "Розширення для VS Code",
  "what changed": "що змінилося",
  "No builds yet": "Білдів ще немає",
  "The first ones are attached to the next version of archdiff. Until then an extension is built from the repository: its README says how.": "Перші з'являться з наступною версією archdiff. Доти розширення збирається з репозиторію: як саме, сказано в його README.",
  "The builds could not be read from GitHub": "Не вдалося прочитати білди з GitHub",
  "GitHub answers a browser that is not signed in sixty times an hour, and not at all offline. The same files are on the releases page:": "GitHub відповідає браузеру без входу шістдесят разів на годину, а без мережі — ніяк. Ті самі файли є на сторінці релізів:",
  "releases on GitHub": "релізи на GitHub",
  "You have build": "У вас білд",
  "It is the newest.": "Він найновіший.",
  "A newer one is out:": "Вийшов новіший:",
  "How to install": "Як встановити",
  "archdiff itself": "Сам archdiff",
  "The extensions draw nothing themselves: they show what the archdiff of your repository draws. It is an npm package (Node 22.18 or newer):": "Розширення самі нічого не малюють: вони показують те, що малює archdiff вашого репозиторію. Це npm-пакет (Node 22.18 або новіший):",
  "Unpack the .zip into a folder that stays where it is.": "Розпакуйте .zip у теку, яка залишатиметься на місці.",
  "Open chrome://extensions and turn on Developer mode (top right).": "Відкрийте chrome://extensions і ввімкніть Developer mode (угорі праворуч).",
  "Press Load unpacked and pick that folder.": "Натисніть Load unpacked і виберіть цю теку.",
  "Start archdiff web in your checkout, open the repository on GitHub and press the extension's button.": "Запустіть archdiff web у своєму checkout, відкрийте репозиторій на GitHub і натисніть кнопку розширення.",
  "To update: unpack the newer build over the same folder and press the reload arrow on the extension's card.": "Щоб оновити: розпакуйте новіший білд у ту саму теку і натисніть стрілку оновлення на картці розширення.",
  "In VS Code: the Extensions view, its … menu, Install from VSIX…, and pick the file. Or from a terminal:": "У VS Code: панель Extensions, меню …, Install from VSIX…, і виберіть файл. Або з термінала:",
  "the repository": "репозиторій",
  "the Chrome extension's README": "README розширення для Chrome",
  "the VS Code extension's README": "README розширення для VS Code",
  "Install": "Встановити",
  "Both extensions are installed on a computer. On a phone, this page keeps the list of versions at hand, also without a network.": "Обидва розширення встановлюються на комп'ютер. На телефоні ця сторінка тримає список версій під рукою, зокрема без мережі.",
  "GitHub cannot be reached right now. This list was saved on": "Зараз GitHub недоступний. Цей список збережено",
  "Downloads need a connection.": "Для завантаження потрібне з'єднання.",
});

/** @type {(text: string) => string} */
let say = (text) => text;

/**
 * @param {string} tag
 * @param {Record<string, string>} [properties]
 * @param {(Node | string)[]} [children]
 */
function make(tag, properties = {}, children = []) {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);

  return node;
}

/** @param {Kind} kind */
function kindText(kind) {
  return kind === "chrome" ? say("Chrome extension") : say("VS Code extension");
}

/** @param {string} date @param {string} language */
function dateText(date, language) {
  const read = new Date(date);

  return Number.isNaN(read.getTime()) ? "" : read.toLocaleDateString(language, { year: "numeric", month: "long", day: "numeric" });
}

/** @param {Build} build */
function downloadLink(build) {
  return make("a", { className: "download", href: build.url }, [make("strong", {}, [kindText(build.kind)]), make("span", {}, [`${build.version} · ${build.name.slice(build.name.lastIndexOf("."))} · ${sizeText(build.size)}`])]);
}

/** @param {Release} release @param {string} heading @param {string} language @param {string | null} note */
function releaseCard(release, heading, language, note) {
  const title = release.development ? dateText(release.date, language) : `${release.title} — ${dateText(release.date, language)}`;

  return make("section", { className: "card" }, [
    make("h2", {}, [heading]),
    make("p", { className: "muted" }, [title, " · ", make("a", { href: release.page }, [say("what changed")])]),
    ...(note === null ? [] : [make("p", { className: "muted" }, [note])]),
    make("div", { className: "downloads" }, release.builds.map(downloadLink)),
  ]);
}

/** @param {{ latest: Release | null, development: Release | null, earlier: Release[] }} releases @param {string} language @param {string | null} have @param {number | null} savedAt when the list was read, for one that is not fresh */
function draw(releases, language, have, savedAt) {
  const list = /** @type {HTMLElement} */ (document.getElementById("builds"));
  list.replaceChildren();

  if (savedAt !== null) list.append(make("p", { className: "have newer", id: "saved" }, [`${say("GitHub cannot be reached right now. This list was saved on")} ${dateText(new Date(savedAt).toISOString(), language).replace(/\.$/, "")}. ${say("Downloads need a connection.")}`]));

  if (have !== null) {
    const newer = newerBuild(have, "chrome", releases);
    list.append(make("p", { className: newer ? "have newer" : "have" }, [`${say("You have build")} ${have}. `, ...(newer ? [say("A newer one is out:"), " ", make("a", { href: newer.url }, [newer.name])] : [say("It is the newest.")])]));
  }

  if (releases.latest === null && releases.development === null) {
    list.append(make("section", { className: "card" }, [make("h2", {}, [say("No builds yet")]), make("p", { className: "muted" }, [say("The first ones are attached to the next version of archdiff. Until then an extension is built from the repository: its README says how.")])]));

    return;
  }

  if (releases.latest) list.append(releaseCard(releases.latest, say("Newest version"), language, null));

  if (releases.development) list.append(releaseCard(releases.development, say("Build of the last commit"), language, say("What master holds now, built on every push: newer than the newest version, and not a release.")));

  if (releases.earlier.length > 0) {
    list.append(
      make("details", { className: "card" }, [
        make("summary", {}, [say("Earlier versions")]),
        ...releases.earlier.map((release) => make("p", {}, [make("a", { href: release.page }, [release.title]), make("span", { className: "muted" }, [` — ${dateText(release.date, language)} · `]), ...release.builds.flatMap((build, index) => [index > 0 ? ", " : "", make("a", { href: build.url }, [build.name])])])),
      ]),
    );
  }
}

async function start() {
  const query = new URLSearchParams(location.search);
  const language = (query.get("lang") ?? navigator.language).toLowerCase().startsWith("uk") ? "uk" : "en";
  const have = /^\d+(\.\d+){0,3}$/.test(query.get("have") ?? "") ? query.get("have") : null;

  if (language === "uk") {
    say = (text) => UK[text] ?? text;
    document.documentElement.lang = "uk";
    document.title = say(document.title);

    for (const node of document.querySelectorAll("[data-say]")) node.textContent = say(node.textContent ?? "");
  }

  showConnection();
  window.addEventListener("offline", showConnection);
  window.addEventListener("online", () => {
    showConnection();
    void load(language, have);
  });
  offerInstall();
  await load(language, have);

  // On the page's own site only: inside the Chrome extension Chrome keeps the files itself.
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost")) await navigator.serviceWorker.register("sw.js").catch(() => undefined);
}

/** Marks the page while the browser has no network: what needs one is shown as out of reach. */
function showConnection() {
  document.documentElement.classList.toggle("offline", !navigator.onLine);
}

/** The browser's localStorage, or null where it is refused. */
function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Draws the releases as GitHub has them now, else as they were last read, else says why there are none. @param {string} language @param {string | null} have */
async function load(language, have) {
  const list = /** @type {HTMLElement} */ (document.getElementById("builds"));

  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`, { headers: { accept: "application/vnd.github+json" } });

    if (!response.ok) throw new Error(String(response.status));
    const answer = await response.json();
    remember(storage(), answer, Date.now());
    draw(arranged(releasesOf(answer)), language, have, null);
  } catch {
    const saved = recalled(storage());

    if (saved) draw(arranged(releasesOf(saved.answer)), language, have, saved.at);
    else {
      list.replaceChildren(
        make("section", { className: "card" }, [
          make("h2", {}, [say("The builds could not be read from GitHub")]),
          make("p", { className: "muted" }, [say("GitHub answers a browser that is not signed in sixty times an hour, and not at all offline. The same files are on the releases page:"), " ", make("a", { href: `https://github.com/${REPOSITORY}/releases` }, [say("releases on GitHub")])]),
        ]),
      );
    }
  }

  document.body.dataset["state"] = "drawn";
}

/** Shows the page's install button once the browser says the page can be installed. */
function offerInstall() {
  const button = /** @type {HTMLButtonElement} */ (document.getElementById("install"));
  /** @type {any} */
  let offer = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    offer = event;
    button.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    offer = null;
    button.hidden = true;
  });
  button.addEventListener("click", () => {
    offer?.prompt();
    offer = null;
    button.hidden = true;
  });
}

if (typeof document !== "undefined") void start();
