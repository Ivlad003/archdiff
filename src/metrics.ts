// Coupling and cohesion as numbers, from the graph alone: per module and
// per layer, Martin's afferent and efferent coupling (Ca: who depends on
// it, Ce: what it depends on), instability I = Ce / (Ca + Ce),
// abstractness A (the share of types and interfaces among the top-level
// declarations), the distance from the main sequence D = |A + I − 1| (far
// from it: the zone of pain — concrete and depended upon — or the zone
// of uselessness — abstract and depending on everything), and a cohesion
// of the module's functions: how many connected groups they form when a
// call between two functions, a callee they share or a type they share
// joins them (1: one group; 0: every function on its own).
//
// Pure functions of the analysis: `metricsOf` computes, `metricsView`
// draws the table (placed, like the matrix), `overlayInstability` shades
// any picture by I; markdown.ts writes the tables. Entry points:
// `metricsOf`, `metricsView`, `overlayInstability`.

import type { Analysis } from "./analyze.ts";
import { farFromMainSequence, SIZE, type Diagram, type PictureContent, type Shape, type LayerMetrics, type Metrics, type ModuleMetrics } from "./diagram.ts";
import { moduleOf, type Graph } from "./graph.ts";
import { unplaced } from "./nodes.ts";
import { moduleOfShape } from "./shape-keys.ts";
import { counted } from "./words.ts";

/** Union–find over the functions of a module, for the groups the cohesion counts. */
class Groups {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    let root = id;

    while (this.parent.get(root) !== root) root = this.parent.get(root)!;

    // Path halving, so a long chain of unions stays cheap.
    for (let at = id; at !== root; ) {
      const next = this.parent.get(at)!;
      this.parent.set(at, root);
      at = next;
    }

    return root;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);

    if (ra !== rb) this.parent.set(ra, rb);
  }

  count(): number {
    return new Set([...this.parent.keys()].map((id) => this.find(id))).size;
  }
}

/** The modules each module imports and is imported by, repository modules only; type-only imports count when `types`. */
function couplings(graph: Graph, types: boolean): { importsOf: Map<string, Set<string>>; importersOf: Map<string, Set<string>> } {
  const importsOf = new Map<string, Set<string>>();
  const importersOf = new Map<string, Set<string>>();

  for (const id of graph.modules.keys()) {
    importsOf.set(id, new Set());
    importersOf.set(id, new Set());
  }

  for (const dep of graph.deps) {
    if ((dep.typeOnly && !types) || !graph.modules.has(dep.to) || dep.from === dep.to) continue;
    importsOf.get(dep.from)!.add(dep.to);
    importersOf.get(dep.to)!.add(dep.from);
  }

  return { importsOf, importersOf };
}

/** Cohesion of a module's functions: 1 − (groups − 1) / (functions − 1); 1 for one function or none. */
function cohesionOf(analysis: Analysis, module: string): number {
  const { graph, facts } = analysis;
  const fns = [...graph.nodes.values()].filter((node) => node.module === module && node.kind === "fn").map((node) => node.id);

  if (fns.length <= 1) return 1;
  const own = new Set(fns);
  const groups = new Groups();

  for (const id of fns) groups.add(id);
  // A call from one function of the module to another joins them; a callee two functions share joins them too.
  const byCallee = new Map<string, string[]>();

  for (const call of graph.calls) {
    if (!own.has(call.from)) continue;

    if (own.has(call.to)) groups.union(call.from, call.to);
    byCallee.set(call.to, [...(byCallee.get(call.to) ?? []), call.from]);
  }

  for (const callers of byCallee.values()) for (let i = 1; i < callers.length; i++) groups.union(callers[0]!, callers[i]!);
  // A type of the repository two functions both name (in a signature or a body) joins them.
  const known = new Set([...graph.nodes.values()].filter((node) => node.kind === "type").map((node) => node.name));
  const byType = new Map<string, string[]>();

  const walk = (decl: { name: string; types: { name: string }[]; members: { name: string; types: { name: string }[]; members: unknown[] }[] }, parent: string | null): void => {
    const id = parent ? `${module}#${parent}.${decl.name}` : `${module}#${decl.name}`;

    if (own.has(id)) for (const type of decl.types) if (known.has(type.name)) byType.set(type.name, [...(byType.get(type.name) ?? []), id]);

    for (const member of decl.members as typeof decl[]) walk(member, parent ? `${parent}.${decl.name}` : decl.name);
  };

  for (const decl of facts.get(module)?.decls ?? []) walk(decl, null);

  for (const users of byType.values()) for (let i = 1; i < users.length; i++) groups.union(users[0]!, users[i]!);

  return 1 - (groups.count() - 1) / (fns.length - 1);
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** The metrics of every module and every layer. */
export function metricsOf(analysis: Analysis, types = false): Metrics {
  const { graph } = analysis;
  const { importsOf, importersOf } = couplings(graph, types);
  const callsIn = new Map<string, number>();
  const callsOut = new Map<string, number>();

  for (const call of graph.calls) {
    const from = moduleOf(call.from);
    const to = moduleOf(call.to);

    if (from === to) continue;
    callsIn.set(to, (callsIn.get(to) ?? 0) + 1);
    callsOut.set(from, (callsOut.get(from) ?? 0) + 1);
  }

  const modules: ModuleMetrics[] = [];
  const abstractParts = new Map<string, { types: number; decls: number }>();

  for (const module of [...graph.modules.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const top = [...graph.nodes.values()].filter((node) => node.module === module.id && !node.parent);
    const types = top.filter((node) => node.kind === "type").length;
    const ca = importersOf.get(module.id)!.size;
    const ce = importsOf.get(module.id)!.size;
    const instability = ca + ce === 0 ? 0 : ce / (ca + ce);
    const abstractness = top.length === 0 ? 0 : types / top.length;
    abstractParts.set(module.id, { types, decls: top.length });
    modules.push({
      id: module.id,
      layer: module.layer,
      ca,
      ce,
      instability: round(instability),
      abstractness: round(abstractness),
      distance: round(Math.abs(abstractness + instability - 1)),
      cohesion: round(cohesionOf(analysis, module.id)),
      lines: module.lines,
      fns: [...graph.nodes.values()].filter((node) => node.module === module.id && node.kind === "fn").length,
      callsIn: callsIn.get(module.id) ?? 0,
      callsOut: callsOut.get(module.id) ?? 0,
    });
  }

  // A layer: the modules outside it that import it (Ca), the ones its modules import outside it (Ce), its types over its declarations (A).
  const layers: LayerMetrics[] = [];

  for (const name of graph.layers) {
    const own = [...graph.modules.values()].filter((module) => module.layer === name).map((module) => module.id);
    const ownSet = new Set(own);
    const ca = new Set<string>();
    const ce = new Set<string>();
    let types = 0;
    let decls = 0;

    for (const id of own) {
      for (const importer of importersOf.get(id)!) if (!ownSet.has(importer)) ca.add(importer);

      for (const imported of importsOf.get(id)!) if (!ownSet.has(imported)) ce.add(imported);
      types += abstractParts.get(id)?.types ?? 0;
      decls += abstractParts.get(id)?.decls ?? 0;
    }

    const instability = ca.size + ce.size === 0 ? 0 : ce.size / (ca.size + ce.size);
    const abstractness = decls === 0 ? 0 : types / decls;
    layers.push({ name, modules: own.length, ca: ca.size, ce: ce.size, instability: round(instability), abstractness: round(abstractness), distance: round(Math.abs(abstractness + instability - 1)) });
  }

  return { modules, layers };
}

const COLUMNS: { key: keyof ModuleMetrics; label: string }[] = [
  { key: "ca", label: "Ca" },
  { key: "ce", label: "Ce" },
  { key: "instability", label: "I" },
  { key: "abstractness", label: "A" },
  { key: "distance", label: "D" },
  { key: "cohesion", label: "coh" },
  { key: "lines", label: "lines" },
];

/** The modules of a scope (a layer, or every layer), the farthest from the main sequence first; ties: the most depended upon, then by name. */
function worstFirst(metrics: Metrics, scope: string | null): ModuleMetrics[] {
  return metrics.modules.filter((module) => scope === null || module.layer === scope).sort((a, b) => b.distance - a.distance || b.ca - a.ca || (a.id < b.id ? -1 : 1));
}

/**
 * The metrics as a table: a row per module, the farthest from the main
 * sequence first, the columns Ca, Ce, I, A, D, cohesion and lines; a cell
 * of D or of a low cohesion is shaded. Placed, at most `limit` rows
 * (`--limit` raises it); `metrics:<layer>` keeps one layer's modules.
 */
export function metricsView(analysis: Analysis, scope: string | null, limit: number, types = false): PictureContent {

  if (scope !== null && !analysis.graph.layers.includes(scope)) return unplaced(scope, [], [], [], { reason: `no layer "${scope}"`, missing: true });
  const metrics = metricsOf(analysis, types);
  const rows = worstFirst(metrics, scope);

  if (rows.length === 0) return unplaced("Metrics", [], [], [], { reason: "no modules" });
  const shown = rows.slice(0, limit);
  const cell = SIZE.cell;
  const head = 240;
  const nodes: Shape[] = [];

  COLUMNS.forEach((column, i) => nodes.push({ id: `col:${column.key}`, kind: "cell", label: column.label, x: head + i * cell.w, y: 0, w: cell.w, h: cell.h }));
  shown.forEach((row, r) => {
    const y = cell.h + r * cell.h;
    nodes.push({ id: `row:${row.id}`, kind: "cell", label: row.id, ref: { id: row.id, file: row.id, line: 1 }, x: 0, y, w: head, h: cell.h });

    COLUMNS.forEach((column, i) => {
      const value = row[column.key] as number;
      const node: Shape = { id: `cell:${row.id}:${column.key}`, kind: "cell", label: Number.isInteger(value) ? String(value) : value.toFixed(2), x: head + i * cell.w, y, w: cell.w, h: cell.h, count: value };

      // The distance and a low cohesion are what to look at: shaded, and marked when far.
      if (column.key === "distance") {
        node.heat = value;

        if (farFromMainSequence(row)) node.diff = "warning";
      } else if (column.key === "cohesion") {
        node.heat = 1 - value;

        if (value < 0.3) node.diff = "warning";
      }

      nodes.push(node);
    });
  });
  const far = shown.filter(farFromMainSequence).length;
  const loose = shown.filter((row) => row.cohesion < 0.3 && row.fns > 2).length;
  const parts = [far > 0 ? `${counted(far, "module")} far from the main sequence (D ≥ 0.7, orange)` : "no module far from the main sequence", loose > 0 ? `${counted(loose, "module")} of loosely related functions (cohesion < 0.3)` : "", rows.length > shown.length ? `${shown.length} of ${rows.length} modules; --limit raises it` : ""].filter(Boolean);

  return unplaced(scope === null ? "Metrics: coupling and cohesion by module" : `Metrics of ${scope}`, nodes, [], [], { placed: true, metrics: { modules: shown, layers: scope === null ? metrics.layers : metrics.layers.filter((layer) => layer.name === scope) }, reason: parts.join("; ") });
}

/** Every module shaded by its instability, labelled with I and Ca; one that is unstable and depended upon (I ≥ 0.7, Ca ≥ 3) is marked: a change to it reaches far and it changes often. */
export function overlayInstability(diagram: Diagram, analysis: Analysis): Diagram {
  const metrics = metricsOf(analysis);
  const byModule = new Map(metrics.modules.map((row) => [row.id, row]));
  let marked = 0;
  const nodes = diagram.nodes.map((node) => {
    const module = moduleOfShape(node);
    const row = module ? byModule.get(module) : undefined;

    if (!row) return node;
    const shaded: Shape = { ...node, heat: row.instability, label: `${node.label}\nI ${row.instability.toFixed(2)} · Ca ${row.ca}` };

    if (row.instability >= 0.7 && row.ca >= 3 && !node.diff) {
      shaded.diff = "warning";
      marked++;
    }

    return shaded;
  });

  return { ...diagram, nodes, reason: [diagram.reason, `shade: instability I = Ce / (Ca + Ce)${marked > 0 ? `; ${marked} unstable modules others depend on (orange)` : ""}`].filter(Boolean).join("; ") };
}
