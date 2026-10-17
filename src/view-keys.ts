// The keys of the views: the `View` type, how a key (`module:src/x.ts`,
// `calls:src/x.ts#f`, `matrix`) is parsed and written, the one question
// each kind answers, the default depth of each, and which kinds draw
// modules (where a hub is noise). Plain data and pure functions, no
// imports: views.ts builds the pictures from them, pipeline.ts shapes
// them, the page and the CLI name views by them.
//
// Entry points: `View`, `parseView`, `viewKey`, `QUESTION`,
// `DEFAULT_DEPTH`, `MODULE_VIEWS`.

export type View =
  | { kind: "layers" }
  | { kind: "layer"; name: string }
  | { kind: "dir"; path: string }
  | { kind: "module"; id: string }
  | { kind: "inside"; id: string }
  | { kind: "contract"; id: string }
  | { kind: "calls"; id: string }
  | { kind: "sequence"; id: string }
  | { kind: "path"; id: string }
  | { kind: "type"; id: string }
  | { kind: "cycles"; scope: "fns" | null }
  | { kind: "cycle"; id: string }
  | { kind: "classes"; scope: string | null }
  | { kind: "matrix"; scope: string | null }
  | { kind: "metrics"; scope: string | null }
  | { kind: "machines" }
  | { kind: "machine"; id: string }
  | { kind: "events" }
  | { kind: "tests" }
  | { kind: "hotspots" }
  | { kind: "packages" }
  | { kind: "timeline" }
  | { kind: "coverage" }
  | { kind: "intent" }
  | { kind: "modules" };

/** The views without a subject. */
const PLAIN_VIEWS = new Set(["layers", "coverage", "cycles", "classes", "matrix", "metrics", "events", "tests", "hotspots", "packages", "timeline", "intent", "modules", "machines"]);

/** The views with a subject (`kind:<subject>`). */
const SUBJECT_VIEWS = new Set(["layer", "dir", "module", "inside", "contract", "calls", "sequence", "path", "type", "cycle", "cycles", "classes", "matrix", "metrics", "machine"]);

/** The one question each kind of view answers. */
export const QUESTION: Record<View["kind"], string> = {
  layers: "which layers import which, and how much",
  layer: "which modules of the layer import which, and what they touch outside it",
  dir: "which modules of the directory import which, and their neighbours",
  module: "what the module imports and what imports it",
  inside: "which functions of the module call which, and what they call outside",
  contract: "which exports of the module are used, by whom",
  calls: "what a function calls, step by step, and where the trail ends",
  sequence: "in what order a function's calls cross the modules",
  path: "which calls lead from a function to a store",
  type: "where a type is produced, consumed and transformed",
  cycles: "which modules (or functions) import or call each other in a circle, and where to cut",
  cycle: "which modules form this circle, through which imports, and where to cut",
  classes: "which classes and interfaces exist, with what fields and methods, extending what",
  matrix: "who imports whom, and which imports go against the order",
  metrics: "how coupled and how cohesive each module is: Ca, Ce, instability, abstractness, the distance from the main sequence",
  machines: "which state machines the code has, declared by a library or written with literal states",
  machine: "which states a machine has, which transitions, and which function or event makes each",
  events: "which modules emit which events, and which listen",
  tests: "which modules the tests import, and which none does",
  hotspots: "which modules are big, and which are called from everywhere",
  packages: "which packages depend on which, declared or not",
  timeline: "how the coupling between layers drifted, commit by commit",
  coverage: "where the diagrams are blind: calls and imports archdiff could not follow",
  intent: "what was intended, what is built, and where the code went beyond the intent",
  modules: "every module of the repository in its layer, and every import between them",
};

/** `layers`, `layer:<name>`, `module:<path>`, `calls:<path>#<fn>`, `coverage` → the view, or null. */
export function parseView(key: string): View | null {
  if (key === "classes") return { kind: "classes", scope: null };

  if (key === "matrix") return { kind: "matrix", scope: null };

  if (key === "metrics") return { kind: "metrics", scope: null };

  if (key === "cycles") return { kind: "cycles", scope: null };

  if (key === "cycles:fns") return { kind: "cycles", scope: "fns" };

  if (PLAIN_VIEWS.has(key)) return { kind: key } as View;
  const at = key.indexOf(":");

  if (at === -1) return null;
  const kind = key.slice(0, at);
  const rest = key.slice(at + 1);

  if (rest === "" || !SUBJECT_VIEWS.has(kind)) return null;

  if (kind === "layer") return { kind, name: rest };

  if (kind === "dir") return { kind, path: rest.replace(/\/+$/, "") };

  if (kind === "cycles") return null;

  if (kind === "classes" || kind === "matrix" || kind === "metrics") return { kind, scope: rest.replace(/\/+$/, "") };

  return { kind, id: rest } as View;
}

export function viewKey(view: View): string {
  if (view.kind === "classes" || view.kind === "matrix" || view.kind === "metrics" || view.kind === "cycles") return view.scope === null ? view.kind : `${view.kind}:${view.scope}`;

  if ("name" in view) return `${view.kind}:${view.name}`;

  if ("path" in view) return `${view.kind}:${view.path}`;

  if ("id" in view) return `${view.kind}:${view.id}`;

  return view.kind;
}

export const DEFAULT_DEPTH: Partial<Record<View["kind"], number>> = { layer: 1, dir: 1, module: 1, inside: 1, calls: 3, sequence: 4, path: 8, type: 1 };

/** The views whose shapes are modules, where a hub (a module most of them import) is noise rather than news. */
export const MODULE_VIEWS = new Set<View["kind"]>(["layer", "dir", "module", "cycle", "cycles", "tests", "intent", "modules"]);
