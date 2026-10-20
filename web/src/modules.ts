// What the navigations share — the folder tree, the views list, the
// Markdown pages: the functions of a module, read once per head from its
// `inside` picture; the view a function opens; the files the picture shown
// now is of, which every navigation marks so the reader sees where the
// picture is; and whether a name a page writes is a file it may link to.
// Pure but for the one read of a module's picture, which asks the server
// for the code at the link's head.
//
// Entry points: `functionsOf`, `knownFunctions`, `fnView`, `filesInPicture`,
// `isFilePath`.

import { api, type Shape } from "./api.ts";
import { codeHead, currentLink, refsOf } from "./link.ts";
import { DEFAULT_PICTURE_OPTIONS } from "../../src/options.ts";
import { moduleOfId, moduleOfShape } from "../../src/shape-keys.ts";
import { isSourceFile } from "../../src/view-keys.ts";

/** A function of a module, as its inside picture lists it. */
export interface Fn {
  id: string;
  name: string;
  line: number;
}

/** The reads under way or done, by head and module path; a read that failed is dropped, so the next ask tries again. */
const reads = new Map<string, Promise<Fn[]>>();
/** The functions read so far, by head and module path, for the lookups that cannot wait. */
const known = new Map<string, Fn[]>();

/** The key of a module's functions: the code at the link's head (the working tree's without one), and the path. */
function keyOf(path: string): string {
  return `${codeHead(currentLink()) ?? ""}\u0000${path}`;
}

/** The functions of a module at the link's head, read once from its `inside` picture (its own functions, in the order of their lines); rejects when the server could not draw it. */
export function functionsOf(path: string): Promise<Fn[]> {
  const key = keyOf(path);
  let read = reads.get(key);

  if (!read) {
    read = api
      .scene(`inside:${path}`, { ...DEFAULT_PICTURE_OPTIONS, limit: 2000 }, refsOf(currentLink()))
      .then((result) => {
        const own = result.diagram.nodes.filter((node) => node.kind === "fn" && node.ref?.file === path).map((node): Fn => ({ id: node.id, name: node.label.split("\n")[0] ?? node.id, line: node.ref?.line ?? 0 })).sort((a, b) => a.line - b.line);
        known.set(key, own);

        return own;
      });
    // A failed read is not kept: the next ask tries again (the server may be back, the code may have changed).
    read.catch(() => reads.delete(key));
    reads.set(key, read);
  }

  return read;
}

/** The functions of a module at the link's head once read; undefined before, or while they are read. */
export function knownFunctions(path: string): Fn[] | undefined {
  return known.get(keyOf(path));
}

/** The view a function opens: its call tree when it is an entry point, its logic when it branches, else everything joined to it. */
export function fnView(id: string, keys: ReadonlySet<string>): string {
  if (keys.has(`calls:${id}`)) return `calls:${id}`;

  if (keys.has(`logic:${id}`)) return `logic:${id}`;

  return `focus:${id}`;
}

/** A path of a source file, alone or with a declaration after `#` (`src/x.ts`, `src/x.ts#f`): a name a page may link to its view. */
export function isFilePath(text: string): boolean {
  return /^[\w./@-]+(?:#[\w.$]+)?$/.test(text) && isSourceFile(moduleOfId(text));
}

/** The files the shapes of a picture are of: a module's, a function's or a class's, a participant's, the folded tail's. */
export function filesInPicture(nodes: ReadonlyMap<string, Shape>): Set<string> {
  const files = new Set<string>();

  for (const node of nodes.values()) {
    const module = moduleOfShape(node);

    if (module !== null) files.add(module);
    else if (node.ref?.file) files.add(node.ref.file);
    else if (node.kind === "more") for (const member of node.members ?? []) files.add(moduleOfId(member));
  }

  return files;
}
