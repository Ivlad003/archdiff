// The side panel: the picture archdiff draws of what the tab beside it shows
// on GitHub. It follows the active tab of its window — a pull request, a
// comparison, a branch, a commit, a file — finds the archdiff that serves
// that repository on this computer (servers.ts), asks what the checkout has
// of the change (target.ts) and frames the server's own page on the picture
// that fits, the picture alone (`?embed=1&host=1`) unless the whole page is
// asked for. A shape tapped on the picture sends the tab to that file on
// GitHub: in the list of the change's files when the change touched it,
// else at the head's revision (github.ts).
//
// The panel draws nothing itself and writes nothing: every request to the
// server is a GET, and the server takes no other from a page that is not
// its own. What it keeps (the picture chosen for each kind of page, the
// addresses added, whether the whole page is shown) is in the extension's
// own storage.
//
// `panel.html?url=<address>` pins the panel to one address instead of the
// active tab, and `&server=<address>` adds a server to ask: a panel opened
// as a page of its own, and the tests.
//
// Entry point: loaded by panel.html.

import { isPlace, placeOnGitHub } from "./github.ts";
import { pageOf, type RepositoryPage } from "./hosts.ts";
import { pullEnds, type PullEnds } from "./pull.ts";
import { candidates, localOrigin, serving, type Search, type Served } from "./servers.ts";
import { resolve, type Checkout, type Picture, type Subject, type Target } from "./target.ts";

/** A text of the panel in the browser's language (`_locales/`), its `$1`… filled in. */
function say(name: string, ...filled: string[]): string {
  return chrome.i18n.getMessage(name, filled) || name;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const query = new URLSearchParams(location.search);
/** The address the panel is pinned to; null: it follows the active tab. */
const pinned = query.get("url");

// ── What the panel keeps ─────────────────────────────────────────────────────

interface Kept {
  /** The whole page of archdiff, not the picture alone. */
  whole: boolean;
  /** The picture chosen last for each kind of subject (`pull`, `branch`…), by its name. */
  chosen: Record<string, string>;
  /** The addresses the reader added to those asked for a server. */
  servers: string[];
}

const KEPT = "archdiff";
let kept: Kept = { whole: false, chosen: {}, servers: [] };

async function readKept(): Promise<void> {
  const stored = (await chrome.storage.local.get(KEPT))[KEPT] as Partial<Kept> | undefined;

  kept = { whole: stored?.whole === true, chosen: typeof stored?.chosen === "object" && stored.chosen !== null ? { ...stored.chosen } : {}, servers: Array.isArray(stored?.servers) ? stored.servers.filter((server): server is string => typeof server === "string") : [] };
}

function keep(): void {
  chrome.storage.local.set({ [KEPT]: kept }).catch((error: unknown) => console.error("archdiff:", error));
}

// ── The checkout, asked through its server ───────────────────────────────────

async function get<T>(origin: string, path: string, params: [string, string][]): Promise<T> {
  const response = await fetch(`${origin}${path}?${new URLSearchParams(params).toString()}`);
  const answer = (await response.json()) as T & { error?: string };

  if (!response.ok) throw new Error(typeof answer.error === "string" ? answer.error : `${path}: ${response.status}`);

  return answer;
}

/** The files that are modules among the views a server lists. */
function modulesOf(views: readonly { key: string }[]): Set<string> {
  return new Set(views.flatMap((view) => (view.key.startsWith("module:") ? [view.key.slice("module:".length)] : [])));
}

function checkoutOf(origin: string): Checkout {
  return {
    branches: async () => {
      const answer = await get<{ branches: { name: string }[]; base: string | null }>(origin, "/api/branches", []);

      return { names: answer.branches.map((branch) => branch.name), mainLine: answer.base };
    },
    refs: async (refs, range) => {
      const answer = await get<{ refs: { ref: string; commit: string | null }[]; fork: string | null }>(origin, "/api/refs", [...refs.map((ref): [string, string] => ["ref", ref]), ...(range ? ([["base", range.base], ["head", range.head]] as [string, string][]) : [])]);

      return { commits: new Map(answer.refs.map(({ ref, commit }) => [ref, commit])), fork: answer.fork };
    },
    modules: async (head) => modulesOf((await get<{ views: { key: string }[] }>(origin, "/api/views", head === null ? [] : [["head", head]])).views),
  };
}

/** The files a change touched, as the server reads the change; none when it cannot (a first commit has no parent to read it against). */
async function changedFiles(origin: string, range: { base: string | null; head: string }): Promise<Set<string>> {
  try {
    const answer = await get<{ views: { key: string }[]; changed: object | null }>(origin, "/api/views", [["changed", "1"], ["head", range.head], ...(range.base === null ? [] : ([["base", range.base]] as [string, string][]))]);

    // Without the count the server could not read the change, and lists every view.
    return answer.changed === null ? new Set() : modulesOf(answer.views);
  } catch {
    return new Set();
  }
}

// ── What is shown ────────────────────────────────────────────────────────────

/** The picture in the frame, and what it is of. */
interface Showing {
  /** What of GitHub it answers: the repository and what its page shows, whatever tab of the page is open. */
  subject: string;
  served: Served;
  target: Target;
  picture: Picture;
  /** The files of the change, asked once, when a place is first tapped. */
  changed: Promise<Set<string>> | null;
}

let showing: Showing | null = null;
/** The address the tab was last seen at, and the tab. */
let seen: { address: string | null; tab: number | null } = { address: null, tab: null };
/** The address the panel itself sent the tab to: arriving there is no reason to draw another picture. */
let sent: string | null = null;
/** The requests so far: an answer a newer request overtook is dropped. */
let asked = 0;

const frame = element<HTMLIFrameElement>("page");
const card = element("card");
const pictures = element<HTMLSelectElement>("picture");

/** The same page of GitHub, whatever its query and its hash. */
function sameAddress(one: string, other: string): boolean {
  const plain = (address: string): string => address.replace(/[?#].*$/, "").replace(/\/+$/, "");

  return plain(one) === plain(other);
}

/** What a page is of, without the tab of it that is open: a pull request is one subject on its conversation and on its files. */
function subjectOf(page: RepositoryPage): string {
  return JSON.stringify([page.host, page.owner.toLowerCase(), page.repo.toLowerCase(), page.shown.kind === "pull" ? { kind: "pull", number: page.shown.number } : page.shown]);
}

function titleOf(subject: Subject): string {
  switch (subject.kind) {
    case "pull":
      return say("subject_pull", String(subject.number), subject.base, subject.head);
    case "compare":
      return say("subject_compare", subject.base ?? say("default_branch"), subject.head);
    case "branch":
      return subject.ref;
    case "file":
      return say("subject_file", subject.path, subject.ref);
    case "commit":
      return say("subject_commit", subject.sha.slice(0, 7));
    case "checkout":
      return say("subject_checkout");
  }
}

/** The address of the server's page on a picture: the picture alone, hosted, unless the whole page is asked for. */
function frameAddress(origin: string, hash: string): string {
  return `${origin}/${kept.whole ? "" : "?embed=1&host=1"}#${hash}`;
}

function setTitle(repository: string, subject: string): void {
  element("repository").textContent = repository;
  element("subject").textContent = subject;
  element("subject").title = subject;
}

function showCommand(command: string | null): void {
  element("command-row").hidden = command === null;
  element("command").textContent = command ?? "";
}

/** A card in place of the picture: nothing to draw, no server, commits to fetch, a failure. */
function showCard(state: string, title: string, text: string, options: { command?: string; search?: Search; again?: boolean } = {}): void {
  showing = null;
  document.body.dataset["state"] = state;
  frame.hidden = true;
  frame.removeAttribute("src");
  card.hidden = false;
  pictures.hidden = true;
  element("open-tab").hidden = true;
  element("note").hidden = true;
  element("card-title").textContent = title;
  element("card-text").textContent = text;
  showCommand(options.command ?? null);
  element("card-again").hidden = options.again === false;
  const found = element("card-found");
  const search = options.search;
  found.replaceChildren();
  found.hidden = !search || (search.found.length === 0 && search.old.length === 0);
  element("address-row").hidden = !search;

  if (search) {
    if (search.found.length > 0) found.append(Object.assign(document.createElement("li"), { className: "heading", textContent: say("noserver_found") }));

    for (const served of search.found) found.append(Object.assign(document.createElement("li"), { textContent: say("found_item", served.origin.replace(/^http:\/\//, ""), served.root, served.remotes.map((remote) => `${remote.host}/${remote.path}`).join(", ") || say("no_remote")) }));

    for (const origin of search.old) found.append(Object.assign(document.createElement("li"), { textContent: say("noserver_old", origin.replace(/^http:\/\//, "")) }));
  }
}

/** The picture of a target in the frame: the one chosen last for its kind of subject, else its first. */
function draw(page: RepositoryPage, served: Served, target: Target): void {
  const picture = target.pictures.find((candidate) => candidate.name === kept.chosen[target.subject.kind]) ?? target.pictures[0]!;

  showing = { subject: subjectOf(page), served, target, picture, changed: null };
  document.body.dataset["state"] = "showing";
  card.hidden = true;
  frame.hidden = false;
  pictures.hidden = false;
  element("open-tab").hidden = false;
  setTitle(`${page.owner}/${page.repo}`, titleOf(target.subject));
  pictures.replaceChildren(...target.pictures.map((candidate) => Object.assign(document.createElement("option"), { value: candidate.name, textContent: say(`picture_${candidate.name}`), selected: candidate === picture })));
  element("note").hidden = target.stale === null;
  element("note-text").textContent = target.stale === null ? "" : say("stale");
  element("note-command").textContent = target.stale ?? "";
  point(frameAddress(served.origin, picture.hash));
}

/** Points the frame at an address of the server: one that differs from the page there by its hash alone changes the view where it is, any other loads the page. */
function point(address: string): void {
  frame.src = address;
  document.body.dataset["frame"] = address;
}

/** The server that served each repository last: asked first, alone, before every port is. */
const lastServer = new Map<string, string>();
/** The ends of the pull requests read lately: a tab come back to is not asked of GitHub again, which answers sixty times an hour without a sign-in. */
const readPulls = new Map<string, { at: number; ends: PullEnds }>();
const PULL_KEPT = 120_000;

/** Looks at an address of the tab and shows what fits it. `again`: asked for by the reader, whatever is shown already. */
async function look(address: string | null, again = false): Promise<void> {
  const page = address === null ? null : pageOf(address);

  if (!page || address === null) {
    asked++;
    setTitle("", "");

    return showCard("idle", say("idle_title"), say("idle_text"), { again: false });
  }

  if (!again) {
    // The tab went where a tapped shape sent it: the picture it was tapped on stays.
    if (sent !== null && sameAddress(address, sent)) return;

    // Another tab of the same subject (a pull request's files after its conversation), or its hash alone. A look
    // under way for a page the tab has left again is dropped: what is shown is what the tab shows.
    if (showing !== null && showing.subject === subjectOf(page)) {
      asked++;
      document.body.dataset["state"] = "showing";

      return setTitle(`${page.owner}/${page.repo}`, titleOf(showing.target.subject));
    }
  }

  sent = null;
  const mine = ++asked;
  const repository = `${page.owner}/${page.repo}`;
  setTitle(repository, say("looking"));
  document.body.dataset["state"] = "looking";

  const key = `${page.host}/${repository}`.toLowerCase();

  try {
    const last = lastServer.get(key);
    let search = last === undefined ? null : await serving(page, [last], (target, init) => fetch(target, init));

    if (!search?.match) search = await serving(page, candidates([...query.getAll("server"), ...kept.servers]), (target, init) => fetch(target, init));

    if (mine !== asked) return;

    if (!search.match) {
      setTitle(repository, "");

      return showCard("no-server", say("noserver_title", repository), say("noserver_text"), { command: "npx @ivlad003/archdiff web", search });
    }

    const { served, remote } = search.match;
    lastServer.set(key, served.origin);
    const pull = async (number: number): Promise<PullEnds | null> => {
      const read = readPulls.get(`${key}#${number}`);

      if (!again && read && Date.now() - read.at < PULL_KEPT) return read.ends;
      const ends = await pullEnds(page, number, (target, init) => fetch(target, init));

      if (ends) readPulls.set(`${key}#${number}`, { at: Date.now(), ends });

      return ends;
    };
    const resolution = await resolve(page, served, remote, checkoutOf(served.origin), pull);

    if (mine !== asked) return;

    if (resolution.kind === "show") return draw(page, served, resolution.target);
    setTitle(repository, resolution.kind === "missing" ? titleOf(resolution.subject) : `#${resolution.number}`);

    if (resolution.kind === "missing") return showCard("missing", say("missing_title", titleOf(resolution.subject)), say("missing_text", served.root), { command: resolution.command });

    return showCard("unread", say("unread_title", String(resolution.number)), say("unread_text"));
  } catch (error) {
    if (mine !== asked) return;
    setTitle(repository, "");
    showCard("failed", say("failed_title"), error instanceof Error ? error.message : String(error));
  }
}

// ── The page in the frame tells of a place: the tab goes there on GitHub ─────

window.addEventListener("message", (event) => {
  const now = showing;

  // Only the framed page, on the server's own origin, and only a place of the code.
  if (now === null || event.source !== frame.contentWindow || event.origin !== now.served.origin || !isPlace(event.data)) return;
  const place = event.data;
  const { range } = now.target;
  now.changed ??= now.target.where.changes === null || range === null ? Promise.resolve(new Set<string>()) : changedFiles(now.served.origin, range);
  void now.changed
    .then((changed) => placeOnGitHub(now.target.where, place, changed))
    .then((address) => {
      // A newer picture took this one's place while its files were asked.
      if (showing !== now) return;
      document.body.dataset["went"] = address;

      if (seen.tab === null) return;
      sent = address;

      return chrome.tabs.update(seen.tab, { url: address });
    })
    .catch((error: unknown) => console.error("archdiff:", error));
});

// ── The controls ─────────────────────────────────────────────────────────────

function copyFrom(source: string, button: string): void {
  element(button).addEventListener("click", () => {
    void navigator.clipboard.writeText(element(source).textContent ?? "").then(() => {
      element(button).textContent = say("copied");
      setTimeout(() => (element(button).textContent = say("copy")), 1200);
    });
  });
}

function wire(): void {
  for (const node of document.querySelectorAll<HTMLElement>("[data-say]")) node.textContent = say(node.dataset["say"]!);

  for (const node of document.querySelectorAll<HTMLElement>("[data-say-title]")) node.title = say(node.dataset["sayTitle"]!);
  element<HTMLInputElement>("address").placeholder = say("address_placeholder");
  element<HTMLInputElement>("whole").checked = kept.whole;

  pictures.addEventListener("change", () => {
    if (showing === null) return;
    const picture = showing.target.pictures.find((candidate) => candidate.name === pictures.value);

    if (!picture) return;
    kept.chosen[showing.target.subject.kind] = picture.name;
    keep();
    showing.picture = picture;
    point(frameAddress(showing.served.origin, picture.hash));
  });
  element<HTMLInputElement>("whole").addEventListener("change", (event) => {
    kept.whole = (event.target as HTMLInputElement).checked;
    keep();

    if (showing !== null) point(frameAddress(showing.served.origin, showing.picture.hash));
  });
  element("again").addEventListener("click", () => void look(seen.address, true));
  element("card-again").addEventListener("click", () => void look(seen.address, true));
  // The whole page of the picture, in a tab of its own.
  element("open-tab").addEventListener("click", () => {
    if (showing !== null) void chrome.tabs.create({ url: `${showing.served.origin}/#${showing.picture.hash}` });
  });
  element("builds").addEventListener("click", () => void chrome.tabs.create({ url: chrome.runtime.getURL(`builds/index.html?have=${encodeURIComponent(chrome.runtime.getManifest().version)}`) }));
  element<HTMLFormElement>("address-row").addEventListener("submit", (event) => {
    event.preventDefault();
    const field = element<HTMLInputElement>("address");
    const origin = localOrigin(field.value);
    element("address-wrong").hidden = origin !== null;

    if (origin === null) return;
    kept.servers = [...new Set([origin, ...kept.servers])].slice(0, 8);
    keep();
    field.value = "";
    void look(seen.address, true);
  });
  copyFrom("command", "command-copy");
  copyFrom("note-command", "note-copy");
}

// ── The tab the panel follows ────────────────────────────────────────────────

async function follow(): Promise<void> {
  // The window the panel is in: its tabs are the ones followed, whichever window has the focus.
  const own = (await chrome.windows.getCurrent()).id;
  const lookAtActive = async (): Promise<void> => {
    const [tab] = await chrome.tabs.query(own === undefined ? { active: true, currentWindow: true } : { active: true, windowId: own });

    seen = { address: tab?.url ?? null, tab: tab?.id ?? null };
    await look(seen.address);
  };

  chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId === own) void lookAtActive();
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url === undefined || !tab.active || tab.windowId !== own) return;
    seen = { address: change.url, tab: tabId };
    void look(seen.address);
  });
  await lookAtActive();
}

async function start(): Promise<void> {
  await readKept();
  wire();

  if (pinned === null) return follow();
  seen = { address: pinned, tab: null };
  await look(pinned);
}

void start();
