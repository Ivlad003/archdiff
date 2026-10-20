// What the navigations share — the folder tree, the views list, the
// Markdown pages: the functions of a module, read once from its `inside`
// picture; the view a function opens; the files the picture shown now is
// of, which every navigation marks so the reader sees where the diagram
// is. Pure but for the one read of a module's picture; takes the page as
// its context (page.ts).
//
// Entry points: `functionsOf`, `fnView`, `filesInPicture`, `isFilePath`.

import { api, type Shape } from "./api.ts";
import { currentLink, refsOf } from "./link.ts";
import { DEFAULT_PICTURE_OPTIONS } from "../../src/options.ts";
import { moduleOfShape } from "../../src/shape-keys.ts";

/** A function of a module, as its inside picture lists it. */
export interface Fn {
  id: string;
  name: string;
  line: number;
}

/** The functions of the modules read so far, by module path. */
const functions = new Map<string, Promise<Fn[]>>();

/** The functions of a module, read once from its `inside` picture (its own functions, in the order of their lines). */
export function functionsOf(path: string): Promise<Fn[]> {
  let known = functions.get(path);

  if (!known) {
    known = api
      .scene(`inside:${path}`, { ...DEFAULT_PICTURE_OPTIONS, limit: 2000 }, refsOf(currentLink()))
      .then((result) => result.diagram.nodes.filter((node) => node.kind === "fn" && node.ref?.file === path).map((node): Fn => ({ id: node.id, name: node.label.split("\n")[0] ?? node.id, line: node.ref?.line ?? 0 })).sort((a, b) => a.line - b.line))
      .catch(() => []);
    functions.set(path, known);
  }

  return known;
}

/** The view a function opens: its call tree when it is an entry point, its logic when it branches, else everything joined to it. */
export function fnView(id: string, keys: ReadonlySet<string>): string {
  if (keys.has(`calls:${id}`)) return `calls:${id}`;

  if (keys.has(`logic:${id}`)) return `logic:${id}`;

  return `focus:${id}`;
}

/** A path of a source file of the five languages, alone or with a declaration after `#`. */
export function isFilePath(text: string): boolean {
  return /^[\w./@-]+\.(?:[cm]?[jt]sx?|py|rs|php)(?:#[\w.$]+)?$/.test(text);
}

/** The files the shapes of a picture are of: a module's, a function's or a class's, a participant's, the folded tail's. */
export function filesInPicture(nodes: ReadonlyMap<string, Shape>): Set<string> {
  const files = new Set<string>();

  for (const node of nodes.values()) {
    const module = moduleOfShape(node);

    if (module !== null) files.add(module);
    else if (node.ref?.file) files.add(node.ref.file);
    else if (node.kind === "more") for (const member of node.members ?? []) files.add(member.slice(0, member.indexOf("#") === -1 ? member.length : member.indexOf("#")));
  }

  return files;
}
