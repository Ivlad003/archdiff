// The views of the graph: which picture to draw of what, each a pure
// function of the graph (and a depth) that returns an unplaced `Diagram`
// for `layout`. Views: `layers` (the layers and the imports between them),
// `layer:<name>` (its modules and their neighbours), `dir:<path>` (the
// modules of a directory and their neighbours), `module:<path>` (what
// imports it and what it imports), `calls:<path>#<fn>` (the call tree from a
// function), `coverage` (the modules with calls archdiff could not follow).
// Lanes are layers; the depth is how far from the subject the picture goes.
//
// Pipeline: Analysis → View → Diagram → layout → canvas/exports/markdown.
// Entry points: `parseView`, `viewKey`, `viewList`, `viewOf`, `entryPoints`.

import type { Analysis } from "./analyze.ts";
import type { Diagram, DiagramEdge, DiagramGroup, DiagramNode } from "./diagram.ts";
import { matchesGlob } from "./glob.ts";
import { moduleOf, type Graph, type GraphNode } from "./graph.ts";

export type View = { kind: "layers" } | { kind: "layer"; name: string } | { kind: "dir"; path: string } | { kind: "module"; id: string } | { kind: "calls"; id: string } | { kind: "coverage" };

export interface ViewOptions {
  /** How far from the subject the picture goes; each view has its default. */
  depth?: number;
  /** Draw the packages and built-ins a module imports (the module view); off by default: they crowd the picture. */
  packages?: boolean;
  /** At most this many shapes; the rest fold into one `more` shape. Default `MAX_SHAPES`. */
  limit?: number;
}

/** More shapes than this and a view folds the tail into one shape. */
export const MAX_SHAPES = 80;

export interface ViewEntry {
  key: string;
  title: string;
  kind: View["kind"];
  /** The lane the subject sits in. */
  layer?: string;
}

/** `layers`, `layer:<name>`, `module:<path>`, `calls:<path>#<fn>`, `coverage` → the view, or null. */
export function parseView(key: string): View | null {
  if (key === "layers") return { kind: "layers" };

  if (key === "coverage") return { kind: "coverage" };
  const at = key.indexOf(":");

  if (at === -1) return null;
  const kind = key.slice(0, at);
  const rest = key.slice(at + 1);

  if (rest === "") return null;

  if (kind === "layer") return { kind, name: rest };

  if (kind === "dir") return { kind, path: rest.replace(/\/+$/, "") };

  if (kind === "module") return { kind, id: rest };

  if (kind === "calls") return { kind, id: rest };

  return null;
}

export function viewKey(view: View): string {
  switch (view.kind) {
    case "layers":
    case "coverage":
      return view.kind;
    case "layer":
      return `layer:${view.name}`;
    case "dir":
      return `dir:${view.path}`;
    case "module":
      return `module:${view.id}`;
    case "calls":
      return `calls:${view.id}`;
  }
}

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
  const { graph, config, facts } = analysis;
  const called = new Set(graph.calls.map((edge) => edge.to));
  const entries = new Map<string, EntryPoint>();

  // The node an export name of a module stands for, through the module's export table.
  const exportedNode = (module: string, exportName: string): GraphNode | null => {
    const row = facts.get(module)?.exportRows.find((candidate) => candidate.name === exportName);
    const node = row?.local ? graph.nodes.get(`${module}#${row.local}`) : undefined;

    return node && node.kind === "fn" ? node : null;
  };

  for (const declared of analysis.declaredEntries) {
    if (declared.exportName === "*") {
      for (const id of graph.modules.get(declared.module)?.decls ?? []) {
        const node = graph.nodes.get(id)!;

        if (node.kind === "fn" && node.exported && !entries.has(id)) entries.set(id, { node, label: declared.label });
      }
    } else {
      const node = exportedNode(declared.module, declared.exportName);

      if (node && !entries.has(node.id)) entries.set(node.id, { node, label: declared.label });
    }
  }

  for (const node of graph.nodes.values()) {
    if (node.kind !== "fn" || node.parent || !node.exported || entries.has(node.id)) continue;

    if (node.module.startsWith("bin/")) entries.set(node.id, { node, label: "bin" });
    else if (node.name === "main") entries.set(node.id, { node, label: "main" });
    else if (config.entries.some((glob) => matchesGlob(node.module, glob))) entries.set(node.id, { node, label: "entries" });
    else if (!called.has(node.id) && graph.calls.some((edge) => edge.from === node.id)) entries.set(node.id, { node, label: "uncalled export" });
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
  list.push({ key: "coverage", title: "Coverage: what the diagrams cannot show", kind: "coverage" });

  return list;
}

function lane(id: string): DiagramGroup {
  return { id, label: id, kind: "lane", x: 0, y: 0, w: 0, h: 0 };
}

function unplaced(view: string, title: string, nodes: DiagramNode[], edges: DiagramEdge[], groups: DiagramGroup[], extra: Partial<Diagram> = {}): Diagram {
  return { view, title, nodes, edges, groups, ...extra };
}

/** The lanes of the layers the nodes use, in the graph's order. */
function lanesOf(graph: Graph, nodes: readonly DiagramNode[]): DiagramGroup[] {
  const used = new Set(nodes.map((node) => node.group).filter((group): group is string => group !== undefined));

  return graph.layers.filter((layer) => used.has(layer)).map(lane);
}

function moduleNode(graph: Graph, id: string): DiagramNode {
  const module = graph.modules.get(id)!;
  const node: DiagramNode = { id, kind: "module", label: id, ref: { id, file: id, line: 1 }, group: module.layer, x: 0, y: 0, w: 0, h: 0 };

  if (module.doc) node.doc = module.doc;

  return node;
}

function externalNode(graph: Graph, id: string): DiagramNode {
  const external = graph.externals.get(id)!;

  return { id, kind: "external", label: external.kind === "builtin" ? `node:${external.name}` : external.name, x: 0, y: 0, w: 0, h: 0 };
}

function fnNode(graph: Graph, id: string): DiagramNode {
  const fn = graph.nodes.get(id)!;
  const node: DiagramNode = { id, kind: "fn", label: fn.parent ? `${fn.parent}.${fn.name}` : fn.name, ref: { id, file: fn.module, line: fn.line, endLine: fn.endLine }, group: graph.modules.get(fn.module)!.layer, x: 0, y: 0, w: 0, h: 0 };

  if (fn.signature) node.signature = fn.signature;

  if (fn.doc) node.doc = fn.doc;

  return node;
}

/** Module-level dependencies between the given modules (and to externals when `externals`), one edge per pair with its count. */
function depEdges(graph: Graph, members: ReadonlySet<string>, externals: boolean): DiagramEdge[] {
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

  if (own.length === 0) return unplaced(`layer:${name}`, name, [], [], [], { reason: `no layer "${name}"` });
  const members = grow(graph, new Set(own), depth, "both");
  const ownSet = new Set(own);
  // The layer's own modules first: a folded picture keeps them and folds the neighbours.
  const nodes = [...members].sort((a, b) => Number(ownSet.has(b)) - Number(ownSet.has(a)) || (a < b ? -1 : 1)).map((id) => moduleNode(graph, id));

  return unplaced(`layer:${name}`, `Layer ${name}`, nodes, depEdges(graph, members, false), lanesOf(graph, nodes));
}

/** Modules within `depth` import steps of `start`, in the given direction. */
function grow(graph: Graph, start: ReadonlySet<string>, depth: number, direction: "both" | "out" | "in"): Set<string> {
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
  if (!graph.modules.has(id)) return unplaced(`module:${id}`, id, [], [], [], { reason: `no module "${id}"` });
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

  if (own.length === 0) return unplaced(`dir:${path}`, path, [], [], [], { reason: `no modules under "${path}/"` });
  const members = grow(graph, new Set(own), depth, "both");
  const ownSet = new Set(own);
  const nodes = [...members].sort((a, b) => Number(ownSet.has(b)) - Number(ownSet.has(a)) || (a < b ? -1 : 1)).map((id) => moduleNode(graph, id));

  return unplaced(`dir:${path}`, `${path}/`, nodes, depEdges(graph, members, false), lanesOf(graph, nodes));
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
  const seen = new Set<string>();
  const edges: DiagramEdge[] = [];

  for (const edge of diagram.edges) {
    const from = keptIds.has(edge.from) ? edge.from : (groupOfId.get(edge.from) ?? "more");
    const to = keptIds.has(edge.to) ? edge.to : (groupOfId.get(edge.to) ?? "more");

    if (from === to) continue;
    const key = `${from}\u0000${to}\u0000${edge.kind}`;

    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(from === edge.from && to === edge.to ? edge : { from, to, kind: edge.kind });
  }

  const nodes = [...kept, ...folded.map(({ members: _members, ...shape }) => shape)];
  const lanes = diagram.groups.filter((group) => nodes.some((node) => node.group === group.id));

  return { ...diagram, nodes, edges, groups: lanes, reason: `${dropped.length} of ${diagram.nodes.length} shapes folded by directory; tap a folded shape to open it, the Markdown lists them all` };
}

/** The call tree from a function: the functions it calls, and theirs, `depth` levels (default 3); gaps as holes. */
function callsView(graph: Graph, id: string, depth: number): Diagram {
  const start = graph.nodes.get(id);

  if (!start) return unplaced(`calls:${id}`, id, [], [], [], { reason: `no function "${id}"` });
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

const DEFAULT_DEPTH: Record<View["kind"], number> = { layers: 0, layer: 1, dir: 1, module: 1, calls: 3, coverage: 0 };

/** The unplaced diagram of a view, folded to `limit` shapes. */
export function viewOf(analysis: Analysis, view: View, options: ViewOptions = {}): Diagram {
  const depth = options.depth ?? DEFAULT_DEPTH[view.kind];
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
      case "calls":
        return callsView(graph, view.id, depth);
      case "coverage":
        return coverageView(graph);
    }
  };

  return fold(full(), options.limit ?? MAX_SHAPES);
}
