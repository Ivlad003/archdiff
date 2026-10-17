// The views that answer one architectural question each, beside the
// structural ones of views.ts (the cycles live in cycles.ts, the metrics
// in metrics.ts): `matrix` (who imports whom, layer by
// layer, as a dependency structure matrix with the back edges marked),
// `type:<id>` (where a type is produced, consumed and stored),
// `path:<fn>` (from an entry to the storages, the branches that lead
// nowhere pruned), `contract:<module>` (its exports and who uses them
// from outside), `events` (emitters, event names, listeners), `tests`
// (which modules the tests import), `hotspots` (modules sized by lines,
// coloured by calls in), `packages` (the package.json files as a system)
// and `timelineDiagram` (the drift commit by commit, from `history`).
// All pure functions of the analysis; the placed ones set their own
// coordinates and `layout` leaves them alone.

import type { Analysis } from "./analyze.ts";
import { SIZE, type Diagram, type DiagramEdge, type DiagramNode } from "./diagram.ts";
import type { HistoryRow } from "./diff.ts";
import { storageOf } from "./flow.ts";
import { moduleOf, type Graph } from "./graph.ts";
import { fnNode, lane, lanesOf, moduleNode, unplaced } from "./nodes.ts";

/**
 * The layers ordered so that most imports point down the list: repeatedly
 * the layer that imports the most of what remains and is imported least by
 * it goes next. A deterministic greedy order, good enough for a matrix.
 */
function layerOrder(graph: Graph, types = false): string[] {
  const counts = new Map<string, number>();

  for (const dep of graph.deps) {
    const from = graph.modules.get(dep.from)?.layer;
    const to = graph.modules.get(dep.to)?.layer;

    if (from && to && from !== to && (types || !dep.typeOnly)) counts.set(`${from}\u0000${to}`, (counts.get(`${from}\u0000${to}`) ?? 0) + 1);
  }

  return greedyOrder(graph.layers, counts);
}

/**
 * The same order over any items with `counts` of imports between them
 * (keyed `from\u0000to`): an item nothing of the rest imports goes next
 * (a source of the remaining graph, the one importing most of the rest
 * first), so an acyclic graph comes out in topological order; inside a
 * cycle, where every item is imported, the one importing the most and
 * imported the least goes next. Deterministic: ties by name.
 */
function greedyOrder(items: readonly string[], counts: ReadonlyMap<string, number>): string[] {
  const remaining = new Set(items);
  const order: string[] = [];

  while (remaining.size > 0) {
    let best: string | null = null;
    let bestScore = -Infinity;

    for (const layer of [...remaining].sort()) {
      let out = 0;
      let into = 0;

      for (const other of remaining) {
        if (other === layer) continue;
        out += counts.get(`${layer}\u0000${other}`) ?? 0;
        into += counts.get(`${other}\u0000${layer}`) ?? 0;
      }

      // A source of what remains outranks every item still imported by something; among sources the busiest importer first.
      const score = into === 0 ? 1_000_000 + out : out - into;

      if (score > bestScore) {
        bestScore = score;
        best = layer;
      }
    }

    order.push(best!);
    remaining.delete(best!);
  }

  return order;
}

/**
 * The dependency structure matrix of the layers: a row imports the columns
 * with the counts in the cells; cells below the diagonal are imports that
 * go against the order (a lower layer importing a higher one) and are marked
 * red. Placed, with the layer names as the first row and column.
 */
export function matrixView(graph: Graph, scope: string | null = null, types = false): Diagram {
  // The matrix of a directory: its modules in the rows and columns, ordered by their layers' order and then greedily
  // by their imports, so that an import against the order (upward) stands out as it does between layers.
  const counts = new Map<string, number>();
  let order: string[];
  let label: (id: string) => string;
  let view = "matrix";
  let title = "Matrix: rows import columns";

  if (scope === null) {
    order = layerOrder(graph, types);

    if (order.length === 0) return unplaced("matrix", "Matrix", [], [], [], { reason: "no layers" });

    for (const dep of graph.deps) {
      const from = graph.modules.get(dep.from)?.layer;
      const to = graph.modules.get(dep.to)?.layer;

      if (from && to && from !== to && (types || !dep.typeOnly)) counts.set(`${from}\u0000${to}`, (counts.get(`${from}\u0000${to}`) ?? 0) + 1);
    }

    label = (id) => id;
  } else {
    const prefix = `${scope}/`;
    const modules = [...graph.modules.keys()].filter((id) => id.startsWith(prefix)).sort();
    view = `matrix:${scope}`;
    title = `Matrix of ${scope}: rows import columns`;

    if (modules.length === 0) return unplaced(view, title, [], [], [], { reason: `no modules under "${scope}"`, missing: true });
    const inside = new Set(modules);

    for (const dep of graph.deps) if (inside.has(dep.from) && inside.has(dep.to) && dep.from !== dep.to && (types || !dep.typeOnly)) counts.set(`${dep.from}\u0000${dep.to}`, (counts.get(`${dep.from}\u0000${dep.to}`) ?? 0) + 1);
    const layers = layerOrder(graph, types);
    const byLayer = new Map<string, string[]>();

    for (const id of modules) byLayer.set(graph.modules.get(id)!.layer, [...(byLayer.get(graph.modules.get(id)!.layer) ?? []), id]);
    order = [];

    for (const layer of [...layers, ...[...byLayer.keys()].filter((layer) => !layers.includes(layer))]) order.push(...greedyOrder(byLayer.get(layer) ?? [], counts));
    label = (id) => id.slice(prefix.length);
  }

  const cell = SIZE.cell;
  const head = scope === null ? 150 : 220;
  const nodes: DiagramNode[] = [];
  const max = Math.max(1, ...counts.values());

  order.forEach((item, row) => {
    const ref = scope === null ? { id: item } : { id: item, file: item, line: 1 };
    nodes.push({ id: `row:${item}`, kind: "cell", label: label(item), ref, x: 0, y: head + row * cell.h, w: head, h: cell.h });
    nodes.push({ id: `col:${item}`, kind: "cell", label: label(item), ref, x: head + row * cell.w, y: head - cell.h, w: cell.w, h: cell.h });
  });

  order.forEach((from, row) => {
    order.forEach((to, column) => {
      const count = counts.get(`${from}\u0000${to}`) ?? 0;
      const node: DiagramNode = { id: `cell:${from}>${to}`, kind: "cell", label: row === column ? "·" : count === 0 ? "" : String(count), x: head + column * cell.w, y: head + row * cell.h, w: cell.w, h: cell.h, count };

      if (count > 0) node.heat = count / max;

      // A row below its column: the import points up the order.
      if (count > 0 && column < row) node.diff = "removed";
      nodes.push(node);
    });
  });
  const back = nodes.filter((node) => node.diff === "removed").length;

  return unplaced(view, title, nodes, [], [], { placed: true, reason: back > 0 ? `${back} cells go against the ${scope === null ? "layer" : "import"} order (red)` : `every import follows the ${scope === null ? "layer" : "import"} order` });
}

/** The role a function has for a type by its signature: it returns it, takes it, or both. */
function roleOf(signature: string | null, type: string): "produces" | "consumes" | "transforms" | null {
  if (!signature) return null;
  const at = signature.lastIndexOf("→");
  const params = at === -1 ? signature : signature.slice(0, at);
  const returns = at === -1 ? "" : signature.slice(at + 1);
  const word = new RegExp(`\\b${type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const takes = word.test(params);
  const gives = word.test(returns);

  return takes && gives ? "transforms" : gives ? "produces" : takes ? "consumes" : null;
}

/**
 * Where a type flows: the functions whose signatures take it (consumers),
 * return it (producers) or both (transformers), in their modules' lanes,
 * with the calls among them; a function in a storage module is marked as
 * one. Only functions of the type's module or of modules importing it
 * count, so a same-named type elsewhere is not confused with it.
 */
export function typeView(analysis: Analysis, id: string): Diagram {
  const { graph } = analysis;
  const type = graph.nodes.get(id);

  if (!type || type.kind !== "type") return unplaced(`type:${id}`, id, [], [], [], { reason: `no type "${id}"`, missing: true });
  const importers = new Set([type.module, ...graph.deps.filter((dep) => dep.to === type.module).map((dep) => dep.from)]);
  const members: { node: DiagramNode; role: string }[] = [];

  for (const node of graph.nodes.values()) {
    if (node.kind !== "fn" || !importers.has(node.module)) continue;
    const role = roleOf(node.signature, type.name);

    if (!role) continue;
    const storage = storageOf(analysis, node.module);
    const drawn = { ...fnNode(graph, node.id), label: `${node.parent ? `${node.parent}.` : ""}${node.name}\n${role}${storage ? " · storage" : ""}` };
    members.push({ node: drawn, role });
  }

  const typeNode: DiagramNode = { id, kind: "fn", label: `type ${type.name}`, ref: { id, file: type.module, line: type.line, endLine: type.endLine }, group: graph.modules.get(type.module)!.layer, x: 0, y: 0, w: 0, h: 0 };
  const ids = new Set(members.map((member) => member.node.id));
  const edges: DiagramEdge[] = [];
  const seen = new Set<string>();

  for (const call of graph.calls) {
    if (!ids.has(call.from) || !ids.has(call.to)) continue;
    const pair = `${call.from}\u0000${call.to}`;

    if (seen.has(pair)) continue;
    seen.add(pair);
    edges.push({ from: call.from, to: call.to, kind: call.kind });
  }

  // Producers first, then transformers, then consumers: the flow reads left to right.
  const rank = { produces: 0, transforms: 1, consumes: 2 } as Record<string, number>;
  const nodes = [typeNode, ...members.sort((a, b) => rank[a.role]! - rank[b.role]! || (a.node.id < b.node.id ? -1 : 1)).map((member) => member.node)];

  for (const member of members) if (member.role !== "consumes") edges.push({ from: member.node.id, to: id, kind: "ref", label: member.role });

  return unplaced(`type:${id}`, `Where ${type.name} flows`, nodes, edges, lanesOf(graph, nodes), members.length === 0 ? { reason: "no function takes or returns this type" } : {});
}

/**
 * From an entry point to the storages: the calls followed `depth` levels,
 * then every function that leads to no storage module pruned away, so the
 * picture is the route data takes to where it rests.
 */
export function pathView(analysis: Analysis, id: string, depth: number): Diagram {
  const { graph } = analysis;
  const start = graph.nodes.get(id);

  if (!start) return unplaced(`path:${id}`, id, [], [], [], { reason: `no function "${id}"`, missing: true });
  const callsFrom = new Map<string, string[]>();

  for (const call of graph.calls) if (call.kind === "call") callsFrom.set(call.from, [...(callsFrom.get(call.from) ?? []), call.to]);
  const storageCache = new Map<string, boolean>();

  const isStorage = (node: string): boolean => {
    const module = moduleOf(node);
    let known = storageCache.get(module);

    if (known === undefined) {
      known = storageOf(analysis, module) !== null;
      storageCache.set(module, known);
    }

    return known;
  };

  // Forward: what the entry reaches within `depth`, with the edges walked.
  const reached = new Set([id]);
  const edges = new Set<string>();
  let frontier = [id];

  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next: string[] = [];

    for (const from of frontier) {
      for (const to of callsFrom.get(from) ?? []) {
        edges.add(`${from}\u0000${to}`);

        if (!reached.has(to)) {
          reached.add(to);
          next.push(to);
        }
      }
    }

    frontier = next;
  }

  // Backward from the storages: only what lies on a route to one stays.
  const parents = new Map<string, string[]>();

  for (const edge of edges) {
    const [from, to] = edge.split("\u0000") as [string, string];
    parents.set(to, [...(parents.get(to) ?? []), from]);
  }

  const kept = new Set<string>();
  const stack = [...reached].filter((node) => node !== id && isStorage(node));

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (kept.has(node)) continue;
    kept.add(node);

    for (const parent of parents.get(node) ?? []) stack.push(parent);
  }

  if (kept.size === 0) return unplaced(`path:${id}`, `Path from ${start.name} to the storages`, [], [], [], { reason: `no storage within ${depth} calls (modules named like stores or importing a database package)` });
  kept.add(id);
  const nodes = [...kept].sort((a, b) => (a === id ? -1 : b === id ? 1 : a < b ? -1 : 1)).map((node) => (isStorage(node) && node !== id ? { ...fnNode(graph, node), label: `${graph.nodes.get(node)!.name}\nstorage` } : fnNode(graph, node)));
  const drawn: DiagramEdge[] = [...edges].map((edge) => edge.split("\u0000") as [string, string]).filter(([from, to]) => kept.has(from) && kept.has(to)).map(([from, to]) => ({ from, to, kind: "call" }));

  return unplaced(`path:${id}`, `Path from ${start.name} to the storages`, nodes, drawn, lanesOf(graph, nodes));
}

/**
 * The public contract of a module: its exports, and the modules outside
 * it that use each (a call to the export, or an import binding of its
 * name), importers in their layers' lanes; an export nothing outside uses
 * says so.
 */
export function contractView(analysis: Analysis, id: string): Diagram {
  const { graph, facts } = analysis;
  const module = graph.modules.get(id);

  if (!module) return unplaced(`contract:${id}`, id, [], [], [], { reason: `no module "${id}"`, missing: true });
  const exported = [...graph.nodes.values()].filter((node) => node.module === id && node.exported && !node.parent);
  const importers = [...new Set(graph.deps.filter((dep) => dep.to === id).map((dep) => dep.from))].sort();
  const used = new Map<string, Set<string>>();

  for (const node of exported) used.set(node.id, new Set());

  for (const call of graph.calls) if (used.has(call.to) && moduleOf(call.from) !== id) used.get(call.to)!.add(moduleOf(call.from));
  const byName = new Map(exported.map((node) => [node.name, node.id]));

  for (const importer of importers) {
    for (const fact of facts.get(importer)?.imports ?? []) {
      for (const binding of fact.bindings) {
        const name = binding.kind === "named" ? binding.imported : binding.kind === "default" ? "default" : null;
        const target = name === null ? null : (byName.get(name) ?? (name === "default" ? (graph.resolvedExports.get(id)?.get("default") ?? null) : null));

        if (target && used.has(target) && graph.deps.some((dep) => dep.from === importer && dep.to === id)) used.get(target)!.add(importer);
      }
    }
  }

  const nodes: DiagramNode[] = exported.map((node) => {
    const users = used.get(node.id)!;
    const drawn = node.kind === "type" ? { ...fnNode(graph, node.id), label: `type ${node.name}` } : fnNode(graph, node.id);

    return users.size === 0 ? { ...drawn, label: `${drawn.label}\n(unused outside)`, diff: "changed" as const, group: id } : { ...drawn, group: id };
  });
  const edges: DiagramEdge[] = [];
  const usedImporters = new Set<string>();

  for (const [target, users] of used) {
    for (const user of users) {
      edges.push({ from: user, to: target, kind: "dependency" });
      usedImporters.add(user);
    }
  }

  for (const importer of [...usedImporters].sort()) nodes.push(moduleNode(graph, importer));
  const lanes = [lane(id), ...lanesOf(graph, nodes.filter((node) => node.group !== id))];

  return unplaced(`contract:${id}`, `Contract of ${id}`, nodes, edges, lanes, exported.length === 0 ? { reason: "the module exports nothing" } : {});
}

const EMITTERS = new Set(["emit", "emitAsync", "publish", "dispatch", "trigger", "fire"]);

const LISTENERS = new Set(["on", "once", "addListener", "addEventListener", "subscribe", "listen"]);

/**
 * Events: every call that emits a named event and every call that
 * listens to one, the event names between them; a listener's handler
 * (the function passed) is drawn as the receiver when it is a function of
 * the same module, else the function that registers it.
 */
export function eventsView(analysis: Analysis): Diagram {
  const { graph, facts } = analysis;
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  const seen = new Set<string>();

  const add = (edge: DiagramEdge): void => {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.label ?? ""}`;

    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  const eventNode = (name: string): string => {
    const id = `event:${name}`;

    if (!nodes.has(id)) nodes.set(id, { id, kind: "event", label: name, x: 0, y: 0, w: 0, h: 0 });

    return id;
  };

  for (const file of facts.values()) {
    const walk = (decl: (typeof file.decls)[number], parent: string | null): void => {
      const owner = `${file.path}#${parent ? `${parent}.` : ""}${decl.name}`;

      for (const call of decl.calls) {
        const member = call.callee.slice(call.callee.lastIndexOf(".") + 1);
        const name = call.nameArg?.literal;

        if (!name || !call.callee.includes(".")) continue;

        if (EMITTERS.has(member)) {
          if (graph.nodes.has(owner)) nodes.set(owner, fnNode(graph, owner));
          add({ from: owner, to: eventNode(name), kind: "call", label: member });
        } else if (LISTENERS.has(member)) {
          // The handler passed to the listener, when it is a function of this file; else the registering function.
          const handler = call.passes?.find((pass) => graph.nodes.has(`${file.path}#${pass.callee}`));
          const receiver = handler ? `${file.path}#${handler.callee}` : owner;

          if (graph.nodes.has(receiver)) nodes.set(receiver, fnNode(graph, receiver));
          add({ from: eventNode(name), to: receiver, kind: "ref", label: member });
        }
      }

      for (const child of decl.members) walk(child, parent ? `${parent}.${decl.name}` : decl.name);
    };

    for (const decl of file.decls) walk(decl, null);
  }

  const drawn = [...nodes.values()].filter((node) => node.kind === "event" || graph.nodes.has(node.id));

  if (drawn.length === 0) return unplaced("events", "Events", [], [], [], { reason: "no emit/publish/dispatch or on/subscribe call with a literal event name" });

  return unplaced("events", "Events: emitters → events → listeners", drawn, edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to)), lanesOf(graph, drawn));
}

const TEST_MODULE = /(^|\/)(tests?|__tests__|spec|e2e)\/|[.\-_](test|spec|stories)\.[cm]?[jt]sx?$|_test\.(py|rs|php)$|(^|\/)tests?_[^/]*\.py$|Test\.php$/;

/** Which modules the tests import: every non-test module in its layer's lane, with the number of test files importing it; one no test imports is marked. */
export function testsView(graph: Graph): Diagram {
  const tests = [...graph.modules.keys()].filter((id) => TEST_MODULE.test(id));
  const covered = new Map<string, Set<string>>();

  for (const dep of graph.deps) if (TEST_MODULE.test(dep.from) && graph.modules.has(dep.to) && !TEST_MODULE.test(dep.to)) covered.set(dep.to, new Set([...(covered.get(dep.to) ?? []), dep.from]));
  const subjects = [...graph.modules.keys()].filter((id) => !TEST_MODULE.test(id)).sort();

  if (subjects.length === 0) return unplaced("tests", "Tests", [], [], [], { reason: "no modules" });
  const nodes = subjects.map((id): DiagramNode => {
    const by = covered.get(id)?.size ?? 0;
    const node = { ...moduleNode(graph, id), label: `${id}\n${by === 0 ? "no tests" : `${by} test file${by === 1 ? "" : "s"}`}`, count: by };

    return by === 0 ? { ...node, diff: "changed" } : node;
  });
  const untested = nodes.filter((node) => node.count === 0).length;

  return unplaced("tests", `Tests: ${tests.length} test files cover ${subjects.length - untested} of ${subjects.length} modules`, nodes, [], lanesOf(graph, nodes), { reason: untested > 0 ? `${untested} modules no test file imports (orange)` : "every module is imported by a test" });
}

/**
 * Hotspots: every module as a box sized by its lines and shaded by the
 * calls into it from other modules, packed row by row in its layer's lane.
 * The big dark boxes are where change is costly.
 */
export function hotspotsView(graph: Graph): Diagram {
  const callsIn = new Map<string, number>();

  for (const call of graph.calls) {
    const from = moduleOf(call.from);
    const to = moduleOf(call.to);

    if (from !== to) callsIn.set(to, (callsIn.get(to) ?? 0) + 1);
  }

  const maxIn = Math.max(1, ...callsIn.values());
  const nodes: DiagramNode[] = [];
  const groups: Diagram["groups"] = [];
  const width = 1100;
  const gap = 10;
  let y = 0;

  for (const layer of graph.layers) {
    const members = [...graph.modules.values()].filter((module) => module.layer === layer).sort((a, b) => b.lines - a.lines || (a.id < b.id ? -1 : 1));

    if (members.length === 0) continue;
    const top = y;
    let x = 20;
    let rowHeight = 0;
    y += 30;

    for (const module of members) {
      const side = Math.round(Math.max(44, Math.min(220, 36 + Math.sqrt(module.lines) * 7)));

      if (x + side > width && x > 20) {
        x = 20;
        y += rowHeight + gap;
        rowHeight = 0;
      }

      const calls = callsIn.get(module.id) ?? 0;
      nodes.push({ id: module.id, kind: "module", label: `${module.id.slice(module.id.lastIndexOf("/") + 1)}\n${module.lines} lines · ${calls} in`, ref: { id: module.id, file: module.id, line: 1 }, group: layer, heat: calls / maxIn, count: calls, x, y, w: side, h: side });
      x += side + gap;
      rowHeight = Math.max(rowHeight, side);
    }

    y += rowHeight + 20;
    groups.push({ id: layer, label: layer, kind: "lane", x: 0, y: top, w: width + 20, h: y - top });
  }

  return unplaced("hotspots", "Hotspots: size by lines, shade by calls in", nodes, [], groups, { placed: true });
}

/** The packages of the repository as a system: what each declares as a dependency on another, and what its modules import from another's. */
export function packagesView(analysis: Analysis): Diagram {
  const { graph, packages } = analysis;

  if (packages.length < 2) return unplaced("packages", "Packages", [], [], [], { reason: packages.length === 0 ? "no package.json" : "one package: the layers view is its map" });
  const byDir = [...packages].sort((a, b) => b.dir.length - a.dir.length);
  const packageOf = (module: string): string | null => byDir.find((candidate) => candidate.dir === "" || module.startsWith(`${candidate.dir}/`))?.name ?? null;
  const counts = new Map<string, number>();

  for (const dep of graph.deps) {
    if (!graph.modules.has(dep.to)) continue;
    const from = packageOf(dep.from);
    const to = packageOf(dep.to);

    if (from && to && from !== to) counts.set(`${from}\u0000${to}`, (counts.get(`${from}\u0000${to}`) ?? 0) + 1);
  }

  const names = new Set(packages.map((candidate) => candidate.name));
  const modulesOf = new Map<string, number>();

  for (const module of graph.modules.keys()) {
    const owner = packageOf(module);

    if (owner) modulesOf.set(owner, (modulesOf.get(owner) ?? 0) + 1);
  }

  const nodes = packages.map((candidate): DiagramNode => ({ id: candidate.name, kind: "package", label: `${candidate.name}\n${candidate.dir || "."} · ${modulesOf.get(candidate.name) ?? 0} modules`, ref: { id: candidate.dir ? `dir:${candidate.dir}` : "layers", file: candidate.dir ? `${candidate.dir}/package.json` : "package.json", line: 1 }, count: modulesOf.get(candidate.name) ?? 0, x: 0, y: 0, w: 0, h: 0 }));
  const edges: DiagramEdge[] = [];
  const seen = new Set<string>();

  for (const candidate of packages) {
    for (const dependency of candidate.dependencies) {
      if (!names.has(dependency) || dependency === candidate.name) continue;
      seen.add(`${candidate.name}\u0000${dependency}`);
      const imports = counts.get(`${candidate.name}\u0000${dependency}`) ?? 0;
      edges.push({ from: candidate.name, to: dependency, kind: "dependency", label: imports > 0 ? `declared, ${imports} imports` : "declared, unused", count: imports });
    }
  }

  // Imports without a declaration: a coupling the package.json does not admit.
  for (const [key, count] of counts) {
    if (seen.has(key)) continue;
    const [from, to] = key.split("\u0000") as [string, string];
    edges.push({ from, to, kind: "dependency", label: `${count} imports, not declared`, count, diff: "added" });
  }

  return unplaced("packages", `Packages (${packages.length})`, nodes, edges, []);
}

/** One box of the class diagram. */
interface ClassBox {
  id: string;
  name: string;
  module: string;
  kind: "class" | "interface" | "type";
  fields: string[];
  methods: string[];
  extends: string[];
  implements: string[];
  line: number;
  endLine: number;
}

/** The `implements A, B` names written on a class, from the extractor's list or from its signature text. */
function implementsOf(decl: { implements?: string[]; signature: string | null }): string[] {
  if (decl.implements && decl.implements.length > 0) return decl.implements;
  const match = decl.signature?.match(/implements\s+([^{]+)/);

  return match ? match[1]!.split(",").map((name) => name.trim().replace(/<.*$/, "")).filter((name) => name !== "") : [];
}

/** The boxes of a module: its classes (methods, constructor-parameter fields, extends, implements) and its interfaces and object types (fields). */
function classBoxes(analysis: Analysis, module: string): ClassBox[] {
  const file = analysis.facts.get(module);

  if (!file) return [];
  const boxes: ClassBox[] = [];

  for (const decl of file.decls) {
    if (decl.kind === "class") {
      const fields: string[] = [];
      const methods: string[] = [];

      for (const member of decl.members) {
        if (member.name === "constructor" || member.name === "__construct" || member.name === "__init__") {
          // Parameter properties (`private readonly repo: Repo`) are fields.
          for (const param of (member.signature ?? "").replace(/^\(|\).*$/g, "").split(/,(?![^<([{]*[>)\]}])/)) {
            const match = param.trim().match(/^(private|protected|public|readonly)[\s\w]*?\s(\w+)(\?)?(?::\s*(.+))?$/);

            if (match) fields.push(`${match[1] === "private" ? "-" : match[1] === "protected" ? "#" : "+"}${match[2]}${match[3] ?? ""}${match[4] ? `: ${match[4].trim()}` : ""}`);
          }

          continue;
        }

        if (member.kind !== "fn") continue;
        const signature = member.signature ?? "()";
        methods.push(`${member.static ? "$" : "+"}${member.name}${member.accessor ? " ⟨get⟩" : ""}${signature.startsWith("(") ? signature : `(${signature})`}`);
      }

      for (const property of decl.properties ?? []) fields.push(`+${property.name}`);

      for (const field of decl.fields ?? []) fields.push(`+${field.name}: ${field.class}`);
      boxes.push({ id: `${module}#${decl.name}`, name: decl.name, module, kind: "class", fields, methods, extends: decl.base ? [decl.base.replace(/<.*$/, "")] : [], implements: implementsOf(decl), line: decl.line, endLine: decl.endLine });
    } else if (decl.kind === "type" && decl.shape && decl.shape.length > 0) {
      const fields = decl.shape.filter((field) => !field.type.startsWith("(")).map((field) => `+${field.name}${field.optional ? "?" : ""}: ${field.type}`);
      const methods = decl.shape.filter((field) => field.type.startsWith("(")).map((field) => `+${field.name}${field.type.replace(/\s*=>\s*/, " → ")}`);
      const isInterface = decl.signature === null || !decl.signature.startsWith("=");
      boxes.push({ id: `${module}#${decl.name}`, name: decl.name, module, kind: isInterface ? "interface" : "type", fields, methods, extends: decl.base ? [decl.base.replace(/<.*$/, "")] : [], implements: [], line: decl.line, endLine: decl.endLine });
    }
  }

  return boxes;
}

/**
 * The class diagram: every class, interface and object type of the scope
 * (the whole repository, a module, or a directory) as a box with its
 * fields and methods, `extends` and `implements` as lines to the boxes
 * they name — in the scope, or brought in from the modules the scope
 * imports. Lanes are modules; the Markdown carries a Mermaid classDiagram.
 */
export function classesView(analysis: Analysis, scope: string | null, limit: number): Diagram {
  const { graph } = analysis;
  const key = scope === null ? "classes" : `classes:${scope}`;
  let modules: string[];

  if (scope === null) modules = [...graph.modules.keys()].sort();
  else if (graph.modules.has(scope)) modules = [scope];
  else {
    modules = [...graph.modules.keys()].filter((id) => id.startsWith(`${scope.replace(/\/+$/, "")}/`)).sort();

    if (modules.length === 0) return unplaced(key, scope, [], [], [], { reason: `no module or directory "${scope}"`, missing: true });
  }

  const boxes = new Map<string, ClassBox>();

  for (const module of modules) for (const box of classBoxes(analysis, module)) boxes.set(box.id, box);

  if (boxes.size === 0) return unplaced(key, scope === null ? "Classes" : `Classes of ${scope}`, [], [], [], { reason: "no class, interface or object type here" });
  // A name written on `extends`/`implements` → the box it means: the same module first, then the modules this one imports.
  const resolveName = (from: string, name: string): string | null => {
    const own = `${from}#${name}`;

    if (boxes.has(own) || graph.nodes.has(own)) return own;

    for (const dep of graph.deps) {
      if (dep.from !== from || !graph.modules.has(dep.to)) continue;
      const id = `${dep.to}#${name}`;

      if (graph.nodes.has(id)) return id;
    }

    return null;
  };

  // Targets outside the scope are brought in as boxes of their own, so a line never points at nothing.
  const related = new Set<string>();

  for (const box of boxes.values()) {
    for (const name of [...box.extends, ...box.implements]) {
      const target = resolveName(box.module, name);

      if (target && !boxes.has(target)) related.add(target);
    }
  }

  for (const id of related) {
    const module = moduleOf(id);
    const found = classBoxes(analysis, module).find((box) => box.id === id);

    if (found) boxes.set(id, found);
  }

  const all = [...boxes.values()].sort((a, b) => (modules.includes(a.module) === modules.includes(b.module) ? (a.id < b.id ? -1 : 1) : modules.includes(a.module) ? -1 : 1)).slice(0, limit);
  const kept = new Set(all.map((box) => box.id));
  const nodes: DiagramNode[] = all.map((box) => {
    const head = box.kind === "class" ? box.name : `«${box.kind}» ${box.name}`;
    const lines = [head, "────────", ...box.fields, ...(box.fields.length > 0 && box.methods.length > 0 ? ["────────"] : []), ...box.methods];
    const shown = lines.slice(0, 18);

    if (lines.length > 18) shown.push(`… ${lines.length - 18} more`);
    const width = Math.min(360, Math.max(230, 14 + 7 * Math.max(...shown.map((line) => line.length))));

    return { id: box.id, kind: "class", label: shown.join("\n"), ref: { id: box.id, file: box.module, line: box.line, endLine: box.endLine }, group: box.module, x: 0, y: 0, w: width, h: 24 + 15 * shown.length };
  });
  const edges: DiagramEdge[] = [];

  for (const box of all) {
    for (const name of box.extends) {
      const target = resolveName(box.module, name);

      if (target && kept.has(target)) edges.push({ from: box.id, to: target, kind: "dependency", label: "extends" });
    }

    for (const name of box.implements) {
      const target = resolveName(box.module, name);

      if (target && kept.has(target)) edges.push({ from: box.id, to: target, kind: "ref", label: "implements" });
    }
  }

  const classes = { boxes: all.map((box) => ({ id: box.id, name: box.name, kind: box.kind, fields: box.fields, methods: box.methods })), relations: edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.label as "extends" | "implements" })) };
  const diagram = unplaced(key, scope === null ? `Classes (${all.length})` : `Classes of ${scope}`, nodes, edges, [...new Set(all.map((box) => box.module))].map(lane), { classes });

  if (boxes.size > limit) diagram.reason = `${boxes.size - limit} of ${boxes.size} classes cut; --limit raises it, classes:<dir> narrows`;

  return diagram;
}

/** The drift of the architecture as a bar per commit: height by the imports and functions that moved, red when a coupling between layers appeared, green when one went. */
export function timelineDiagram(rows: readonly HistoryRow[], base: string, head: string): Diagram {
  const key = "timeline";

  if (rows.length === 0) return unplaced(key, `Timeline ${base}..${head}`, [], [], [], { placed: true, reason: "no commits in the range" });
  const magnitude = (row: HistoryRow): number => row.depsAdded + row.depsRemoved + row.fnsChanged + row.modulesAdded + row.modulesRemoved + 10 * (row.layerEdgesAdded.length + row.layerEdgesRemoved.length);
  const max = Math.max(1, ...rows.map(magnitude));
  const column = 110;
  const chart = 240;
  const nodes: DiagramNode[] = [];

  rows.forEach((row, i) => {
    const height = Math.max(8, Math.round((chart * magnitude(row)) / max));
    const x = 20 + i * column;
    const couplings = [...row.layerEdgesAdded.map((edge) => `+${edge.from}→${edge.to}`), ...row.layerEdgesRemoved.map((edge) => `−${edge.from}→${edge.to}`)];
    const bar: DiagramNode = { id: `bar:${row.commit.sha}`, kind: "cell", label: `+${row.depsAdded} −${row.depsRemoved} imp\n~${row.fnsChanged} fn${couplings.length > 0 ? `\n${couplings.join(" ")}` : ""}`, x, y: 20 + chart - height, w: column - 20, h: height, heat: magnitude(row) / max, count: magnitude(row) };

    if (row.layerEdgesAdded.length > 0) bar.diff = "removed";
    else if (row.layerEdgesRemoved.length > 0) bar.diff = "added";
    nodes.push(bar);
    nodes.push({ id: `commit:${row.commit.sha}`, kind: "cell", label: `${row.commit.short} ${row.commit.date}\n${row.commit.subject.slice(0, 28)}`, ref: { id: row.commit.sha }, x, y: 20 + chart + 10, w: column - 20, h: 48 });
  });

  return unplaced(key, `Timeline ${base}..${head}: ${rows.length} commits`, nodes, [], [], { placed: true, reason: "bars: imports and functions moved; red: a coupling between layers appeared, green: one went" });
}
