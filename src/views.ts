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
import { SIZE, type Diagram, type DiagramEdge, type DiagramNode } from "./diagram.ts";
import { matchesGlob } from "./glob.ts";
import { INTENT_FILE } from "./intent.ts";
import { intentView } from "./intent-view.ts";
import { moduleOf, type Graph, type GraphNode } from "./graph.ts";
import { classesView, contractView, cyclesView, eventsView, hotspotsView, matrixView, packagesView, pathView, testsView, typeView } from "./views-more.ts";
import { depEdges, externalNode, fnNode, grow, lane, lanesOf, moduleNode, unplaced } from "./nodes.ts";
import { MAX_SHAPES } from "./shape.ts";
import { DEFAULT_DEPTH, type View } from "./view-keys.ts";
import { runSteps } from "./pipeline.ts";
import { timelineDiagram } from "./views-more.ts";
import type { GraphDiff } from "./diff.ts";
import type { LaneMode, Overlay, PictureOptions } from "./options.ts";

export { MAX_SHAPES } from "./shape.ts";
export { parseView, viewKey, QUESTION, type View } from "./view-keys.ts";
export { depEdges, externalNode, fnNode, grow, lane, lanesOf, moduleNode, unplaced } from "./nodes.ts";

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
  /** Overlays laid over the picture after the fold, in order (tests, storages, heat, instability). */
  overlays?: readonly Overlay[];
  /** The review's diff whose marks are laid over the picture (`--changes`). */
  diff?: GraphDiff;
  /** With `diff`: keep the marked shapes and their neighbours only. */
  onlyChanges?: boolean;
  /** Lanes as rows or columns; `auto` lets the layout decide by the number of lanes. */
  lanes?: LaneMode;
  /** Count type-only imports too (cycles, matrix), drawn dashed. */
  types?: boolean;
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

/** The view options a picture's options (options.ts) imply, as `viewOf` takes them. */
export function viewOptionsOf(picture: PictureOptions): ViewOptions {
  const options: ViewOptions = { packages: picture.packages, hubs: picture.hubs, expand: picture.expand, hideLanes: picture.hideLanes, overlays: picture.overlays, onlyChanges: picture.onlyChanges, lanes: picture.lanes, types: picture.types };

  if (picture.depth !== null) options.depth = picture.depth;

  if (picture.limit !== null) options.limit = picture.limit;

  if (picture.weight !== null) options.weight = picture.weight;

  return options;
}

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
        // From the commits of a range, which the caller attaches with `withTimeline` (git is read at the edge, not here).
        return analysis.timeline ? timelineDiagram(analysis.timeline.rows, analysis.timeline.base, analysis.timeline.head) : unplaced("timeline", "Timeline", [], [], [], { placed: true, reason: "the timeline is built from the commits (archdiff diagram timeline --base --head)" });
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
  return runSteps(full(), { analysis, graph, view, options, subject: "id" in view ? view.id : null });
}


