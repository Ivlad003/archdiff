// The state of the page: what the link (the hash) says — the view, the
// depth, the fold limit, the weight, the overlays, the review, the
// branches, the opened and hidden parts — the defaults a browser
// remembers for links that leave an option out, and the option sets of
// the presets (who is reading) and the detail buttons (how much at once).
// Pure functions of `location` and `localStorage`; app.ts renders from
// `stateFromHash()` and navigates with `setHash()`.

export interface State {
  view: string;
  depth: number | null;
  review: boolean;
  /** Draw packages and built-ins in the module views. */
  packages: boolean;
  /** The head of a review: a ref, or null for the working tree. */
  head: string | null;
  /** The heads of a comparison (two or more branches, `WORKTREE` the working tree); empty: a plain review. */
  heads: string[];
  /** Lay the review's marks over the view. */
  changes: boolean;
  /** More shapes than this fold; null: the built-in limit. */
  limit: number | null;
  /** Overlays laid over the view, in order: tests, storages, heat. */
  overlays: string[];
  /** The Mermaid type of the Markdown and the export; `auto` picks per view. */
  mermaid: string;
  /** Lines lighter than this are left out; null: every line. */
  weight: number | null;
  /** Hubs (modules most of the picture imports) as badges rather than lines. */
  hubs: boolean;
  /** Modules opened in place as lanes of their functions (the mix tool). */
  expand: string[];
  /** Lanes left out of the picture. */
  hide: string[];
  /** With the changes: only the marked shapes and their neighbours. */
  onlyChanges: boolean;
}

/** The options a link may leave out, remembered in this browser as defaults ("remember as defaults"). */
export interface Defaults {
  depth: number | null;
  limit: number | null;
  packages: boolean;
  overlays: string[];
  mermaid: string;
  weight?: number | null;
  hubs?: boolean;
}

/** The option sets of the presets: who is reading, and what they want to see at once. */
export const PRESETS: Record<string, Partial<State>> = {
  reviewer: { changes: true, overlays: ["tests"], depth: null, limit: null, weight: null, hubs: true },
  newcomer: { changes: false, overlays: [], depth: 1, limit: 30, weight: null, hubs: true, packages: false },
  architect: { changes: false, overlays: ["heat"], depth: null, limit: 60, weight: 2, hubs: true },
};

export function readDefaults(): Defaults {
  try {
    const saved = localStorage.getItem("archdiff.defaults");

    if (saved) return JSON.parse(saved) as Defaults;
  } catch {
    // No storage: the built-in defaults.
  }

  return { depth: null, limit: null, packages: false, overlays: [], mermaid: "auto", weight: null, hubs: true };
}

export function stateFromHash(): State {
  const params = new URLSearchParams(location.hash.slice(1));
  const depth = params.get("depth");

  const defaults = readDefaults();
  const limit = params.get("limit");
  // A link without an option takes the remembered default; `packages=0`, `overlay=none`, `mermaid=auto` say "none" explicitly.
  const overlay = params.get("overlay");

  return {
    view: params.get("view") ?? "layers",
    depth: depth === null ? defaults.depth : depth === "" ? null : Number(depth),
    review: params.get("review") === "1",
    packages: params.has("packages") ? params.get("packages") === "1" : defaults.packages,
    head: params.get("head") || null,
    heads: (params.get("heads") ?? "").split(",").filter((head) => head !== ""),
    changes: params.get("changes") === "1",
    limit: limit === null ? defaults.limit : limit === "" ? null : Number(limit),
    overlays: overlay === null ? defaults.overlays : overlay.split(",").filter((name) => name !== "" && name !== "none"),
    mermaid: params.get("mermaid") ?? defaults.mermaid,
    weight: params.get("weight") === null ? (defaults.weight ?? null) : params.get("weight") === "" ? null : Number(params.get("weight")),
    hubs: params.has("hubs") ? params.get("hubs") !== "0" : (defaults.hubs ?? true),
    expand: (params.get("expand") ?? "").split(",").filter((id) => id !== ""),
    hide: (params.get("hide") ?? "").split(",").filter((id) => id !== ""),
    onlyChanges: params.get("only") === "changes",
  };
}

export function setHash(state: State): void {
  const params = new URLSearchParams();
  params.set("view", state.view);

  if (state.depth !== null) params.set("depth", String(state.depth));

  if (state.review) params.set("review", "1");

  if (state.packages) params.set("packages", "1");
  const base = (document.getElementById("base") as HTMLInputElement | null)?.value ?? "".trim();

  if (base) params.set("base", base);

  if (state.head) params.set("head", state.head);

  if (state.heads.length > 0) params.set("heads", state.heads.join(","));

  if (state.changes) params.set("changes", "1");
  const defaults = readDefaults();

  // Written only when they differ from the defaults, so a plain link stays short; an explicit "none" when a default is turned off.
  if (state.limit !== defaults.limit) params.set("limit", state.limit === null ? "" : String(state.limit));

  if (state.packages !== defaults.packages) params.set("packages", state.packages ? "1" : "0");

  if (state.overlays.join(",") !== defaults.overlays.join(",")) params.set("overlay", state.overlays.length > 0 ? state.overlays.join(",") : "none");

  if (state.mermaid !== defaults.mermaid) params.set("mermaid", state.mermaid);

  if (state.weight !== (defaults.weight ?? null)) params.set("weight", state.weight === null ? "" : String(state.weight));

  if (state.hubs !== (defaults.hubs ?? true)) params.set("hubs", state.hubs ? "1" : "0");

  if (state.expand.length > 0) params.set("expand", state.expand.join(","));

  if (state.hide.length > 0) params.set("hide", state.hide.join(","));

  if (state.onlyChanges && state.changes) params.set("only", "changes");
  location.hash = params.toString();
}

/** The detail presets of the canvas toolbar: how much a picture shows at once. */
export const DETAIL: Record<string, Partial<State>> = {
  minimal: { depth: 1, limit: 20, weight: 2, hubs: true },
  normal: { depth: null, limit: null, weight: null, hubs: true },
  full: { depth: null, limit: 200, weight: null, hubs: false },
};

/** The overview pictures of the picture select, after those of the current subject. */
export const OVERVIEWS: [string, string][] = [["layers", "layers"], ["modules", "every module and import"], ["intent", "the intent against the code"], ["matrix", "matrix of the layers"], ["cycles", "import cycles"], ["classes", "class diagram"], ["hotspots", "hotspots"], ["tests", "test coverage"], ["events", "events"], ["packages", "packages"], ["coverage", "blind spots"], ["timeline", "timeline"]];
