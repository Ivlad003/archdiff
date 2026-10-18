// The builders every view shares: a lane, an unplaced diagram, the lanes of
// a set of shapes, a module / external / function shape from the graph,
// the import lines among modules, and `grow` (the neighbourhood of a set of
// modules, `depth` steps out). Pure functions of the graph; views.ts and
// views-more.ts compose them into pictures.
//
// Entry points: `lane`, `unplaced`, `lanesOf`, `moduleNode`,
// `externalNode`, `fnNode`, `depEdges`, `grow`.

import type { Line, Lane, PictureContent, Shape } from "./diagram.ts";
import type { Graph } from "./graph.ts";
export function lane(id: string): Lane {
  return { id, label: id, kind: "lane", x: 0, y: 0, w: 0, h: 0 };
}

/** The content of a picture before `layout`: what a view draws; `viewOf` names it with the view's key. */
export function unplaced(title: string, nodes: Shape[], edges: Line[], groups: Lane[], extra: Partial<PictureContent> = {}): PictureContent {
  return { title, nodes, edges, groups, ...extra };
}

/** The lanes of the layers the nodes use, in the graph's order. */
export function lanesOf(graph: Graph, nodes: readonly Shape[]): Lane[] {
  const used = new Set(nodes.map((node) => node.group).filter((group): group is string => group !== undefined));

  return graph.layers.filter((layer) => used.has(layer)).map(lane);
}

export function moduleNode(graph: Graph, id: string): Shape {
  const module = graph.modules.get(id)!;
  const node: Shape = { id, kind: "module", label: id, ref: { id, file: id, line: 1 }, group: module.layer, x: 0, y: 0, w: 0, h: 0 };

  if (module.doc) node.doc = module.doc;

  return node;
}

export function externalNode(graph: Graph, id: string): Shape {
  const external = graph.externals.get(id)!;

  return { id, kind: "external", label: external.kind === "builtin" ? `node:${external.name}` : external.name, x: 0, y: 0, w: 0, h: 0 };
}

export function fnNode(graph: Graph, id: string): Shape {
  const fn = graph.nodes.get(id)!;
  const node: Shape = { id, kind: "fn", label: fn.parent ? `${fn.parent}.${fn.name}` : fn.name, ref: { id, file: fn.module, line: fn.line, endLine: fn.endLine }, group: graph.modules.get(fn.module)!.layer, x: 0, y: 0, w: 0, h: 0 };

  if (fn.signature) node.signature = fn.signature;

  if (fn.doc) node.doc = fn.doc;

  return node;
}

/** Module-level dependencies between the given modules (and to externals when `externals`), one edge per pair with its count. */
export function depEdges(graph: Graph, members: ReadonlySet<string>, externals: boolean): Line[] {
  // Per pair, the imports that run and those of types only (`import type`): a pair of types only is a dashed line.
  const counts = new Map<string, { runs: number; types: number }>();

  for (const dep of graph.deps) {
    if (!members.has(dep.from)) continue;

    if (!(members.has(dep.to) || (externals && graph.externals.has(dep.to)))) continue;
    const key = `${dep.from}\u0000${dep.to}`;
    const count = counts.get(key) ?? { runs: 0, types: 0 };
    counts.set(key, dep.typeOnly ? { ...count, types: count.types + 1 } : { ...count, runs: count.runs + 1 });
  }

  return [...counts].map(([key, { runs, types }]): Line => {
    const [from, to] = key.split("\u0000") as [string, string];

    return runs > 0 ? { from, to, kind: "dependency", count: runs } : { from, to, kind: "dependency", count: types, typeOnly: true };
  });
}

/** Modules within `depth` import steps of `start`, in the given direction. */
export function grow(graph: Graph, start: ReadonlySet<string>, depth: number, direction: "both" | "out" | "in"): Set<string> {
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
