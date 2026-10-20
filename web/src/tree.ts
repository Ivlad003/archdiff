// The folder tree of the repository, on the left in place of the views
// list: the layers, their directories as folders, the modules as files,
// and a module's functions once it is opened (read from its `inside`
// picture then, modules.ts). A tap on an entry opens its view with the
// presentation the link shows — in the Markdown presentation the pages
// read like a book with this as its table of contents; the entry of the
// current view is lit and the folders above it are opened; the files the
// picture shown now is of carry a dot, and the list can be cut to them.
// Which folders are open is remembered in this browser. The filter of the
// views (`v`) finds entries here too, and shows a match with the folders
// above it open.
//
// Entry points: `renderTree`, `treeState` (for the browser tests).

import type { ViewEntry } from "./api.ts";
import { h } from "./dom.ts";
import { currentLink, setLink } from "./link.ts";
import { fnView, functionsOf, type Fn } from "./modules.ts";
import { parseView } from "../../src/view-keys.ts";

/** A folder of the tree: a layer, or a directory under it (its view when the repository has one of it). */
interface Folder {
  kind: "layer" | "dir";
  key: string;
  label: string;
  view: string | null;
  children: Entry[];
}

/** A module of the tree, under its directory. */
interface File {
  kind: "module";
  key: string;
  label: string;
  path: string;
  view: string;
}

type Entry = Folder | File;

/** Where this browser keeps the open folders and modules, by their keys. */
const OPEN_KEY = "archdiff.tree.v1";

const open = new Set<string>(readOpen());
/** The functions of the modules opened so far, by module path; null while they load. */
const functions = new Map<string, Fn[] | null>();

function readOpen(): string[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");

    return Array.isArray(kept) ? kept.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function rememberOpen(): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    // No storage: the folders close on the next load.
  }
}

/** The tree of the views list: each layer, the directories of its modules as folders, the modules as files, sorted by path. */
function treeOf(views: readonly ViewEntry[]): Folder[] {
  const keys = new Set(views.map((entry) => entry.key));
  const layers = views.filter((entry) => entry.kind === "layer").map((entry): Folder => ({ kind: "layer", key: entry.key, label: entry.title, view: entry.key, children: [] }));
  const byLayer = new Map(layers.map((layer) => [layer.label, layer]));

  for (const entry of views.filter((candidate) => candidate.kind === "module").sort((a, b) => (a.title < b.title ? -1 : 1))) {
    const path = entry.title;
    const layer = byLayer.get(entry.layer ?? "") ?? layers.find((candidate) => candidate.label === entry.layer);

    if (!layer) continue;
    // The directories above the module, each a folder (made on the way), the module a file in the last.
    const parts = path.split("/");
    let at: Folder = layer;

    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join("/");
      const key = `${layer.key}/${dir}`;
      let folder = at.children.find((child): child is Folder => child.kind === "dir" && child.key === key);

      if (!folder) {
        folder = { kind: "dir", key, label: `${parts[depth - 1]}/`, view: keys.has(`dir:${dir}`) ? `dir:${dir}` : null, children: [] };
        at.children.push(folder);
      }

      at = folder;
    }

    at.children.push({ kind: "module", key: `${layer.key}/${path}`, label: parts[parts.length - 1]!, path, view: entry.key });
  }

  return layers;
}

/** The module the current view is of (the subject's file), and the function when the view is one function's. */
function current(): { module: string | null; fn: string | null } {
  const view = parseView(currentLink().view);
  const subject = view?.subject ?? null;

  if (subject === null || !/\.[a-z0-9]+(#|$)/i.test(subject)) return { module: null, fn: null };
  const hash = subject.indexOf("#");

  return { module: hash === -1 ? subject : subject.slice(0, hash), fn: hash === -1 ? null : subject };
}

/** The functions of a module, read once (modules.ts); the tree is drawn again when they arrive. */
function loadFunctions(path: string, redraw: () => void): void {
  if (functions.has(path)) return;
  functions.set(path, null);
  void functionsOf(path).then((own) => {
    functions.set(path, own);
    redraw();
  });
}

/** Whether an entry, or one under it, is shown: it matches the filter, and, with the picture's files alone asked for, is one of them. */
function shown(entry: Entry, needle: string, picture: ReadonlySet<string> | null): boolean {
  if (entry.kind === "module") return (needle === "" || entry.path.toLowerCase().includes(needle)) && (picture === null || picture.has(entry.path));

  if (picture !== null && !entry.children.some((child) => shown(child, "", picture))) return false;

  return needle === "" || entry.label.toLowerCase().includes(needle) || entry.children.some((child) => shown(child, needle, picture));
}

/**
 * The tree into `list`: the layers, their folders and files, the functions of the opened modules; filtered by
 * `needle` (a match shows with the folders above it open) and, when `pictureOnly`, cut to the files of the picture
 * shown now (`inPicture`), which carry a dot either way; the entry of the current view lit, its folders opened.
 */
export function renderTree(list: HTMLElement, views: readonly ViewEntry[], needle: string, inPicture: ReadonlySet<string> = new Set(), pictureOnly = false): void {
  const keys = new Set(views.map((entry) => entry.key));
  const now = current();
  const picture = pictureOnly ? inPicture : null;
  const redraw = (): void => renderTree(list, views, needle, inPicture, pictureOnly);
  list.replaceChildren();

  // The folders above the current module open, so the lit entry is in sight.
  const openTo = (entries: readonly Entry[]): boolean => {
    for (const entry of entries) {
      if (entry.kind === "module" ? entry.path === now.module : openTo(entry.children)) {
        if (entry.kind !== "module") open.add(entry.key);

        return true;
      }
    }

    return false;
  };

  if (now.module !== null) openTo(treeOf(views));

  const row = (depth: number, caret: string | null, icon: string, label: string, active: boolean, onTap: (() => void) | null, onCaret: (() => void) | null, title: string, marked = false): HTMLElement => {
    const line = h("div", { class: `tree-row${active ? " active" : ""}${onTap ? "" : " plain"}${marked ? " in-picture" : ""}`, style: `padding-left: ${8 + depth * 14}px`, title });
    const toggle = h("span", { class: "caret" }, caret ?? "");

    if (onCaret) {
      toggle.classList.add("live");
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        onCaret();
      });
    }

    line.append(toggle, h("span", { class: "icon" }, icon), h("span", { class: "label" }, label));

    if (onTap) line.addEventListener("click", onTap);
    else if (onCaret) line.addEventListener("click", onCaret);

    return line;
  };

  const toggle = (key: string): void => {
    if (open.has(key)) open.delete(key);
    else open.add(key);
    rememberOpen();
    redraw();
  };

  const openView = (view: string): void => setLink({ ...currentLink(), view });

  const draw = (entries: readonly Entry[], depth: number): void => {
    for (const entry of entries) {
      if (!shown(entry, needle, picture)) continue;
      // With a filter every folder on the way to a match is open; without one, the ones the reader opened.
      const isOpen = needle !== "" || picture !== null || open.has(entry.key);

      if (entry.kind === "module") {
        const own = functions.get(entry.path);
        const listed = isOpen && own !== undefined;
        const marked = inPicture.has(entry.path);
        list.append(row(depth, isOpen ? "▾" : "▸", marked ? "●" : "▫", entry.label, now.module === entry.path && now.fn === null, () => openView(entry.view), () => {
          if (!open.has(entry.key)) loadFunctions(entry.path, redraw);
          toggle(entry.key);
        }, `${entry.path}${marked ? " — in the picture shown now" : ""} — tap for the module's view, the caret for its functions`, marked));

        if (isOpen && own === undefined) loadFunctions(entry.path, redraw);

        if (listed && own === null) list.append(row(depth + 1, null, "…", "loading", false, null, null, ""));

        if (listed && own) for (const fn of own) list.append(row(depth + 1, null, "ƒ", fn.name, now.fn === fn.id, () => openView(fnView(fn.id, keys)), null, `${fn.id}:${fn.line} — its call tree, its logic or everything joined to it`));
        continue;
      }

      const onTap = entry.view === null ? null : (): void => openView(entry.view!);
      list.append(row(depth, isOpen ? "▾" : "▸", entry.kind === "layer" ? "▣" : "▭", entry.label, false, onTap, () => toggle(entry.key), entry.kind === "layer" ? `layer ${entry.label} — tap for its picture, the caret to fold it` : `${entry.label} ${entry.view ? "— tap for the directory's picture, " : "— no picture of its own, "}the caret to fold it`));

      if (isOpen) draw(entry.children, depth + 1);
    }
  };

  draw(treeOf(views), 0);

  if (list.childElementCount === 0) list.append(h("li", { class: "muted" }, picture !== null && picture.size === 0 ? "no file in the picture yet" : needle === "" ? "no modules" : "nothing matches"));
}

/** For the browser tests: the open keys, and the rows shown. */
export function treeState(list: HTMLElement): { open: string[]; rows: string[] } {
  return { open: [...open], rows: [...list.querySelectorAll<HTMLElement>(".tree-row .label")].map((label) => label.textContent ?? "") };
}
