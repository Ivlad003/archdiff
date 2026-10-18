// The views and their keys: one table of the kinds of view — whether a
// kind takes a subject, the one question it answers, its default depth,
// whether its shapes are modules (where a hub is noise) — from which the
// `View` type, the questions and the depths are read, and the codec
// between a view and its key (`module:src/x.ts`, `calls:src/x.ts#f`,
// `matrix`). The key is the view on the wire — in a link, a chat tag, a
// drawing's file name, the Markdown — and the code in between reads it
// with `parseView` and writes it with `viewKey`, never by hand. Plain
// data and pure functions without imports: views.ts builds the pictures,
// pipeline.ts shapes them, the page and the CLI name views by them.
//
// Entry points: `VIEW_KINDS`, `View`, `ViewKind`, `parseView`, `viewKey`,
// `questionOf`, `defaultDepth`, `usesDepth`, `isModuleView`, `isMapView`.

/** What one kind of view is: how its key is written, what it answers, how deep it goes by default. */
interface KindSpec {
  /** `none`: the key is the kind (`layers`); `required`: `kind:<subject>`; `optional`: either. */
  subject: "none" | "required" | "optional";
  /** The one question the picture answers. */
  question: string;
  /** How far from the subject the picture goes without `--depth`; 0 when absent. */
  depth?: number;
  /** How many shapes the picture keeps before its tail folds by directory, without `--limit`; `FOLD` when absent. */
  fold?: number;
  /** The shapes are modules: a module most of them import is a hub, drawn as a badge. */
  modules?: true;
  /** A map of modules in many lanes, which reads better with the lanes as columns. */
  map?: true;
  /** The subject is a directory (or a module path) that may be written with a trailing slash. */
  path?: true;
  /** The only subjects the kind takes (`cycles:fns`). */
  subjects?: readonly string[];
}

export const VIEW_KINDS = {
  layers: { subject: "none", question: "which layers import which, and how much" },
  layer: { subject: "required", question: "which modules of the layer import which, and what they touch outside it", depth: 1, modules: true, map: true },
  dir: { subject: "required", question: "which modules of the directory import which, and their neighbours", depth: 1, modules: true, map: true, path: true },
  module: { subject: "required", question: "what the module imports and what imports it", depth: 1, modules: true },
  inside: { subject: "required", question: "which functions of the module call which, and what they call outside", depth: 1 },
  usage: { subject: "required", question: "which exports of the module are used, by whom" },
  calls: { subject: "required", question: "what a function calls, step by step, and where the trail ends", depth: 3 },
  sequence: { subject: "required", question: "in what order a function's calls cross the modules", depth: 4 },
  path: { subject: "required", question: "which calls lead from a function to a store", depth: 8 },
  type: { subject: "required", question: "where a type is produced, consumed and transformed", depth: 1 },
  focus: { subject: "required", question: "everything joined to this one shape: what calls or imports it, what it calls or imports, across every module", depth: 1 },
  logic: { subject: "optional", question: "which branches, loops and early exits a function's body has, and which conditions lead to which outcome" },
  cycles: { subject: "optional", question: "which modules (or functions) import or call each other in a circle, and where to cut", modules: true, subjects: ["fns"] },
  cycle: { subject: "required", question: "which modules form this circle, through which imports, and where to cut", modules: true },
  classes: { subject: "optional", question: "which classes and interfaces exist, with what fields and methods, extending what", path: true },
  matrix: { subject: "optional", question: "who imports whom, and which imports go against the order", path: true },
  metrics: { subject: "optional", question: "how coupled and how cohesive each module is: Ca, Ce, instability, abstractness, the distance from the main sequence", path: true },
  machines: { subject: "none", question: "which state machines the code has, declared by a library or written with literal states" },
  machine: { subject: "required", question: "which states a machine has, which transitions, and which function or event makes each" },
  events: { subject: "none", question: "which modules emit which events, and which listen" },
  tests: { subject: "none", question: "which modules the tests import, and which none does", modules: true },
  hotspots: { subject: "none", question: "which modules are big, and which are called from everywhere" },
  packages: { subject: "none", question: "which packages depend on which, declared or not" },
  timeline: { subject: "none", question: "how the coupling between layers drifted, commit by commit" },
  coverage: { subject: "none", question: "where the diagrams are blind: calls and imports archdiff could not follow" },
  intent: { subject: "none", question: "what was intended, what is built, and where the code went beyond the intent", modules: true },
  // The whole map shows every module of all but a big repository (the fold of `full`); the project map has the rest.
  modules: { subject: "none", question: "every module of the repository in its layer, and every import between them", modules: true, map: true, fold: 200 },
  review: { subject: "none", question: "what a change did to the architecture: the modules, imports and calls it added, removed or changed, and the new couplings between layers", modules: true },
  compare: { subject: "none", question: "what each of several branches did to the architecture against one base, side by side", modules: true },
} as const satisfies Record<string, KindSpec>;

export type ViewKind = keyof typeof VIEW_KINDS;

/** The kinds whose subject is `S` in the table. */
type KindsWith<S extends KindSpec["subject"]> = { [K in ViewKind]: (typeof VIEW_KINDS)[K]["subject"] extends S ? K : never }[ViewKind];

/** A view: its kind and its subject (a layer, a directory, a module, a function, a scope), null for a view without one. */
export type View = { kind: KindsWith<"none">; subject: null } | { kind: KindsWith<"required">; subject: string } | { kind: KindsWith<"optional">; subject: string | null };

/** Older names of a kind, still read from a link or a command line: `contract:` was the usage view. */
const ALIASES: Readonly<Record<string, ViewKind>> = { contract: "usage" };

function isKind(name: string): name is ViewKind {
  return Object.hasOwn(VIEW_KINDS, name);
}

/** `layers`, `layer:<name>`, `module:<path>`, `calls:<path>#<fn>`, `cycles:fns` → the view; null for a key no kind reads. */
export function parseView(key: string): View | null {
  const at = key.indexOf(":");
  const written = at === -1 ? key : key.slice(0, at);
  const name = ALIASES[written] ?? written;

  if (!isKind(name)) return null;
  const spec: KindSpec = VIEW_KINDS[name];

  if (at === -1) return spec.subject === "required" ? null : ({ kind: name, subject: null } as View);
  // A directory may be written with a trailing slash; nothing else changes the subject.
  const subject = spec.path ? key.slice(at + 1).replace(/\/+$/, "") : key.slice(at + 1);

  if (subject === "" || spec.subject === "none" || (spec.subjects && !spec.subjects.includes(subject))) return null;

  return { kind: name, subject } as View;
}

/** The key of a view: the kind, and `:<subject>` when it has one. */
export function viewKey(view: View): string {
  return view.subject === null ? view.kind : `${view.kind}:${view.subject}`;
}

/** The one question the pictures of a kind answer. */
export function questionOf(kind: ViewKind): string {
  return VIEW_KINDS[kind].question;
}

/**
 * More shapes than this and a view folds the tail into one shape per directory. Studies of diagram reading put the
 * comfortable count far lower (7–10 at a glance); 40 keeps a lane grid readable while a folded shape still opens on a
 * tap.
 */
export const FOLD = 40;

/** How many shapes a picture of the kind keeps before its tail folds, without `--limit`. */
export function foldLimit(kind: ViewKind): number {
  const spec: KindSpec = VIEW_KINDS[kind];

  return spec.fold ?? FOLD;
}

/** How far from the subject a picture of the kind goes without `--depth`. */
export function defaultDepth(kind: ViewKind): number {
  const spec: KindSpec = VIEW_KINDS[kind];

  return spec.depth ?? 0;
}

/** Whether the pictures of a kind go a depth from their subject (`--depth` changes them); the others ignore it. */
export function usesDepth(kind: ViewKind): boolean {
  const spec: KindSpec = VIEW_KINDS[kind];

  return spec.depth !== undefined;
}

/** The kinds that draw a map of modules in lanes, which reads better across (columns) when the lanes are many. */
export function isMapView(kind: ViewKind): boolean {
  const spec: KindSpec = VIEW_KINDS[kind];

  return spec.map === true;
}

/** The kinds whose shapes are modules, where a module most of them import (a logger, the types) is noise rather than news. */
export function isModuleView(kind: ViewKind): boolean {
  const spec: KindSpec = VIEW_KINDS[kind];

  return spec.modules === true;
}
