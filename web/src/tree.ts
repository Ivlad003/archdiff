// The folder tree of the repository, on the left in place of the views
// list: the layers, their directories as folders, the modules as files,
// and a module's functions once the reader opens it (read from its
// `inside` picture then, modules.ts). A tap on an entry opens its view
// with the presentation the link shows — in the Markdown presentation the
// pages read like a book with this as its table of contents; the entry of
// the current view is lit (a layer's, a directory's, a module's, a
// function's, whose module opens for it) and the folders above it are
// opened; the files the picture shown now is of carry a dot, and the
// list can be cut to them. Which folders are open is remembered in this
// browser. The filter of the views (`v`) finds entries here too, and shows
// a match with the folders above it open; a list cut to a few files (the
// changed ones, the picture's) opens its folders the same way, the
// modules staying closed: a module's functions are read when the reader
// opens that module, never for a whole filter.
//
// Entry point: `renderTree`.

import type { ViewEntry } from "./api.ts";
import { h, rememberList, rememberedList } from "./dom.ts";
import { currentLink, setLink } from "./link.ts";
import { fnView, functionsOf, knownFunctions } from "./modules.ts";
import { parseView, subjectFile } from "../../src/view-keys.ts";

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

/** One row of the tree: where it sits, what it shows, what a tap and the caret do. */
interface Row {
  depth: number;
  caret: string | null;
  icon: string;
  label: string;
  title: string;
  active?: boolean;
  /** The row's file is in the picture shown now. */
  marked?: boolean;
  onTap?: () => void;
  onCaret?: () => void;
}

/** Where this browser keeps the open folders and modules, by their keys. */
const OPEN_KEY = "archdiff.tree.v1";

const open = new Set<string>(rememberedList(OPEN_KEY));
/** The modules whose functions are being read, and the ones whose read failed (asked again when their caret is pressed). */
const loading = new Set<string>();
const failed = new Set<string>();

/** The tree of the views list: each layer, the directories of its modules as folders, the modules as files, sorted by path. */
function treeOf(views: readonly ViewEntry[]): Folder[] {
  const keys = new Set(views.map((entry) => entry.key));
  const layers = views.filter((entry) => entry.kind === "layer").map((entry): Folder => ({ kind: "layer", key: entry.key, label: entry.title, view: entry.key, children: [] }));
  const byLayer = new Map(layers.map((layer) => [layer.label, layer]));

  for (const entry of views.filter((candidate) => candidate.kind === "module").sort((a, b) => (a.title < b.title ? -1 : 1))) {
    const path = entry.title;
    const layer = byLayer.get(entry.layer ?? "");

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
  const file = subjectFile(view);

  return { module: file?.file ?? null, fn: file && file.declaration !== null ? view!.subject : null };
}

/** The functions of a module read (modules.ts); the tree is drawn again when they arrive, or when the read failed. */
function loadFunctions(path: string, redraw: () => void): void {
  if (loading.has(path) || failed.has(path) || knownFunctions(path) !== undefined) return;
  loading.add(path);
  functionsOf(path)
    .catch(() => failed.add(path))
    .then(() => {
      loading.delete(path);
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
 * The tree into `list`: the layers, their folders and files, the functions of the modules the reader opened; filtered
 * by `needle` (a match shows with the folders above it open), cut to the files of the picture shown now when
 * `pictureOnly` (`inPicture`, whose files carry a dot either way); `cut` says the list itself was cut (the changed
 * files), so the folders open as for a filter. The entry of the current view is lit, its folders opened.
 */
export function renderTree(list: HTMLElement, views: readonly ViewEntry[], needle: string, inPicture: ReadonlySet<string> = new Set(), pictureOnly = false, cut = false): void {
  const keys = new Set(views.map((entry) => entry.key));
  const link = currentLink();
  const now = current();
  const picture = pictureOnly ? inPicture : null;
  const tree = treeOf(views);
  const redraw = (): void => renderTree(list, views, needle, inPicture, pictureOnly, cut);
  list.replaceChildren();

  // The folders above the current module open, so the lit entry is in sight; for a function's view the module opens too, to show the function.
  const openTo = (entries: readonly Entry[]): boolean => {
    for (const entry of entries) {
      if (entry.kind === "module" ? entry.path === now.module : openTo(entry.children)) {
        if (entry.kind !== "module" || now.fn !== null) open.add(entry.key);

        return true;
      }
    }

    return false;
  };

  if (now.module !== null) openTo(tree);

  const row = (spec: Row): HTMLElement => {
    const line = h("div", { class: `tree-row${spec.active ? " active" : ""}${spec.onTap ? "" : " plain"}${spec.marked ? " in-picture" : ""}`, style: `padding-left: ${8 + spec.depth * 14}px`, title: spec.title });
    const toggle = h("span", { class: "caret" }, spec.caret ?? "");

    if (spec.onCaret) {
      toggle.classList.add("live");
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        spec.onCaret!();
      });
    }

    line.append(toggle, h("span", { class: "icon" }, spec.icon), h("span", { class: "label" }, spec.label));

    if (spec.onTap) line.addEventListener("click", spec.onTap);
    else if (spec.onCaret) line.addEventListener("click", spec.onCaret);

    return line;
  };

  const toggle = (key: string): void => {
    if (open.has(key)) open.delete(key);
    else open.add(key);
    rememberList(OPEN_KEY, open);
    redraw();
  };

  const openView = (view: string): void => setLink({ ...currentLink(), view });

  const draw = (entries: readonly Entry[], depth: number): void => {
    for (const entry of entries) {
      if (!shown(entry, needle, picture)) continue;

      if (entry.kind === "module") {
        // A module opens on the reader's press alone: its functions are a read of its picture, never a filter's.
        const isOpen = open.has(entry.key);
        const own = knownFunctions(entry.path);
        const marked = inPicture.has(entry.path);
        list.append(row({ depth, caret: isOpen ? "▾" : "▸", icon: marked ? "●" : "▫", label: entry.label, active: now.module === entry.path && now.fn === null, marked, title: `${entry.path}${marked ? " — in the picture shown now" : ""} — tap for the module's view, the caret for its functions`, onTap: () => openView(entry.view), onCaret: () => {
          failed.delete(entry.path);
          toggle(entry.key);
        } }));

        if (!isOpen) continue;

        if (own === undefined) loadFunctions(entry.path, redraw);

        if (own === undefined) list.append(row({ depth: depth + 1, caret: null, icon: failed.has(entry.path) ? "!" : "…", label: failed.has(entry.path) ? "could not read its functions (press the caret again)" : "loading", title: "" }));
        else if (own.length === 0) list.append(row({ depth: depth + 1, caret: null, icon: "·", label: "no function of its own", title: "" }));
        else for (const fn of own) list.append(row({ depth: depth + 1, caret: null, icon: "ƒ", label: fn.name, active: now.fn === fn.id, title: `${fn.id}:${fn.line} — its call tree, its logic or everything joined to it`, onTap: () => openView(fnView(fn.id, keys)) }));
        continue;
      }

      // With a filter or a cut list every folder on the way to a match is open; without one, the ones the reader opened.
      const isOpen = needle !== "" || picture !== null || cut || open.has(entry.key);
      list.append(row({ depth, caret: isOpen ? "▾" : "▸", icon: entry.kind === "layer" ? "▣" : "▭", label: entry.label, active: entry.view !== null && entry.view === link.view, title: entry.kind === "layer" ? `layer ${entry.label} — tap for its picture, the caret to fold it` : `${entry.label} ${entry.view ? "— tap for the directory's picture, " : "— no picture of its own, "}the caret to fold it`, ...(entry.view === null ? {} : { onTap: () => openView(entry.view!) }), onCaret: () => toggle(entry.key) }));

      if (isOpen) draw(entry.children, depth + 1);
    }
  };

  draw(tree, 0);

  if (list.childElementCount === 0) list.append(h("li", { class: "muted" }, picture !== null && picture.size === 0 ? "no file in the picture yet" : needle === "" ? "no modules" : "nothing matches"));
}
