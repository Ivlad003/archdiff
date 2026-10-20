// The views and their keys: one table of the kinds of view — whether a
// kind takes a subject, the one question it answers, its default depth,
// whether its shapes are modules (where a hub is noise), and where the
// kind shows: its overview label, the page's list group of its subject
// views, its chat tag, the template of its breadcrumbs, the Mermaid
// types that read better for it — from which the `View` type, the
// questions, the depths and every list of kinds are read, and the codec
// between a view and its key (`module:src/x.ts`, `calls:src/x.ts#f`,
// `matrix`). The key is the view on the wire — in a link, a chat tag, a
// drawing's file name, the Markdown — and the code in between reads it
// with `parseView` and writes it with `viewKey`, never by hand. A kind
// is registered here and nowhere else: the page's groups and overview
// picker, the chat's tags and the export menu derive from the table, so
// a kind the table does not place cannot be listed by the server and
// dropped by the page. Plain data and pure functions, with no import but
// a type: views.ts builds the pictures, pipeline.ts shapes them, the
// page and the CLI name views by them.
//
// Entry points: `VIEW_KINDS`, `View`, `ViewKind`, `parseView`, `viewKey`,
// `questionOf`, `defaultDepth`, `usesDepth`, `isModuleView`, `isMapView`,
// `overviews`, `listGroup`, `listGroups`, `tagOf`, `crumbTemplate`,
// `mermaidTypesOf`, `viewSyntax`, `ViewEntry`, `subjectFile`, `viewsOfFiles`.

import { isSourceFile } from "./languages.ts";
import type { MermaidStyle } from "./options.ts";

/** Whether a path is a source file archdiff reads: what a key's subject must be to name a file, offered to the page here, which bundles no frontend. */
export { isSourceFile } from "./languages.ts";

/**
 * How the breadcrumbs above a subject view are laid: `layer` (layers › the layer), `dir` (every directory above),
 * `classes` (the layer, the directories, then the directory or the module, then the picture), `code` (the layer,
 * the directories, the module, then the function and the picture), `type` (…the module, then the type), `under`
 * (the kind's overview, then the subject's last segment), `kind` (layers › the picture).
 */
export type CrumbTemplate = "layer" | "dir" | "classes" | "code" | "type" | "under" | "kind";

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
  /** The only subjects the kind takes, each an overview of its own with its label (`cycles:fns` → "call cycles"). */
  subjects?: Readonly<Record<string, string>>;
  /** A change: the view reads its own revisions, and the link's head is the change's, not the code the page shows. */
  change?: true;
  /** The bare view is an overview of the whole repository: its label in the page's overview picker. */
  overview?: string;
  /** The page's list shows the subject views of the kind under this group; a kind without one is reached from the shapes. */
  group?: string;
  /** The chat tag of the subject views (`@layer:`, `@flow:`): its prefix, and what the tag says beside the view's title. */
  tag?: { prefix: string; says?: string };
  /** How the breadcrumbs above a subject view are laid; `kind` when absent. */
  crumbs?: CrumbTemplate;
  /** The Mermaid types that read better than the flowchart for the kind, which the export menu offers. */
  mermaid?: readonly MermaidStyle[];
  /** How the subject is written, for the CLI's help: `<path>#<fn>`; the listed subjects when `subjects` names them. */
  form?: string;
}

export const VIEW_KINDS = {
  layers: { subject: "none", question: "which layers import which, and how much", overview: "layers", mermaid: ["c4", "pie"] },
  layer: { subject: "required", question: "which modules of the layer import which, and what they touch outside it", depth: 1, modules: true, map: true, group: "Layers", tag: { prefix: "layer" }, crumbs: "layer", mermaid: ["mindmap"], form: "<name>" },
  dir: { subject: "required", question: "which modules of the directory import which, and their neighbours", depth: 1, modules: true, map: true, path: true, group: "Directories", tag: { prefix: "dir" }, crumbs: "dir", mermaid: ["mindmap"], form: "<path>" },
  module: { subject: "required", question: "what the module imports and what imports it", depth: 1, modules: true, group: "Modules", tag: { prefix: "module" }, crumbs: "code", form: "<path>" },
  inside: { subject: "required", question: "which functions of the module call which, and what they call outside", depth: 1, crumbs: "code", form: "<path>" },
  usage: { subject: "required", question: "which exports of the module are used, by whom", crumbs: "code", form: "<path>" },
  calls: { subject: "required", question: "what a function calls, step by step, and where the trail ends", depth: 3, group: "Entry points (call trees)", tag: { prefix: "flow", says: "its data flow" }, crumbs: "code", form: "<path>#<fn>" },
  sequence: { subject: "required", question: "in what order a function's calls cross the modules", depth: 4, crumbs: "code", form: "<path>#<fn>" },
  path: { subject: "required", question: "which calls lead from a function to a store", depth: 8, crumbs: "code", form: "<path>#<fn>" },
  type: { subject: "required", question: "where a type is produced, consumed and transformed", depth: 1, group: "Types (where they flow)", tag: { prefix: "type" }, crumbs: "type", form: "<path>#<Type>" },
  focus: { subject: "required", question: "everything joined to this one shape: what calls or imports it, what it calls or imports, across every module", depth: 1, crumbs: "code", form: "<path>[#<fn>]" },
  logic: { subject: "optional", question: "which branches, loops and early exits a function's body has, and which conditions lead to which outcome", overview: "the functions with branches", group: "Logic (functions with branches)", tag: { prefix: "logic", says: "the flowchart and its rules" }, crumbs: "code", form: "<path>#<fn>" },
  cycles: { subject: "optional", question: "which modules (or functions) import or call each other in a circle, and where to cut", modules: true, subjects: { fns: "call cycles" }, overview: "import cycles" },
  cycle: { subject: "required", question: "which modules form this circle, through which imports, and where to cut", modules: true, crumbs: "code", form: "<path>[#<fn>]" },
  classes: { subject: "optional", question: "which classes and interfaces exist, with what fields and methods, extending what", path: true, overview: "class diagram", crumbs: "classes", form: "<path|dir>" },
  matrix: { subject: "optional", question: "who imports whom, and which imports go against the order", path: true, overview: "matrix of the layers", form: "<dir>" },
  metrics: { subject: "optional", question: "how coupled and how cohesive each module is: Ca, Ce, instability, abstractness, the distance from the main sequence", path: true, overview: "coupling and cohesion", form: "<layer>" },
  machines: { subject: "none", question: "which state machines the code has, declared by a library or written with literal states", overview: "state machines" },
  machine: { subject: "required", question: "which states a machine has, which transitions, and which function or event makes each", group: "State machines", form: "<path>#<name>" },
  events: { subject: "none", question: "which modules emit which events, and which listen", overview: "events" },
  messages: { subject: "optional", question: "what the parts say to each other: which module sends which typed message to which, as a sequence", path: true, overview: "messages between the parts", crumbs: "code", form: "<path>" },
  apis: { subject: "optional", question: "which operations of an external API (SCAPI) the code calls, by family and by module, and which hooks modify them", overview: "operations of external APIs", group: "APIs (operations by family)", crumbs: "under", form: "<family|path>" },
  postman: { subject: "optional", question: "which requests of a Postman collection the code calls, which it never calls, and which operations it calls that the collection lacks", path: true, overview: "Postman collections against the code", group: "Postman collections (against the code)", crumbs: "under", form: "<file>" },
  tests: { subject: "none", question: "which modules the tests import, and which none does", modules: true, overview: "test coverage" },
  hotspots: { subject: "none", question: "which modules are big, and which are called from everywhere", overview: "hotspots", mermaid: ["quadrant"] },
  packages: { subject: "none", question: "which packages depend on which, declared or not", overview: "packages", mermaid: ["c4", "pie"] },
  timeline: { subject: "none", question: "how the coupling between layers drifted, commit by commit", change: true, overview: "timeline" },
  coverage: { subject: "none", question: "where the diagrams are blind: calls and imports archdiff could not follow", overview: "blind spots" },
  intent: { subject: "none", question: "what was intended, what is built, and where the code went beyond the intent", modules: true, overview: "the intent against the code" },
  // The whole map shows every module of all but a big repository (the fold of `full`); the project map has the rest.
  modules: { subject: "none", question: "every module of the repository in its layer, and every import between them", modules: true, map: true, fold: 200, overview: "every module and import" },
  review: { subject: "none", question: "what a change did to the architecture: the modules, imports and calls it added, removed or changed, and the new couplings between layers", modules: true, change: true },
  commit: { subject: "required", question: "what one commit did to the architecture, against the commit before it: the modules, imports and calls it added, removed or changed", modules: true, change: true, form: "<sha>" },
  branches: { subject: "none", question: "where every branch left the base, the commits of its own, and how far it is ahead and behind", change: true, overview: "branches and their commits" },
  compare: { subject: "none", question: "what each of several branches did to the architecture against one base, side by side", modules: true, change: true },
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

  if (subject === "" || spec.subject === "none" || (spec.subjects && !Object.hasOwn(spec.subjects, subject))) return null;

  return { kind: name, subject } as View;
}

/** The key of a view: the kind, and `:<subject>` when it has one. */
export function viewKey(view: View): string {
  return view.subject === null ? view.kind : `${view.kind}:${view.subject}`;
}

/**
 * The file a view's subject names, as the one codec reads it: `module:src/x.ts` → `src/x.ts`; `calls:src/x.ts#f` →
 * `src/x.ts` with the declaration `f`; null for a subject that is no source file (a layer, a directory, an API
 * family, a listed scope such as `fns`).
 */
export function subjectFile(view: View | null): { file: string; declaration: string | null } | null {
  if (!view || view.subject === null) return null;
  const at = view.subject.indexOf("#");
  const file = at === -1 ? view.subject : view.subject.slice(0, at);

  return isSourceFile(file) ? { file, declaration: at === -1 ? null : view.subject.slice(at + 1) } : null;
}

/** A view's entry in the lists the server gives and the page shows: its key, its title, its kind, the lane its subject sits in. */
export interface ViewEntry {
  key: string;
  title: string;
  kind: ViewKind;
  /** The lane the subject sits in. */
  layer?: string;
}

/**
 * The views of some files, out of a list: an overview (no subject) stays; a view of a file, or of a declaration in
 * one, stays when the file is among them; a layer's (and a scope's named like a layer, `metrics:<layer>`) when a
 * file of that layer is, as the list's module entries say; a directory's, or a scope's written as a path, when a
 * file under it is; a view of what is no file nor path — a listed subject (`cycles:fns`), an API family, a Postman
 * collection — stays. The one rule of `--changed` and of the page's "in picture".
 */
export function viewsOfFiles(list: readonly ViewEntry[], files: ReadonlySet<string>): ViewEntry[] {
  const layers = new Set<string>();

  for (const entry of list) {
    const file = entry.kind === "module" ? subjectFile(parseView(entry.key)) : null;

    if (file && entry.layer !== undefined && files.has(file.file)) layers.add(entry.layer);
  }

  return list.filter((entry) => {
    const view = parseView(entry.key);

    if (!view || view.subject === null) return true;
    const spec: KindSpec = VIEW_KINDS[view.kind];

    if (spec.subjects !== undefined || view.kind === "apis" || view.kind === "postman") return true;
    const file = subjectFile(view);

    if (file) return files.has(file.file);

    if (view.kind === "layer" || layers.has(view.subject)) return layers.has(view.subject);

    return [...files].some((candidate) => candidate.startsWith(`${view.subject}/`));
  });
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

/** Whether a picture of the kind is the code at the link's head (a branch, a commit; the working tree without one): every view but a change. */
export function drawnAtHead(kind: ViewKind | undefined): boolean {
  if (kind === undefined) return false;
  const spec: KindSpec = VIEW_KINDS[kind];

  return spec.change !== true;
}

/**
 * The revision whose code the pages of a view read — a shape's page, its file, the views list, the project map —
 * null for the working tree: the head of a picture of the code and of a review (the change's result), the commit of
 * a commit's change; the working tree for a comparison of several heads and for the timeline.
 */
export function codeRevision(view: View | null, head: string | null): string | null {
  if (view?.kind === "commit") return view.subject;

  return view?.kind === "compare" || view?.kind === "timeline" ? null : head;
}

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

/** The kinds in the table's order, each with its spec. */
function kinds(): [ViewKind, KindSpec][] {
  return Object.entries(VIEW_KINDS) as [ViewKind, KindSpec][];
}

/** The group of the page's list that holds the overviews: the bare views, and a listed subject such as `cycles:fns`. */
export const OVERVIEW_GROUP = "Overview";

/** The overviews of the repository for the page's picker, in the table's order: each kind's bare view, then its listed subjects. */
export function overviews(): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];

  for (const [kind, spec] of kinds()) {
    if (spec.overview !== undefined) out.push({ key: kind, label: spec.overview });

    for (const [subject, label] of Object.entries(spec.subjects ?? {})) out.push({ key: `${kind}:${subject}`, label });
  }

  return out;
}

/**
 * The group of the page's list a view belongs to: the overviews for a bare view of an overview kind or a listed
 * subject, the kind's group for a subject view; null for a view the list does not show (reached from the shapes).
 */
export function listGroup(view: View): string | null {
  const spec: KindSpec = VIEW_KINDS[view.kind];

  if (view.subject === null) return spec.overview === undefined ? null : OVERVIEW_GROUP;

  if (spec.subjects && Object.hasOwn(spec.subjects, view.subject)) return OVERVIEW_GROUP;

  return spec.group ?? null;
}

/** The groups of the page's list in order: the overviews, then each kind's group as the table lists the kinds. */
export function listGroups(): string[] {
  const out = [OVERVIEW_GROUP];

  for (const [, spec] of kinds()) if (spec.group !== undefined && !out.includes(spec.group)) out.push(spec.group);

  return out;
}

/** The chat tag of a kind's subject views (`@flow:` for a call tree), if the chat names them. */
export function tagOf(kind: ViewKind): { prefix: string; says?: string } | undefined {
  const spec: KindSpec = VIEW_KINDS[kind];

  return spec.tag;
}

/** How the breadcrumbs above a subject view of the kind are laid. */
export function crumbTemplate(kind: ViewKind): CrumbTemplate {
  const spec: KindSpec = VIEW_KINDS[kind];

  return spec.crumbs ?? "kind";
}

/** The Mermaid types that read better than the flowchart for the kind, in the order the export menu offers them. */
export function mermaidTypesOf(kind: ViewKind): readonly MermaidStyle[] {
  const spec: KindSpec = VIEW_KINDS[kind];

  return spec.mermaid ?? [];
}

/**
 * How every view is written, for the CLI's help, in the table's order: `layers`, `layer:<name>`, `logic | logic:<path>#<fn>`,
 * `cycles | cycles:fns`. A kind with a subject names its form; a listed subject is written as it is.
 */
export function viewSyntax(): string[] {
  return kinds().map(([kind, spec]) => {
    const form = spec.subjects ? Object.keys(spec.subjects).join("|") : (spec.form ?? "<subject>");

    if (spec.subject === "none") return kind;

    return spec.subject === "required" ? `${kind}:${form}` : `${kind} | ${kind}:${form}`;
  });
}
