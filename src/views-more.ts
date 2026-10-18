// The views that answer one architectural question each, beside the
// structural ones of views.ts (the cycles live in cycles.ts, the metrics
// in metrics.ts): `matrix` (who imports whom, layer by
// layer, as a dependency structure matrix with the back edges marked),
// `type:<id>` (where a type is produced, consumed and stored),
// `path:<fn>` (from an entry to the storages, the branches that lead
// nowhere pruned), `usage:<module>` (its exports and who uses them
// from outside), `events` (emitters, event names, listeners), `tests`
// (which modules the tests import), `hotspots` (modules sized by lines,
// coloured by calls in), `packages` (the package.json files as a system)
// `timelineDiagram` (the drift commit by commit, from `history`) and
// `branchesDiagram` (the branches and their commits, from `branchGraph`).
// All pure functions of the analysis; the placed ones set their own
// coordinates and `layout` leaves them alone.
//
// Entry points: `matrixView`, `typeView`, `pathView`, `usageView`,
// `eventsView`, `testsView`, `hotspotsView`, `packagesView`, `classesView`,
// `timelineDiagram`, `branchesDiagram` (views.ts's `viewOf` dispatches to them).

import type { Analysis } from "./analyze.ts";
import { SIZE, type Diagram, type Line, type PictureContent, type Shape } from "./diagram.ts";
import type { HistoryRow } from "./diff.ts";
import type { BranchGraph, Commit } from "./git.ts";
import { storageOf } from "./flow.ts";
import { moduleOf, type Graph } from "./graph.ts";
import { fnNode, lane, lanesOf, moduleNode, unplaced } from "./nodes.ts";
import { greedyOrder } from "./order.ts";

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
 * The dependency structure matrix of the layers: a row imports the columns
 * with the counts in the cells; cells below the diagonal are imports that
 * go against the order (a lower layer importing a higher one) and are marked
 * red. Placed, with the layer names as the first row and column.
 */
export function matrixView(graph: Graph, scope: string | null = null, types = false): PictureContent {
  // The matrix of a directory: its modules in the rows and columns, ordered by their layers' order and then greedily
  // by their imports, so that an import against the order (upward) stands out as it does between layers.
  const counts = new Map<string, number>();
  let order: string[];
  let label: (id: string) => string;
  let title = "Matrix: rows import columns";

  if (scope === null) {
    order = layerOrder(graph, types);

    if (order.length === 0) return unplaced("Matrix", [], [], [], { reason: "no layers" });

    for (const dep of graph.deps) {
      const from = graph.modules.get(dep.from)?.layer;
      const to = graph.modules.get(dep.to)?.layer;

      if (from && to && from !== to && (types || !dep.typeOnly)) counts.set(`${from}\u0000${to}`, (counts.get(`${from}\u0000${to}`) ?? 0) + 1);
    }

    label = (id) => id;
  } else {
    const prefix = `${scope}/`;
    const modules = [...graph.modules.keys()].filter((id) => id.startsWith(prefix)).sort();
    title = `Matrix of ${scope}: rows import columns`;

    if (modules.length === 0) return unplaced(title, [], [], [], { reason: `no modules under "${scope}"`, missing: true });
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
  const nodes: Shape[] = [];
  const max = Math.max(1, ...counts.values());

  order.forEach((item, row) => {
    // A header opens its layer, or its module's dependencies; a module's header points at its file too.
    const header = scope === null ? { opens: `layer:${item}` } : { opens: `module:${item}`, ref: { id: item, file: item, line: 1 } };
    nodes.push({ id: `row:${item}`, kind: "cell", label: label(item), ...header, x: 0, y: head + row * cell.h, w: head, h: cell.h });
    nodes.push({ id: `col:${item}`, kind: "cell", label: label(item), ...header, x: head + row * cell.w, y: head - cell.h, w: cell.w, h: cell.h });
  });

  order.forEach((from, row) => {
    order.forEach((to, column) => {
      const count = counts.get(`${from}\u0000${to}`) ?? 0;
      const node: Shape = { id: `cell:${from}>${to}`, kind: "cell", label: row === column ? "·" : count === 0 ? "" : String(count), x: head + column * cell.w, y: head + row * cell.h, w: cell.w, h: cell.h, count };

      if (count > 0) node.heat = count / max;

      // A row below its column: the import points up the order.
      if (count > 0 && column < row) node.diff = "removed";
      nodes.push(node);
    });
  });
  const back = nodes.filter((node) => node.diff === "removed").length;
  // The table behind the picture, for the Markdown: the rows in order and every import between them.
  const index = new Map(order.map((item, row) => [item, row]));
  const cells = [...counts].map(([key, count]) => {
    const [from, to] = key.split("\u0000") as [string, string];

    return { from, to, count, against: (index.get(to) ?? 0) < (index.get(from) ?? 0) };
  }).filter((cell) => index.has(cell.from) && index.has(cell.to)).sort((a, b) => index.get(a.from)! - index.get(b.from)! || index.get(a.to)! - index.get(b.to)!);
  const matrix = { scope, rows: order.map((item) => ({ id: item, label: label(item) })), cells };

  return unplaced(title, nodes, [], [], { placed: true, matrix, reason: back > 0 ? `${back} cells go against the ${scope === null ? "layer" : "import"} order (red)` : `every import follows the ${scope === null ? "layer" : "import"} order` });
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
export function typeView(analysis: Analysis, id: string): PictureContent {
  const { graph } = analysis;
  const type = graph.nodes.get(id);

  if (!type || type.kind !== "type") return unplaced(id, [], [], [], { reason: `no type "${id}"`, missing: true });
  const importers = new Set([type.module, ...graph.deps.filter((dep) => dep.to === type.module).map((dep) => dep.from)]);
  const members: { node: Shape; role: string }[] = [];

  for (const node of graph.nodes.values()) {
    if (node.kind !== "fn" || !importers.has(node.module)) continue;
    const role = roleOf(node.signature, type.name);

    if (!role) continue;
    const storage = storageOf(analysis, node.module);
    const drawn = { ...fnNode(graph, node.id), label: `${node.parent ? `${node.parent}.` : ""}${node.name}\n${role}${storage ? " · storage" : ""}` };
    members.push({ node: drawn, role });
  }

  const typeNode: Shape = { id, kind: "fn", label: `type ${type.name}`, ref: { id, file: type.module, line: type.line, endLine: type.endLine }, group: graph.modules.get(type.module)!.layer, x: 0, y: 0, w: 0, h: 0 };
  const ids = new Set(members.map((member) => member.node.id));
  const edges: Line[] = [];
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

  return unplaced(`Where ${type.name} flows`, nodes, edges, lanesOf(graph, nodes), members.length === 0 ? { reason: "no function takes or returns this type" } : {});
}

/**
 * From an entry point to the storages: the calls followed `depth` levels,
 * then every function that leads to no storage module pruned away, so the
 * picture is the route data takes to where it rests.
 */
export function pathView(analysis: Analysis, id: string, depth: number): PictureContent {
  const { graph } = analysis;
  const start = graph.nodes.get(id);

  if (!start) return unplaced(id, [], [], [], { reason: `no function "${id}"`, missing: true });
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

  if (kept.size === 0) return unplaced(`Path from ${start.name} to the storages`, [], [], [], { reason: `no storage within ${depth} calls (modules named like stores or importing a database package)` });
  kept.add(id);
  const nodes = [...kept].sort((a, b) => (a === id ? -1 : b === id ? 1 : a < b ? -1 : 1)).map((node) => (isStorage(node) && node !== id ? { ...fnNode(graph, node), label: `${graph.nodes.get(node)!.name}\nstorage` } : fnNode(graph, node)));
  const drawn: Line[] = [...edges].map((edge) => edge.split("\u0000") as [string, string]).filter(([from, to]) => kept.has(from) && kept.has(to)).map(([from, to]) => ({ from, to, kind: "call" }));

  return unplaced(`Path from ${start.name} to the storages`, nodes, drawn, lanesOf(graph, nodes));
}

/**
 * Who uses a module: its exports, and the modules outside it that use
 * each (a call to the export, or an import binding of its name), the
 * importers in their layers' lanes; an export nothing outside uses says so.
 */
export function usageView(analysis: Analysis, id: string): PictureContent {
  const { graph, facts } = analysis;
  const module = graph.modules.get(id);

  if (!module) return unplaced(id, [], [], [], { reason: `no module "${id}"`, missing: true });
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

        // The binding is of this import only when the statement imports this module: a name of another module's
        // (`import { format } from "./b"`) is no use of this one's `format`.
        if (target && used.has(target) && graph.deps.some((dep) => dep.from === importer && dep.to === id && dep.line === fact.line)) used.get(target)!.add(importer);
      }
    }
  }

  const nodes: Shape[] = exported.map((node) => {
    const users = used.get(node.id)!;
    const drawn = node.kind === "type" ? { ...fnNode(graph, node.id), label: `type ${node.name}` } : fnNode(graph, node.id);

    return users.size === 0 ? { ...drawn, label: `${drawn.label}\n(unused outside)`, diff: "warning" as const, group: id } : { ...drawn, group: id };
  });
  const edges: Line[] = [];
  const usedImporters = new Set<string>();

  for (const [target, users] of used) {
    for (const user of users) {
      edges.push({ from: user, to: target, kind: "dependency" });
      usedImporters.add(user);
    }
  }

  for (const importer of [...usedImporters].sort()) nodes.push(moduleNode(graph, importer));
  const lanes = [lane(id), ...lanesOf(graph, nodes.filter((node) => node.group !== id))];

  return unplaced(`Usage of ${id}: who uses its exports`, nodes, edges, lanes, exported.length === 0 ? { reason: "the module exports nothing" } : {});
}

const EMITTERS = new Set(["emit", "emitAsync", "publish", "dispatch", "trigger", "fire"]);

const LISTENERS = new Set(["on", "once", "addListener", "addEventListener", "subscribe", "listen"]);

/**
 * Events: every call that emits a named event and every call that
 * listens to one, the event names between them; a listener's handler
 * (the function passed) is drawn as the receiver when it is a function of
 * the same module, else the function that registers it.
 */
export function eventsView(analysis: Analysis): PictureContent {
  const { graph, facts } = analysis;
  const nodes = new Map<string, Shape>();
  const edges: Line[] = [];
  const seen = new Set<string>();

  const add = (edge: Line): void => {
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

  // The shape of what emits or listens: a function, or the module itself for a call at its top level.
  const ownerNode = (id: string): void => {
    if (graph.nodes.has(id)) nodes.set(id, fnNode(graph, id));
    else if (graph.modules.has(id)) nodes.set(id, moduleNode(graph, id));
  };

  for (const file of facts.values()) {
    const record = (owner: string, call: (typeof file.moduleCalls)[number]): void => {
      const member = call.callee.slice(call.callee.lastIndexOf(".") + 1);
      const name = call.nameArg?.literal;

      if (!name || !call.callee.includes(".")) return;

      if (EMITTERS.has(member)) {
        ownerNode(owner);
        add({ from: owner, to: eventNode(name), kind: "call", label: member });
      } else if (LISTENERS.has(member)) {
        // The handler passed to the listener, when it is a function of this file; else the registering function (or module).
        const handler = call.passes?.find((pass) => graph.nodes.has(`${file.path}#${pass.callee}`));
        const receiver = handler ? `${file.path}#${handler.callee}` : owner;

        ownerNode(receiver);
        add({ from: eventNode(name), to: receiver, kind: "ref", label: member });
      }
    };

    const walk = (decl: (typeof file.decls)[number], parent: string | null): void => {
      const owner = `${file.path}#${parent ? `${parent}.` : ""}${decl.name}`;

      for (const call of decl.calls) record(owner, call);

      for (const child of decl.members) walk(child, parent ? `${parent}.${decl.name}` : decl.name);
    };

    for (const decl of file.decls) walk(decl, null);

    // `bus.on("order:shipped", onShipped)` at the top level of a module registers as surely as one in a function.
    for (const call of file.moduleCalls) record(file.path, call);
  }

  const drawn = [...nodes.values()].filter((node) => node.kind === "event" || graph.nodes.has(node.id) || graph.modules.has(node.id));

  if (drawn.length === 0) return unplaced("Events", [], [], [], { reason: "no emit/publish/dispatch or on/subscribe call with a literal event name" });

  return unplaced("Events: emitters → events → listeners", drawn, edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to)), lanesOf(graph, drawn));
}

/**
 * A test file, by the conventions of each language: a `tests/` or `__tests__/` directory, `x.test.ts`,
 * `x.spec.js` or `x_test.js`, `test_x.py`, Django's `tests.py`, `conftest.py`, `x_test.rs`, `XTest.php`. Not a
 * module whose name only contains the word (`ab-test.ts`, an A/B test).
 */
const TEST_MODULE = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$|_(test|spec)\.[cm]?[jt]sx?$|_test\.(py|rs|php)$|(^|\/)tests?(_[^/]*)?\.py$|(^|\/)conftest\.py$|Test\.php$/;

/** Which modules the tests import: every non-test module in its layer's lane, with the number of test files importing it; one no test imports is marked. */
export function testsView(graph: Graph): PictureContent {
  const tests = [...graph.modules.keys()].filter((id) => TEST_MODULE.test(id));
  const covered = new Map<string, Set<string>>();

  for (const dep of graph.deps) if (TEST_MODULE.test(dep.from) && graph.modules.has(dep.to) && !TEST_MODULE.test(dep.to)) covered.set(dep.to, new Set([...(covered.get(dep.to) ?? []), dep.from]));
  const subjects = [...graph.modules.keys()].filter((id) => !TEST_MODULE.test(id)).sort();

  if (subjects.length === 0) return unplaced("Tests", [], [], [], { reason: "no modules" });
  const nodes = subjects.map((id): Shape => {
    const by = covered.get(id)?.size ?? 0;
    const node = { ...moduleNode(graph, id), label: `${id}\n${by === 0 ? "no tests" : `${by} test file${by === 1 ? "" : "s"}`}`, count: by };

    return by === 0 ? { ...node, diff: "warning" } : node;
  });
  const untested = nodes.filter((node) => node.count === 0).length;

  return unplaced(`Tests: ${tests.length} test files cover ${subjects.length - untested} of ${subjects.length} modules`, nodes, [], lanesOf(graph, nodes), { reason: untested > 0 ? `${untested} modules no test file imports (orange)` : "every module is imported by a test" });
}

/**
 * Hotspots: every module as a box sized by its lines and shaded by the
 * calls into it from other modules, packed row by row in its layer's lane.
 * The big dark boxes are where change is costly.
 */
export function hotspotsView(graph: Graph): PictureContent {
  const callsIn = new Map<string, number>();

  for (const call of graph.calls) {
    const from = moduleOf(call.from);
    const to = moduleOf(call.to);

    if (from !== to) callsIn.set(to, (callsIn.get(to) ?? 0) + 1);
  }

  const maxIn = Math.max(1, ...callsIn.values());
  const nodes: Shape[] = [];
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

  return unplaced("Hotspots: size by lines, shade by calls in", nodes, [], groups, { placed: true });
}

/** The packages of the repository as a system: what each declares as a dependency on another, and what its modules import from another's. */
export function packagesView(analysis: Analysis): PictureContent {
  const { graph, packages } = analysis;

  if (packages.length < 2) return unplaced("Packages", [], [], [], { reason: packages.length === 0 ? "no package.json" : "one package: the layers view is its map" });
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

  const nodes = packages.map((candidate): Shape => ({ id: candidate.name, kind: "package", label: `${candidate.name}\n${candidate.dir || "."} · ${modulesOf.get(candidate.name) ?? 0} modules`, opens: candidate.dir ? `dir:${candidate.dir}` : "layers", ref: { file: candidate.dir ? `${candidate.dir}/package.json` : "package.json", line: 1 }, count: modulesOf.get(candidate.name) ?? 0, x: 0, y: 0, w: 0, h: 0 }));
  const edges: Line[] = [];
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

  return unplaced(`Packages (${packages.length})`, nodes, edges, []);
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
export function classesView(analysis: Analysis, scope: string | null, limit: number): PictureContent {
  const { graph } = analysis;
  let modules: string[];

  if (scope === null) modules = [...graph.modules.keys()].sort();
  else if (graph.modules.has(scope)) modules = [scope];
  else {
    modules = [...graph.modules.keys()].filter((id) => id.startsWith(`${scope.replace(/\/+$/, "")}/`)).sort();

    if (modules.length === 0) return unplaced(scope, [], [], [], { reason: `no module or directory "${scope}"`, missing: true });
  }

  const boxes = new Map<string, ClassBox>();

  for (const module of modules) for (const box of classBoxes(analysis, module)) boxes.set(box.id, box);

  if (boxes.size === 0) return unplaced(scope === null ? "Classes" : `Classes of ${scope}`, [], [], [], { reason: "no class, interface or object type here" });
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
  const nodes: Shape[] = all.map((box) => {
    const head = box.kind === "class" ? box.name : `«${box.kind}» ${box.name}`;
    const lines = [head, "────────", ...box.fields, ...(box.fields.length > 0 && box.methods.length > 0 ? ["────────"] : []), ...box.methods];
    const shown = lines.slice(0, 18);

    if (lines.length > 18) shown.push(`… ${lines.length - 18} more`);
    const width = Math.min(360, Math.max(230, 14 + 7 * Math.max(...shown.map((line) => line.length))));

    return { id: box.id, kind: "class", label: shown.join("\n"), ref: { id: box.id, file: box.module, line: box.line, endLine: box.endLine }, group: box.module, x: 0, y: 0, w: width, h: 24 + 15 * shown.length };
  });
  const edges: Line[] = [];

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
  const diagram = unplaced(scope === null ? `Classes (${all.length})` : `Classes of ${scope}`, nodes, edges, [...new Set(all.map((box) => box.module))].map(lane), { classes });

  if (boxes.size > limit) diagram.reason = `${boxes.size - limit} of ${boxes.size} classes cut; --limit raises it, classes:<dir> narrows`;

  return diagram;
}

/** The drift of the architecture as a bar per commit: height by the imports and functions that moved, red when a coupling between layers appeared, green when one went. */
export function timelineDiagram(rows: readonly HistoryRow[], base: string, head: string): PictureContent {
  if (rows.length === 0) return unplaced(`Timeline ${base}..${head}`, [], [], [], { placed: true, reason: "no commits in the range" });
  const magnitude = (row: HistoryRow): number => row.depsAdded + row.depsRemoved + row.fnsChanged + row.modulesAdded + row.modulesRemoved + 10 * (row.layerEdgesAdded.length + row.layerEdgesRemoved.length);
  const max = Math.max(1, ...rows.map(magnitude));
  const column = 110;
  const chart = 240;
  const nodes: Shape[] = [];

  rows.forEach((row, i) => {
    const height = Math.max(8, Math.round((chart * magnitude(row)) / max));
    const x = 20 + i * column;
    const couplings = [...row.layerEdgesAdded.map((edge) => `+${edge.from}→${edge.to}`), ...row.layerEdgesRemoved.map((edge) => `−${edge.from}→${edge.to}`)];
    const bar: Shape = { id: `bar:${row.commit.sha}`, kind: "cell", label: `+${row.depsAdded} −${row.depsRemoved} imp\n~${row.fnsChanged} fn${couplings.length > 0 ? `\n${couplings.join(" ")}` : ""}`, x, y: 20 + chart - height, w: column - 20, h: height, heat: magnitude(row) / max, count: magnitude(row) };

    if (row.layerEdgesAdded.length > 0) bar.diff = "removed";
    else if (row.layerEdgesRemoved.length > 0) bar.diff = "added";
    nodes.push(bar);
    nodes.push({ id: `commit:${row.commit.sha}`, kind: "cell", label: `${row.commit.short} ${row.commit.date}\n${row.commit.subject.slice(0, 28)}`, opens: `commit:${row.commit.sha}`, x, y: 20 + chart + 10, w: column - 20, h: 48 });
  });

  return unplaced(`Timeline ${base}..${head}: ${rows.length} commits`, nodes, [], [], { placed: true, reason: "bars: imports and functions moved; red: a coupling between layers appeared, green: one went" });
}

/** The cell of one commit in the branches' picture, and the room between two columns (the lines to a branch turn there). */
const COMMIT_CELL = { w: 150, h: 56, gap: 40, row: 100, top: 32 } as const;

/**
 * The branches as a picture: one lane per branch, the base on top, time from left to right. The base's last
 * commits lie along its lane; a branch leaves the commit it forked from — on the base, or on the branch it was
 * started on (a stacked branch) — and its own commits follow in its lane. Every commit opens its own change
 * (`commit:<sha>`); a branch with nothing of its own is named on the commit it points at.
 */
export function branchesDiagram(graph: BranchGraph): PictureContent {
  const { w, h, gap, row, top } = COMMIT_CELL;
  const nodes: Shape[] = [];
  const edges: Line[] = [];
  const groups: Diagram["groups"] = [];
  /** Where each drawn commit is: its shape and column, so a later branch can leave it. */
  const drawn = new Map<string, { id: string; column: number; lane: number }>();
  /** The branches with no lane of their own, by the commit they point at. */
  const tips = new Map<string, string[]>();
  let columns = 0;

  for (const { name, tip } of graph.level) tips.set(tip, [...(tips.get(tip) ?? []), name]);
  const place = (column: number, lane: number): { x: number; y: number } => ({ x: 20 + column * (w + gap), y: lane * row + top });
  const commitShape = (commit: Commit, column: number, lane: number, branch: string): Shape => {
    columns = Math.max(columns, column + 1);
    drawn.set(commit.sha, { id: `commit:${commit.sha}`, column, lane });

    return { id: `commit:${commit.sha}`, kind: "cell", label: `${commit.short} · ${commit.date}\n${commit.subject.length > 24 ? `${commit.subject.slice(0, 23)}…` : commit.subject}`, opens: `commit:${commit.sha}`, group: branch, ...place(column, lane), w, h };
  };
  const moreShape = (id: string, count: number, column: number, lane: number, branch: string): Shape => {
    columns = Math.max(columns, column + 1);

    return { id, kind: "more", label: `${count} earlier ${count === 1 ? "commit" : "commits"}`, group: branch, count, ...place(column, lane), w, h };
  };
  const flow = (from: string, to: string, route?: { x: number; y: number }[]): Line => (route ? { from, to, kind: "flow", route } : { from, to, kind: "flow" });

  // The base: its earlier commits as one shape, then its last commits, oldest on the left.
  const baseRow = [...graph.baseCommits].reverse();
  const baseStart = graph.baseEarlier > 0 ? 1 : 0;
  let previous: string | null = null;

  if (graph.baseEarlier > 0) {
    nodes.push(moreShape(`more:${graph.base}`, graph.baseEarlier, 0, 0, graph.base));
    previous = `more:${graph.base}`;
  }

  for (const [i, commit] of baseRow.entries()) {
    nodes.push(commitShape(commit, baseStart + i, 0, graph.base));

    if (previous) edges.push(flow(previous, `commit:${commit.sha}`));
    previous = `commit:${commit.sha}`;
  }

  groups.push({ id: graph.base, label: `${graph.base} (base${graph.current === graph.base ? ", checked out" : ""})`, kind: "lane", x: 0, y: 0, w: 0, h: row });

  // The branches, the shortest first, so a branch started on another one leaves that one's commit.
  const lanes = [...graph.lanes].sort((a, b) => a.ahead - b.ahead || (a.name < b.name ? -1 : 1));

  for (const lane of lanes) {
    // Its own commits not drawn yet, newest first; the first one already drawn is where it left (a stacked branch).
    const own: Commit[] = [];
    let from: { id: string; column: number; lane: number } | null = null;

    for (const commit of lane.commits) {
      const known = drawn.get(commit.sha);

      if (known) {
        from = known;
        break;
      }

      own.push(commit);
    }

    // Nothing of its own left: it points at a commit another branch drew.
    if (own.length === 0) {
      const tip = lane.commits[0]?.sha;

      if (tip) tips.set(tip, [...(tips.get(tip) ?? []), lane.name]);
      continue;
    }

    // Left where it forked from the base: that commit when drawn, else the base's earlier commits (older than drawn).
    if (!from && lane.fork) from = drawn.get(lane.fork) ?? (graph.baseEarlier > 0 ? { id: `more:${graph.base}`, column: 0, lane: 0 } : null);
    const index = groups.length;
    const unread = lane.ahead - lane.commits.length;
    let column = (from?.column ?? -1) + 1;
    let last: string | null = null;

    // Its commits older than those read (none for a stacked branch: those are the other branch's), one shape before them.
    if (own.length === lane.commits.length && unread > 0) {
      nodes.push(moreShape(`more:${lane.name}`, unread, column, index, lane.name));
      last = `more:${lane.name}`;
      column++;
    }

    for (const commit of [...own].reverse()) {
      nodes.push(commitShape(commit, column, index, lane.name));

      if (last) edges.push(flow(last, `commit:${commit.sha}`));
      last = `commit:${commit.sha}`;
      column++;
    }

    // The line from where it left: out of that commit's right side, down (or up) in the gap after it, into the lane.
    if (from) {
      const first = nodes.find((node) => node.group === lane.name)!;
      const start = place(from.column, from.lane);
      const turn = start.x + w + gap / 2;
      edges.push(flow(from.id, first.id, [{ x: start.x + w, y: start.y + h / 2 }, { x: turn, y: start.y + h / 2 }, { x: turn, y: first.y + h / 2 }, { x: first.x, y: first.y + h / 2 }]));
    }

    const state = [`${lane.ahead} ahead`, `${lane.behind} behind`].join(", ");
    groups.push({ id: lane.name, label: `${lane.name}${lane.current ? " (checked out)" : ""}${lane.remote ? " (remote)" : ""} — ${state}`, kind: "lane", x: 0, y: index * row, w: 0, h: row });
  }

  // The branches with no lane, named on the commit they point at (when it is drawn).
  for (const node of nodes) {
    const names = tips.get(node.id.slice("commit:".length));

    if (node.kind === "cell" && names) node.label += `\n⌂ ${names.join(", ")}`;
  }

  const width = 20 + columns * (w + gap);

  for (const group of groups) group.w = width;
  const level = graph.level.map((branch) => branch.name);
  const notes = [
    graph.lanes.length === 0 ? `no branch has commits of its own against ${graph.base}` : `${graph.lanes.length} ${graph.lanes.length === 1 ? "branch has" : "branches have"} commits of their own against ${graph.base}`,
    level.length > 0 ? `level with ${graph.base} or merged: ${level.join(", ")}` : "",
    graph.more > 0 ? `${graph.more} more ${graph.more === 1 ? "branch" : "branches"} left out` : "",
    "a double tap on a commit opens what it did",
  ].filter(Boolean);

  return unplaced(`Branches against ${graph.base}`, nodes, edges, groups, { placed: true, reason: notes.join("; ") });
}
