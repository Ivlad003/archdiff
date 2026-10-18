// State machines found in the code: the explicit ones a library declares
// (XState's `createMachine`, javascript-state-machine, Python's
// `transitions` — read by control.ts into `FileFacts.machines`) and the
// implicit ones written with literals — a field or variable that is set
// to two or more literal states and compared or switched on
// (`FileFacts.states`): its states are the literals, its transitions the
// assignments under a `case` or an `if` on the same field (`case "new":
// order.status = "paid"` is new → paid, in `pay`), an assignment under no
// such guard comes from any state, and a union type naming the states
// declares the ones the code never sets. Two views: `machines` lists
// them, `machine:<path>#<name>` draws one as states and transitions
// (Mermaid: a stateDiagram-v2).
//
// Pure functions of the analysis. Entry points: `machinesOf`,
// `machinesView`, `machineView`, `Machine`.

import type { Analysis } from "./analyze.ts";
import type { PictureContent, Line, Shape, MachineData } from "./diagram.ts";
import { lane, unplaced } from "./nodes.ts";

export interface Machine extends MachineData {
  /** `machine:<path>#<name>`, the view key. */
  id: string;
  kind: "explicit" | "implicit";
  /** The library of an explicit machine. */
  library?: string;
  line: number;
  /** How many places read the state (compare it, switch on it): an implicit machine with none is a value, not a machine. */
  reads: number;
}

/** The literal states a type alias declares: `type Status = "new" | "paid"` → new, paid; empty for any other type. */
function unionLiterals(signature: string | null): string[] {
  if (!signature || !signature.startsWith("=") || !signature.includes("|")) return [];
  const literals = [...signature.matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2] ?? "");

  return literals.filter((value) => value !== "");
}

/** The name a subject is shown by: `this.state` → `state`. */
function displayName(subject: string): string {
  return subject.replace(/^this\./, "");
}

/** Every machine of the repository, explicit first, by module then name. */
export function machinesOf(analysis: Analysis): Machine[] {
  const { facts, graph } = analysis;
  const machines: Machine[] = [];

  for (const file of [...facts.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    for (const fact of file.machines ?? []) {
      const states = fact.states.map((name) => ({ name, declared: true, assigned: true }));
      machines.push({ id: `machine:${file.path}#${fact.name}`, name: fact.name, module: file.path, kind: "explicit", library: fact.library, initial: fact.initial ?? null, states, transitions: fact.transitions.map((transition) => ({ from: transition.from, to: transition.to, event: transition.event, line: fact.line })), line: fact.line, reads: 0 });
    }

    // Implicit: the facts of one subject, `this.status` and `status` alike.
    const bySubject = new Map<string, NonNullable<typeof file.states>>();

    for (const fact of file.states ?? []) bySubject.set(displayName(fact.subject), [...(bySubject.get(displayName(fact.subject)) ?? []), fact]);

    for (const [name, list] of [...bySubject].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const assigns = list.filter((fact) => fact.kind === "assign" && !fact.initial);
      const reads = list.filter((fact) => fact.kind !== "assign").length;
      const values = new Set(list.map((fact) => fact.value));

      // A machine: set to a literal somewhere other than its declaration, read as one somewhere, two or more states in all.
      if (assigns.length === 0 || reads === 0 || values.size < 2) continue;
      // A type alias of the module declaring the states: named like the subject, or a union holding most of the values seen.
      const declared = new Set<string>();

      for (const node of graph.nodes.values()) {
        if (node.module !== file.path || node.kind !== "type") continue;
        const literals = unionLiterals(node.signature);
        const shared = literals.filter((value) => values.has(value)).length;

        if (literals.length >= 2 && (node.name.toLowerCase().includes(name.toLowerCase()) || shared * 2 >= values.size)) for (const value of literals) declared.add(value);
      }

      // What tells a machine from a field that merely takes literals: a transition from a known state (an assignment under a
      // case or an if on the field), or a type declaring the states with the field set in two or more places.
      const guarded = assigns.some((fact) => fact.under !== undefined);

      if (!guarded && !(declared.size >= 2 && assigns.length >= 2)) continue;

      const assigned = new Set(list.filter((fact) => fact.kind === "assign").map((fact) => fact.value));
      const names = [...new Set([...values, ...declared])];
      const states = names.map((value) => ({ name: value, declared: declared.has(value), assigned: assigned.has(value) }));
      const transitions: Machine["transitions"] = [];
      const seen = new Set<string>();

      for (const fact of assigns) {
        for (const from of fact.under ?? ["*"]) {
          const key = `${from}\u0000${fact.value}\u0000${fact.within ?? ""}`;

          if (seen.has(key)) continue;
          seen.add(key);
          const transition: Machine["transitions"][number] = { from, to: fact.value, line: fact.line };

          if (fact.within) transition.fn = fact.within;
          transitions.push(transition);
        }
      }

      const initial = list.find((fact) => fact.kind === "assign" && fact.initial)?.value ?? null;
      const first = list[0]!;
      machines.push({ id: `machine:${file.path}#${name}`, name, module: file.path, kind: "implicit", initial, states, transitions, line: first.line, reads });
    }
  }

  return machines;
}

/** Every machine as a shape in its module's lane; a tap opens it. */
export function machinesView(analysis: Analysis): PictureContent {
  const machines = machinesOf(analysis);

  if (machines.length === 0) return unplaced("State machines", [], [], [], { reason: "no state machine: no field or variable set to two or more literal states and read as one, and no createMachine / StateMachine / Machine(…)" });
  const nodes: Shape[] = machines.map((machine) => ({ id: machine.id, kind: "machine", label: `${machine.name}\n${machine.states.length} states · ${machine.transitions.length} transitions${machine.kind === "explicit" ? ` · ${machine.library}` : ""}`, opens: machine.id, ref: { file: machine.module, line: machine.line }, group: machine.module, x: 0, y: 0, w: 0, h: 0 }));
  const explicit = machines.filter((machine) => machine.kind === "explicit").length;

  return unplaced(`State machines (${machines.length})`, nodes, [], [...new Set(machines.map((machine) => machine.module))].map(lane), { reason: `${explicit} declared by a library, ${machines.length - explicit} written with literals; tap one to see its states and transitions` });
}

/** One machine: a start mark, its states (dashed when declared but never set), its transitions labelled with the event or the function that makes them. */
export function machineView(analysis: Analysis, id: string): PictureContent {
  const key = `machine:${id}`;
  const machine = machinesOf(analysis).find((candidate) => candidate.id === key);

  if (!machine) return unplaced(id, [], [], [], { reason: `no state machine "${id}" (archdiff diagram machines lists them)`, missing: true });
  const stateId = (name: string): string => `state:${name}`;
  const nodes: Shape[] = [];
  const edges: Line[] = [];

  if (machine.initial !== null) {
    nodes.push({ id: "start", kind: "start", label: "", x: 0, y: 0, w: 0, h: 0 });
    edges.push({ from: "start", to: stateId(machine.initial), kind: "call" });
  }

  for (const state of machine.states) {
    const node: Shape = { id: stateId(state.name), kind: "state", label: state.assigned || machine.kind === "explicit" ? state.name : `${state.name}\n${state.declared ? "declared, never set" : "read, never set"}`, ref: { file: machine.module, line: machine.line }, x: 0, y: 0, w: 0, h: 0 };

    if (!state.assigned && machine.kind === "implicit") node.diff = "planned";
    nodes.push(node);
  }

  if (machine.transitions.some((transition) => transition.from === "*")) nodes.push({ id: stateId("*"), kind: "state", label: "any state", ref: { file: machine.module, line: machine.line }, x: 0, y: 0, w: 0, h: 0 });
  const seen = new Set<string>();

  for (const transition of machine.transitions) {
    const label = transition.event ?? transition.fn ?? "";
    const pairKey = `${transition.from}\u0000${transition.to}\u0000${label}`;

    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    const edge: Line = { from: stateId(transition.from), to: stateId(transition.to), kind: "call" };

    if (label) edge.label = label;
    edges.push(edge);
  }

  const unset = machine.states.filter((state) => !state.assigned).length;
  const fromAny = machine.transitions.filter((transition) => transition.from === "*").length;
  const notes = [machine.kind === "explicit" ? `declared with ${machine.library}` : `written with literals in ${machine.module}: states from assignments, comparisons${machine.states.some((state) => state.declared) ? " and the type" : ""}`, unset > 0 ? `${unset} states never set (dashed)` : "", fromAny > 0 ? `${fromAny} transitions from any state: set outside a case or an if on ${machine.name}` : ""].filter(Boolean);
  const data: MachineData = { name: machine.name, module: machine.module, initial: machine.initial, states: machine.states, transitions: machine.transitions };

  return unplaced(`State machine ${machine.name} (${machine.module})`, nodes, edges, [], { machine: data, reason: notes.join("; ") });
}
