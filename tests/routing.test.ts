// The invariant of the edge router: no segment of a route runs through a
// shape that is not the edge's own source or target. Checked on synthetic
// grids that force every case (a span over several columns with a shape in
// the way, a backward edge with shapes below its source) and on every view
// of the sample fixture.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { analyze } from "../src/analyze.ts";
import type { Diagram, DiagramNode } from "../src/diagram.ts";
import { layout } from "../src/diagram.ts";
import { routeEdges } from "../src/export/excalidraw.ts";
import { parseView, viewList, viewOf } from "../src/views.ts";

const fixture = join(import.meta.dirname, "fixtures", "sample");

/** The shapes a route runs through, other than its own two ends: `id` for each offence. */
function crossings(diagram: Diagram): string[] {
  const offences: string[] = [];

  for (const [edge, points] of routeEdges(diagram)) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const x1 = Math.min(a.x, b.x);
      const x2 = Math.max(a.x, b.x);
      const y1 = Math.min(a.y, b.y);
      const y2 = Math.max(a.y, b.y);

      for (const node of diagram.nodes) {
        if (node.id === edge.from || node.id === edge.to || node.kind === "anchor") continue;

        // A strict overlap of the segment with the shape's box, 1 px in from the border, so a line along a side is no offence.
        if (x1 < node.x + node.w - 1 && x2 > node.x + 1 && y1 < node.y + node.h - 1 && y2 > node.y + 1) offences.push(`${edge.from} → ${edge.to} through ${node.id}`);
      }
    }
  }

  return [...new Set(offences)];
}

/** A grid of modules: `grid[row][column]` names a shape or is null; `edges` are pairs of names. */
function grid(rows: (string | null)[][], edges: [string, string][]): Diagram {
  const nodes: DiagramNode[] = [];

  rows.forEach((row, r) => row.forEach((name, c) => {
    if (name) nodes.push({ id: name, kind: "module", label: name, x: 40 + c * 260, y: 40 + r * 90, w: 180, h: 50, group: "lane" });
  }));

  return { view: "test", title: "test", nodes, edges: edges.map(([from, to]) => ({ from, to, kind: "dependency" })), groups: [{ id: "lane", label: "lane", kind: "lane", x: 0, y: 0, w: 2000, h: 1000 }] };
}

test("a route over several columns goes around the shapes in between, between the rows", () => {
  const diagram = grid(
    [
      ["a", "b", "c", "d"],
      ["e", "f", "g", "h"],
      [null, "i", null, "j"],
    ],
    [["a", "d"], ["a", "c"], ["e", "h"], ["e", "d"], ["a", "h"], ["e", "j"], ["i", "j"], ["a", "b"]],
  );
  assert.deepEqual(crossings(diagram), []);
  // The edge a → d took a corridor: its route has the bends of a detour, not one straight run through b and c.
  const route = routeEdges(diagram).get(diagram.edges[0]!)!;
  assert.ok(route.length >= 5, JSON.stringify(route));
});

test("a backward edge runs through the gaps beside the columns, not through the shapes below its source", () => {
  const diagram = grid(
    [
      ["a", "b", "c"],
      ["d", "e", "f"],
      ["g", "h", "i"],
    ],
    [["c", "a"], ["b", "a"], ["f", "d"], ["c", "e"], ["a", "d"], ["b", "h"]],
  );
  assert.deepEqual(crossings(diagram), []);
});

test("no route of any view of the sample fixture runs through a shape", async () => {
  const analysis = await analyze(fixture, { cache: false });
  const keys = viewList(analysis).map((view) => view.key);
  assert.ok(keys.length > 10, keys.join(", "));

  for (const key of keys) {
    const view = parseView(key);
    assert.ok(view, key);
    const placed = layout(viewOf(analysis, view));
    assert.deepEqual(crossings(placed), [], key);
  }
});
