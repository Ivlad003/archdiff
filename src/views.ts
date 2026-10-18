// The views of the graph: which picture to draw of what, each a pure
// function of the graph (and a depth) that returns an unplaced `Diagram`
// for `layout`. Views: `layers` (the layers and the imports between them),
// `layer:<name>` (its modules and their neighbours), `dir:<path>` (the
// modules of a directory and their neighbours), `module:<path>` (what
// imports it and what it imports), `calls:<path>#<fn>` (the call tree from a
// function), `coverage` (the modules with calls archdiff could not follow).
// `inside:<path>` (the functions of a module and the calls among them,
// lanes being modules), `sequence:<path>#<fn>` (the calls from a function
// as a sequence diagram, placed), `focus:<path>[#<fn>]` (everything joined
// to one shape across the modules). Lanes are layers elsewhere; the depth
// is how far from the subject the picture goes.
//
// Pipeline: Analysis → View → Diagram → layout → canvas/exports/markdown.
// Entry points: `parseView`, `viewKey`, `viewList`, `viewOf`, `entryPoints`.

import type { Analysis } from "./analyze.ts";
import { SIZE, type Diagram, type Line, type PictureContent, type Shape } from "./diagram.ts";
import { matchesGlob } from "./glob.ts";
import { INTENT_FILE } from "./intent.ts";
import { intentView } from "./intent-view.ts";
import { moduleOf, type Graph, type Declaration } from "./graph.ts";
import { classesView, usageView, eventsView, hotspotsView, matrixView, packagesView, pathView, testsView, typeView } from "./views-more.ts";
import { cyclesView } from "./cycles.ts";
import { metricsView } from "./metrics.ts";
import { machinesOf, machinesView, machineView } from "./machines.ts";
import { logicList, logicView } from "./logic.ts";
import { depEdges, externalNode, fnNode, grow, lane, lanesOf, moduleNode, unplaced } from "./nodes.ts";
import { MAX_SHAPES } from "./shape.ts";
import { defaultDepth, viewKey, type View } from "./view-keys.ts";
import { runSteps } from "./pipeline.ts";
import { timelineDiagram } from "./views-more.ts";
import { compareDiagram, diffDiagram, type Compared, type GraphDiff, type HistoryRow } from "./diff.ts";
import type { LogicFact } from "./extract/logic.ts";
import { DEFAULT_PICTURE_OPTIONS, type PictureOptions } from "./options.ts";

export { MAX_SHAPES } from "./shape.ts";
export { parseView, viewKey, type View } from "./view-keys.ts";
export { depEdges, externalNode, fnNode, grow, lane, lanesOf, moduleNode, unplaced } from "./nodes.ts";

/**
 * What a view reads at the edge, besides the analysis: git and a file,
 * read by picture.ts (the commits of a timeline, the two graphs of a
 * review, the heads of a comparison, a function's body for its logic, the
 * review's diff for `changes`), so the views stay pure functions.
 */
export interface EdgeReads {
  /** `changes`: the review's diff whose marks are laid over the picture. */
  diff?: GraphDiff;
  timeline?: { rows: readonly HistoryRow[]; base: string; head: string };
  /** The flowchart of the function of a `logic:` view; null when its body could not be read. */
  logic?: LogicFact | null;
  review?: { diff: GraphDiff; base: Graph; head: Graph };
  compare?: { base: string; heads: readonly Compared[]; baseGraph: Graph; graphs: ReadonlyMap<string, Graph> };
}

export interface ViewEntry {
  key: string;
  title: string;
  kind: View["kind"];
  /** The lane the subject sits in. */
  layer?: string;
}

/** Modules whose public methods a framework calls: controllers, handlers, commands, jobs, listeners, middleware, routes. */
const HANDLER_MODULE = /(controller|handler|command|job|listener|subscriber|middleware|route|resolver|consumer|action)s?[/.]|[/.](controllers?|handlers?|commands?|jobs?|listeners?|middlewares?|routes?|actions?)\//i;

/** A function execution starts from, with how it is known. */
export interface EntryPoint {
  node: Declaration;
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
  const exportedNode = (module: string, exportName: string): Declaration | null => {
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
  list.push({ key: "cycles", title: "Cycles: modules importing each other, and where to cut", kind: "cycles" });
  list.push({ key: "cycles:fns", title: "Call cycles: functions calling each other across modules", kind: "cycles" });
  list.push({ key: "metrics", title: "Metrics: coupling and cohesion of every module", kind: "metrics" });
  list.push({ key: "machines", title: "State machines: declared by a library or written with literal states", kind: "machines" });

  for (const machine of machinesOf(analysis)) list.push({ key: machine.id, title: `${machine.name} (${machine.module}) — ${machine.states.length} states`, kind: "machine", layer: graph.modules.get(machine.module)!.layer });
  list.push({ key: "logic", title: "Logic: the functions with branches in them, the most branching first", kind: "logic" });

  for (const fn of logicList(analysis)) list.push({ key: `logic:${fn.id}`, title: `${fn.parent ? `${fn.parent}.` : ""}${fn.name} (${fn.module}) — ${fn.branches} ${fn.branches === 1 ? "branch" : "branches"}`, kind: "logic", layer: graph.modules.get(fn.module)!.layer });
  list.push({ key: "events", title: "Events: emitters and listeners", kind: "events" });
  list.push({ key: "tests", title: "Tests: which modules the tests cover", kind: "tests" });
  list.push({ key: "hotspots", title: "Hotspots: size and calls in", kind: "hotspots" });

  if (analysis.packages.length > 1) list.push({ key: "packages", title: `Packages: ${analysis.packages.length} package.json as a system`, kind: "packages" });
  list.push({ key: "timeline", title: "Timeline: the drift of the architecture, commit by commit", kind: "timeline" });

  return list;
}

/** The layers and the imports between them, each line counted. */
function layersView(graph: Graph): PictureContent {
  const counts = new Map<string, number>();
  const modulesOf = new Map<string, number>();

  for (const module of graph.modules.values()) modulesOf.set(module.layer, (modulesOf.get(module.layer) ?? 0) + 1);

  for (const dep of graph.deps) {
    const from = graph.modules.get(dep.from)?.layer;
    const to = graph.modules.get(dep.to)?.layer;

    if (!from || !to || from === to || dep.typeOnly) continue;
    counts.set(`${from}\u0000${to}`, (counts.get(`${from}\u0000${to}`) ?? 0) + 1);
  }

  const nodes = graph.layers.map((layer): Shape => ({ id: layer, kind: "layer", label: layer, count: modulesOf.get(layer) ?? 0, x: 0, y: 0, w: 0, h: 0 }));
  const edges = [...counts].map(([key, count]): Line => {
    const [from, to] = key.split("\u0000") as [string, string];

    return { from, to, kind: "dependency", count, label: String(count) };
  });

  return unplaced("Layers", nodes, edges, []);
}

/** The modules of a layer; depth 1 (default) adds the modules of other layers they import or are imported by. */
function layerView(graph: Graph, name: string, depth: number): PictureContent {
  const own = [...graph.modules.values()].filter((module) => module.layer === name).map((module) => module.id);

  if (own.length === 0) return unplaced(name, [], [], [], { reason: `no layer "${name}"`, missing: true });
  const members = grow(graph, new Set(own), depth, "both");
  const ownSet = new Set(own);
  // The layer's own modules first: a folded picture keeps them and folds the neighbours.
  const nodes = [...members].sort((a, b) => Number(ownSet.has(b)) - Number(ownSet.has(a)) || (a < b ? -1 : 1)).map((id) => moduleNode(graph, id));

  return unplaced(`Layer ${name}`, nodes, depEdges(graph, members, false), lanesOf(graph, nodes));
}

/** One module: what imports it (left) and what it imports (right), and with `packages` the packages too; depth 1 default. */
function moduleView(graph: Graph, id: string, depth: number, packages: boolean): PictureContent {
  if (!graph.modules.has(id)) return unplaced(id, [], [], [], { reason: `no module "${id}"`, missing: true });
  const members = grow(graph, new Set([id]), depth, "both");
  const nodes = [...members].sort().map((member) => moduleNode(graph, member));
  const edges = depEdges(graph, members, packages);
  const externals = new Set(edges.map((edge) => edge.to).filter((to) => graph.externals.has(to)));

  for (const external of [...externals].sort()) nodes.push(externalNode(graph, external));

  return unplaced(id, nodes, edges, lanesOf(graph, nodes));
}

/** The modules of a directory (and below), with the imports among them; depth 1 (default) adds their neighbours outside it. */
function dirView(graph: Graph, path: string, depth: number): PictureContent {
  const prefix = `${path}/`;
  const own = [...graph.modules.keys()].filter((id) => id.startsWith(prefix));

  if (own.length === 0) return unplaced(path, [], [], [], { reason: `no modules under "${path}/"`, missing: true });
  const members = grow(graph, new Set(own), depth, "both");
  const ownSet = new Set(own);
  const nodes = [...members].sort((a, b) => Number(ownSet.has(b)) - Number(ownSet.has(a)) || (a < b ? -1 : 1)).map((id) => moduleNode(graph, id));

  return unplaced(`${path}/`, nodes, depEdges(graph, members, false), lanesOf(graph, nodes));
}

/** The whole map: every module in its layer's lane and every import between modules (packages left out). Big by nature: hubs, the fold and the weight keep it readable. */
function modulesView(graph: Graph): PictureContent {
  const ids = [...graph.modules.keys()].sort();

  if (ids.length === 0) return unplaced("Modules", [], [], [], { reason: "no modules" });
  const nodes = ids.map((id) => moduleNode(graph, id));

  return unplaced(`Modules: ${ids.length} in ${graph.layers.length} layers`, nodes, depEdges(graph, new Set(ids), false), lanesOf(graph, nodes));
}

/** The call tree from a function: the functions it calls, and theirs, `depth` levels (default 3); gaps as holes. */
function callsView(graph: Graph, id: string, depth: number): PictureContent {
  const start = graph.nodes.get(id);

  if (!start) return unplaced(id, [], [], [], { reason: `no function "${id}"`, missing: true });
  const members = new Set([id]);
  const edges: Line[] = [];
  const seenEdges = new Set<string>();
  let frontier = new Set([id]);
  const callsFrom = new Map<string, typeof graph.calls>();

  for (const call of graph.calls) callsFrom.set(call.from, [...(callsFrom.get(call.from) ?? []), call]);
  const gapsFrom = new Map<string, typeof graph.gaps>();

  for (const gap of graph.gaps) gapsFrom.set(gap.from, [...(gapsFrom.get(gap.from) ?? []), gap]);
  const holes: Shape[] = [];

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

  return unplaced(`Calls from ${start.parent ? `${start.parent}.` : ""}${start.name}`, [...nodes, ...holes], edges, lanesOf(graph, [...nodes, ...holes]));
}

/** The modules with calls into the repository archdiff could not follow (blind spots) or imports it could not resolve, by layer, labelled with the counts. */
function coverageView(graph: Graph): PictureContent {
  const gapsOf = new Map<string, number>();

  for (const gap of graph.gaps) if (gap.reason === "dynamic" || gap.reason === "unknown-member" || gap.reason === "interface") gapsOf.set(moduleOf(gap.from), (gapsOf.get(moduleOf(gap.from)) ?? 0) + 1);

  for (const unresolved of graph.unresolvedImports) gapsOf.set(unresolved.from, (gapsOf.get(unresolved.from) ?? 0) + 1);
  const callsOf = new Map<string, number>();

  for (const call of graph.calls) callsOf.set(moduleOf(call.from), (callsOf.get(moduleOf(call.from)) ?? 0) + 1);
  const nodes = [...gapsOf]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id, gaps]): Shape => ({ ...moduleNode(graph, id), label: `${id}\n${gaps} gaps / ${callsOf.get(id) ?? 0} calls`, count: gaps, diff: "changed" }));

  return unplaced("What the diagrams cannot show", nodes, [], lanesOf(graph, nodes), nodes.length === 0 ? { reason: "every import and call was followed" } : {});
}

/**
 * Inside a module: its functions, classes and methods, the calls among
 * them, and (depth 1, default) the functions of other modules they call,
 * each module a lane. The map of one file.
 */
function insideView(graph: Graph, id: string, depth: number): PictureContent {
  const module = graph.modules.get(id);

  if (!module) return unplaced(id, [], [], [], { reason: `no module "${id}"`, missing: true });
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
  const edges: Line[] = [];

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

  if (nodes.length === 0) return unplaced(`Inside ${id}`, [], [], [], { reason: "the module declares no function or class" });

  return unplaced(`Inside ${id}`, nodes, edges, [...new Set(modules)].map(lane));
}

/**
 * Everything joined to one shape, across the modules: for a function, the
 * functions that call it (`depth` steps back) and the ones it calls
 * (`depth` steps on), calls and references alike; for a module, its own
 * functions with their callers and callees in other modules, and the
 * modules that import it or that it imports without a call between them
 * (the module itself as a shape then). Lanes are modules.
 */
function focusView(graph: Graph, id: string, depth: number): PictureContent {
  const fn = graph.nodes.get(id);
  const module = graph.modules.get(id);

  if ((!fn || fn.kind === "type") && !module) return unplaced(id, [], [], [], { reason: `no function or module "${id}"`, missing: true });
  const own = module ? [...graph.nodes.values()].filter((node) => node.module === id && node.kind !== "type").map((node) => node.id) : [id];
  const members = new Set(own);
  const edges: Line[] = [];
  const seen = new Set<string>();

  const take = (from: string, to: string, kind: Line["kind"]): void => {
    const edgeKey = `${from}\u0000${to}\u0000${kind}`;

    if (seen.has(edgeKey) || from === to) return;
    seen.add(edgeKey);
    edges.push({ from, to, kind });
  };

  // Out along the calls, then back along them, `depth` steps each way; a call at a module's top level comes from the module.
  let frontier = new Set(own);

  for (let step = 0; step < depth && frontier.size > 0; step++) {
    const next = new Set<string>();

    for (const call of graph.calls) {
      if (!frontier.has(call.from) || graph.nodes.get(call.to)?.kind === "type") continue;

      if (!members.has(call.to)) next.add(call.to);
    }

    for (const target of next) members.add(target);
    frontier = next;
  }

  frontier = new Set(own);

  for (let step = 0; step < depth && frontier.size > 0; step++) {
    const next = new Set<string>();

    for (const call of graph.calls) {
      if (!frontier.has(call.to) || !graph.nodes.has(call.from)) continue;

      if (!members.has(call.from)) next.add(call.from);
    }

    for (const source of next) members.add(source);
    frontier = next;
  }

  for (const call of graph.calls) if (members.has(call.from) && members.has(call.to)) take(call.from, call.to, call.kind);
  const nodes: Shape[] = [...members].filter((member) => graph.nodes.has(member)).map((member) => ({ ...fnNode(graph, member), group: moduleOf(member) }));

  // A module: the modules joined by an import with no call drawn between them, as module shapes beside the subject's own.
  if (module) {
    const drawn = new Set(nodes.map((node) => moduleOf(node.id)));
    const importers = graph.deps.filter((dep) => dep.to === id && !dep.typeOnly && graph.modules.has(dep.from) && !drawn.has(dep.from)).map((dep) => dep.from);
    const imported = graph.deps.filter((dep) => dep.from === id && !dep.typeOnly && graph.modules.has(dep.to) && !drawn.has(dep.to)).map((dep) => dep.to);
    const others = [...new Set([...importers, ...imported])].sort();

    if (others.length > 0 || nodes.length === 0) {
      nodes.unshift({ ...moduleNode(graph, id), label: `${id}\n(the module)`, group: id });

      for (const other of others) nodes.push({ ...moduleNode(graph, other), group: other });

      for (const other of importers) take(other, id, "dependency");

      for (const other of imported) take(id, other, "dependency");
    }
  }

  // The subject's lane first, then the others as they come; the subject's shapes first, so a folded picture keeps them.
  const subjectModule = module ? id : moduleOf(id);
  nodes.sort((a, b) => Number((b.group ?? "") === subjectModule) - Number((a.group ?? "") === subjectModule) || Number(own.includes(b.id)) - Number(own.includes(a.id)));
  const lanes = [subjectModule, ...[...new Set(nodes.map((node) => node.group ?? ""))].filter((group) => group !== subjectModule && group !== "").sort()];
  const subject = fn ? `${fn.parent ? `${fn.parent}.` : ""}${fn.name}` : id;
  const callers = edges.filter((edge) => edge.kind !== "dependency" && own.includes(edge.to) && !own.includes(edge.from)).length;
  const callees = edges.filter((edge) => edge.kind !== "dependency" && own.includes(edge.from) && !own.includes(edge.to)).length;

  return unplaced(`Everything joined to ${subject}`, nodes, edges, lanes.map(lane), { reason: `${callers} calls in, ${callees} calls out, ${lanes.length - 1} other modules, ${depth} ${depth === 1 ? "step" : "steps"} each way (--depth goes further)` });
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
function sequenceView(graph: Graph, id: string, depth: number, limit: number): PictureContent {
  const start = graph.nodes.get(id);

  if (!start) return unplaced(id, [], [], [], { reason: `no function "${id}"`, missing: true });
  const callsFrom = new Map<string, typeof graph.calls>();

  for (const call of graph.calls) if (call.kind === "call") callsFrom.set(call.from, [...(callsFrom.get(call.from) ?? []), call]);
  type Guard = { id: string; kind: "opt" | "loop"; label: string };
  const messages: { from: string; to: string; label: string; line: number; depth: number; times?: number; chain: Guard[] }[] = [];
  const active = new Set<string>();

  // The guards of a message, outermost first: those its caller sat under (the calls a guarded call makes happen under
  // the same guards), then its own call's branches and loops. A guard's id is made unique per function it sits in.
  const walk = (from: string, level: number, inherited: Guard[]): void => {
    if (level >= depth || messages.length >= limit) return;
    active.add(from);

    for (const call of [...(callsFrom.get(from) ?? [])].sort((a, b) => a.line - b.line)) {
      if (messages.length >= limit) break;
      const target = graph.nodes.get(call.to);

      if (!target) continue;
      const own = (call.guards ?? []).map((guard): Guard => ({ id: `${from}:${guard.id}`, kind: guard.kind === "loop" ? "loop" : "opt", label: guard.kind === "loop" || guard.kind === "if" || guard.kind === "else" ? guard.text : guard.text === "" || guard.text === guard.kind ? guard.kind : `${guard.kind} ${guard.text}` }));
      const chain = [...inherited, ...own];
      messages.push({ from: moduleOf(from), to: moduleOf(call.to), label: target.parent ? `${target.parent}.${target.name}` : target.name, line: call.line, depth: level, chain });

      // A call back into a function already on the stack is drawn, not followed: no loop.
      if (!active.has(call.to)) walk(call.to, level + 1, chain);
    }

    active.delete(from);
  };

  walk(id, 0, []);
  // Consecutive repeats of one call (a loop body, a helper called twice in a row) collapse into one message "×N".
  const collapsed: (typeof messages[number] & { times: number })[] = [];

  for (const message of messages) {
    const last = collapsed[collapsed.length - 1];

    if (last && last.from === message.from && last.to === message.to && last.label === message.label && last.chain.map((guard) => guard.id).join() === message.chain.map((guard) => guard.id).join()) last.times++;
    else collapsed.push({ ...message, times: 1 });
  }

  // Consecutive messages under one guard form a fragment: an opt (a branch) or a loop, labelled with the condition;
  // the guards inside a guard nest, up to three deep.
  const fragments: NonNullable<Diagram["sequence"]>["fragments"] = [];

  const frame = (first: number, last: number, level: number): void => {
    if (level >= 3) return;
    let i = first;

    while (i <= last) {
      const guard = collapsed[i]!.chain[level];

      if (!guard) {
        i++;
        continue;
      }

      let end = i;

      while (end + 1 <= last && collapsed[end + 1]!.chain[level]?.id === guard.id) end++;
      fragments.push({ kind: guard.kind, label: guard.label, first: i, last: end, level });
      frame(i, end, level + 1);
      i = end + 1;
    }
  };

  frame(0, collapsed.length - 1, 0);
  fragments.sort((a, b) => a.first - b.first || a.level - b.level);

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
  const nodes: Shape[] = [];
  const edges: Line[] = [];

  for (const module of participants) {
    const x = column.get(module)!;
    nodes.push({ id: module, kind: "participant", label: module, ref: { id: module, file: module, line: 1 }, x, y: 20, w: SIZE.participant.w, h: SIZE.participant.h });
    nodes.push({ id: `foot:${module}`, kind: "anchor", label: "", x: x + SIZE.participant.w / 2 - 1, y: bottom, w: 2, h: 2 });
    edges.push({ from: module, to: `foot:${module}`, kind: "lifeline", route: [{ x: x + SIZE.participant.w / 2, y: 20 + SIZE.participant.h }, { x: x + SIZE.participant.w / 2, y: bottom }] });
  }

  // A fragment is a dashed frame across every lifeline, from a little above its first message to a little below its
  // last; a nested one sits a few pixels inside its parent.
  for (const [i, fragment] of fragments.entries()) {
    const inset = fragment.level * 8;
    const top = 80 + (fragment.first + 1) * SEQ_ROW - 26 + inset;
    const bottom = 80 + (fragment.last + 1) * SEQ_ROW + 14 - inset;
    nodes.push({ id: `fragment:${i}`, kind: "fragment", label: `${fragment.kind} [${fragment.label}]`, x: 6 + inset, y: top, w: participants.length * SEQ_COLUMN - 2 * inset, h: bottom - top });
  }

  messages.forEach((message, i) => {
    const y = 80 + (i + 1) * SEQ_ROW;
    const fromX = column.get(message.from)! + SIZE.participant.w / 2;
    const toX = column.get(message.to)! + SIZE.participant.w / 2;
    // A call within one module loops out to the right and back.
    const route = message.from === message.to ? [{ x: fromX, y: y - 12 }, { x: fromX + 70, y: y - 12 }, { x: fromX + 70, y: y + 12 }, { x: fromX + 6, y: y + 12 }] : [{ x: fromX, y }, { x: toX, y }];
    edges.push({ from: message.from, to: message.to, kind: "message", label: `${i + 1}. ${message.label}()${(message.times ?? 1) > 1 ? ` ×${message.times}` : ""}`, route });
  });

  const diagram = unplaced(`Sequence from ${start.parent ? `${start.parent}.` : ""}${start.name}`, nodes, edges, [], { placed: true, sequence: { participants, messages: messages.map(({ from, to, label, line, times }) => ((times ?? 1) > 1 ? { from, to, label, line, times: times as number } : { from, to, label, line })), ...(fragments.length > 0 ? { fragments } : {}) } });

  if (fragments.length > 0) diagram.reason = `${fragments.length} fragments: the calls under a branch or a loop, framed`;

  if (messages.length === 0) diagram.reason = "the function calls nothing archdiff can follow";
  else if (messages.length >= limit) diagram.reason = `cut at ${limit} messages; --limit raises it`;

  if (foldedParticipants > 0) diagram.reason = [diagram.reason, `${foldedParticipants} modules share the last lifeline (at most ${MAX_PARTICIPANTS})`].filter(Boolean).join("; ");

  return diagram;
}

/** Lifelines a sequence keeps apart; beyond it the picture is a wall of arrows (the usual guidance says 10–12). */
const MAX_PARTICIPANTS = 12;

/**
 * The picture of a view before `layout`: drawn from the analysis (and what
 * the edge read for it), then shaped by the steps of pipeline.ts with the
 * picture's options — hidden lanes, the mix, hubs, the fold, the weight,
 * the review's marks, the overlays, the lanes.
 */
export function viewOf(analysis: Analysis, view: View, options: PictureOptions = DEFAULT_PICTURE_OPTIONS, reads: EdgeReads = {}): Diagram {
  const depth = options.depth ?? defaultDepth(view.kind);
  const limit = options.limit ?? MAX_SHAPES;
  const { graph } = analysis;

  const full = (): PictureContent => {
    switch (view.kind) {
      case "layers":
        return layersView(graph);
      case "layer":
        return layerView(graph, view.subject, depth);
      case "dir":
        return dirView(graph, view.subject, depth);
      case "module":
        return moduleView(graph, view.subject, depth, options.packages);
      case "inside":
        return insideView(graph, view.subject, depth);
      case "usage":
        return usageView(analysis, view.subject);
      case "calls":
        return callsView(graph, view.subject, depth);
      case "sequence":
        return sequenceView(graph, view.subject, depth, limit);
      case "path":
        return pathView(analysis, view.subject, depth);
      case "type":
        return typeView(analysis, view.subject);
      case "cycles":
        return cyclesView(graph, null, { types: options.types, fns: view.subject === "fns" });
      case "cycle":
        return cyclesView(graph, view.subject, { types: options.types, fns: view.subject.includes("#") });
      case "classes":
        return classesView(analysis, view.subject, limit);
      case "matrix":
        return matrixView(graph, view.subject, options.types);
      case "metrics":
        return metricsView(analysis, view.subject, limit, options.types);
      case "machines":
        return machinesView(analysis);
      case "machine":
        return machineView(analysis, view.subject);
      case "focus":
        return focusView(graph, view.subject, depth);
      case "logic":
        return logicView(analysis, view.subject, reads.logic);
      case "events":
        return eventsView(analysis);
      case "tests":
        return testsView(graph);
      case "hotspots":
        return hotspotsView(graph);
      case "packages":
        return packagesView(analysis);
      case "timeline":
        // From the commits of a range, which picture.ts reads from git.
        return reads.timeline ? timelineDiagram(reads.timeline.rows, reads.timeline.base, reads.timeline.head) : unplaced("Timeline", [], [], [], { placed: true, reason: "the timeline is built from the commits of a range (archdiff diagram timeline --base --head)" });
      case "review":
        // The analyses of the base and the head, which picture.ts reads from git.
        return reads.review ? diffDiagram(reads.review.diff, reads.review.base, reads.review.head) : unplaced("Review", [], [], [], { reason: "a review is read from git (archdiff review, or the page's review)" });
      case "compare":
        return reads.compare ? compareDiagram(reads.compare.base, reads.compare.heads, reads.compare.baseGraph, reads.compare.graphs) : unplaced("Compare", [], [], [], { reason: "a comparison is read from git (archdiff compare --heads a,b)" });
      case "coverage":
        return coverageView(graph);
      case "intent":
        return intentView(analysis, analysis.intent);
      case "modules":
        return modulesView(graph);
    }
  };

  // The steps after a view — hidden lanes, the mix, hubs, the question, the fold, the weight, the review's marks, the
  // overlays — are the pipeline's data (pipeline.ts), each a pure Diagram → Diagram that explains itself in `reason`.
  // The view's key comes from the codec (view-keys.ts), never from the view function that drew the picture.
  return runSteps({ view: viewKey(view), ...full() }, { analysis, graph, view, options, reads, subject: view.subject });
}


