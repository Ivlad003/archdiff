// The cycles of a repository: modules importing each other in a circle
// (`cycles`, `cycle:<path>`), functions calling each other in a circle
// across modules (`cycles:fns`, `cycle:<path>#<fn>`), layers importing
// each other (a lane of the `cycles` picture), and where to cut: for every
// cycle the smallest set of lines whose removal breaks it (the minimum
// feedback arc set, exact for small cycles, a greedy order for big ones),
// drawn red and dashed with their weight. Type-only imports count only
// when asked (`--types`) and are drawn dashed.
//
// Pure functions of the graph, on scc.ts. Entry points: `cyclesView`,
// `feedbackArcSet`.

import type { PictureContent, Line, Shape } from "./diagram.ts";
import { moduleOf, type Graph } from "./graph.ts";
import { fnNode, lane, moduleNode, unplaced } from "./nodes.ts";
import { stronglyConnected } from "./scc.ts";

export interface CycleOptions {
  /** Count type-only imports too. */
  types?: boolean;
  /** Cycles of functions (calls) rather than of modules (imports). */
  fns?: boolean;
}

/** A weighted line of a cycle: how many imports or calls it stands for. */
export interface WeightedEdge {
  from: string;
  to: string;
  weight: number;
}

const key = (edge: { from: string; to: string }): string => `${edge.from}\u0000${edge.to}`;

/** Whether the edges form a cycle among `nodes`. */
function hasCycle(nodes: readonly string[], edges: readonly WeightedEdge[]): boolean {
  const out = new Map<string, string[]>();

  for (const edge of edges) out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
  const state = new Map<string, "open" | "done">();

  for (const start of nodes) {
    if (state.has(start)) continue;
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    state.set(start, "open");

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const targets = out.get(top.id) ?? [];

      if (top.next < targets.length) {
        const next = targets[top.next++]!;
        const seen = state.get(next);

        if (seen === "open") return true;

        if (!seen) {
          state.set(next, "open");
          stack.push({ id: next, next: 0 });
        }
      } else {
        state.set(top.id, "done");
        stack.pop();
      }
    }
  }

  return false;
}

/** How many edges an exact search tries subsets of; beyond it the greedy order decides. */
const EXACT_EDGES = 14;

/**
 * The lines to remove so that no cycle remains: the fewest lines, and among
 * those the lightest (an import written once is cut before one written in
 * five files). Exact — every subset by size — up to `EXACT_EDGES` lines;
 * else the order of Eades, Lin and Smyth (sinks last, sources first, then
 * the node with the largest out − in weight) and the lines that go against
 * it.
 */
export function feedbackArcSet(nodes: readonly string[], edges: readonly WeightedEdge[]): WeightedEdge[] {
  if (!hasCycle(nodes, edges)) return [];

  if (edges.length <= EXACT_EDGES) {
    for (let size = 1; size <= edges.length; size++) {
      let best: WeightedEdge[] | null = null;
      let bestWeight = Infinity;
      // Every subset of `size` lines, as the bits of a counter; the lightest acyclic one wins at this size.
      const choose = (start: number, chosen: number[]): void => {
        if (chosen.length === size) {
          const weight = chosen.reduce((sum, i) => sum + edges[i]!.weight, 0);

          if (weight >= bestWeight) return;
          const removed = new Set(chosen);

          if (!hasCycle(nodes, edges.filter((_edge, i) => !removed.has(i)))) {
            best = chosen.map((i) => edges[i]!);
            bestWeight = weight;
          }

          return;
        }

        for (let i = start; i <= edges.length - (size - chosen.length); i++) choose(i + 1, [...chosen, i]);
      };

      choose(0, []);

      if (best) return best;
    }
  }

  // Greedy: an order of the nodes that keeps the heaviest lines forward; the lines going backward are the set.
  const remaining = new Set(nodes);
  const left: string[] = [];
  const right: string[] = [];
  const weightOut = (id: string): number => edges.filter((edge) => edge.from === id && remaining.has(edge.to) && edge.to !== id).reduce((sum, edge) => sum + edge.weight, 0);
  const weightIn = (id: string): number => edges.filter((edge) => edge.to === id && remaining.has(edge.from) && edge.from !== id).reduce((sum, edge) => sum + edge.weight, 0);

  while (remaining.size > 0) {
    let moved = true;

    while (moved) {
      moved = false;

      for (const id of [...remaining].sort()) {
        if (weightOut(id) === 0) {
          right.unshift(id);
          remaining.delete(id);
          moved = true;
        } else if (weightIn(id) === 0) {
          left.push(id);
          remaining.delete(id);
          moved = true;
        }
      }
    }

    if (remaining.size === 0) break;
    const best = [...remaining].sort((a, b) => weightOut(b) - weightIn(b) - (weightOut(a) - weightIn(a)) || (a < b ? -1 : 1))[0]!;
    left.push(best);
    remaining.delete(best);
  }

  const position = new Map([...left, ...right].map((id, i) => [id, i]));

  return edges.filter((edge) => position.get(edge.from)! >= position.get(edge.to)!);
}

/** The imports between modules as weighted lines (one per pair, counting the statements), type-only ones included when asked. */
function importEdges(graph: Graph, types: boolean): { edges: WeightedEdge[]; typeOnly: Set<string> } {
  const weights = new Map<string, WeightedEdge>();
  const runtime = new Set<string>();

  for (const dep of graph.deps) {
    if (!graph.modules.has(dep.to) || dep.from === dep.to || (dep.typeOnly && !types)) continue;
    const id = key(dep);
    const edge = weights.get(id) ?? { from: dep.from, to: dep.to, weight: 0 };
    edge.weight += 1;
    weights.set(id, edge);

    if (!dep.typeOnly) runtime.add(id);
  }

  return { edges: [...weights.values()], typeOnly: new Set([...weights.keys()].filter((id) => !runtime.has(id))) };
}

/** The calls between functions as weighted lines (one per pair, counting the call sites); a module's top level is no function. */
function callEdges(graph: Graph): WeightedEdge[] {
  const weights = new Map<string, WeightedEdge>();

  for (const call of graph.calls) {
    if (call.from === call.to || !graph.nodes.has(call.from) || !graph.nodes.has(call.to)) continue;
    const id = key(call);
    const edge = weights.get(id) ?? { from: call.from, to: call.to, weight: 0 };
    edge.weight += 1;
    weights.set(id, edge);
  }

  return [...weights.values()];
}

/** The adjacency of weighted lines. */
function adjacencyOf(edges: readonly WeightedEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();

  for (const edge of edges) {
    adjacency.set(edge.from, new Set([...(adjacency.get(edge.from) ?? []), edge.to]));

    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
  }

  return adjacency;
}

/**
 * The cycles: every strongly connected component of two or more modules
 * (or functions, with `fns`), each a lane, with the lines among its
 * members and, red and dashed, the lines to cut; above them, when the
 * layers import each other, a lane of the layers in a circle. `only`
 * keeps the cycle holding that module or function.
 */
export function cyclesView(graph: Graph, only: string | null, options: CycleOptions = {}): PictureContent {
  const fns = options.fns === true;
  const what = fns ? "function" : "module";

  if (only !== null && !(fns ? graph.nodes.has(only) : graph.modules.has(only))) return unplaced(only, [], [], [], { reason: `no ${what} "${only}"`, missing: true });
  const { edges: all, typeOnly } = fns ? { edges: callEdges(graph), typeOnly: new Set<string>() } : importEdges(graph, options.types === true);
  const every = stronglyConnected(adjacencyOf(all)).filter((component) => component.length >= 2);
  // A circle of functions inside one module is mutual recursion, not a coupling: counted, not drawn.
  const components = every.filter((component) => !fns || new Set(component.map(moduleOf)).size >= 2).sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1));
  const within = every.length - components.length;
  const chosen = only === null ? components : components.filter((component) => component.includes(only));
  const title = only === null ? (fns ? `Call cycles (${chosen.length})` : `Import cycles (${chosen.length})`) : `Cycle of ${only}`;
  const nodes: Shape[] = [];
  const edges: Line[] = [];
  const lanes: string[] = [];
  const notes: string[] = [];

  // The layers importing each other, named as a cycle of their own.
  if (only === null && !fns) {
    const layerWeights = new Map<string, WeightedEdge>();

    for (const edge of all) {
      const from = graph.modules.get(edge.from)!.layer;
      const to = graph.modules.get(edge.to)!.layer;

      if (from === to) continue;
      const id = `${from}\u0000${to}`;
      const row = layerWeights.get(id) ?? { from, to, weight: 0 };
      row.weight += edge.weight;
      layerWeights.set(id, row);
    }

    const layerEdges = [...layerWeights.values()];
    const circles = stronglyConnected(adjacencyOf(layerEdges)).filter((component) => component.length >= 2);

    if (circles.length > 0) {
      const laneId = "layers in a circle";
      lanes.push(laneId);
      const inCircle = new Set(circles.flat());

      for (const name of [...inCircle].sort()) nodes.push({ id: name, kind: "layer", label: name, group: laneId, x: 0, y: 0, w: 0, h: 0 });
      const cuts = new Set(feedbackArcSet([...inCircle], layerEdges.filter((edge) => inCircle.has(edge.from) && inCircle.has(edge.to))).map(key));

      for (const edge of layerEdges) {
        if (!inCircle.has(edge.from) || !inCircle.has(edge.to)) continue;
        const line: Line = { from: edge.from, to: edge.to, kind: "dependency", count: edge.weight, label: `${edge.weight}` };

        if (cuts.has(key(edge))) {
          line.diff = "removed";
          line.label = `cut: ${edge.weight} import${edge.weight === 1 ? "" : "s"}`;
        }

        edges.push(line);
      }

      notes.push(`layers in a circle: ${circles.map((circle) => circle.join(" ⇄ ")).join("; ")}`);
    }
  }

  chosen.forEach((component, i) => {
    const laneId = `cycle ${i + 1} (${component.length} ${what}s)`;
    lanes.push(laneId);
    const members = new Set(component);

    for (const id of component) nodes.push(fns ? { ...fnNode(graph, id), label: `${graph.nodes.get(id)!.parent ? `${graph.nodes.get(id)!.parent}.` : ""}${graph.nodes.get(id)!.name}\n${moduleOf(id)}`, group: laneId } : { ...moduleNode(graph, id), group: laneId });
    const inside = all.filter((edge) => members.has(edge.from) && members.has(edge.to));
    const cuts = feedbackArcSet(component, inside);
    const cutKeys = new Set(cuts.map(key));

    for (const edge of inside) {
      const line: Line = { from: edge.from, to: edge.to, kind: fns ? "call" : "dependency", count: edge.weight };

      if (typeOnly.has(key(edge))) line.typeOnly = true;

      if (cutKeys.has(key(edge))) {
        line.diff = "removed";
        line.label = `cut: ${edge.weight} ${fns ? "call" : "import"}${edge.weight === 1 ? "" : "s"}`;
      }

      edges.push(line);
    }

    if (cuts.length > 0) notes.push(`to break cycle ${i + 1} remove ${cuts.map((cut) => `${fns ? cut.from.slice(cut.from.indexOf("#") + 1) : cut.from} → ${fns ? cut.to.slice(cut.to.indexOf("#") + 1) : cut.to} (${cut.weight})`).join(", ")}`);
  });

  if (chosen.length === 0 && lanes.length === 0) {
    const reason = only === null ? (fns ? `no call cycles: no two functions of different modules call each other in a circle${within > 0 ? ` (${within} within one module: mutual recursion)` : ""}` : `no import cycles: no two modules import each other${options.types ? "" : " (type-only imports not counted; --types counts them)"}`) : `${only} is in no ${fns ? "call" : "import"} cycle`;

    return unplaced(title, [], [], [], { reason });
  }

  const typed = edges.filter((edge) => edge.typeOnly).length;

  if (typed > 0) notes.push(`${typed} ${typed === 1 ? "line carries" : "lines carry"} types only (dashed)`);

  if (within > 0 && only === null) notes.push(`${within} circles of functions within one module (mutual recursion) not drawn`);

  return unplaced(title, nodes, edges, lanes.map(lane), { reason: notes.join("; ") });
}
