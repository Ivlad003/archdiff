// The whole repository as one graph for the page's project map (the
// Obsidian-like picture beside the breadcrumbs): every module as a dot
// with its layer, lines and functions, every import between two modules
// as one line with its count, and the layers in order for the colours.
// Big repositories are folded to directories at a depth that keeps the
// map under a few hundred dots; the page lays it out by forces.
//
// A pure function of the graph. Entry points: `projectMap`, `ProjectMap`.

import type { ProjectMap, MapLine, MapDot } from "./diagram.ts";
import type { Graph } from "./graph.ts";

export type { ProjectMap, MapLine, MapDot } from "./diagram.ts";

/** More modules than this, and the map folds to directories. */
const FOLD_ABOVE = 400;

/** The directory of a path cut at `depth` segments (the file itself when shallower). */
function directoryAt(path: string, depth: number): string {
  const parts = path.split("/");

  return parts.length <= depth ? path : parts.slice(0, depth).join("/");
}

export function projectMap(graph: Graph): ProjectMap {
  const modules = [...graph.modules.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const fnsOf = new Map<string, number>();

  for (const node of graph.nodes.values()) if (node.kind === "fn") fnsOf.set(node.module, (fnsOf.get(node.module) ?? 0) + 1);

  // The depth at which the directories number under the limit: 1 (`src`) upward until they do.
  let depth = 0;

  if (modules.length > FOLD_ABOVE) {
    depth = 1;

    while (depth < 6 && new Set(modules.map((module) => directoryAt(module.id, depth + 1))).size <= FOLD_ABOVE) depth++;
  }

  const groupOf = (id: string): string => (depth === 0 ? id : `dir:${directoryAt(id, depth)}`);
  const byGroup = new Map<string, MapDot>();

  for (const module of modules) {
    const id = groupOf(module.id);
    const known = byGroup.get(id);

    if (known) {
      known.lines += module.lines;
      known.fns += fnsOf.get(module.id) ?? 0;
      known.modules = (known.modules ?? 1) + 1;
      continue;
    }

    const node: MapDot = { id, label: depth === 0 ? module.id : directoryAt(module.id, depth), layer: module.layer, lines: module.lines, fns: fnsOf.get(module.id) ?? 0 };

    if (depth > 0) node.modules = 1;
    byGroup.set(id, node);
  }

  const counts = new Map<string, MapLine>();

  for (const dep of graph.deps) {
    if (!graph.modules.has(dep.to)) continue;
    const from = groupOf(dep.from);
    const to = groupOf(dep.to);

    if (from === to) continue;
    const key = `${from}\u0000${to}`;
    const known = counts.get(key);

    if (known) {
      known.count++;

      if (!dep.typeOnly) delete known.typeOnly;
    } else counts.set(key, dep.typeOnly ? { from, to, count: 1, typeOnly: true } : { from, to, count: 1 });
  }

  return { layers: [...graph.layers], nodes: [...byGroup.values()], edges: [...counts.values()], level: depth === 0 ? "module" : `dir:${depth}` };
}
