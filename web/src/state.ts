// The state of the page: what the link (the hash) says — the view, the
// review, the branches, and the options of the picture as options.ts
// names them (depth, limit, weight, hubs, packages, opened modules, hidden
// lanes, overlays, the review's marks, the Mermaid type, the lanes) — the
// defaults a browser remembers for links that leave an option out, and
// the option sets of the presets (who is reading) and the detail buttons
// (how much at once). Pure functions of `location` and `localStorage`;
// app.ts renders from `stateFromHash()` and navigates with `setHash()`.

import { DEFAULT_PICTURE_OPTIONS, readPictureOptions, writePictureParams, type PictureOptionKey, type PictureOptions } from "../../src/options.ts";
import { parseView } from "../../src/view-keys.ts";
import type { Refs } from "./api.ts";

export type { PictureOptions } from "../../src/options.ts";

export interface State extends PictureOptions {
  view: string;
  /** The head of a review: a ref, or null for the working tree. */
  head: string | null;
  /** The heads of a comparison (two or more branches, `WORKTREE` the working tree). */
  heads: string[];
}

/** A review of a change or a comparison of heads: the page shows the branch bar, and nothing is drawn on it. */
export function reviewing(view: string): boolean {
  const kind = parseView(view)?.kind;

  return kind === "review" || kind === "compare";
}

/** The refs of the link: the base (the base field), the head, the heads. */
export function refsOf(state: State): Refs {
  const base = (document.getElementById("base") as HTMLInputElement | null)?.value.trim() || null;

  return { base, head: state.head, heads: state.heads };
}

/** The options a link may leave out: remembered in this browser as defaults ("remember as defaults"). */
const REMEMBERED = ["depth", "limit", "packages", "overlays", "mermaid", "weight", "hubs", "lanes"] as const satisfies readonly PictureOptionKey[];

export type Defaults = Pick<PictureOptions, (typeof REMEMBERED)[number]>;

/** The option sets of the presets: who is reading, and what they want to see at once. */
export const PRESETS: Record<string, Partial<State>> = {
  reviewer: { changes: true, overlays: ["tests"], depth: null, limit: null, weight: null, hubs: true },
  newcomer: { changes: false, overlays: [], depth: 1, limit: 30, weight: null, hubs: true, packages: false },
  architect: { changes: false, overlays: ["heat"], depth: null, limit: 60, weight: 2, hubs: true },
};

/** The remembered defaults over the built-in ones; a stored value of a wrong shape is ignored. */
export function readDefaults(): PictureOptions {
  const defaults: PictureOptions = { ...DEFAULT_PICTURE_OPTIONS };

  try {
    const saved = localStorage.getItem("archdiff.defaults");
    const parsed = saved ? (JSON.parse(saved) as Partial<Record<string, unknown>>) : {};

    for (const key of REMEMBERED) if (key in parsed && parsed[key] !== undefined) (defaults as Record<string, unknown>)[key] = parsed[key];
  } catch {
    // No storage: the built-in defaults.
  }

  return defaults;
}

/** Writes the remembered defaults of this browser (the options of `state` a link may leave out). */
export function rememberDefaults(state: State): boolean {
  const defaults: Partial<Defaults> = {};

  for (const key of REMEMBERED) (defaults as Record<string, unknown>)[key] = state[key];

  try {
    localStorage.setItem("archdiff.defaults", JSON.stringify(defaults));

    return true;
  } catch {
    return false;
  }
}

export function forgetDefaults(): void {
  try {
    localStorage.removeItem("archdiff.defaults");
  } catch {
    // Nothing stored.
  }
}

export function stateFromHash(): State {
  const params = new URLSearchParams(location.hash.slice(1));
  const defaults = readDefaults();
  const read = readPictureOptions((name) => params.get(name), "param");
  // A wrong value in the hash reads as the defaults rather than an error: the link may be old or typed.
  const picture = read.ok ? read.value : { options: { ...DEFAULT_PICTURE_OPTIONS }, given: new Set<PictureOptionKey>() };
  const options = { ...picture.options };

  // A link without an option takes the remembered default; `packages=0`, `overlay=none`, `depth=` say "none" explicitly.
  for (const key of REMEMBERED) if (!picture.given.has(key)) (options as Record<string, unknown>)[key] = defaults[key];

  const heads = (params.get("heads") ?? "").split(",").filter((head) => head !== "");
  // A link of an older page said `review=1` beside another view: the review, or the comparison of its heads.
  const view = params.get("review") === "1" ? (heads.length > 1 ? "compare" : "review") : (params.get("view") ?? "layers");

  return { ...options, view, head: params.get("head") || null, heads };
}

export function setHash(state: State): void {
  const params = new URLSearchParams();
  params.set("view", state.view);
  const base = (document.getElementById("base") as HTMLInputElement | null)?.value.trim() ?? "";

  if (base) params.set("base", base);

  if (state.head) params.set("head", state.head);

  if (state.heads.length > 0) params.set("heads", state.heads.join(","));
  // The picture's options, written only when they differ from the remembered defaults, so a plain link stays short; an
  // explicit "none" when a default is turned off. "only the changes" means nothing without the changes.
  const picture = writePictureParams({ ...state, onlyChanges: state.onlyChanges && state.changes }, { ...DEFAULT_PICTURE_OPTIONS, ...readDefaults() });

  for (const [key, value] of picture) params.set(key, value);
  location.hash = params.toString();
}

/** The detail presets of the canvas toolbar: how much a picture shows at once. */
export const DETAIL: Record<string, Partial<State>> = {
  minimal: { depth: 1, limit: 20, weight: 2, hubs: true },
  normal: { depth: null, limit: null, weight: null, hubs: true },
  full: { depth: null, limit: 200, weight: null, hubs: false },
};

/** The overview pictures of the picture select, after those of the current subject. */
export const OVERVIEWS: [string, string][] = [["layers", "layers"], ["modules", "every module and import"], ["intent", "the intent against the code"], ["matrix", "matrix of the layers"], ["cycles", "import cycles"], ["cycles:fns", "call cycles"], ["metrics", "coupling and cohesion"], ["machines", "state machines"], ["classes", "class diagram"], ["hotspots", "hotspots"], ["tests", "test coverage"], ["events", "events"], ["packages", "packages"], ["coverage", "blind spots"], ["timeline", "timeline"]];
