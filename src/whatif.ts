// What a move, a deletion or a split would do to the architecture, before
// a file is touched: the graph of the code as it would be, recomputed from
// the graph as it is, and set against it as a review sets two revisions —
// the modules, functions, imports and calls added and removed (diff.ts),
// the imports that would go against the contract or stop going against it
// (intent.ts's check on both graphs), the import cycles and the circles of
// layers it would close, break or change, and the imports and calls a
// deletion would leave without their target.
//
// A change is one of three. `move:<path>><to>`: the module at another path
// (a directory names the place, the file keeps its name) — its layer is
// the new path's by archdiff.json, its imports and calls stay whose they
// are. `delete:<path>`: the module, its functions, its imports and the
// calls from it are gone; an import of it and a call into it break.
// `split:<path>#<fn>,<fn>><new>`: the named top-level declarations (a
// class with its members) leave for a new module. A split's imports follow
// the code that uses them: an importer of the old module imports the new
// one where it binds a moved name or calls a moved declaration, and keeps
// the old one where it binds anything else; an import of the old module
// goes with the moved declarations that use its names (callees, types and
// values, as the facts have them), stays where the rest uses them or
// nothing tells; and the two halves import each other where one calls or
// names the other — which is how a split closes a cycle.
//
// A what-if supposes the change is made well (the importers' paths
// rewritten); it says what the architecture would be, not what the
// compiler would say. Pure functions of the analysis, in the views layer.
// Entry points: `parseWhatIf`, `whatIfKey`, `whatIfOf`, `whatIfView`,
// `whatIfMarkdown`, `WhatIf`, `WhatIfChange`.

import type { Analysis } from "./analyze.ts";
import { layerOf } from "./config.ts";
import type { Diagram, Line, PictureContent, Shape } from "./diagram.ts";
import { changeSections, diffDiagram, graphDiff, markContract, type GraphDiff } from "./diff.ts";
import { toMermaid } from "./export/mermaid.ts";
import type { DeclFact, FileFacts } from "./extract/facts.ts";
import { moduleOf, type CallEdge, type Declaration, type Dependency, type Graph, type Module } from "./graph.ts";
import { checkIntent, INTENT_FILE, judgesLayers, type IntentReport } from "./intent.ts";
import { unplaced } from "./nodes.ts";
import { ok, wrong, type Result } from "./result.ts";
import { stronglyConnected } from "./scc.ts";
import { isSourceFile } from "./view-keys.ts";
import { counted } from "./words.ts";

/** A change to suppose: a module moved, a module deleted, or declarations of a module split off into a new one. */
export type WhatIfChange = { op: "move"; module: string; to: string } | { op: "delete"; module: string } | { op: "split"; module: string; names: string[]; to: string };

/** How every what-if is written, for the messages that refuse one. */
export const WHATIF_FORMS = "move:<path>><to>, delete:<path>, split:<path>#<fn>,<fn>><new path>";

/** `move:src/a.ts>src/b/`, `delete:src/a.ts`, `split:src/a.ts#f,g>src/c.ts` → the change; null for a text that is none of them. */
export function parseWhatIf(subject: string): WhatIfChange | null {
  const at = subject.indexOf(":");
  const op = at === -1 ? subject : subject.slice(0, at);
  const rest = at === -1 ? "" : subject.slice(at + 1);

  if (op === "delete") return rest === "" || rest.includes(">") ? null : { op, module: rest };
  const arrow = rest.lastIndexOf(">");

  if ((op !== "move" && op !== "split") || arrow <= 0 || arrow === rest.length - 1) return null;
  const from = rest.slice(0, arrow);
  const to = rest.slice(arrow + 1);

  if (op === "move") return from.includes("#") ? null : { op, module: from, to };
  const hash = from.indexOf("#");
  const names = hash === -1 ? [] : from.slice(hash + 1).split(",").map((name) => name.trim()).filter((name) => name !== "");

  return hash <= 0 || names.length === 0 ? null : { op, module: from.slice(0, hash), names, to };
}

/** The subject of the `whatif:` view of a change: what `parseWhatIf` reads back. */
export function whatIfKey(change: WhatIfChange): string {
  if (change.op === "delete") return `delete:${change.module}`;

  return change.op === "move" ? `move:${change.module}>${change.to}` : `split:${change.module}#${change.names.join(",")}>${change.to}`;
}

/** A circle of modules, or of layers, by its members in order. */
type Circle = string[];

/** The circles of one kind (of modules by their imports, of layers) a change would close, break or change. */
export interface CircleChange {
  created: Circle[];
  removed: Circle[];
  /** A circle that would gain or lose members. */
  changed: { before: Circle; after: Circle }[];
}

/** What a change would do, as data: `archdiff whatif --json` prints it, the picture and the Markdown are drawn from it. */
export interface WhatIf {
  /** The change as understood: a move's `to` is the file it lands at. */
  change: WhatIfChange;
  /** The change in words: "move src/a.ts to src/b/a.ts". */
  title: string;
  /** The layer of the module as it is, and of the module the change makes (a move's target, a split's new module); null where there is none. */
  layer: { before: string | null; after: string | null };
  /** The code as it would be against the code as it is, as a review's diff. */
  diff: GraphDiff;
  /** The code has a contract that names layers: the violations are judged by it. */
  contract: boolean;
  /** The imports that would go against the contract and do not now, and those that do now and would not. */
  violations: { added: IntentReport["violations"]; removed: IntentReport["violations"] };
  /** The circles of modules importing each other, and of layers. */
  cycles: { modules: CircleChange; layers: CircleChange };
  /** The imports and calls left without their target (a deletion). */
  broken: { imports: { from: string; to: string; line: number }[]; calls: { from: string; to: string; line: number }[] };
  /** What a reader must know first, one line each; empty when the change breaks nothing, goes against nothing and closes no circle. */
  findings: string[];
}

/** A what-if with the graphs it was computed between, for the picture. */
interface Computed {
  result: WhatIf;
  before: Graph;
  after: Graph;
}

const computed = new WeakMap<Analysis, Map<string, Result<Computed>>>();

/** The what-if of a `whatif:` view's subject on the analysis, computed once per analysis and subject; a problem names what is wrong with the change. */
function compute(analysis: Analysis, subject: string): Result<Computed> {
  const known = computed.get(analysis) ?? new Map<string, Result<Computed>>();
  computed.set(analysis, known);
  let result = known.get(subject);

  if (!result) {
    const change = parseWhatIf(subject);
    result = change ? suppose(analysis, change) : wrong(`"${subject}" is no what-if (${WHATIF_FORMS})`);
    known.set(subject, result);
  }

  return result;
}

/** What the change a `whatif:` view's subject names would do to the architecture, as data; a problem when it names no change that can be supposed. */
export function whatIfOf(analysis: Analysis, subject: string): Result<WhatIf> {
  const result = compute(analysis, subject);

  return result.ok ? ok(result.value.result) : result;
}

/** The last segment of a path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The graph with other modules, nodes, lines and exports; its layers are those its modules lie in. */
function graphWith(graph: Graph, parts: Partial<Pick<Graph, "modules" | "nodes" | "deps" | "calls" | "gaps" | "apiCalls" | "externals" | "leftOutImports" | "unresolvedImports" | "resolvedExports">>): Graph {
  const next = { ...graph, ...parts };
  const modules = new Map([...next.modules].sort((a, b) => (a[0] < b[0] ? -1 : 1)));

  return { ...next, modules, layers: [...new Set([...modules.values()].map((module) => module.layer))].sort() };
}

/** Every ID of the graph renamed by `rename`: the modules and nodes it moves take their new place, the lines follow. */
function renamed(graph: Graph, rename: (id: string) => string, layer: (module: string) => string): Graph {
  const modules = new Map<string, Module>();

  for (const module of graph.modules.values()) {
    const id = rename(module.id);
    modules.set(id, id === module.id ? module : { ...module, id, layer: layer(id), decls: module.decls.map(rename) });
  }

  const nodes = new Map<string, Declaration>();

  for (const node of graph.nodes.values()) {
    const id = rename(node.id);
    nodes.set(id, id === node.id ? node : { ...node, id, module: moduleOf(id) });
  }

  const from = <T extends { from: string }>(row: T): T => (rename(row.from) === row.from ? row : { ...row, from: rename(row.from) });
  const ends = <T extends { from: string; to: string }>(row: T): T => (rename(row.from) === row.from && rename(row.to) === row.to ? row : { ...row, from: rename(row.from), to: rename(row.to) });

  return graphWith(graph, {
    modules,
    nodes,
    deps: graph.deps.map(ends),
    calls: graph.calls.map(ends),
    gaps: graph.gaps.map(from),
    apiCalls: graph.apiCalls.map(from),
    leftOutImports: graph.leftOutImports.map(from),
    unresolvedImports: graph.unresolvedImports.map(from),
    resolvedExports: new Map([...graph.resolvedExports].map(([module, names]) => [rename(module), new Map([...names].map(([name, id]) => [name, rename(id)]))])),
  });
}

/** The module at another path: every ID under it renamed, its layer the new path's. */
function moved(analysis: Analysis, module: string, to: string): Graph {
  const rename = (id: string): string => (id === module ? to : id.startsWith(`${module}#`) ? `${to}${id.slice(module.length)}` : id);

  return renamed(analysis.graph, rename, (id) => layerOf(id, analysis.config));
}

/** The graph without the module, and the imports and calls that would lose their target. */
function deleted(graph: Graph, module: string): { graph: Graph; broken: WhatIf["broken"] } {
  const own = (id: string): boolean => moduleOf(id) === module;
  const broken: WhatIf["broken"] = { imports: [], calls: [] };

  for (const dep of graph.deps) if (dep.to === module && dep.from !== module) broken.imports.push({ from: dep.from, to: dep.to, line: dep.line });

  for (const call of graph.calls) if (own(call.to) && !own(call.from)) broken.calls.push({ from: call.from, to: call.to, line: call.line });
  const deps = graph.deps.filter((dep) => dep.from !== module && dep.to !== module);
  const used = new Set(deps.map((dep) => dep.to));
  const after = graphWith(graph, {
    modules: new Map([...graph.modules].filter(([id]) => id !== module)),
    nodes: new Map([...graph.nodes].filter(([id]) => !own(id))),
    deps,
    calls: graph.calls.filter((call) => !own(call.from) && !own(call.to)),
    gaps: graph.gaps.filter((gap) => !own(gap.from)),
    apiCalls: graph.apiCalls.filter((call) => !own(call.from)),
    // A package only the module imported is no package of the code any more.
    externals: new Map([...graph.externals].filter(([id]) => used.has(id))),
    leftOutImports: graph.leftOutImports.filter((row) => row.from !== module),
    unresolvedImports: graph.unresolvedImports.filter((row) => row.from !== module),
    resolvedExports: new Map([...graph.resolvedExports].filter(([id]) => id !== module).map(([id, names]) => [id, new Map([...names].filter(([, node]) => !own(node)))])),
  });

  return { graph: after, broken };
}

/** The names a declaration (and its members) uses that an import could bind: the heads of its callees, the types it mentions. */
function namesUsed(decl: DeclFact, into: Set<string>): Set<string> {
  for (const call of decl.calls) {
    if (call.form.kind === "name") into.add(call.form.name);
    else if (call.form.kind === "member") into.add(call.form.head);
    else if (call.form.kind === "typed") into.add(call.form.type);
  }

  for (const type of decl.types) into.add(type.name);

  for (const member of decl.members) namesUsed(member, into);

  return into;
}

/**
 * The imports of a split, by the rules of the header: what the importers of the old module import afterwards, what
 * of the old module's own imports each half keeps, and the imports between the halves.
 */
function splitDeps(analysis: Analysis, module: string, names: ReadonlySet<string>, to: string, isMoved: (id: string) => boolean): Dependency[] {
  const { graph, facts } = analysis;
  const file: FileFacts | undefined = facts.get(module);
  const own = (id: string): boolean => moduleOf(id) === module;
  const deps: Dependency[] = [];
  // Who calls what, by module: the calls into the moved declarations and into the rest, and those between the halves.
  const callsMoved = new Map<string, number>();
  let restCallsMoved: CallEdge | null = null;
  let movedCallsRest: CallEdge | null = null;

  for (const call of graph.calls) {
    if (own(call.to) && !own(call.from) && isMoved(call.to) && !callsMoved.has(moduleOf(call.from))) callsMoved.set(moduleOf(call.from), call.line);

    if (!own(call.from) || !own(call.to) || graph.nodes.get(call.to)?.kind === "type") continue;

    if (!isMoved(call.from) && isMoved(call.to)) restCallsMoved ??= call;
    else if (isMoved(call.from) && !isMoved(call.to)) movedCallsRest ??= call;
  }

  // What each half names: for the module's own imports, and for the types the halves share.
  const movedUses = new Set<string>();
  const restUses = new Set<string>();

  for (const decl of file?.decls ?? []) namesUsed(decl, names.has(decl.name) ? movedUses : restUses);

  for (const call of file?.moduleCalls ?? []) {
    if (call.form.kind === "name") restUses.add(call.form.name);
    else if (call.form.kind === "member") restUses.add(call.form.head);
  }

  // A value read without a call (`later(save)`, `{ save }`) is the rest's unless a moved declaration's lines hold it;
  // the facts keep where a name is first read, so a value both halves read is known for the half that reads it first.
  for (const ref of file?.valueRefs ?? []) {
    const holder = (file?.decls ?? []).find((decl) => ref.line >= decl.line && ref.line <= decl.endLine);
    (holder && names.has(holder.name) ? movedUses : restUses).add(ref.name);
  }

  for (const dep of graph.deps) {
    if (dep.from !== module && dep.to !== module) {
      deps.push(dep);
      continue;
    }

    // An importer: the new module where it binds a moved name, the old where it binds anything else.
    if (dep.to === module && dep.from !== module) {
      const statements = (facts.get(dep.from)?.imports ?? []).filter((fact) => fact.line === dep.line);
      const bound = statements.flatMap((fact) => fact.bindings);
      const bindsMoved = bound.some((binding) => binding.kind === "named" && names.has(binding.imported));
      const bindsRest = statements.length === 0 || statements.some((fact) => fact.glob === true || fact.bindings.length === 0) || bound.some((binding) => !(binding.kind === "named" && names.has(binding.imported)));

      if (bindsRest) deps.push(dep);

      if (bindsMoved) deps.push({ ...dep, to });
      continue;
    }

    // The module's own import: with the half that uses the names it binds; with the old module when nothing tells.
    if (dep.from === module && dep.to !== module) {
      const statements = (file?.imports ?? []).filter((fact) => fact.line === dep.line);
      const locals = statements.flatMap((fact) => fact.bindings.map((binding) => binding.local));
      const byMoved = locals.some((local) => movedUses.has(local));
      const byRest = locals.some((local) => restUses.has(local));

      if (byRest || !byMoved) deps.push(dep);

      if (byMoved) deps.push({ ...dep, from: to });
      continue;
    }

    deps.push(dep);
  }

  // A module that calls a moved declaration through a name of the whole module (`orders.placeOrder()`) imports the new one too.
  for (const [importer, line] of callsMoved) if (!deps.some((dep) => dep.from === importer && dep.to === to && !dep.typeOnly)) deps.push({ from: importer, to, typeOnly: false, reexport: false, line });

  // Between the halves: an import where one calls the other, of types only where it only names a type of the other.
  const typeNames = (moved: boolean): Set<string> => new Set((file?.decls ?? []).filter((decl) => decl.kind === "type" && names.has(decl.name) === moved).map((decl) => decl.name));
  const valueNames = (moved: boolean): Set<string> => new Set((file?.decls ?? []).filter((decl) => decl.kind !== "type" && names.has(decl.name) === moved).map((decl) => decl.name));
  const between = (from: string, target: string, call: CallEdge | null, uses: ReadonlySet<string>, values: ReadonlySet<string>, types: ReadonlySet<string>): void => {
    const runs = call !== null || [...values].some((name) => uses.has(name));

    if (runs || [...types].some((name) => uses.has(name))) deps.push({ from, to: target, typeOnly: !runs, reexport: false, line: call?.line ?? 1 });
  };

  between(module, to, restCallsMoved, restUses, valueNames(true), typeNames(true));
  between(to, module, movedCallsRest, movedUses, valueNames(false), typeNames(false));

  return deps;
}

/** The named top-level declarations of the module (each with its members) in a new module, the lines following them. */
function split(analysis: Analysis, module: string, names: ReadonlySet<string>, to: string): Graph {
  const { graph } = analysis;
  const isMoved = (id: string): boolean => [...names].some((name) => id === `${module}#${name}` || id.startsWith(`${module}#${name}.`));
  const rename = (id: string): string => (isMoved(id) ? `${to}${id.slice(module.length)}` : id);
  const old = graph.modules.get(module)!;
  const leaving = old.decls.filter(isMoved);
  // The lines the moved declarations take, as the new module's size; the old one keeps the rest.
  const lines = leaving.reduce((sum, id) => sum + (graph.nodes.get(id)!.endLine - graph.nodes.get(id)!.line + 1), 0);
  const base = renamed(graph, rename, (id) => layerOf(id, analysis.config));
  const modules = new Map(base.modules);
  modules.set(module, { ...old, decls: old.decls.filter((id) => !isMoved(id)), lines: Math.max(1, old.lines - lines) });
  modules.set(to, { id: to, layer: layerOf(to, analysis.config), decls: leaving.map(rename), lines: Math.max(1, lines), opaque: false });
  const exports = new Map(base.resolvedExports);
  // The old module exports what stays; the new one what left, under the names it had.
  const before = [...(graph.resolvedExports.get(module) ?? [])];
  exports.set(module, new Map(before.filter(([, id]) => !isMoved(id))));
  exports.set(to, new Map(before.filter(([, id]) => isMoved(id)).map(([name, id]) => [name, rename(id)])));

  return graphWith(base, { modules, deps: splitDeps(analysis, module, names, to, isMoved), resolvedExports: exports });
}

/** The circles of a graph's modules by their imports that run, and of its layers by the imports between them. */
function circlesOf(graph: Graph): { modules: Circle[]; layers: Circle[] } {
  const modules = new Map<string, Set<string>>();
  const layers = new Map<string, Set<string>>();

  for (const dep of graph.deps) {
    if (dep.typeOnly || dep.from === dep.to || !graph.modules.has(dep.to) || !graph.modules.has(dep.from)) continue;
    modules.set(dep.from, (modules.get(dep.from) ?? new Set<string>()).add(dep.to));
    const from = graph.modules.get(dep.from)!.layer;
    const to = graph.modules.get(dep.to)!.layer;

    if (from !== to) layers.set(from, (layers.get(from) ?? new Set<string>()).add(to));
  }

  const sorted = (circles: string[][]): Circle[] => circles.map((circle) => [...circle].sort()).sort((a, b) => (a.join() < b.join() ? -1 : 1));

  return { modules: sorted(stronglyConnected(modules).filter((circle) => circle.length > 1)), layers: sorted(stronglyConnected(layers).filter((circle) => circle.length > 1)) };
}

/** The circles the change would close, break or change: one of after that shares no member with one of before is new, one of before that shares none with one of after is gone. */
function circleChange(before: readonly Circle[], after: readonly Circle[]): CircleChange {
  const same = (a: Circle, b: Circle): boolean => a.join("\u0000") === b.join("\u0000");
  const meets = (a: Circle, b: Circle): boolean => a.some((member) => b.includes(member));
  const change: CircleChange = { created: [], removed: [], changed: [] };

  for (const circle of after) {
    const was = before.find((other) => meets(circle, other));

    if (!was) change.created.push(circle);
    else if (!same(was, circle) && !before.some((other) => same(other, circle))) change.changed.push({ before: was, after: circle });
  }

  for (const circle of before) if (!after.some((other) => meets(circle, other))) change.removed.push(circle);

  return change;
}

/** The change supposed on the analysis's graph: the graph after it, and what it would do; a problem when the change cannot be supposed. */
function suppose(analysis: Analysis, asked: WhatIfChange): Result<Computed> {
  const { graph } = analysis;
  const module = graph.modules.get(asked.module);

  if (!module) return wrong(`no module "${asked.module}"`, 404);
  let change: WhatIfChange = asked;
  let after: Graph;
  let broken: WhatIf["broken"] = { imports: [], calls: [] };
  let title: string;
  // The IDs of before as they are after, to tell a violation or a circle that only moved from a new one.
  let rename = (id: string): string => id;

  if (asked.op === "move") {
    // A source file is the place itself; anything else is a directory, and the file keeps its name.
    const place = asked.to.replace(/\/+$/, "");
    const to = isSourceFile(place) && !asked.to.endsWith("/") ? place : `${place}/${baseName(asked.module)}`;

    if (to === asked.module) return wrong(`${asked.module} is there already`);

    if (graph.modules.has(to)) return wrong(`there is a module at ${to} already`);
    change = { op: "move", module: asked.module, to };
    after = moved(analysis, asked.module, to);
    title = `move ${asked.module} to ${to}`;
    rename = (id) => (id === asked.module ? to : id);
  } else if (asked.op === "delete") {
    ({ graph: after, broken } = deleted(graph, asked.module));
    title = `delete ${asked.module}`;
  } else {
    const top = module.decls.map((id) => graph.nodes.get(id)!.name);
    const unknown = asked.names.find((name) => !top.includes(name));

    if (unknown !== undefined) return wrong(`${asked.module} declares no "${unknown}" at its top level (it declares ${top.join(", ") || "nothing"})`, 404);
    const names = new Set(asked.names);

    if (top.every((name) => names.has(name))) return wrong(`every declaration of ${asked.module} would leave it: that is a move (whatif move ${asked.module} ${asked.to})`);

    if (!isSourceFile(asked.to)) return wrong(`${asked.to} is no source file archdiff reads: a split makes a module`);

    if (graph.modules.has(asked.to)) return wrong(`there is a module at ${asked.to} already: a split makes a new one`);
    change = { op: "split", module: asked.module, names: [...names], to: asked.to };
    after = split(analysis, asked.module, names, asked.to);
    title = `split ${[...names].join(", ")} off ${asked.module} into ${asked.to}`;
  }

  const made = change.op === "delete" ? null : change.to;
  const contract = judgesLayers(analysis.intent) ? analysis.intent : null;
  const diff = markContract(graphDiff(graph, after, "the code as it is", made === null ? [asked.module] : [asked.module, made]), contract, after);
  const violationKey = (violation: IntentReport["violations"][number]): string => `${violation.from}\u0000${violation.to}`;
  const violationsBefore = contract ? checkIntent(analysis, contract).violations.map((violation) => ({ ...violation, from: rename(violation.from), to: rename(violation.to) })) : [];
  const violationsAfter = contract ? checkIntent({ ...analysis, graph: after }, contract).violations : [];
  const wasViolation = new Set(violationsBefore.map(violationKey));
  const isViolation = new Set(violationsAfter.map(violationKey));
  const violations = { added: violationsAfter.filter((violation) => !wasViolation.has(violationKey(violation))), removed: violationsBefore.filter((violation) => !isViolation.has(violationKey(violation))) };
  const circlesBefore = circlesOf(graph);
  const circlesAfter = circlesOf(after);
  const cycles = { modules: circleChange(circlesBefore.modules.map((circle) => circle.map(rename).sort()), circlesAfter.modules), layers: circleChange(circlesBefore.layers, circlesAfter.layers) };
  const closing = cycles.modules.created.length + cycles.modules.changed.filter((circle) => circle.after.length > circle.before.length).length;
  const findings = [
    broken.imports.length > 0 ? `${counted(broken.imports.length, "import")} would break` : "",
    broken.calls.length > 0 ? `${counted(broken.calls.length, "call")} would lose ${broken.calls.length === 1 ? "its" : "their"} target` : "",
    violations.added.length > 0 ? `${counted(violations.added.length, "import")} would go against ${INTENT_FILE}` : "",
    closing > 0 ? `${counted(closing, "import cycle")} would close or grow` : "",
    cycles.layers.created.length > 0 ? `${counted(cycles.layers.created.length, "circle")} of layers would close` : "",
  ].filter(Boolean);
  const result: WhatIf = { change, title, layer: { before: module.layer, after: made === null ? null : (after.modules.get(made)?.layer ?? null) }, diff, contract: contract !== null, violations, cycles, broken, findings };

  return ok({ result, before: graph, after });
}

/** A circle as a line of text: its members joined round. */
function circleText(circle: Circle): string {
  return circle.join(" ⇄ ");
}

/** What the change would do to the circles of one kind, a line each. */
function circleLines(change: CircleChange, what: string): string[] {
  return [
    ...change.created.map((circle) => `would close a circle of ${what}: ${circleText(circle)}`),
    ...change.changed.map((circle) => `a circle of ${what} would ${circle.after.length > circle.before.length ? "grow" : "change"}: ${circleText(circle.before)} becomes ${circleText(circle.after)}`),
    ...change.removed.map((circle) => `would break a circle of ${what}: ${circleText(circle)}`),
  ];
}

/**
 * The picture of a what-if: the review's picture of the code as it would be against the code as it is — the module
 * moved, deleted or made marked, the imports added and removed — with what the change would break said on it: a
 * module whose import loses its target is marked, an import that would go against the contract says so on its line.
 */
export function whatIfView(analysis: Analysis, subject: string): PictureContent {
  const found = compute(analysis, subject);

  // A change that cannot be supposed is a wrong call, like a subject the code does not have.
  if (!found.ok) return unplaced(`What if: ${subject}`, [], [], [], { reason: found.problem.message, missing: true });
  const { result, before, after } = found.value;
  const picture = diffDiagram(result.diff, before, after);
  const breaks = new Set(result.broken.imports.map((dep) => dep.from));
  const against = new Set(result.violations.added.map((violation) => `${violation.from}\u0000${violation.to}`));
  const nodes = picture.nodes.map((node): Shape => (breaks.has(node.id) ? { ...node, label: `${node.label}\nits import breaks`, diff: node.diff ?? "warning" } : node));
  const edges = picture.edges.map((edge): Line => (against.has(`${edge.from}\u0000${edge.to}`) ? { ...edge, label: "against contract" } : edge));
  const { before: layerBefore, after: layerAfter } = result.layer;
  const moves = layerAfter === null || layerAfter === layerBefore ? "" : result.change.op === "move" ? `layer ${layerBefore} → ${layerAfter}` : `the new module in layer ${layerAfter}, the old in ${layerBefore}`;
  const reason = [moves, ...(result.findings.length > 0 ? result.findings.map((finding) => `⚠ ${finding}`) : [nodes.length === 0 ? "no module, function, import or call would change" : "nothing would break, go against the contract or close a cycle"])].filter(Boolean).join("; ");

  return { ...picture, nodes, edges, title: `What if: ${result.title}`, reason };
}

/**
 * A what-if as Markdown, as a review reads: what was supposed and the counts, what it would break, the contract and
 * the cycles — said when nothing changes there too, so a clean answer is an answer — the picture, then every change
 * by kind.
 */
export function whatIfMarkdown(result: WhatIf, diagram: Diagram): string {
  const { diff } = result;
  const lines = [`<!-- archdiff:generated — what-if ${whatIfKey(result.change)}${diagram.stamp ? ` — commit ${diagram.stamp.commit} (${diagram.stamp.date})` : ""} -->`, `# What if: ${result.title}`, ""];
  lines.push("_No file was touched: the graph of the code was recomputed as if the change were made, and set against the code as it is._", "");
  const counts = [`modules +${diff.modulesAdded.length} −${diff.modulesRemoved.length}`, `functions +${diff.nodesAdded.length} −${diff.nodesRemoved.length}`, `imports +${diff.depsAdded.length} −${diff.depsRemoved.length}`, `calls +${diff.callsAdded.length} −${diff.callsRemoved.length}`, `packages +${diff.externalsAdded.length} −${diff.externalsRemoved.length}`];
  lines.push(`${counts.join("; ")}.${result.layer.after !== null ? ` ${result.change.op === "move" ? "The module" : "The new module"} would lie in layer **${result.layer.after}**${result.change.op === "move" && result.layer.before !== result.layer.after ? ` (now **${result.layer.before}**)` : ""}.` : ""}`, "");

  if (result.broken.imports.length + result.broken.calls.length > 0) {
    lines.push("## ⚠ Broken by it", "", ...result.broken.imports.map((dep) => `- \`${dep.from}:${dep.line}\` imports \`${dep.to}\``), ...result.broken.calls.map((call) => `- \`${call.from}\` calls \`${call.to}\` — ${moduleOf(call.from)}:${call.line}`), "");
  }

  lines.push(result.violations.added.length > 0 ? "## ⚠ The contract" : "## The contract", "");

  if (!result.contract) lines.push(`_No ${INTENT_FILE} that names a layer: nothing to hold the change against._`, "");
  else {
    for (const violation of result.violations.added) lines.push(`- would go against it: \`${violation.from}:${violation.line}\` imports \`${violation.to}\` — layer **${violation.fromLayer}** → **${violation.toLayer}** is not in ${INTENT_FILE}`);

    for (const violation of result.violations.removed) lines.push(`- would no longer go against it: \`${violation.from}\` imports \`${violation.to}\` (layer ${violation.fromLayer} → ${violation.toLayer})`);

    if (result.violations.added.length + result.violations.removed.length === 0) lines.push(`_No import would start or stop going against ${INTENT_FILE}._`);
    lines.push("");
  }

  const circles = [...circleLines(result.cycles.modules, "modules"), ...circleLines(result.cycles.layers, "layers")];
  const closes = result.findings.some((finding) => finding.includes("cycle") || finding.includes("circle"));
  lines.push(closes ? "## ⚠ Cycles" : "## Cycles", "", ...(circles.length > 0 ? circles.map((line) => `- ${line}`) : ["_No import cycle and no circle of layers would close or break._"]), "");

  if (diff.layerEdgesAdded.length > 0) lines.push("## New dependencies between layers", "", ...diff.layerEdgesAdded.map((edge) => `- **${edge.from} → ${edge.to}**${result.contract ? (edge.against ? ` — against ${INTENT_FILE}` : ` — allowed by ${INTENT_FILE}`) : ""}`), "");

  if (diff.layerEdgesRemoved.length > 0) lines.push("## Layer dependencies removed", "", ...diff.layerEdgesRemoved.map((edge) => `- ${edge.from} → ${edge.to}`), "");

  if (diagram.nodes.length > 0) lines.push("```mermaid", toMermaid(diagram).trimEnd(), "```", "");
  else lines.push(`_${diagram.reason}_`, "");
  lines.push(...changeSections(diff, "##"));

  return `${lines.join("\n").trimEnd()}\n`;
}
