// Impact: what a change to a module or a function reaches. Who imports
// the module, and who imports those; who calls the function, and who
// calls them — breadth-first up the imports and the calls, every
// dependent once, at its shortest distance — and the test files among
// them, which are the tests to run after the change. The list stops at a
// depth and counts what lies beyond it; the tests are looked for all the
// way up, since a test that reaches the subject through ten imports runs
// it as surely as one that imports it.
//
// A module's dependents are its importers (an import of types only and a
// file loaded by URL are told apart) and the callers of its functions from
// other modules; a function's or a class's are its callers (a class's: of
// its members too); a type has no callers, it flows by imports, so its
// module's importers stand for it. A call archdiff could not follow (a
// gap) is in no list: the coverage report has those.
//
// Pure: a function of the graph. Entry points: `impactOf`,
// `impactMarkdown`, `Impact`, `Dependent`, `TestReach`,
// `DEFAULT_IMPACT_DEPTH`.

import { moduleOf, type Declaration, type Graph } from "./graph.ts";
import { isTestModule } from "./views-more.ts";
import { counted } from "./words.ts";

/** How far up the imports and the calls the lists go when no depth is asked for. */
export const DEFAULT_IMPACT_DEPTH = 3;

/** How a dependent hangs on what it depends on: an import, an import of types only, a file loaded by URL, a call, a function passed as a value. */
type How = "imports" | "types" | "loads" | "calls" | "refers";

/** One dependent of the subject: who, how many steps away, and the import or the call that makes it one. */
export interface Dependent {
  /** A module, or a function (a module's own ID for a call at its top level). */
  id: string;
  /** Steps from the subject: 1 imports or calls the subject itself. */
  distance: number;
  /** What it imports or calls: the subject (or a function of it), or the dependent one step nearer. */
  of: string;
  how: How;
  /** The line of the import or the call in the dependent's file. */
  line: number;
}

/** A test file that reaches the subject: by a chain of calls archdiff followed, else by a chain of imports. */
export interface TestReach {
  id: string;
  by: "calls" | "imports";
  distance: number;
}

export interface Impact {
  /** The module's path, or the declaration's ID (`<path>#<name>`). */
  subject: string;
  kind: "module" | Declaration["kind"];
  /** The module the subject is, or sits in. */
  module: string;
  layer: string;
  /** The line of a declaration; absent for a module. */
  line?: number;
  depth: number;
  /** The modules importing the subject's module, up to `depth`: a module's and a type's; empty for a function or a class. */
  importers: Dependent[];
  /** The functions calling the subject (a module's: its functions, from other modules), up to `depth`. */
  callers: Dependent[];
  /** How many dependents lie further than `depth`. */
  beyond: { importers: number; callers: number };
  /** Every test file that reaches the subject, however far. */
  tests: TestReach[];
}

/** An edge read backwards: who points at a node, how and where. */
interface Inward {
  from: string;
  how: How;
  line: number;
}

/** Every dependent of the start set, nearest first: breadth-first up the inward edges, each dependent once, at its shortest distance. */
function walkUp(start: ReadonlySet<string>, inward: ReadonlyMap<string, readonly Inward[]>): Dependent[] {
  const seen = new Set(start);
  const found: Dependent[] = [];
  let frontier = [...start];

  for (let distance = 1; frontier.length > 0; distance++) {
    const next: string[] = [];

    for (const id of frontier) {
      for (const edge of inward.get(id) ?? []) {
        if (seen.has(edge.from)) continue;
        seen.add(edge.from);
        found.push({ id: edge.from, distance, of: id, how: edge.how, line: edge.line });
        next.push(edge.from);
      }
    }

    frontier = next;
  }

  return found;
}

/** Who imports each module: one edge per pair of modules, an import of a value before one of types only. */
function importsInto(graph: Graph): Map<string, Inward[]> {
  const pairs = new Map<string, Inward & { to: string }>();

  for (const dep of graph.deps) {
    if (!graph.modules.has(dep.to) || dep.from === dep.to) continue;
    const key = `${dep.from}\u0000${dep.to}`;
    const how: How = dep.url ? "loads" : dep.typeOnly ? "types" : "imports";
    const known = pairs.get(key);

    if (!known || (known.how === "types" && how !== "types")) pairs.set(key, { from: dep.from, to: dep.to, how, line: dep.line });
  }

  const inward = new Map<string, Inward[]>();

  for (const { to, ...edge } of pairs.values()) inward.set(to, [...(inward.get(to) ?? []), edge]);

  return inward;
}

/** Who calls each function, or passes it as a value: one edge per pair, a call before a reference. */
function callsInto(graph: Graph): Map<string, Inward[]> {
  const pairs = new Map<string, Inward & { to: string }>();

  for (const call of graph.calls) {
    if (call.from === call.to) continue;
    const key = `${call.from}\u0000${call.to}`;
    const how: How = call.kind === "call" ? "calls" : "refers";
    const known = pairs.get(key);

    if (!known || (known.how === "refers" && how === "calls")) pairs.set(key, { from: call.from, to: call.to, how, line: call.line });
  }

  const inward = new Map<string, Inward[]>();

  for (const { to, ...edge } of pairs.values()) inward.set(to, [...(inward.get(to) ?? []), edge]);

  return inward;
}

/** Nearest first, then by name: the order of every list. */
function byDistance<T extends { id: string; distance: number }>(a: T, b: T): number {
  return a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The impact of changing `subject` — a module (its path) or a declaration (`<path>#<name>`) — listed up to `depth`
 * steps away; null when the graph has neither.
 */
export function impactOf(graph: Graph, subject: string, depth: number = DEFAULT_IMPACT_DEPTH): Impact | null {
  const node = graph.nodes.get(subject);
  const module = graph.modules.get(node ? node.module : subject);

  if (!module) return null;
  const kind = node ? node.kind : "module";
  // A module is changed through any of its declarations; a class through its members too. The module's own ID is in
  // the start set so that a call it makes to itself at its top level is no caller.
  const members = [...graph.nodes.values()].filter((candidate) => (node ? candidate.id === node.id || (node.kind === "class" && candidate.module === node.module && candidate.parent === node.name) : candidate.module === module.id));
  const called = kind === "type" ? [] : walkUp(new Set([...members.map((member) => member.id), ...(node ? [] : [module.id])]), callsInto(graph));
  const imported = walkUp(new Set([module.id]), importsInto(graph));
  // A function is reached by calls; the importers of its module are not its dependents, though a test among them may
  // still run it through a call archdiff could not follow.
  const importers = kind === "module" || kind === "type" ? imported : [];
  const tests = new Map<string, TestReach>();

  for (const caller of called) {
    const test = moduleOf(caller.id);

    if (isTestModule(test) && !tests.has(test)) tests.set(test, { id: test, by: "calls", distance: caller.distance });
  }

  for (const importer of imported) if (isTestModule(importer.id) && !tests.has(importer.id)) tests.set(importer.id, { id: importer.id, by: "imports", distance: importer.distance });
  const within = (dependent: Dependent): boolean => dependent.distance <= depth;
  const impact: Impact = {
    subject,
    kind,
    module: module.id,
    layer: module.layer,
    depth,
    importers: importers.filter(within).sort(byDistance),
    callers: called.filter(within).sort(byDistance),
    beyond: { importers: importers.filter((dependent) => !within(dependent)).length, callers: called.filter((dependent) => !within(dependent)).length },
    tests: [...tests.values()].sort(byDistance),
  };

  return node ? { ...impact, line: node.line } : impact;
}

function steps(distance: number): string {
  return counted(distance, "step");
}

const VERBS: Record<How, string> = { imports: "imports", types: "imports the types of", loads: "loads", calls: "calls", refers: "passes on" };

/** The dependents of one list (nearest first) under a line per distance, each with what it imports or calls and where; `subject` is said as `it`. */
function dependentLines(dependents: readonly Dependent[], subject: string, it: string): string[] {
  const lines: string[] = [];
  let distance = 0;

  for (const dependent of dependents) {
    if (dependent.distance !== distance) {
      distance = dependent.distance;
      lines.push(...(lines.length > 0 ? [""] : []), `${steps(distance)} away:`, "");
    }

    // A call at a module's top level is the module's own.
    const who = (dependent.how === "calls" || dependent.how === "refers") && !dependent.id.includes("#") ? `\`${dependent.id}\` (its top level)` : `\`${dependent.id}\``;
    lines.push(`- ${who} ${VERBS[dependent.how]} ${dependent.of === subject ? it : `\`${dependent.of}\``} — ${moduleOf(dependent.id)}:${dependent.line}`);
  }

  return lines;
}

/** The impact as Markdown: what the subject is, the importers and the callers by distance, the tests to run. */
export function impactMarkdown(impact: Impact): string {
  const lines = [`<!-- archdiff:generated — impact of ${impact.subject} -->`, `# Impact of ${impact.subject}`, ""];
  const what = impact.kind === "module" ? `A module of the layer **${impact.layer}**` : `A ${impact.kind === "fn" ? "function" : impact.kind} of \`${impact.module}\` (layer **${impact.layer}**), ${impact.module}:${impact.line}`;
  const reached = [...(impact.kind === "module" || impact.kind === "type" ? [counted(impact.importers.length, "importer")] : []), ...(impact.kind === "type" ? [] : [`${counted(impact.callers.length, "caller")} in ${counted(new Set(impact.callers.map((caller) => moduleOf(caller.id))).size, "module")}`])];
  lines.push(`${what}. Within ${steps(impact.depth)}: ${reached.join(", ")}; ${counted(impact.tests.length, "test file")} ${impact.tests.length === 1 ? "reaches" : "reach"} it.`, "");

  if (impact.kind === "module" || impact.kind === "type") {
    lines.push(`## Importers${impact.kind === "type" ? " of its module" : ""} (${impact.importers.length})`, "");
    lines.push(...(impact.importers.length > 0 ? dependentLines(impact.importers, impact.module, impact.kind === "module" ? "it" : "its module") : ["_no module imports it_"]), "");

    if (impact.beyond.importers > 0) lines.push(`… ${impact.beyond.importers} more further than ${steps(impact.depth)} away (a deeper depth lists them).`, "");
  }

  if (impact.kind === "type") {
    lines.push(`A type has no callers: it flows through signatures (the view \`type:${impact.subject}\` draws where).`, "");
  } else {
    lines.push(`## Callers${impact.kind === "module" ? " of its functions, from other modules" : ""} (${impact.callers.length})`, "");
    lines.push(...(impact.callers.length > 0 ? dependentLines(impact.callers, impact.subject, "it") : ["_no call of it that archdiff could follow_"]), "");

    if (impact.beyond.callers > 0) lines.push(`… ${impact.beyond.callers} more further than ${steps(impact.depth)} away (a deeper depth lists them).`, "");
  }

  lines.push(`## Tests that reach it (${impact.tests.length})`, "");

  if (impact.tests.length === 0) lines.push("_no test file calls it or imports its module, however far: no test archdiff can see covers a change here_", "");
  else lines.push(...impact.tests.map((test) => `- \`${test.id}\` — ${test.by === "calls" ? "calls it" : `imports ${impact.kind === "module" ? "it" : "its module"}`}, ${steps(test.distance)} away`), "");
  lines.push("A call archdiff could not follow (a computed callee, a value of an unknown type) is in no list above: the `coverage` view names those.");

  return `${lines.join("\n")}\n`;
}
