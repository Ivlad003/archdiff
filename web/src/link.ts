// The link of the page: what the hash says — the view (a review and a
// comparison are views too), the head and the heads, and the options of
// the picture as options.ts names them (depth, limit, weight, hubs,
// packages, opened modules, hidden lanes, overlays, the review's marks,
// the Mermaid type, the lanes) — the defaults a browser remembers for
// links that leave an option out (kept as the query the table reads), and
// the option sets of the presets (who is reading) and the detail buttons
// (how much at once). Pure functions of `location` and `localStorage`;
// the page renders from `currentLink()` and navigates with `setLink()`.
//
// Entry points: `Link`, `currentLink`, `setLink`, `wrongInLink`, `refsOf`, `codeHead`,
// `reviewing`, `readOnlyView`, `readDefaults`, `rememberDefaults`, `forgetDefaults`,
// `PRESETS`, `detailPresets`, `Detail`, `OVERVIEWS`.

import { DEFAULT_PICTURE_OPTIONS, readEachPictureOption, writePictureParams, type PictureOptionKey, type PictureOptions } from "../../src/options.ts";
import { codeRevision, defaultDepth, parseView, usesDepth } from "../../src/view-keys.ts";
import type { Refs } from "./api.ts";

export type { PictureOptions } from "../../src/options.ts";

export interface Link extends PictureOptions {
  view: string;
  /** The head of a review: a ref, or null for the working tree. */
  head: string | null;
  /** The heads of a comparison (two or more branches, `WORKTREE` the working tree). */
  heads: string[];
}

/** A review of a change or a comparison of heads: the page shows the branch bar. */
export function reviewing(view: string): boolean {
  const kind = parseView(view)?.kind;

  return kind === "review" || kind === "compare";
}

/** A picture read from git — a review, a comparison, one commit's change, the branches: nothing is drawn on it. */
export function readOnlyView(view: string): boolean {
  const kind = parseView(view)?.kind;

  return kind === "review" || kind === "compare" || kind === "commit" || kind === "branches";
}

/** The revision whose code the page shows (null: the working tree), as `codeRevision` says for the link's view. */
export function codeHead(link: Link): string | null {
  return codeRevision(parseView(link.view), link.head);
}

/** The refs of the link: the base (the base field), the head, the heads. */
export function refsOf(link: Link): Refs {
  const base = (document.getElementById("base") as HTMLInputElement | null)?.value.trim() || null;

  return { base, head: link.head, heads: link.heads };
}

/** The options a link may leave out: remembered in this browser as defaults ("remember as defaults"). */
const REMEMBERED = ["depth", "limit", "packages", "overlays", "mermaid", "weight", "hubs", "lanes"] as const satisfies readonly PictureOptionKey[];

/** The option sets of the presets: who is reading, and what they want to see at once. */
export const PRESETS: Record<string, Partial<Link>> = {
  reviewer: { changes: true, overlays: ["tests"], depth: null, limit: null, weight: null, hubs: true },
  newcomer: { changes: false, overlays: [], depth: 1, limit: 30, weight: null, hubs: true, packages: false },
  architect: { changes: false, overlays: ["heat"], depth: null, limit: 60, weight: 2, hubs: true },
};

/** Where this browser keeps its defaults: the remembered options as a query, read back through the table of options.ts. */
const DEFAULTS_KEY = "archdiff.defaults.v2";

/** The remembered defaults over the built-in ones; a stored value the table refuses (an old or a hand-edited one) is left out alone. */
export function readDefaults(): PictureOptions {
  const defaults: PictureOptions = { ...DEFAULT_PICTURE_OPTIONS };

  try {
    const params = new URLSearchParams(localStorage.getItem(DEFAULTS_KEY) ?? "");
    const read = readEachPictureOption((name) => params.get(name));

    for (const key of REMEMBERED) if (read.given.has(key)) Object.assign(defaults, { [key]: read.options[key] });
  } catch {
    // No storage: the built-in defaults.
  }

  return defaults;
}

/** Writes the remembered defaults of this browser: the options of `link` a link may leave out, as the query the table reads. */
export function rememberDefaults(link: Link): boolean {
  const remembered: PictureOptions = { ...DEFAULT_PICTURE_OPTIONS };

  for (const key of REMEMBERED) Object.assign(remembered, { [key]: link[key] });

  try {
    localStorage.setItem(DEFAULTS_KEY, writePictureParams(remembered).toString());

    return true;
  } catch {
    return false;
  }
}

export function forgetDefaults(): void {
  try {
    localStorage.removeItem(DEFAULTS_KEY);
    // The JSON an older page kept: forgotten too.
    localStorage.removeItem("archdiff.defaults");
  } catch {
    // Nothing stored.
  }
}

export function currentLink(): Link {
  const params = new URLSearchParams(location.hash.slice(1));
  const defaults = readDefaults();
  // A wrong value in the hash is left out alone, not an error (the link may be old or typed); `wrongInLink` names it.
  const read = readEachPictureOption((name) => params.get(name));
  const options = { ...read.options };

  // A link without an option takes the remembered default; `packages=0`, `overlay=none`, `depth=` say "none" explicitly.
  for (const key of REMEMBERED) if (!read.given.has(key)) (options as Record<string, unknown>)[key] = defaults[key];

  const heads = (params.get("heads") ?? "").split(",").filter((head) => head !== "");
  // A link of an older page said `review=1` beside another view: the review, or the comparison of its heads.
  const view = params.get("review") === "1" ? (heads.length > 1 ? "compare" : "review") : (params.get("view") ?? "layers");

  return { ...options, view, head: params.get("head") || null, heads };
}

/** The values of the link the options table refuses (`limit=1.5 (limit must be a whole number of at least 1)`), each left out of the picture. */
export function wrongInLink(): string[] {
  const params = new URLSearchParams(location.hash.slice(1));

  return readEachPictureOption((name) => params.get(name)).wrong;
}

export function setLink(link: Link): void {
  const params = new URLSearchParams();
  params.set("view", link.view);
  const base = (document.getElementById("base") as HTMLInputElement | null)?.value.trim() ?? "";

  if (base) params.set("base", base);

  if (link.head) params.set("head", link.head);

  if (link.heads.length > 0) params.set("heads", link.heads.join(","));
  // The picture's options, written only when they differ from the remembered defaults, so a plain link stays short; an
  // explicit "none" when a default is turned off. "Only the changes" needs marks: the changes laid over, or a review.
  const picture = writePictureParams({ ...link, onlyChanges: link.onlyChanges && (link.changes || readOnlyView(link.view)) }, { ...DEFAULT_PICTURE_OPTIONS, ...readDefaults() });

  for (const [key, value] of picture) params.set(key, value);
  location.hash = params.toString();
}

/** The detail buttons of the canvas toolbar. */
export type Detail = "minimal" | "normal" | "full";

/**
 * How much a picture of a view shows at once: minimal (one step deep, 20
 * shapes, lines of weight 2 and more), normal (the defaults), full (one
 * step deeper than the view goes by itself, 200 shapes, every line, the
 * hubs drawn). A view the depth does not change keeps its depth unset.
 */
export function detailPresets(view: string): Record<Detail, Partial<Link>> {
  const kind = parseView(view)?.kind;
  const own = kind !== undefined && usesDepth(kind) ? defaultDepth(kind) : null;

  return {
    minimal: { depth: own === null ? null : 1, limit: 20, weight: 2, hubs: true },
    normal: { depth: null, limit: null, weight: null, hubs: true },
    full: { depth: own === null ? null : own + 1, limit: 200, weight: null, hubs: false },
  };
}

/** The overview pictures of the picture select, after those of the current subject. */
export const OVERVIEWS: [string, string][] = [["layers", "layers"], ["modules", "every module and import"], ["intent", "the intent against the code"], ["matrix", "matrix of the layers"], ["cycles", "import cycles"], ["cycles:fns", "call cycles"], ["metrics", "coupling and cohesion"], ["machines", "state machines"], ["classes", "class diagram"], ["hotspots", "hotspots"], ["tests", "test coverage"], ["events", "events"], ["messages", "messages between the parts"], ["packages", "packages"], ["coverage", "blind spots"], ["timeline", "timeline"], ["branches", "branches and their commits"]];
