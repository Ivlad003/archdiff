// The views of the graph: which picture to draw of what, each a pure
// function of the graph (and a depth) that returns an unplaced `Diagram`
// for `layout`. Views: `layers` (the layers and the imports between them),
// `layer:<name>` (its modules and their neighbours), `dir:<path>` (the
// modules of a directory and their neighbours), `module:<path>` (what
// imports it and what it imports), `calls:<path>#<fn>` (the call tree from a
// function), `coverage` (the modules with calls archdiff could not follow).
// `inside:<path>` (the functions of a module and the calls among them,
// lanes being modules), `sequence:<path>#<fn>` (the calls from a function
// as a sequence diagram, placed). Lanes are layers elsewhere; the depth is
// how far from the subject the picture goes.
//
// Pipeline: Analysis → View → Diagram → layout → canvas/exports/markdown.
// Entry points: `parseView`, `viewKey`, `viewList`, `viewOf`, `entryPoints`.

import type { Analysis } from "./analyze.ts";
import { SIZE, type Diagram, type DiagramEdge, type DiagramGroup, type DiagramNode } from "./diagram.ts";
import { matchesGlob } from "./glob.ts";
import { INTENT_FILE, intentView } from "./intent.ts";
import { moduleOf, type Graph, type GraphNode } from "./graph.ts";
import { classesView, contractView, cyclesView, eventsView, hotspotsView, matrixView, packagesView, pathView, testsView, typeView } from "./views-more.ts";

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
  | { kind: "cycles" }
  | { kind: "cycle"; id: string }
  | { kind: "classes"; scope: string | null }
  | { kind: "matrix"; scope: string | null }
  | { kind: "events" }
  | { kind: "tests" }
  | { kind: "hotspots" }
  | { kind: "packages" }
  | { kind: "timeline" }
  | { kind: "coverage" }
  | { kind: "intent" }
  | { kind: "modules" };

/** The views without a subject. */
const PLAIN_VIEWS = new Set(["layers", "coverage", "cycles", "classes", "matrix", "events", "tests", "hotspots", "packages", "timeline", "intent", "modules"]);

/** The views with a subject (`kind:<subject>`). */
const SUBJECT_VIEWS = new Set(["layer", "dir", "module", "inside", "contract", "calls", "sequence", "path", "type", "cycle", "classes", "matrix"]);

export interface ViewOptions {
  /** How far from the subject the picture goes; each view has its default. */
  depth?: number;
  /** Draw the packages and built-ins a module imports (the module view); off by default: they crowd the picture. */
  packages?: boolean;
  /** At most this many shapes; the rest fold into one `more` shape. Default `MAX_SHAPES`. */
  limit?: number;
  /** Lines standing for fewer imports or calls than this are left out (the Markdown keeps them). Default 1: every line. */
  weight?: number;
  /** Modules most of a picture imports (a logger, the types) become a badge on their importers instead of a tangle of lines. Default on. */
  hubs?: boolean;
  /** Lanes (layers, or modules of an inside view) left out of the picture with their shapes. */
  hideLanes?: readonly string[];
  /** Modules opened in place: each becomes a lane of its functions, and the lines into and out of it land on the functions they concern (the mix of a module view and an inside view). */
  expand?: readonly string[];
}

/**
 * More shapes than this and a view folds the tail into one shape. Studies of
 * diagram reading put the comfortable count far lower (7–10 at a glance); 40
 * keeps a lane grid readable while a folded shape still opens on a tap.
 */
export const MAX_SHAPES = 40;

/** A module imported by at least this many of a picture's modules, and at least HUB_SHARE of them, is a hub. */
const HUB_MIN_IMPORTERS = 6;

/** The share of a picture's modules that must import a module for it to be a hub: a quarter marks the logger and the shared types, not a busy neighbour. */
const HUB_SHARE = 0.25;

/** On a big map a quarter is hundreds; this many importers make a hub whatever the picture's size. */
const HUB_MAX_IMPORTERS = 40;

/** The one question each kind of view answers. */
const QUESTION: Record<View["kind"], string> = {
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
  cycles: "which modules import each other in a circle",
  cycle: "which modules form this circle, and through which imports",
  classes: "which classes and interfaces exist, with what fields and methods, extending what",
  matrix: "who imports whom, and which imports go against the order",
  events: "which modules emit which events, and which listen",
  tests: "which modules the tests import, and which none does",
  hotspots: "which modules are big, and which are called from everywhere",
  packages: "which packages depend on which, declared or not",
  timeline: "how the coupling between layers drifted, commit by commit",
  coverage: "where the diagrams are blind: calls and imports archdiff could not follow",
  intent: "what was intended, what is built, and where the code went beyond the intent",
  modules: "every module of the repository in its layer, and every import between them",
};

export interface ViewEntry {
  key: string;
  title: string;
  kind: View["kind"];
  /** The lane the subject sits in. */
  layer?: string;
}

/** `layers`, `layer:<name>`, `module:<path>`, `calls:<path>#<fn>`, `coverage` → the view, or null. */
export function parseView(key: string): View | null {
  if (key === "classes") return { kind: "classes", scope: null };

  if (key === "matrix") return { kind: "matrix", scope: null };

  if (PLAIN_VIEWS.has(key)) return { kind: key } as View;
  const at = key.indexOf(":");

  if (at === -1) return null;
  const kind = key.slice(0, at);
  const rest = key.slice(at + 1);

  if (rest === "" || !SUBJECT_VIEWS.has(kind)) return null;

  if (kind === "layer") return { kind, name: rest };

  if (kind === "dir") return { kind, path: rest.replace(/\/+$/, "") };

  if (kind === "classes" || kind === "matrix") return { kind, scope: rest.replace(/\/+$/, "") };

  return { kind, id: rest } as View;
}

export function viewKey(view: View): string {
  if (view.kind === "classes" || view.kind === "matrix") return view.scope === null ? view.kind : `${view.kind}:${view.scope}`;

  if ("name" in view) return `${view.kind}:${view.name}`;

  if ("path" in view) return `${view.kind}:${view.path}`;

  if ("id" in view) return `${view.kind}:${view.id}`;

  return view.kind;
}

/** Modules whose public methods a framework calls: controllers, handlers, commands, jobs, listeners, middleware, routes. */
const HANDLER_MODULE = /(controller|handler|command|job|listener|subscriber|middleware|route|resolver|consumer|action)s?[/.]|[/.](controllers?|handlers?|commands?|jobs?|listeners?|middlewares?|routes?|actions?)\//i;

/** A function execution starts from, with how it is known. */
export interface EntryPoint {
  node: GraphNode;
  /** `route cart.tsx: loader`, `hook …`, `bin`, `main`, `entries` (archdiff.json), `uncalled export`. */
  label: string;
}

/**
 * The functions execution starts from: what the frameworks declare (routes,
 * hooks), exported functions of files under `bin/`, functions named `main`,
 * exported functions of files the `entries` globs name (archdiff.json), and
 * exported functions nothing in the repository calls or references but
 * which call something.
 */
export function entryPoints(analysis: Analysis): EntryPoint[] {
  const { graph, config } = analysis;
  const called = new Set(graph.calls.map((edge) => edge.to));
  const entries = new Map<string, EntryPoint>();

  // The node an export name of a module stands for, re-exports followed.
  const exportedNode = (module: string, exportName: string): GraphNode | null => {
    const id = graph.resolvedExports.get(module)?.get(exportName);
    const node = id ? graph.nodes.get(id) : undefined;

    return node && node.kind === "fn" ? node : null;
  };

  for (const declared of analysis.declaredEntries) {
    if (declared.exportName === "*") {
      for (const id of graph.resolvedExports.get(declared.module)?.values() ?? []) {
        const node = graph.nodes.get(id);

        if (node && node.kind === "fn" && !entries.has(id)) entries.set(id, { node, label: declared.label });
      }
    } else {
      const node = exportedNode(declared.module, declared.exportName);

      if (node && !entries.has(node.id)) entries.set(node.id, { node, label: declared.label });
    }
  }

  for (const node of graph.nodes.values()) {
    if (node.kind !== "fn" || entries.has(node.id)) continue;

    // A `main` is an entry whether or not it is exported (Rust's and Python's are not); a method of a handler-like class
    // (controller, handler, command, job, listener, middleware, route) that nothing calls is one the framework calls.
    if (!node.parent && node.name === "main") entries.set(node.id, { node, label: "main" });
    else if (!node.parent && node.exported && node.module.startsWith("bin/")) entries.set(node.id, { node, label: "bin" });
    else if (!node.parent && node.exported && config.entries.some((glob) => matchesGlob(node.module, glob))) entries.set(node.id, { node, label: "entries" });
    else if (!node.parent && node.exported && !called.has(node.id) && graph.calls.some((edge) => edge.from === node.id)) entries.set(node.id, { node, label: "uncalled export" });
    else if (node.parent && node.exported && HANDLER_MODULE.test(node.module) && !called.has(node.id) && !node.name.startsWith("_") && node.name !== "constructor" && graph.calls.some((edge) => edge.from === node.id)) entries.set(node.id, { node, label: "uncalled method of a handler" });
  }

  return [...entries.values()].sort((a, b) => (a.node.id < b.node.id ? -1 : 1));
}

/** Every view the page lists: the layers, each layer, each module, each entry point's calls, the coverage. */
export function viewList(analysis: Analysis): ViewEntry[] {
  const { graph } = analysis;
  const list: ViewEntry[] = [{ key: "layers", title: "Layers", kind: "layers" }];

  for (const layer of graph.layers) list.push({ key: `layer:${layer}`, title: layer, kind: "layer", layer });

  // Directories with at least two modules, as views of their own: the middle rung between a layer and a module.
  const directories = new Map<string, number>();

  for (const module of graph.modules.keys()) {
    const parts = module.split("/");

    for (let depth = 1; depth < parts.length; depth++) {
      const directory = parts.slice(0, depth).join("/");
      directories.set(directory, (directories.get(directory) ?? 0) + 1);
    }
  }

  for (const [directory, count] of [...directories].sort()) if (count >= 2) list.push({ key: `dir:${directory}`, title: `${directory}/ (${count})`, kind: "dir" });

  for (const module of [...graph.modules.keys()].sort()) list.push({ key: `module:${module}`, title: module, kind: "module", layer: graph.modules.get(module)!.layer });

  for (const entry of entryPoints(analysis)) list.push({ key: `calls:${entry.node.id}`, title: `${entry.node.name} (${entry.node.module}) — ${entry.label}`, kind: "calls", layer: graph.modules.get(entry.node.module)!.layer });

  // The types with a declaration of their own, for the type flow view.
  for (const node of [...graph.nodes.values()].filter((candidate) => candidate.kind === "type" && !candidate.parent && candidate.exported).sort((a, b) => (a.id < b.id ? -1 : 1))) list.push({ key: `type:${node.id}`, title: `${node.name} (${node.module})`, kind: "type", layer: graph.modules.get(node.module)!.layer });
  list.push({ key: "coverage", title: "Coverage: what the diagrams cannot show", kind: "coverage" });
  list.push({ key: "intent", title: `Intent: ${INTENT_FILE} against the code`, kind: "intent" });
  list.push({ key: "modules", title: "Modules: the whole map, every module and import", kind: "modules" });
  list.push({ key: "classes", title: "Classes: every class and interface, fields and methods", kind: "classes" });
  list.push({ key: "matrix", title: "Matrix: who imports whom, layer by layer", kind: "matrix" });
  list.push({ key: "cycles", title: "Cycles: modules importing each other", kind: "cycles" });
  list.push({ key: "events", title: "Events: emitters and listeners", kind: "events" });
  list.push({ key: "tests", title: "Tests: which modules the tests cover", kind: "tests" });
  list.push({ key: "hotspots", title: "Hotspots: size and calls in", kind: "hotspots" });

  if (analysis.packages.length > 1) list.push({ key: "packages", title: `Packages: ${analysis.packages.length} package.json as a system`, kind: "packages" });
  list.push({ key: "timeline", title: "Timeline: the drift of the architecture, commit by commit", kind: "timeline" });

  return list;
}

export function lane(id: string): DiagramGroup {
  return { id, label: id, kind: "lane", x: 0, y: 0, w: 0, h: 0 };
}

export function unplaced(view: string, title: string, nodes: DiagramNode[], edges: DiagramEdge[], groups: DiagramGroup[], extra: Partial<Diagram> = {}): Diagram {
  return { view, title, nodes, edges, groups, ...extra };
}

/** The lanes of the layers the nodes use, in the graph's order. */
export function lanesOf(graph: Graph, nodes: readonly DiagramNode[]): DiagramGroup[] {
  const used = new Set(nodes.map((node) => node.group).filter((group): group is string => group !== undefined));

  return graph.layers.filter((layer) => used.has(layer)).map(lane);
}

export function moduleNode(graph: Graph, id: string): DiagramNode {
  const module = graph.modules.get(id)!;
  const node: DiagramNode = { id, kind: "module", label: id, ref: { id, file: id, line: 1 }, group: module.layer, x: 0, y: 0, w: 0, h: 0 };

  if (module.doc) node.doc = module.doc;

  return node;
}

export function externalNode(graph: Graph, id: string): DiagramNode {
  const external = graph.externals.get(id)!;

  return { id, kind: "external", label: external.kind === "builtin" ? `node:${external.name}` : external.name, x: 0, y: 0, w: 0, h: 0 };
}

export function fnNode(graph: Graph, id: string): DiagramNode {
  const fn = graph.nodes.get(id)!;
  const node: DiagramNode = { id, kind: "fn", label: fn.parent ? `${fn.parent}.${fn.name}` : fn.name, ref: { id, file: fn.module, line: fn.line, endLine: fn.endLine }, group: graph.modules.get(fn.module)!.layer, x: 0, y: 0, w: 0, h: 0 };

  if (fn.signature) node.signature = fn.signature;

  if (fn.doc) node.doc = fn.doc;

  return node;
}

/** Module-level dependencies between the given modules (and to externals when `externals`), one edge per pair with its count. */
export function depEdges(graph: Graph, members: ReadonlySet<string>, externals: boolean): DiagramEdge[] {
  const counts = new Map<string, number>();

  for (const dep of graph.deps) {
    if (!members.has(dep.from)) continue;

    if (!(members.has(dep.to) || (externals && graph.externals.has(dep.to)))) continue;
    const key = `${dep.from}\u0000${dep.to}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts].map(([key, count]) => {
    const [from, to] = key.split("\u0000") as [string, string];

    return { from, to, kind: "dependency", count };
  });
}

/** The layers and the imports between them, each line counted. */
function layersView(graph: Graph): Diagram {
  const counts = new Map<string, number>();
  const modulesOf = new Map<string, number>();

  for (const module of graph.modules.values()) modulesOf.set(module.layer, (modulesOf.get(module.layer) ?? 0) + 1);

  for (const dep of graph.deps) {
    const from = graph.modules.get(dep.from)?.layer;
    const to = graph.modules.get(dep.to)?.layer;

    if (!from || !to || from === to || dep.typeOnly) continue;
    counts.set(`${from}\u0000${to}`, (counts.get(`${from}\u0000${to}`) ?? 0) + 1);
  }

  const nodes = graph.layers.map((layer): DiagramNode => ({ id: layer, kind: "layer", label: layer, count: modulesOf.get(layer) ?? 0, x: 0, y: 0, w: 0, h: 0 }));
  const edges = [...counts].map(([key, count]): DiagramEdge => {
    const [from, to] = key.split("\u0000") as [string, string];

    return { from, to, kind: "dependency", count, label: String(count) };
  });

  return unplaced("layers", "Layers", nodes, edges, []);
}

/** The modules of a layer; depth 1 (default) adds the modules of other layers they import or are imported by. */
function layerView(graph: Graph, name: string, depth: number): Diagram {
  const own = [...graph.modules.values()].filter((module) => module.layer === name).map((module) => module.id);

  if (own.length === 0) return unplaced(`layer:${name}`, name, [], [], [], { reason: `no layer "${name}"`, missing: true });
  const members = grow(graph, new Set(own), depth, "both");
  const ownSet = new Set(own);
  // The layer's own modules first: a folded picture keeps them and folds the neighbours.
  const nodes = [...members].sort((a, b) => Number(ownSet.has(b)) - Number(ownSet.has(a)) || (a < b ? -1 : 1)).map((id) => moduleNode(graph, id));

  return unplaced(`layer:${name}`, `Layer ${name}`, nodes, depEdges(graph, members, false), lanesOf(graph, nodes));
}

/** Modules within `depth` import steps of `start`, in the given direction. */
export function grow(graph: Graph, start: ReadonlySet<string>, depth: number, direction: "both" | "out" | "in"): Set<string> {
  const members = new Set(start);
  let frontier = new Set(start);

  for (let step = 0; step < depth && frontier.size > 0; step++) {
    const next = new Set<string>();

    for (const dep of graph.deps) {
      if (dep.typeOnly || !graph.modules.has(dep.to)) continue;

      if (direction !== "in" && frontier.has(dep.from) && !members.has(dep.to)) next.add(dep.to);

      if (direction !== "out" && frontier.has(dep.to) && !members.has(dep.from)) next.add(dep.from);
    }

    for (const id of next) members.add(id);
    frontier = next;
  }

  return members;
}

/** One module: what imports it (left) and what it imports (right), and with `packages` the packages too; depth 1 default. */
function moduleView(graph: Graph, id: string, depth: number, packages: boolean): Diagram {
  if (!graph.modules.has(id)) return unplaced(`module:${id}`, id, [], [], [], { reason: `no module "${id}"`, missing: true });
  const members = grow(graph, new Set([id]), depth, "both");
  const nodes = [...members].sort().map((member) => moduleNode(graph, member));
  const edges = depEdges(graph, members, packages);
  const externals = new Set(edges.map((edge) => edge.to).filter((to) => graph.externals.has(to)));

  for (const external of [...externals].sort()) nodes.push(externalNode(graph, external));

  return unplaced(`module:${id}`, id, nodes, edges, lanesOf(graph, nodes));
}

/** The modules of a directory (and below), with the imports among them; depth 1 (default) adds their neighbours outside it. */
function dirView(graph: Graph, path: string, depth: number): Diagram {
  const prefix = `${path}/`;
  const own = [...graph.modules.keys()].filter((id) => id.startsWith(prefix));

  if (own.length === 0) return unplaced(`dir:${path}`, path, [], [], [], { reason: `no modules under "${path}/"`, missing: true });
  const members = grow(graph, new Set(own), depth, "both");
  const ownSet = new Set(own);
  const nodes = [...members].sort((a, b) => Number(ownSet.has(b)) - Number(ownSet.has(a)) || (a < b ? -1 : 1)).map((id) => moduleNode(graph, id));

  return unplaced(`dir:${path}`, `${path}/`, nodes, depEdges(graph, members, false), lanesOf(graph, nodes));
}

/** The whole map: every module in its layer's lane and every import between modules (packages left out). Big by nature: hubs, the fold and the weight keep it readable. */
function modulesView(graph: Graph): Diagram {
  const ids = [...graph.modules.keys()].sort();

  if (ids.length === 0) return unplaced("modules", "Modules", [], [], [], { reason: "no modules" });
  const nodes = ids.map((id) => moduleNode(graph, id));

  return unplaced("modules", `Modules: ${ids.length} in ${graph.layers.length} layers`, nodes, depEdges(graph, new Set(ids), false), lanesOf(graph, nodes));
}

/** The deepest directory holding every path; "" when they share none. */
function commonDirectory(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  let parts = paths[0]!.split("/").slice(0, -1);

  for (const path of paths) {
    const own = path.split("/").slice(0, -1);
    let n = 0;

    while (n < parts.length && n < own.length && parts[n] === own[n]) n++;
    parts = parts.slice(0, n);
  }

  return parts.join("/");
}

/**
 * A big picture folded: the first `limit` shapes stay (the subject first,
 * then the diagram's order, which the views sort by importance); the rest
 * are grouped by directory into `more` shapes — one per directory with
 * its count, which opens that directory's view on a tap — and the edges of
 * the dropped shapes point to their group. Functions fold by module into
 * one shape per module. The Markdown of the view still lists everything.
 */
function fold(diagram: Diagram, limit: number): Diagram {
  if (diagram.nodes.length <= limit) return diagram;
  const kept = diagram.nodes.slice(0, limit);
  const dropped = diagram.nodes.slice(limit);
  const keptIds = new Set(kept.map((node) => node.id));
  // The group of a dropped shape: a module by the directory just below the common root of the dropped modules
  // (the view's own directory folds into its subdirectories), a function by its module, anything else into one "more".
  const droppedModules = dropped.filter((node) => node.kind === "module").map((node) => node.id);
  const common = commonDirectory(droppedModules);

  const groupOf = (node: DiagramNode): { id: string; label: string; view: string | null } => {
    if (node.kind === "module") {
      const rest = common === "" ? node.id : node.id.slice(common.length + 1);
      const slash = rest.indexOf("/");
      // A file directly under the common directory folds into that directory; a file deeper into its first subdirectory.
      const folder = slash === -1 ? common : common === "" ? rest.slice(0, slash) : `${common}/${rest.slice(0, slash)}`;
      const label = folder === "" ? "(root)" : `${folder}/`;

      return { id: `more:${folder || "(root)"}`, label, view: folder === "" ? null : `dir:${folder}` };
    }

    if (node.kind === "fn") {
      const module = moduleOf(node.ref?.id ?? node.id);

      return { id: `more:${module}`, label: module, view: `module:${module}` };
    }

    return { id: "more", label: "more", view: null };
  };

  const groups = new Map<string, DiagramNode & { members: string[] }>();
  const groupOfId = new Map<string, string>();

  for (const node of dropped) {
    const group = groupOf(node);
    let shape = groups.get(group.id);

    if (!shape) {
      shape = { id: group.id, kind: "more", label: group.label, count: 0, x: 0, y: 0, w: 0, h: 0, members: [] };

      if (group.view) shape.ref = { id: group.view };

      if (node.group !== undefined) shape.group = node.group;
      groups.set(group.id, shape);
    }

    shape.count = (shape.count ?? 0) + 1;
    shape.members.push(node.id);
    groupOfId.set(node.id, group.id);
  }

  // Too many groups is no better than too many shapes: beyond a dozen, the smallest merge into one "other".
  let folded = [...groups.values()].sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (a.id < b.id ? -1 : 1));

  if (folded.length > 12) {
    const rest = folded.slice(11);
    const other: DiagramNode & { members: string[] } = { id: "more", kind: "more", label: "other", count: rest.reduce((sum, shape) => sum + (shape.count ?? 0), 0), x: 0, y: 0, w: 0, h: 0, members: rest.flatMap((shape) => shape.members) };

    for (const member of other.members) groupOfId.set(member, "more");
    folded = [...folded.slice(0, 11), other];
  }

  for (const shape of folded) shape.label = `… ${shape.count} in ${shape.label}`;
  // The lines into or out of a folded shape merge into one per (from, to, kind), which counts the lines behind it, so
  // a weight filter can thin them and the Markdown can say how many.
  const merged = new Map<string, DiagramEdge>();

  for (const edge of diagram.edges) {
    const from = keptIds.has(edge.from) ? edge.from : (groupOfId.get(edge.from) ?? "more");
    const to = keptIds.has(edge.to) ? edge.to : (groupOfId.get(edge.to) ?? "more");

    if (from === to) continue;
    const key = `${from}\u0000${to}\u0000${edge.kind}`;
    const existing = merged.get(key);

    if (existing) existing.count = (existing.count ?? 1) + (edge.count ?? 1);
    else merged.set(key, from === edge.from && to === edge.to ? { ...edge } : { from, to, kind: edge.kind, count: edge.count ?? 1 });
  }

  const edges = [...merged.values()].map((edge) => (edge.count === 1 && !diagram.edges.includes(edge) ? { from: edge.from, to: edge.to, kind: edge.kind } : edge));
  const nodes = [...kept, ...folded.map(({ members: _members, ...shape }) => shape)];
  const lanes = diagram.groups.filter((group) => nodes.some((node) => node.group === group.id));
  const note = `${dropped.length} of ${diagram.nodes.length} shapes folded by directory; tap a folded shape to open it, the Markdown lists them all`;

  return { ...diagram, nodes, edges, groups: lanes, reason: [diagram.reason, note].filter(Boolean).join("; ") };
}

/** The call tree from a function: the functions it calls, and theirs, `depth` levels (default 3); gaps as holes. */
function callsView(graph: Graph, id: string, depth: number): Diagram {
  const start = graph.nodes.get(id);

  if (!start) return unplaced(`calls:${id}`, id, [], [], [], { reason: `no function "${id}"`, missing: true });
  const members = new Set([id]);
  const edges: DiagramEdge[] = [];
  const seenEdges = new Set<string>();
  let frontier = new Set([id]);
  const callsFrom = new Map<string, typeof graph.calls>();

  for (const call of graph.calls) callsFrom.set(call.from, [...(callsFrom.get(call.from) ?? []), call]);
  const gapsFrom = new Map<string, typeof graph.gaps>();

  for (const gap of graph.gaps) gapsFrom.set(gap.from, [...(gapsFrom.get(gap.from) ?? []), gap]);
  const holes: DiagramNode[] = [];

  for (let step = 0; step < depth && frontier.size > 0; step++) {
    const next = new Set<string>();

    for (const from of frontier) {
      for (const call of callsFrom.get(from) ?? []) {
        const key = `${call.from}\u0000${call.to}\u0000${call.kind}`;

        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        edges.push({ from: call.from, to: call.to, kind: call.kind });

        if (!members.has(call.to)) {
          members.add(call.to);
          next.add(call.to);
        }
      }

      // The calls archdiff could not follow from this function: one hole per callee.
      const reasons = new Map<string, string>();

      for (const gap of gapsFrom.get(from) ?? []) if (gap.reason === "dynamic" || gap.reason === "unknown-member" || gap.reason === "interface") reasons.set(gap.callee, gap.reason);

      for (const [callee, reason] of reasons) {
        const holeId = `hole:${from}:${callee}`;
        holes.push({ id: holeId, kind: "hole", label: callee, reason, group: graph.modules.get(moduleOf(from))!.layer, ref: { file: moduleOf(from) }, x: 0, y: 0, w: 0, h: 0 });
        edges.push({ from, to: holeId, kind: "call" });
      }
    }

    frontier = next;
  }

  const nodes = [...members].map((member) => fnNode(graph, member));
  nodes[0] = { ...nodes[0]!, kind: "fn" };

  return unplaced(`calls:${id}`, `Calls from ${start.parent ? `${start.parent}.` : ""}${start.name}`, [...nodes, ...holes], edges, lanesOf(graph, [...nodes, ...holes]));
}

/** The modules with calls into the repository archdiff could not follow (blind spots) or imports it could not resolve, by layer, labelled with the counts. */
function coverageView(graph: Graph): Diagram {
  const gapsOf = new Map<string, number>();

  for (const gap of graph.gaps) if (gap.reason === "dynamic" || gap.reason === "unknown-member" || gap.reason === "interface") gapsOf.set(moduleOf(gap.from), (gapsOf.get(moduleOf(gap.from)) ?? 0) + 1);

  for (const unresolved of graph.unresolvedImports) gapsOf.set(unresolved.from, (gapsOf.get(unresolved.from) ?? 0) + 1);
  const callsOf = new Map<string, number>();

  for (const call of graph.calls) callsOf.set(moduleOf(call.from), (callsOf.get(moduleOf(call.from)) ?? 0) + 1);
  const nodes = [...gapsOf]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id, gaps]): DiagramNode => ({ ...moduleNode(graph, id), label: `${id}\n${gaps} gaps / ${callsOf.get(id) ?? 0} calls`, count: gaps, diff: "changed" }));

  return unplaced("coverage", "What the diagrams cannot show", nodes, [], lanesOf(graph, nodes), nodes.length === 0 ? { reason: "every import and call was followed" } : {});
}

/**
 * Inside a module: its functions, classes and methods, the calls among
 * them, and (depth 1, default) the functions of other modules they call,
 * each module a lane. The map of one file.
 */
function insideView(graph: Graph, id: string, depth: number): Diagram {
  const module = graph.modules.get(id);

  if (!module) return unplaced(`inside:${id}`, id, [], [], [], { reason: `no module "${id}"`, missing: true });
  const own = [...graph.nodes.values()].filter((node) => node.module === id && node.kind !== "type").map((node) => node.id);
  const members = new Set(own);
  let frontier = new Set(own);

  for (let step = 0; step < depth && frontier.size > 0; step++) {
    const next = new Set<string>();

    for (const call of graph.calls) if (frontier.has(call.from) && !members.has(call.to) && graph.nodes.get(call.to)?.kind !== "type") next.add(call.to);

    for (const target of next) members.add(target);
    frontier = next;
  }

  const seen = new Set<string>();
  const edges: DiagramEdge[] = [];

  for (const call of graph.calls) {
    if (!members.has(call.from) || !members.has(call.to) || call.from === call.to) continue;
    const key = `${call.from}\u0000${call.to}\u0000${call.kind}`;

    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: call.from, to: call.to, kind: call.kind });
  }

  // Lanes are modules here, the subject first; a function sits in its module's lane.
  const modules = [id, ...[...members].map((member) => moduleOf(member)).filter((other) => other !== id).sort()];
  const nodes = [...members]
    .sort((a, b) => Number(moduleOf(b) === id) - Number(moduleOf(a) === id) || (graph.nodes.get(a)!.line - graph.nodes.get(b)!.line))
    .map((member) => ({ ...fnNode(graph, member), group: moduleOf(member) }));

  if (nodes.length === 0) return unplaced(`inside:${id}`, `Inside ${id}`, [], [], [], { reason: "the module declares no function or class" });

  return unplaced(`inside:${id}`, `Inside ${id}`, nodes, edges, [...new Set(modules)].map(lane));
}

/** The width of a column of the sequence view and the height of one message row. */
const SEQ_COLUMN = 190;

const SEQ_ROW = 44;

/**
 * The sequence of calls from a function, drawn like a sequence diagram:
 * the modules on the way as participants across the top, their lifelines
 * down, every call a horizontal message in the order the code makes them
 * (depth first, by line), `depth` levels deep, at most `limit` messages.
 */
function sequenceView(graph: Graph, id: string, depth: number, limit: number): Diagram {
  const start = graph.nodes.get(id);

  if (!start) return unplaced(`sequence:${id}`, id, [], [], [], { reason: `no function "${id}"`, missing: true });
  const callsFrom = new Map<string, typeof graph.calls>();

  for (const call of graph.calls) if (call.kind === "call") callsFrom.set(call.from, [...(callsFrom.get(call.from) ?? []), call]);
  const messages: { from: string; to: string; label: string; line: number; depth: number; times?: number }[] = [];
  const active = new Set<string>();

  const walk = (from: string, level: number): void => {
    if (level >= depth || messages.length >= limit) return;
    active.add(from);

    for (const call of [...(callsFrom.get(from) ?? [])].sort((a, b) => a.line - b.line)) {
      if (messages.length >= limit) break;
      const target = graph.nodes.get(call.to);

      if (!target) continue;
      messages.push({ from: moduleOf(from), to: moduleOf(call.to), label: target.parent ? `${target.parent}.${target.name}` : target.name, line: call.line, depth: level });

      // A call back into a function already on the stack is drawn, not followed: no loop.
      if (!active.has(call.to)) walk(call.to, level + 1);
    }

    active.delete(from);
  };

  walk(id, 0);
  // Consecutive repeats of one call (a loop body, a helper called twice in a row) collapse into one message "×N".
  const collapsed: (typeof messages[number] & { times: number })[] = [];

  for (const message of messages) {
    const last = collapsed[collapsed.length - 1];

    if (last && last.from === message.from && last.to === message.to && last.label === message.label) last.times++;
    else collapsed.push({ ...message, times: 1 });
  }

  messages.length = 0;
  messages.push(...collapsed);
  const participants = [moduleOf(id)];

  for (const message of messages) for (const module of [message.from, message.to]) if (!participants.includes(module)) participants.push(module);

  // More than MAX_PARTICIPANTS lifelines no longer read as a sequence: the rest share one "… N more" lifeline.
  let foldedParticipants = 0;

  if (participants.length > MAX_PARTICIPANTS) {
    const kept = new Set(participants.slice(0, MAX_PARTICIPANTS - 1));
    foldedParticipants = participants.length - kept.size;
    const more = `… ${foldedParticipants} more`;

    for (const message of messages) {
      if (!kept.has(message.from)) message.from = more;

      if (!kept.has(message.to)) message.to = more;
    }

    participants.splice(0, participants.length, ...kept, more);
  }
  const column = new Map(participants.map((module, i) => [module, 20 + i * SEQ_COLUMN]));
  const bottom = 80 + (messages.length + 1) * SEQ_ROW;
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];

  for (const module of participants) {
    const x = column.get(module)!;
    nodes.push({ id: module, kind: "participant", label: module, ref: { id: module, file: module, line: 1 }, x, y: 20, w: SIZE.participant.w, h: SIZE.participant.h });
    nodes.push({ id: `foot:${module}`, kind: "anchor", label: "", x: x + SIZE.participant.w / 2 - 1, y: bottom, w: 2, h: 2 });
    edges.push({ from: module, to: `foot:${module}`, kind: "lifeline", route: [{ x: x + SIZE.participant.w / 2, y: 20 + SIZE.participant.h }, { x: x + SIZE.participant.w / 2, y: bottom }] });
  }

  messages.forEach((message, i) => {
    const y = 80 + (i + 1) * SEQ_ROW;
    const fromX = column.get(message.from)! + SIZE.participant.w / 2;
    const toX = column.get(message.to)! + SIZE.participant.w / 2;
    // A call within one module loops out to the right and back.
    const route = message.from === message.to ? [{ x: fromX, y: y - 12 }, { x: fromX + 70, y: y - 12 }, { x: fromX + 70, y: y + 12 }, { x: fromX + 6, y: y + 12 }] : [{ x: fromX, y }, { x: toX, y }];
    edges.push({ from: message.from, to: message.to, kind: "message", label: `${i + 1}. ${message.label}()${(message.times ?? 1) > 1 ? ` ×${message.times}` : ""}`, route });
  });

  const diagram = unplaced(`sequence:${id}`, `Sequence from ${start.parent ? `${start.parent}.` : ""}${start.name}`, nodes, edges, [], { placed: true, sequence: { participants, messages: messages.map(({ from, to, label, line, times }) => ((times ?? 1) > 1 ? { from, to, label, line, times: times as number } : { from, to, label, line })) } });

  if (messages.length === 0) diagram.reason = "the function calls nothing archdiff can follow";
  else if (messages.length >= limit) diagram.reason = `cut at ${limit} messages; --limit raises it`;

  if (foldedParticipants > 0) diagram.reason = [diagram.reason, `${foldedParticipants} modules share the last lifeline (at most ${MAX_PARTICIPANTS})`].filter(Boolean).join("; ");

  return diagram;
}

/** Lifelines a sequence keeps apart; beyond it the picture is a wall of arrows (the usual guidance says 10–12). */
const MAX_PARTICIPANTS = 12;

const DEFAULT_DEPTH: Partial<Record<View["kind"], number>> = { layer: 1, dir: 1, module: 1, inside: 1, calls: 3, sequence: 4, path: 8, type: 1 };

/** The unplaced diagram of a view, folded to `limit` shapes. */
export function viewOf(analysis: Analysis, view: View, options: ViewOptions = {}): Diagram {
  const depth = options.depth ?? DEFAULT_DEPTH[view.kind] ?? 0;
  const { graph } = analysis;

  const full = (): Diagram => {
    switch (view.kind) {
      case "layers":
        return layersView(graph);
      case "layer":
        return layerView(graph, view.name, depth);
      case "dir":
        return dirView(graph, view.path, depth);
      case "module":
        return moduleView(graph, view.id, depth, options.packages === true);
      case "inside":
        return insideView(graph, view.id, depth);
      case "contract":
        return contractView(analysis, view.id);
      case "calls":
        return callsView(graph, view.id, depth);
      case "sequence":
        return sequenceView(graph, view.id, depth, options.limit ?? MAX_SHAPES);
      case "path":
        return pathView(analysis, view.id, depth);
      case "type":
        return typeView(analysis, view.id);
      case "cycles":
        return cyclesView(graph, null);
      case "cycle":
        return cyclesView(graph, view.id);
      case "classes":
        return classesView(analysis, view.scope, options.limit ?? MAX_SHAPES);
      case "matrix":
        return matrixView(graph, view.scope);
      case "events":
        return eventsView(analysis);
      case "tests":
        return testsView(graph);
      case "hotspots":
        return hotspotsView(graph);
      case "packages":
        return packagesView(analysis);
      case "timeline":
        // The timeline needs git (commits): the server and the CLI build it with `timelineDiagram`; here it is a placeholder.
        return unplaced("timeline", "Timeline", [], [], [], { placed: true, reason: "the timeline is built from the commits (archdiff diagram timeline --base --head)" });
      case "coverage":
        return coverageView(graph);
      case "intent":
        return intentView(analysis, analysis.intent);
      case "modules":
        return modulesView(graph);
    }
  };

  const diagram = full();

  // Hubs leave before the fold (they would eat its budget); the weight filter runs after it, on the merged lines.
  const subject = "id" in view ? view.id : null;
  const shown = options.hideLanes && options.hideLanes.length > 0 ? hideLanes(diagram, options.hideLanes) : diagram;
  const mixed = options.expand && options.expand.length > 0 && MODULE_VIEWS.has(view.kind) ? expandInPlace(shown, graph, options.expand) : shown;
  const slimmed = options.hubs === false || !MODULE_VIEWS.has(view.kind) ? mixed : hubsAsBadges(mixed, subject);
  const answered = slimmed.question ? slimmed : { ...slimmed, question: QUESTION[view.kind] };

  return dropLightLines(answered.placed || answered.classes ? answered : fold(answered, options.limit ?? MAX_SHAPES), options.weight ?? 1);
}

/** The views whose shapes are modules, where a hub (a module most of them import) is noise rather than news. */
const MODULE_VIEWS = new Set<View["kind"]>(["layer", "dir", "module", "cycle", "cycles", "tests", "intent", "modules"]);

/**
 * Modules that most of a picture's modules import — a logger, the shared
 * types — leave the picture: their lines would cross everything and say
 * little. Each importer gets a badge line "+ log.ts, types.ts" instead, and
 * the reason names the hubs with their counts. The view's own subject is
 * never a hub. The Markdown of a module still lists every import.
 */
export function hubsAsBadges(diagram: Diagram, subject: string | null): Diagram {
  const modules = diagram.nodes.filter((node) => node.kind === "module");

  if (modules.length < 8) return diagram;
  const ids = new Set(modules.map((node) => node.id));
  const importers = new Map<string, Set<string>>();

  for (const edge of diagram.edges) {
    if (edge.kind !== "dependency" || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    importers.set(edge.to, new Set([...(importers.get(edge.to) ?? []), edge.from]));
  }

  const threshold = Math.max(HUB_MIN_IMPORTERS, Math.min(HUB_MAX_IMPORTERS, Math.ceil(modules.length * HUB_SHARE)));
  const hubs = modules.filter((node) => node.id !== subject && (importers.get(node.id)?.size ?? 0) >= threshold).map((node) => node.id);

  if (hubs.length === 0) return diagram;
  const hubSet = new Set(hubs);
  const badge = new Map<string, string[]>();

  for (const hub of hubs) for (const importer of importers.get(hub)!) badge.set(importer, [...(badge.get(importer) ?? []), hub.slice(hub.lastIndexOf("/") + 1)]);
  const nodes = diagram.nodes.filter((node) => !hubSet.has(node.id)).map((node) => (badge.has(node.id) ? { ...node, label: `${node.label}\n+ ${badge.get(node.id)!.join(", ")}` } : node));
  const edges = diagram.edges.filter((edge) => !hubSet.has(edge.from) && !hubSet.has(edge.to));
  const note = `hubs as badges, not drawn: ${hubs.map((hub) => `${hub} (imported by ${importers.get(hub)!.size} of ${modules.length})`).join(", ")}`;

  return { ...diagram, nodes, edges, reason: [diagram.reason, note].filter(Boolean).join("; ") };
}

/** Lines standing for fewer imports or calls than `weight` leave the picture; the shapes stay. */
export function dropLightLines(diagram: Diagram, weight: number): Diagram {
  if (weight <= 1) return diagram;
  const kept = diagram.edges.filter((edge) => edge.kind === "lifeline" || edge.kind === "message" || (edge.count ?? 1) >= weight);
  const dropped = diagram.edges.length - kept.length;

  if (dropped === 0) return diagram;

  return { ...diagram, edges: kept, reason: [diagram.reason, `${dropped} lines lighter than ${weight} left out`].filter(Boolean).join("; ") };
}

/**
 * The mix of a module view and the inside of some of its modules: each
 * module named in `expand` leaves its lane and becomes a lane of its own
 * functions and classes, with the calls among them; a line into the module
 * lands on the functions the source actually calls (the rest on a small
 * "rest of the module" shape), a line out of it leaves from the functions
 * that make the calls. Structure and detail in one picture, where it is
 * wanted and nowhere else.
 */
export function expandInPlace(diagram: Diagram, graph: Graph, expand: readonly string[]): Diagram {
  const present = new Set(diagram.nodes.filter((node) => node.kind === "module").map((node) => node.id));
  const opened = expand.filter((id) => present.has(id) && graph.modules.has(id));

  if (opened.length === 0) return diagram;
  const openedSet = new Set(opened);
  const nodes: DiagramNode[] = diagram.nodes.filter((node) => !openedSet.has(node.id));
  const edges: DiagramEdge[] = [];
  const groups: DiagramGroup[] = [...diagram.groups];
  const restOf = (module: string): string => `${module}#(rest)`;
  // The functions of every opened module, by module, and the calls among them.
  const fnsOf = new Map<string, string[]>();

  for (const module of opened) {
    const laneId = `inside:${module}`;
    const own = [...graph.nodes.values()].filter((node) => node.module === module && node.kind !== "type").map((node) => node.id);
    fnsOf.set(module, own);
    groups.push({ id: laneId, label: `${module} (inside)`, kind: "lane", x: 0, y: 0, w: 0, h: 0 });

    for (const id of own) nodes.push({ ...fnNode(graph, id), group: laneId });
    nodes.push({ id: restOf(module), kind: "module", label: `${module.slice(module.lastIndexOf("/") + 1)}\n(rest of the module)`, ref: { id: module, file: module, line: 1 }, group: laneId, x: 0, y: 0, w: 0, h: 0 });
  }

  const seen = new Set<string>();

  const push = (edge: DiagramEdge): void => {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;

    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (const module of opened) {
    const own = new Set(fnsOf.get(module)!);

    for (const call of graph.calls) if (own.has(call.from) && own.has(call.to) && call.from !== call.to) push({ from: call.from, to: call.to, kind: call.kind });
  }

  // The lines of the picture: those touching an opened module land on its functions where a call names one.
  for (const edge of diagram.edges) {
    const fromOpen = openedSet.has(edge.from);
    const toOpen = openedSet.has(edge.to);

    if (!fromOpen && !toOpen) {
      push(edge);
      continue;
    }

    if (fromOpen && toOpen) {
      // Between two opened modules: the calls between their functions, else rest → rest.
      const calls = graph.calls.filter((call) => moduleOf(call.from) === edge.from && moduleOf(call.to) === edge.to && fnsOf.get(edge.from)!.includes(call.from) && fnsOf.get(edge.to)!.includes(call.to));

      if (calls.length === 0) push({ from: restOf(edge.from), to: restOf(edge.to), kind: edge.kind });
      else for (const call of calls) push({ from: call.from, to: call.to, kind: call.kind });
    } else if (toOpen) {
      // Into the module: the functions called from the source's module (or from the source function itself).
      const sourceModule = diagram.nodes.find((node) => node.id === edge.from);
      const fromModule = sourceModule?.kind === "fn" ? moduleOf(sourceModule.ref?.id ?? edge.from) : edge.from;
      const targets = new Set(graph.calls.filter((call) => moduleOf(call.from) === fromModule && fnsOf.get(edge.to)!.includes(call.to)).map((call) => call.to));

      if (targets.size === 0) push({ from: edge.from, to: restOf(edge.to), kind: edge.kind });
      else for (const target of targets) push({ from: edge.from, to: target, kind: "call" });
    } else {
      // Out of the module: the functions that call into the target's module.
      const targetModule = diagram.nodes.find((node) => node.id === edge.to);
      const toModule = targetModule?.kind === "fn" ? moduleOf(targetModule.ref?.id ?? edge.to) : edge.to;
      const sources = new Set(graph.calls.filter((call) => fnsOf.get(edge.from)!.includes(call.from) && (moduleOf(call.to) === toModule || call.to === toModule)).map((call) => call.from));

      if (sources.size === 0) push({ from: restOf(edge.from), to: edge.to, kind: edge.kind });
      else for (const source of sources) push({ from: source, to: edge.to, kind: "call" });
    }
  }

  const note = `opened in place: ${opened.join(", ")}`;

  return { ...diagram, nodes, edges, groups, reason: [diagram.reason, note].filter(Boolean).join("; ") };
}

/** The picture without the lanes named: their shapes and every line touching them go; a lane the picture lacks is ignored. */
export function hideLanes(diagram: Diagram, lanes: readonly string[]): Diagram {
  const hidden = new Set(lanes.filter((lane) => diagram.groups.some((group) => group.id === lane)));

  if (hidden.size === 0) return diagram;
  const gone = new Set(diagram.nodes.filter((node) => node.group !== undefined && hidden.has(node.group)).map((node) => node.id));
  const nodes = diagram.nodes.filter((node) => !gone.has(node.id));
  const edges = diagram.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to));
  const groups = diagram.groups.filter((group) => !hidden.has(group.id));

  return { ...diagram, nodes, edges, groups, reason: [diagram.reason, `lanes hidden: ${[...hidden].join(", ")} (${gone.size} shapes)`].filter(Boolean).join("; ") };
}
