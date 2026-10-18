// Chains of lines in the current picture, for the page's tools: the
// shortest chain between two shapes, the chain onward from a line, the
// neighbourhood of a shape (what the dim tool keeps), and the shapes a
// search finds. Pure functions of the picture's shapes and lines, which
// app.ts passes in.
//
// Entry points: `chainBetween`, `chainFrom`, `neighbourhoodOf`, `findShapes`.

import type { Line, Shape } from "./api.ts";
import type { PickedLine } from "./editor.tsx";
import { lineElementId } from "../../src/shape-keys.ts";

/** The shortest chain of lines from `from` to `to` along the arrows (else against them), breadth first; null when none. */
export function chainBetween(edges: readonly Line[], from: string, to: string, directed: boolean): { edge: Line; index: number }[] | null {
  const previous = new Map<string, { edge: Line; index: number; node: string }>();
  const seen = new Set([from]);
  let frontier = [from];

  while (frontier.length > 0 && !seen.has(to)) {
    const next: string[] = [];

    for (const id of frontier) {
      edges.forEach((edge, index) => {
        if (edge.kind === "lifeline") return;
        const other = edge.from === id ? edge.to : !directed && edge.to === id ? edge.from : null;

        if (other === null || seen.has(other)) return;
        seen.add(other);
        previous.set(other, { edge, index, node: id });
        next.push(other);
      });
    }

    frontier = next;
  }

  if (!seen.has(to)) return null;
  const chain: { edge: Line; index: number }[] = [];

  for (let at = to; at !== from; ) {
    const step = previous.get(at)!;
    chain.unshift({ edge: step.edge, index: step.index });
    at = step.node;
  }

  return chain;
}

/** The shapes whose label or ID holds the text, case-insensitively; the first is the best match (a label that starts with it). */
export function findShapes(nodes: ReadonlyMap<string, Shape>, text: string): Shape[] {
  const needle = text.trim().toLowerCase();

  if (needle === "") return [];
  const hits = [...nodes.values()].filter((node) => node.kind !== "anchor" && (node.label.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle)));

  return hits.sort((a, b) => Number(b.label.toLowerCase().startsWith(needle)) - Number(a.label.toLowerCase().startsWith(needle)));
}

/** A shape, its lines and the shapes at their other ends: what stays lit under the focus tool. */
export function neighbourhoodOf(edges: readonly Line[], id: string): string[] {
  const keep = new Set([id]);
  edges.forEach((edge, index) => {
    if (edge.from === id || edge.to === id) {
      keep.add(lineElementId(edge, index));
      keep.add(edge.from);
      keep.add(edge.to);
    }
  });

  return [...keep];
}

/** The chain onward from a line: every line reachable from its target along the arrows, with the shapes on the way, breadth first, capped. */
export function chainFrom(edges: readonly Line[], line: PickedLine, cap = 300): { lineIds: string[]; nodeIds: string[]; hops: { edge: Line; depth: number }[] } {
  const lineIds = [line.id];
  const nodeIds = [line.from, line.to];
  const seen = new Set([line.from, line.to]);
  const hops: { edge: Line; depth: number }[] = [];
  let frontier = [line.to];
  let depth = 1;

  while (frontier.length > 0 && lineIds.length < cap) {
    const next: string[] = [];

    for (const id of frontier) {
      edges.forEach((edge, index) => {
        if (edge.from !== id || edge.kind === "lifeline" || lineIds.length >= cap) return;
        lineIds.push(lineElementId(edge, index));
        hops.push({ edge, depth });

        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          nodeIds.push(edge.to);
          next.push(edge.to);
        }
      });
    }

    frontier = next;
    depth++;
  }

  return { lineIds, nodeIds, hops };
}
