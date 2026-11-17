// The blast radius of a change: everything that depends on a subject,
// walked backwards from it step by step. A module's dependents are the
// modules that import it or call into it (a call through a re-exporting
// index reaches it in one step); a function's, a class's or a method's
// are the functions that call it or pass it on as a value, a module's top
// level among them. Type-only imports count only when asked (`--types`).
// The dependents written in a test file are told apart: they are what
// would catch the change, the rest what it could break.
//
// Each subject has a risk score of 0–100 whose parts are shown, from what
// archdiff already knows — how many depend on it (30 points: one and a
// half each, full at 20), how many layers besides its own they lie in (20:
// full at 3), whether a test reaches it (20 when none does, 10 when one
// reaches it only through other code, 0 when one imports or calls it), the
// instability of its module (15 × I = Ce / (Ca + Ce), when something
// imports it) and its module's rank among the hotspots (15 for the module
// with the most calls in, down to 0 for the last, and 0 for a module no
// other module calls into). The score is a property
// of the code: it counts the dependents at any distance, whatever depth
// the picture goes to.
//
// The picture places its own shapes: the subject in the middle, what
// depends on it in a column per step to the right, the tests that reach
// it in a column on the left, every line the nearest way a dependent
// reaches the subject. A column keeps `PER_COLUMN` shapes and the picture
// `limit` dependents, the ones that carry the change furthest first; the
// rest of a column is one folded shape, and the Markdown lists them all.
//
// Pure functions of the analysis, in the views layer. Entry points:
// `impactOf` (the one function another reader needs: the dependents, the
// tests and the risk of one subject, as data), `impactView` (the picture
// of a subject, or of the files of a change), `isImpactSubject`.

import type { Analysis } from "./analyze.ts";
import { SIZE, type Impact, type ImpactDependent, type Lane, type Line, type PictureContent, type RiskPart, type Shape } from "./diagram.ts";
import { moduleOf, type Graph } from "./graph.ts";
import { fnNode, moduleNode, unplaced } from "./nodes.ts";
import { defaultDepth } from "./view-keys.ts";
import { isTestModule } from "./views-more.ts";
import { counted } from "./words.ts";

export type { Impact, ImpactData, ImpactDependent, RiskPart } from "./diagram.ts";

/** How far the dependents are listed without a depth: the view's own, as the table of kinds has it. */
export const IMPACT_DEPTH = defaultDepth("impact");

export interface ImpactOptions {
  /** How many steps from the subject the dependents are listed to (default `IMPACT_DEPTH`); the score counts them at any distance. */
  depth?: number;
  /** Count type-only imports as dependencies too. */
  types?: boolean;
}

/** The points of each part of the risk; together 100. */
const POINTS = { dependents: 30, layers: 20, tests: 20, instability: 15, hotspot: 15 } as const;

/** This many dependents, and this many layers besides the subject's own, give the part its full points. */
const FULL = { dependents: 20, layers: 3 } as const;

/** A score from here up is `high`, from the lower bound up `medium`. */
const LEVELS = { high: 67, medium: 34 } as const;

/** Who depends on whom, backwards, and what the risk reads of every module: built once per analysis and per `types`. */
interface Index {
  /** A module → the modules that import it or call into it. */
  moduleDependents: Map<string, Set<string>>;
  /** A declaration → the functions (or modules, for a call at a top level) that call it or pass it on. */
  callers: Map<string, Set<string>>;
  /** Ca, Ce and I of every module (as metrics.ts counts them). */
  coupling: Map<string, { ca: number; ce: number; instability: number }>;
  /** The modules as hotspots, the hottest first: by the calls into them from other modules, then by their lines. */
  hotspots: { id: string; callsIn: number; lines: number }[];
}

const indexes = new WeakMap<Analysis, Map<boolean, Index>>();

function indexOf(analysis: Analysis, types: boolean): Index {
  const known = indexes.get(analysis) ?? new Map<boolean, Index>();
  indexes.set(analysis, known);
  let index = known.get(types);

  if (!index) {
    index = buildIndex(analysis.graph, types);
    known.set(types, index);
  }

  return index;
}

function buildIndex(graph: Graph, types: boolean): Index {
  const moduleDependents = new Map<string, Set<string>>();
  const callers = new Map<string, Set<string>>();
  const imports = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  const callsIn = new Map<string, number>();
  const add = (map: Map<string, Set<string>>, key: string, value: string): void => void map.set(key, (map.get(key) ?? new Set<string>()).add(value));

  for (const dep of graph.deps) {
    if ((dep.typeOnly && !types) || dep.from === dep.to || !graph.modules.has(dep.to) || !graph.modules.has(dep.from)) continue;
    add(moduleDependents, dep.to, dep.from);
    add(imports, dep.from, dep.to);
    add(importers, dep.to, dep.from);
  }

  for (const call of graph.calls) {
    if (call.from === call.to) continue;
    const from = moduleOf(call.from);
    const to = moduleOf(call.to);

    if (from !== to) callsIn.set(to, (callsIn.get(to) ?? 0) + 1);

    // A type named as a value is no call that runs: counted with the types only.
    if (graph.nodes.get(call.to)?.kind === "type" && !types) continue;
    add(callers, call.to, call.from);

    if (from !== to) add(moduleDependents, to, from);
  }

  const coupling = new Map<string, { ca: number; ce: number; instability: number }>();

  for (const id of graph.modules.keys()) {
    const ca = importers.get(id)?.size ?? 0;
    const ce = imports.get(id)?.size ?? 0;
    coupling.set(id, { ca, ce, instability: ca + ce === 0 ? 0 : Math.round((ce / (ca + ce)) * 100) / 100 });
  }

  const hotspots = [...graph.modules.values()].map((module) => ({ id: module.id, callsIn: callsIn.get(module.id) ?? 0, lines: module.lines })).sort((a, b) => b.callsIn - a.callsIn || b.lines - a.lines || (a.id < b.id ? -1 : 1));

  return { moduleDependents, callers, coupling, hotspots };
}

/** What a subject names in the graph: a module, or a declaration with the nodes that are its own (a class with its members). */
type Subject = { kind: "module"; id: string; module: string; starts: string[] } | { kind: "fn" | "class" | "type"; id: string; module: string; starts: string[] };

function subjectOf(graph: Graph, id: string): Subject | null {
  if (graph.modules.has(id)) return { kind: "module", id, module: id, starts: [id] };
  const node = graph.nodes.get(id);

  if (!node) return null;

  // A class is called through its members: a caller of one is a caller of the class.
  return { kind: node.kind, id, module: node.module, starts: [id, ...[...graph.nodes.keys()].filter((other) => other.startsWith(`${id}.`))] };
}

/** Whether `id` names a module or a declaration of the analysis: what an impact can be asked of. */
export function isImpactSubject(analysis: Analysis, id: string): boolean {
  return subjectOf(analysis.graph, id) !== null;
}

/** Everything reached from `starts` against the lines, nearest first: its distance, and the one a step nearer it was reached through. */
function walkBack(dependentsOf: ReadonlyMap<string, ReadonlySet<string>>, starts: readonly string[]): Map<string, { distance: number; via: string }> {
  const found = new Map<string, { distance: number; via: string }>();
  const own = new Set(starts);
  let frontier = [...starts];

  for (let distance = 1; frontier.length > 0; distance++) {
    const next: string[] = [];

    for (const at of frontier) {
      for (const dependent of [...(dependentsOf.get(at) ?? [])].sort()) {
        if (own.has(dependent) || found.has(dependent)) continue;
        found.set(dependent, { distance, via: at });
        next.push(dependent);
      }
    }

    frontier = next;
  }

  return found;
}

/** The dependents of a subject at any distance, nearest first then by name; `via` names the subject itself for what reaches one of its members. */
function dependentsOf(graph: Graph, index: Index, subject: Subject): ImpactDependent[] {
  const own = new Set(subject.starts);
  const found = walkBack(subject.kind === "module" ? index.moduleDependents : index.callers, subject.starts);

  return [...found]
    .map(([id, { distance, via }]): ImpactDependent => ({ id, module: moduleOf(id), layer: graph.modules.get(moduleOf(id))?.layer ?? "", distance, via: own.has(via) ? subject.id : via, test: isTestModule(moduleOf(id)) }))
    .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
}

/** The risk of a subject from its dependents at any distance, its module's coupling and its module's place among the hotspots. */
function riskOf(graph: Graph, index: Index, subject: Subject, all: readonly ImpactDependent[]): Impact["risk"] {
  const what = subject.kind === "module" ? "module" : "function";
  const others = all.filter((dependent) => !dependent.test);
  const tests = all.filter((dependent) => dependent.test);
  const ownLayer = graph.modules.get(subject.module)?.layer ?? "";
  const layers = [...new Set(others.map((dependent) => dependent.layer))].filter((layer) => layer !== ownLayer).sort();
  const direct = others.filter((dependent) => dependent.distance === 1).length;
  const nearest = tests.length === 0 ? null : Math.min(...tests.map((test) => test.distance));
  const ofModule = subject.kind === "module" ? "" : " of its module";
  const { ca, ce, instability } = index.coupling.get(subject.module) ?? { ca: 0, ce: 0, instability: 0 };
  const rank = index.hotspots.findIndex((row) => row.id === subject.module) + 1;
  const hot = index.hotspots[rank - 1];
  const parts: RiskPart[] = [
    {
      part: "dependents",
      points: Math.round(POINTS.dependents * Math.min(1, others.length / FULL.dependents)),
      of: POINTS.dependents,
      fact: others.length === 0 ? `no ${what} depends on it` : `${counted(others.length, what)} ${others.length === 1 ? "depends" : "depend"} on it, ${direct} directly`,
    },
    {
      part: "layers",
      points: Math.round(POINTS.layers * Math.min(1, layers.length / FULL.layers)),
      of: POINTS.layers,
      fact: layers.length > 0 ? `they span ${counted(layers.length, "layer")} besides its own: ${layers.join(", ")}` : others.length === 0 ? "no dependent, so no layer but its own" : `all in its own layer (${ownLayer})`,
    },
    {
      part: "tests",
      points: isTestModule(subject.module) || nearest === 1 ? 0 : nearest === null ? POINTS.tests : POINTS.tests / 2,
      of: POINTS.tests,
      fact: isTestModule(subject.module) ? "a test file itself" : nearest === null ? "no test reaches it" : nearest === 1 ? `${counted(tests.filter((test) => test.distance === 1).length, "test")} ${subject.kind === "module" ? "import" : "call"}${tests.filter((test) => test.distance === 1).length === 1 ? "s" : ""} it directly` : `reached only through other code: the nearest test is ${nearest} steps away`,
    },
    {
      part: "instability",
      points: ca > 0 ? Math.round(POINTS.instability * instability) : 0,
      of: POINTS.instability,
      fact: ca > 0 ? `I = ${instability.toFixed(2)}${ofModule} (Ca ${ca}, Ce ${ce})` : `nothing imports ${subject.kind === "module" ? "it" : "its module"}: what it depends on puts no importer at risk`,
    },
    {
      part: "hotspot",
      // A module nothing calls into is no hotspot, wherever its lines place it among the others.
      points: index.hotspots.length > 1 && hot && hot.callsIn > 0 ? Math.round((POINTS.hotspot * (index.hotspots.length - rank)) / (index.hotspots.length - 1)) : 0,
      of: POINTS.hotspot,
      fact: !hot ? "not among the modules" : hot.callsIn === 0 ? `no other module calls into ${subject.kind === "module" ? "it" : "its module"}: no hotspot` : `rank ${rank} of ${index.hotspots.length} among the hotspots${ofModule} (${counted(hot.callsIn, "call")} in, ${counted(hot.lines, "line")})`,
    },
  ];
  const score = parts.reduce((sum, part) => sum + part.points, 0);

  return { score, level: score >= LEVELS.high ? "high" : score >= LEVELS.medium ? "medium" : "low", parts };
}

/**
 * The blast radius of one subject — a module (`src/x.ts`) or a declaration
 * (`src/x.ts#fn`, `src/x.ts#Class`, `src/x.ts#Class.method`) — as data:
 * what depends on it within `depth` steps (nearest first, each with its
 * distance, its layer, the one a step nearer it reaches the subject
 * through, and whether it is written in a test file), how many depend on
 * it at any distance, the layers they lie in, and the risk with its
 * parts. Null when the analysis has no such module or declaration.
 */
export function impactOf(analysis: Analysis, subject: string, options: ImpactOptions = {}): Impact | null {
  const { graph } = analysis;
  const found = subjectOf(graph, subject);

  if (!found) return null;
  const depth = options.depth ?? IMPACT_DEPTH;
  const index = indexOf(analysis, options.types === true);
  const all = dependentsOf(graph, index, found);
  const tests = all.filter((dependent) => dependent.test);

  return {
    subject,
    kind: found.kind,
    module: found.module,
    layer: graph.modules.get(found.module)?.layer ?? "",
    dependents: all.filter((dependent) => dependent.distance <= depth),
    total: { dependents: all.length - tests.length, tests: tests.length },
    layers: [...new Set(all.filter((dependent) => !dependent.test).map((dependent) => dependent.layer))].sort(),
    risk: riskOf(graph, index, found, all),
  };
}

/** The heat of a dependent one step away; a dependent `n` steps away has an `n`th of it. */
const NEAREST_HEAT = 0.6;

/** A column of the picture keeps this many shapes; the rest of it is one folded shape. */
const PER_COLUMN = 10;

/** The grid the picture is placed on: a column's width with the room for the lines between two, a row's height, the room above a column for its lane's label. */
const GRID = { column: 300, row: 80, top: 44, pad: 20 } as const;

/** One column of the picture: the tests, the subjects, or the dependents a number of steps away. */
interface Column {
  lane: string;
  label: string;
  shapes: Shape[];
}

/** The shape of a dependent or a subject: a module's box, or a function's; a call at a module's top level comes from the module. */
function shapeOf(graph: Graph, id: string, second: string): Shape {
  if (graph.nodes.has(id)) return { ...fnNode(graph, id), label: `${fnNode(graph, id).label}\n${second}` };

  return { ...moduleNode(graph, id), label: `${id}\n${second}` };
}

/**
 * The picture of a blast radius: of one subject, or (`change`) of every
 * file changed since a base, each a subject. Placed here, not by `layout`:
 * the subjects in the middle column, the dependents in a column per step
 * to the right, the tests that reach a subject in a column on the left;
 * every line is the nearest way a dependent reaches a subject, and runs
 * between two neighbouring columns.
 */
export function impactView(analysis: Analysis, subject: string | null, options: { depth: number; limit: number; types: boolean }, change?: { files: readonly string[]; since: string }): PictureContent {
  const { graph } = analysis;
  const { depth, limit, types } = options;

  if (subject === null && !change) return unplaced("Impact", [], [], [], { placed: true, reason: "the impact of a change is read from git: the files changed since the base (archdiff impact --changed, or the page)" });
  const asked = subject !== null ? [subject] : change!.files.filter((file) => graph.modules.has(file));

  if (subject !== null && !subjectOf(graph, subject)) return unplaced(subject, [], [], [], { reason: `no module or function "${subject}"`, missing: true });
  // The riskiest first: a change of many files is read from its most dangerous one.
  const impacts = asked.map((id) => impactOf(analysis, id, { depth, types })!).sort((a, b) => b.risk.score - a.risk.score || (a.subject < b.subject ? -1 : 1));
  const title = subject !== null ? `Impact of ${nameOf(graph, subject)}` : `Impact of ${counted(impacts.length, "file")} changed since ${change!.since}`;
  const data = { depth, ...(change ? { since: change.since } : {}), subjects: impacts };

  if (impacts.length === 0) {
    const gone = change!.files.length;

    return unplaced(title, [], [], [], { placed: true, impact: data, reason: gone === 0 ? `no source file changed since ${change!.since}` : `the ${counted(gone, "file")} changed since ${change!.since} ${gone === 1 ? "is no module" : "are no modules"} of the code (deleted)` });
  }

  // Every dependent once, from the subject it is nearest to: the union of the subjects' blast radii.
  const subjects = new Set(impacts.map((impact) => impact.subject));
  const nearest = new Map<string, ImpactDependent & { subject: string }>();

  for (const impact of impacts) {
    for (const dependent of impact.dependents) {
      const known = nearest.get(dependent.id);

      if (subjects.has(dependent.id) || (known && known.distance <= dependent.distance)) continue;
      nearest.set(dependent.id, { ...dependent, subject: impact.subject });
    }
  }

  const all = [...nearest.values()];
  // How many a dependent carries the change on to: the ones kept first when a column is cut.
  const carries = new Map<string, number>();

  for (const dependent of all) carries.set(dependent.via, (carries.get(dependent.via) ?? 0) + 1);
  const byWeight = (a: { id: string }, b: { id: string }): number => (carries.get(b.id) ?? 0) - (carries.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1);
  const columns: Column[] = [];
  const drawn = new Map<string, Shape>();
  const foldOf = new Map<string, Shape>();
  /** The shape a line to `id` lands on: its own, or the folded shape of its column. */
  const landing = (id: string): Shape | undefined => drawn.get(id) ?? foldOf.get(id);

  const column = (lane: string, label: (count: number) => string, members: readonly { id: string }[], budget: number, draw: (id: string) => Shape): void => {
    if (members.length === 0) return;
    const kept = members.slice(0, Math.max(1, Math.min(PER_COLUMN, budget)));
    const folded = members.slice(kept.length);
    const shapes = kept.map((member): Shape => ({ ...draw(member.id), group: lane }));

    for (const shape of shapes) drawn.set(shape.id, shape);

    if (folded.length > 0) {
      const more: Shape = { id: `more:${lane}`, kind: "more", label: `… ${folded.length} more`, count: folded.length, members: folded.map((member) => member.id), group: lane, x: 0, y: 0, w: 0, h: 0 };
      shapes.push(more);

      for (const member of folded) foldOf.set(member.id, more);
    }

    columns.push({ lane, label: label(members.length), shapes });
  };

  // What reaches a subject only through a test file is on the tests' side with it: test code, or code only the tests use.
  const testSide = new Set<string>();

  for (const dependent of [...all].sort((a, b) => a.distance - b.distance)) if (dependent.test || testSide.has(dependent.via)) testSide.add(dependent.id);
  const tests = all.filter((dependent) => testSide.has(dependent.id)).sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
  column("tests", (count) => `tests that reach ${impacts.length === 1 ? "it" : "them"} (${count})`, tests, PER_COLUMN, (id) => {
    const test = nearest.get(id)!;

    return shapeOf(graph, id, `${test.test ? "test" : "through a test"}${test.distance > 1 ? ` · ${test.distance} steps` : ""}`);
  });
  column("d00", (count) => (subject !== null ? "the subject" : `changed since ${change!.since} (${count})`), impacts.map((impact) => ({ id: impact.subject })), PER_COLUMN, (id) => {
    const impact = impacts.find((candidate) => candidate.subject === id)!;
    const untested = impact.total.tests === 0 && !isTestModule(impact.module);
    const shape = shapeOf(graph, id, `risk ${impact.risk.score} · ${impact.risk.level}${untested ? "\nno test reaches it" : ""}`);

    return untested ? { ...shape, diff: "warning" } : shape;
  });
  let budget = limit;

  for (let distance = 1; distance <= depth; distance++) {
    const members = all.filter((dependent) => !testSide.has(dependent.id) && dependent.distance === distance).sort(byWeight);
    column(`d${String(distance).padStart(2, "0")}`, (count) => `${counted(distance, "step")} away (${count})`, members, budget, (id) => {
      const dependent = nearest.get(id)!;

      // The nearer, the hotter: the fill fades with the distance, and stays light enough to read the label on.
      return { ...shapeOf(graph, id, graph.nodes.has(id) ? dependent.module : subject !== null && subject.includes("#") ? "(top level)" : dependent.layer), heat: NEAREST_HEAT / distance };
    });
    budget -= Math.min(members.length, PER_COLUMN, Math.max(1, budget));
  }

  const { nodes, groups, columnOf } = place(columns);
  const edges = linesOf(graph, nodes, columnOf, impacts, nearest, landing, testSide);
  const beyond = impacts.reduce((sum, impact) => sum + impact.total.dependents + impact.total.tests - impact.dependents.length, 0);
  const first = impacts[0]!;
  const notes = [
    subject !== null ? `risk ${first.risk.score} of 100 (${first.risk.level})` : `the riskiest: ${first.subject}, ${first.risk.score} of 100 (${first.risk.level})`,
    `${counted(all.length - tests.length, "dependent")} within ${counted(depth, "step")}${tests.length > 0 ? `, ${counted(tests.length, "test")} that ${tests.length === 1 ? "reaches" : "reach"} ${impacts.length === 1 ? "it" : "them"}` : ""}`,
    beyond > 0 && subject !== null ? `${beyond} more beyond (--depth goes further)` : "",
    foldOf.size > 0 ? `${foldOf.size} folded: a column keeps ${PER_COLUMN} and the picture ${limit} (--limit raises it); the Markdown lists them all` : "",
    change && change.files.length > impacts.length ? `${counted(change.files.length - impacts.length, "changed file")} no module of the code (deleted)` : "",
  ];

  return unplaced(title, nodes, edges, groups, { placed: true, impact: data, reason: notes.filter(Boolean).join("; ") });
}

/** A subject as a title names it: a module by its path, a declaration by its name and its module. */
function nameOf(graph: Graph, id: string): string {
  const node = graph.nodes.get(id);

  return node ? `${node.parent ? `${node.parent}.` : ""}${node.name} (${node.module})` : id;
}

/** The columns placed left to right, each centred on the tallest, with a lane around each; `columnOf` says which column a shape stands in. */
function place(columns: readonly Column[]): { nodes: Shape[]; groups: Lane[]; columnOf: Map<string, number> } {
  const rows = Math.max(...columns.map((column) => column.shapes.length));
  const height = GRID.top + rows * GRID.row + GRID.pad;
  const nodes: Shape[] = [];
  const groups: Lane[] = [];
  const columnOf = new Map<string, number>();

  columns.forEach((column, at) => {
    const left = at * GRID.column;
    const box = SIZE.module;
    const top = GRID.top + ((rows - column.shapes.length) * GRID.row) / 2;
    groups.push({ id: column.lane, label: column.label, kind: "lane", x: left, y: 0, w: box.w + 2 * GRID.pad, h: height });
    column.shapes.forEach((shape, row) => {
      const size = SIZE[shape.kind];
      nodes.push({ ...shape, x: left + GRID.pad + (box.w - size.w) / 2, y: top + row * GRID.row + (GRID.row - GRID.pad - size.h) / 2, w: size.w, h: size.h });
      columnOf.set(shape.id, at);
    });
  });

  return { nodes, groups, columnOf };
}

/** A line that leaves a shape on the row of another line's target leaves this far above the middle, so the two do not run as one. */
const ASIDE = 10;

/**
 * The lines of the picture, each with its own route: a dependent to the
 * one a step nearer a subject (the import or the call it reaches it by) —
 * for every subject it reaches by a nearest way, so each file of a change
 * shows what lands on it — what is on the tests' side to every subject it
 * reaches (its shape says in how many steps, when through other code), a
 * folded shape to everything its members reach. A line leaves the side
 * that faces the subjects, turns in the room between the two columns —
 * each target has a channel of its own there — and lands on the target's
 * facing side.
 */
function linesOf(graph: Graph, nodes: readonly Shape[], columnOf: ReadonlyMap<string, number>, impacts: readonly Impact[], nearest: ReadonlyMap<string, ImpactDependent>, landing: (id: string) => Shape | undefined, testSide: ReadonlySet<string>): Line[] {
  const placed = new Map(nodes.map((node) => [node.id, node]));
  const runs = new Set<string>();
  const typed = new Set<string>();

  for (const dep of graph.deps) (dep.typeOnly ? typed : runs).add(`${dep.from}\u0000${dep.to}`);
  const lines = new Map<string, Line & { ends: [Shape, Shape] }>();

  for (const impact of impacts) {
    for (const dependent of impact.dependents) {
      const drawn = nearest.get(dependent.id);

      // A subject is no dependent here; a longer way to this subject would run past the column of the nearest one.
      if (!drawn || (!testSide.has(dependent.id) && (dependent.distance !== drawn.distance || testSide.has(dependent.via)))) continue;
      const from = landing(dependent.id);
      // The tests' column lies beside the subjects': what stands in it lands on the subject it reaches, whatever it reaches it through.
      const to = landing(testSide.has(dependent.id) ? impact.subject : dependent.via);

      if (!from || !to || from.id === to.id) continue;
      const key = `${from.id}\u0000${to.id}`;

      if (lines.has(key)) continue;
      const whole = from.kind !== "more" && to.kind !== "more";
      const direct = !testSide.has(dependent.id) || dependent.distance === 1;
      const pair = `${dependent.id}\u0000${dependent.via}`;
      // The line is the import when there is one, else the call that reaches it (through a re-exporting index, or between functions).
      const kind: Line["kind"] = whole && direct && !runs.has(pair) && !typed.has(pair) ? "call" : "dependency";
      lines.set(key, { from: from.id, to: to.id, kind, ...(whole && direct && kind === "dependency" && !runs.has(pair) ? { typeOnly: true as const } : {}), ends: [placed.get(from.id)!, placed.get(to.id)!] });
    }
  }

  // A channel per target in the room between two columns, so the lines to two targets do not run as one.
  const targetsOf = new Map<number, Shape[]>();
  const gapOf = (from: Shape, to: Shape): number => Math.min(columnOf.get(from.id)!, columnOf.get(to.id)!);

  for (const { ends } of lines.values()) {
    const known = targetsOf.get(gapOf(...ends)) ?? [];

    if (!known.includes(ends[1])) targetsOf.set(gapOf(...ends), [...known, ends[1]].sort((a, b) => a.y - b.y));
  }

  return [...lines.values()].map(({ ends: [from, to], ...line }): Line => {
    const rightward = from.x < to.x;
    const targets = targetsOf.get(gapOf(from, to))!;
    const middle = from.y + from.h / 2;
    const end = { x: rightward ? to.x : to.x + to.w, y: to.y + to.h / 2 };

    if (middle === end.y) return { ...line, route: [{ x: rightward ? from.x + from.w : from.x, y: middle }, end] };
    // Another target on this row: its line ends where this one would start.
    const start = { x: rightward ? from.x + from.w : from.x, y: targets.some((other) => other !== to && other.y + other.h / 2 === middle) ? middle - ASIDE : middle };
    const channel = Math.round(Math.min(start.x, end.x) + (Math.abs(end.x - start.x) * (targets.indexOf(to) + 1)) / (targets.length + 1));

    return { ...line, route: [start, { x: channel, y: start.y }, { x: channel, y: end.y }, end] };
  });
}
