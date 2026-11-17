// The view of a place in the editor, and the address of the page on it.
// A file is its module's view (`module:<path>`), the cursor in a function
// that function's (`calls:<path>#<name>`, or another kind the settings
// name); the path is the file's in the workspace folder, with slashes, as
// archdiff names it. The functions of a file are archdiff's own, read from
// the picture of the module's inside (`GET /api/diagram?view=inside:<path>`
// of the server the extension started), so a view names a function exactly
// as archdiff does — `Class.method`, a constructor — and never one it does
// not know. The innermost function around the cursor is the one meant.
//
// The page takes its view in the hash; `host=1` in its query has it tell
// the extension which place of the code to open, `embed=1` hides its
// header and side panels.
//
// Pure. Entry points: `repositoryPath`, `moduleView`, `functionView`,
// `functionAt`, `functionsOfInside`, `insideRequest`, `pageUrl`,
// `FunctionSpot`, `FUNCTION_VIEWS`, `FunctionViewKind`.

import { posix, win32 } from "node:path";

/** A function of a file as archdiff has it: its ID (`<path>#<name>`) and its lines, from 1. */
export interface FunctionSpot {
  id: string;
  line: number;
  /** The last line of the declaration; a function without one runs to wherever the cursor is. */
  endLine?: number;
}

/** The kinds of view a function has, of which the settings pick the one *Show this function* opens. */
export const FUNCTION_VIEWS = ["calls", "sequence", "path", "focus", "logic"] as const;

export type FunctionViewKind = (typeof FUNCTION_VIEWS)[number];

/**
 * A file's path as archdiff names it: relative to the workspace folder, with slashes; null for a file outside the
 * folder (or the folder itself). `platform` says whose paths these are: Windows' compare without regard to case.
 */
export function repositoryPath(folder: string, file: string, platform: string = process.platform): string | null {
  const path = platform === "win32" ? win32 : posix;
  const relative = path.relative(folder, file);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

  return relative.split(path.sep).join("/");
}

/** The view of a file: what the module imports and what imports it. */
export function moduleView(path: string): string {
  return `module:${path}`;
}

/** The view of a function, of the kind chosen: `calls:src/x.ts#f`. */
export function functionView(kind: FunctionViewKind, id: string): string {
  return `${kind}:${id}`;
}

/** The function the cursor is in (`line` from 1): the innermost of those whose lines hold it; null outside every function. */
export function functionAt(functions: readonly FunctionSpot[], line: number): FunctionSpot | null {
  let found: FunctionSpot | null = null;

  for (const candidate of functions) {
    if (candidate.line > line || (candidate.endLine ?? Infinity) < line) continue;

    // The one that starts last holds the cursor closest; of two starting on one line, the one that ends first.
    if (found === null || candidate.line > found.line || (candidate.line === found.line && (candidate.endLine ?? Infinity) < (found.endLine ?? Infinity))) found = candidate;
  }

  return found;
}

/** The request for the picture of a module's inside, which names its functions with their lines: the path and query on the server. */
export function insideRequest(path: string): string {
  return `/api/diagram?${new URLSearchParams({ view: `inside:${path}`, limit: "2000" }).toString()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The functions of `path` in the answer to `insideRequest`: the shapes of kind `fn` whose code is in that file (the
 * picture also holds what they call in other files), by their first line. A shape without a file, an ID or a line is
 * left out; an answer of another form names no function.
 */
export function functionsOfInside(answer: unknown, path: string): FunctionSpot[] {
  const nodes = isRecord(answer) && isRecord(answer["diagram"]) ? answer["diagram"]["nodes"] : null;
  const functions: FunctionSpot[] = [];

  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!isRecord(node) || node["kind"] !== "fn" || typeof node["id"] !== "string" || !isRecord(node["ref"])) continue;
    const { file, line, endLine } = node["ref"];

    if (file !== path || typeof line !== "number") continue;
    functions.push(typeof endLine === "number" ? { id: node["id"], line, endLine } : { id: node["id"], line });
  }

  return functions.sort((a, b) => a.line - b.line);
}

/** The address of the page on a view (null: the view the page opens by itself), hosted by the extension; `embed`: the picture alone. */
export function pageUrl(origin: string, view: string | null, embed: boolean): string {
  return `${origin}/?host=1${embed ? "&embed=1" : ""}${view === null ? "" : `#${new URLSearchParams({ view }).toString()}`}`;
}
