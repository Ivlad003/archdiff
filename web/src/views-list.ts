// The list of views on the left: every picture the repository has, in
// the groups the table of kinds names (the overviews first, then the
// subject views of each kind under its group), filtered as you type
// (`v`) — or, at the reader's choice (`t`, remembered), the repository as
// a folder tree (tree.ts); and the header's line with the repository's
// root and its numbers. The list is of the code the page shows: the
// link's head (a branch, a commit) or the working tree. `loadViews` asks
// the server again after every change of the code and of the head.
//
// Every entry of a file the picture shown now is of carries a dot, and
// the panel can be cut to those files (the toggle over the filter),
// in the lists and in the tree alike: where the diagram is, in the
// navigation.
//
// Entry points: `loadViews`, `viewEntries`, `renderViews`,
// `focusViewSearch`, `viewsStale`, `toggleTree`, `treeShown`,
// `togglePictureOnly`.

import { api, type ViewEntry } from "./api.ts";
import { element, remember, remembered } from "./dom.ts";
import { codeHead, currentLink, refsOf, setLink, type Link } from "./link.ts";
import { filesInPicture, isFilePath } from "./modules.ts";
import { page } from "./page.ts";
import { togglePanel } from "./panel.ts";
import { renderTree } from "./tree.ts";
import { listGroup, listGroups, parseView } from "../../src/view-keys.ts";

const list = element<HTMLUListElement>("views");
const search = element<HTMLInputElement>("search");

/** How many views of a group show unfiltered, and filtered: a long group (every module) shows its first; the filter finds the rest. */
const SHOWN = { all: 60, filtered: 400 };

let views: ViewEntry[] = [];
/** What the list holds the views of (`viewsKey`); undefined before the first load. */
let listed: string | undefined;
/** The left panel shows the repository as a folder tree rather than the lists of views; remembered in this browser. */
let tree = remembered("left-tree");

export function treeShown(): boolean {
  return tree;
}

/** The lists or the tree (`t`, or the switch at the top of the panel). */
export function toggleTree(force?: boolean): void {
  tree = force ?? !tree;
  remember("left-tree", tree);
  renderViews();
}

/** Only the files of the picture shown now, in the lists and the tree; remembered in this browser. */
let pictureOnly = remembered("left-picture");

export function togglePictureOnly(force?: boolean): void {
  pictureOnly = force ?? !pictureOnly;
  remember("left-picture", pictureOnly);
  renderViews();
}

/** The file a view's entry is of (`module:src/x.ts`, `calls:src/x.ts#f`), or null for an overview, a layer, a directory. */
function fileOf(entry: ViewEntry): string | null {
  const subject = parseView(entry.key)?.subject ?? null;

  if (subject === null || !isFilePath(subject)) return null;
  const hash = subject.indexOf("#");

  return hash === -1 ? subject : subject.slice(0, hash);
}

/** What a link asks the views of: the head, and with `changed` the base the changed files are counted from. */
function viewsKey(link: Link): string {
  return JSON.stringify([codeHead(link), link.changed, link.changed ? refsOf(link).base : null]);
}

/** Whether the list holds the views the link asks for; a load fetches them again otherwise. */
export function viewsStale(link: Link): boolean {
  return listed !== viewsKey(link);
}

export function viewEntries(): ViewEntry[] {
  return views;
}

export function renderViews(): void {
  const state = currentLink();
  const needle = search.value.trim().toLowerCase();
  // The files the picture shown now is of: their entries carry a dot; the toggle cuts the panel to them.
  const inPicture = filesInPicture(page.nodes());
  const pictureButton = element<HTMLButtonElement>("left-picture");
  pictureButton.textContent = `● ${inPicture.size} in picture`;
  pictureButton.classList.toggle("active", pictureOnly);
  pictureButton.title = pictureOnly ? "The files of the picture shown now alone; press for every file" : "The files of the picture shown now carry a dot; press to list them alone";

  for (const button of document.querySelectorAll<HTMLButtonElement>("#left-mode button[data-left]")) button.classList.toggle("active", (button.dataset["left"] === "tree") === tree);
  list.classList.toggle("tree", tree);

  if (tree) {
    renderTree(list, views, needle, inPicture, pictureOnly);

    return;
  }

  list.replaceChildren();
  const cap = needle === "" ? SHOWN.all : SHOWN.filtered;
  // Each view under the group its kind names (view-keys.ts): the overviews, then the groups in the table's order.
  const grouped = new Map<string, ViewEntry[]>(listGroups().map((label) => [label, []]));
  // With the picture's files alone: their entries, the overviews, and the layers and directories holding them.
  const layersInPicture = new Set(views.filter((entry) => entry.kind === "module" && inPicture.has(entry.title)).map((entry) => entry.layer));
  const inPictureEntry = (view: ViewEntry): boolean => {
    const file = fileOf(view);

    if (file !== null) return inPicture.has(file);
    const subject = parseView(view.key)?.subject ?? null;

    if (subject === null) return true;

    if (view.kind === "layer") return layersInPicture.has(subject);

    return view.kind === "dir" ? [...inPicture].some((candidate) => candidate.startsWith(`${subject}/`)) : true;
  };

  for (const view of views) {
    if (pictureOnly && !inPictureEntry(view)) continue;
    const parsed = parseView(view.key);
    const group = parsed ? listGroup(parsed) : null;

    if (group !== null) grouped.get(group)!.push(view);
  }

  for (const [label, all] of grouped) {
    const members = all.filter((view) => needle === "" || view.title.toLowerCase().includes(needle) || view.key.toLowerCase().includes(needle));

    if (members.length === 0) continue;
    const head = document.createElement("li");
    head.className = "group";
    head.textContent = `${label} (${members.length})`;
    list.append(head);

    for (const view of members.slice(0, cap)) {
      const item = document.createElement("li");
      item.textContent = view.title;
      item.title = view.key;
      item.classList.toggle("active", view.key === state.view);
      // The dot of a file of the picture shown now (page.css); the title stays the key, which the lookups by it read.
      const file = fileOf(view);
      item.classList.toggle("in-picture", file !== null && inPicture.has(file));
      item.addEventListener("click", () => setLink({ ...currentLink(), view: view.key }));
      list.append(item);
    }

    if (members.length > cap) {
      const more = document.createElement("li");
      more.className = "muted";
      more.textContent = `… ${members.length - cap} more: type to filter`;
      list.append(more);
    }
  }
}

/** The views and the numbers of the code the page shows (the link's head, or the working tree), the agent the server may run; the list drawn again. */
export async function loadViews(): Promise<void> {
  const link = currentLink();
  const head = codeHead(link);
  const response = await api.views(head, link.changed, link.changed ? refsOf(link).base : null);
  listed = viewsKey(link);
  views = response.views;
  element("root").textContent = response.root;
  element("root").title = response.root;
  const s = response.stats;
  // A server that cannot follow the code says so here: the pictures stay as they were until a reload.
  const notFollowing = response.watching.problem ? ` · ⚠ not following the code: ${response.watching.problem}` : "";
  // With the changed files alone: how many since which base, or why they could not be read (the list is whole then).
  const changed = response.changed ? `${response.changed.files} changed since ${response.changed.since} · ` : response.note ? `⚠ ${response.note} · ` : "";
  element("stats").textContent = `${head ? `at ${head} · ` : ""}${changed}${s.files} files · ${s.fns} functions · ${s.deps} imports · ${s.calls} calls · ${s.gaps} gaps · ${s.ms.total} ms${notFollowing}`;
  element("stats").title = element("stats").textContent;
  renderViews();
}

/** The filter of the views focused, the left panel shown (the `v` key). */
export function focusViewSearch(): void {
  togglePanel("left", false);
  search.focus();
  search.select();
}

search.addEventListener("input", () => renderViews());

for (const button of document.querySelectorAll<HTMLButtonElement>("#left-mode button[data-left]")) button.addEventListener("click", () => toggleTree(button.dataset["left"] === "tree"));
element<HTMLButtonElement>("left-picture").addEventListener("click", () => togglePictureOnly());
