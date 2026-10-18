// The invariant of the edge router: no segment of a route runs through a
// shape that is not the edge's own source or target. Checked on synthetic
// grids that force every case (a span over several columns with a shape in
// the way, a backward edge with shapes below its source) and on every view
// of the sample fixture.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { analyze } from "../src/analyze.ts";
import type { Diagram, Shape } from "../src/diagram.ts";
import { layout } from "../src/diagram.ts";
import { routeEdges } from "../src/export/excalidraw.ts";
import { parseView, viewList, viewOf } from "../src/views.ts";
import { hideLanes, hubsAsBadges } from "../src/shape.ts";
import { onlyChanged } from "../src/diff.ts";
import { intentMarkdown, parseIntent, syncConfigLayers } from "../src/intent.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { withTempDir } from "./temp-dir.ts";

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
  const nodes: Shape[] = [];

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

/** How many times the routes of two different lines cross (segment pairs that intersect). */
function crossingsOf(diagram: Diagram): number {
  const orient = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }): number => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const routes = [...routeEdges(diagram).values()];
  let n = 0;

  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      for (let p = 1; p < routes[i]!.length; p++) {
        for (let q = 1; q < routes[j]!.length; q++) {
          const [a, b, c, d] = [routes[i]![p - 1]!, routes[i]![p]!, routes[j]![q - 1]!, routes[j]![q]!];
          const marks = [orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)];

          if (marks.every((mark) => mark !== 0) && marks[0] !== marks[1] && marks[2] !== marks[3]) n++;
        }
      }
    }
  }

  return n;
}

test("crossings of the fixture's views stay at or under their baseline (ordering and routing together)", async () => {
  const analysis = await analyze(fixture, { cache: false });
  // Counted on 2026-10-17; a change that adds crossings must raise these on purpose, with a reason.
  const baseline: Record<string, number> = { layers: 0, "layer:lib": 2, "dir:src/lib": 2, "inside:src/lib/orders.ts": 4, "calls:src/routes/checkout.tsx#action": 2 };

  for (const [key, allowed] of Object.entries(baseline)) {
    const view = parseView(key);
    assert.ok(view, key);
    const count = crossingsOf(layout(viewOf(analysis, view)));
    assert.ok(count <= allowed, `${key}: ${count} crossings, baseline ${allowed}`);
  }
});

test("a module most of a picture imports becomes a badge on its importers, not a tangle of lines", () => {
  const modules = ["a", "b", "c", "d", "e", "f", "g", "h", "log"];
  const nodes: Shape[] = modules.map((id) => ({ id, kind: "module", label: id, x: 0, y: 0, w: 0, h: 0 }));
  const edges = modules.filter((id) => id !== "log" && id !== "h").map((id) => ({ from: id, to: "log", kind: "dependency" as const }));
  edges.push({ from: "a", to: "b", kind: "dependency" });
  const diagram: Diagram = { view: "layer:x", title: "x", nodes, edges, groups: [] };
  const slim = hubsAsBadges(diagram, null);
  assert.ok(!slim.nodes.some((node) => node.id === "log"), "the hub stayed");
  assert.equal(slim.edges.length, 1);
  assert.ok(slim.nodes.find((node) => node.id === "a")!.label.includes("+ log"));
  assert.ok(!slim.nodes.find((node) => node.id === "h")!.label.includes("+ log"));
  assert.ok(slim.reason?.includes("log (imported by 7 of 9)"), slim.reason);
  // The view's own subject is never a hub; a small picture keeps every line.
  assert.equal(hubsAsBadges(diagram, "log").nodes.length, 9);
  assert.equal(hubsAsBadges({ ...diagram, nodes: nodes.slice(0, 5) }, null).nodes.length, 5);
});

test("only the changed shapes and their neighbours stay; hidden lanes take their shapes and lines with them", () => {
  const nodes: Shape[] = ["a", "b", "c", "d"].map((id) => ({ id, kind: "module", label: id, group: id === "d" ? "other" : "main", x: 0, y: 0, w: 0, h: 0 }));
  nodes[1]!.diff = "changed";
  const diagram: Diagram = { view: "layer:x", title: "x", nodes, edges: [{ from: "a", to: "b", kind: "dependency" }, { from: "c", to: "d", kind: "dependency" }], groups: [{ id: "main", label: "main", kind: "lane", x: 0, y: 0, w: 0, h: 0 }, { id: "other", label: "other", kind: "lane", x: 0, y: 0, w: 0, h: 0 }] };
  const only = onlyChanged(diagram);
  assert.deepEqual(only.nodes.map((node) => node.id), ["a", "b"]);
  assert.equal(only.edges.length, 1);
  assert.deepEqual(only.groups.map((group) => group.id), ["main"]);
  assert.equal(onlyChanged({ ...diagram, nodes: nodes.map(({ diff: _diff, ...node }) => node) }).nodes.length, 0);
  const hidden = hideLanes(diagram, ["other", "nowhere"]);
  assert.deepEqual(hidden.nodes.map((node) => node.id), ["a", "b", "c"]);
  assert.equal(hidden.edges.length, 1);
  assert.ok(hidden.reason?.includes("lanes hidden: other (1 shapes)"));
  assert.equal(hideLanes(diagram, ["nowhere"]), diagram);
});

test("the intent parser keeps labels with entities and ampersands whole, reads every bracket and arrow, and round-trips", () => {
  const text = `# Note\n\n\`\`\`mermaid\nflowchart TD\n  subgraph out["outbound — adapters"]\n    F["src/out/fetch.ts<br>fetchTitle(url) &lt;string | null&gt; &amp; retries"]\n    G(src/out/log.ts) & H{src/out/clock.ts}\n  end\n  subgraph app\n    A["src/app/add.ts: adds a bookmark"]\n  end\n  A -->|fill title| F\n  A --> G & H\n  A -.-> src/app/add.ts#validate\n\`\`\`\n\nAfter.\n`;
  const intent = parseIntent(text);
  assert.deepEqual(intent.layers, [{ name: "outbound", description: "adapters" }, { name: "app" }]);
  assert.deepEqual(intent.modules.map((module) => module.id).sort(), ["src/app/add.ts", "src/out/clock.ts", "src/out/fetch.ts", "src/out/log.ts"]);
  assert.equal(intent.modules.find((module) => module.id === "src/out/fetch.ts")?.description, "fetchTitle(url) <string | null> & retries");
  assert.equal(intent.modules.find((module) => module.id === "src/app/add.ts")?.description, "adds a bookmark");
  assert.deepEqual(intent.modules.find((module) => module.id === "src/app/add.ts")?.fns, [{ name: "validate" }]);
  assert.deepEqual(intent.edges.map((edge) => `${edge.from}>${edge.to}${edge.label ? `|${edge.label}` : ""}`), ["src/app/add.ts>src/out/fetch.ts|fill title", "src/app/add.ts>src/out/log.ts", "src/app/add.ts>src/out/clock.ts", "src/app/add.ts>src/app/add.ts#validate"]);
  // Written back and read again: the same intent, the prose kept.
  const again = parseIntent(intentMarkdown(intent));
  assert.deepEqual(again.modules, intent.modules);
  assert.deepEqual(again.edges, intent.edges);
  assert.ok(intentMarkdown(intent).startsWith("# Note\n") && intentMarkdown(intent).trimEnd().endsWith("After."));
});

test("archdiff.json's layers follow the intent: a directory as the glob, the files themselves where another layer lives below", () =>
  withTempDir("archdiff-layers-", (dir) => {
    writeFileSync(join(dir, "archdiff.json"), JSON.stringify({ layers: { app: ["src/**"] }, exclude: ["vendor/**"] }));
    const intent = parseIntent("```mermaid\nflowchart LR\n  subgraph entry\n    M[src/main.ts]\n    C[src/config.ts]\n  end\n  subgraph http\n    S[src/http/server.ts]\n  end\n  subgraph tests\n  end\n  M --> S\n```\n");
    syncConfigLayers(dir, intent);
    const config = JSON.parse(readFileSync(join(dir, "archdiff.json"), "utf8")) as { layers: Record<string, string[]>; exclude: string[] };
    assert.deepEqual(Object.keys(config.layers), ["entry", "http", "tests", "app"]);
    assert.deepEqual(config.layers["entry"], ["src/config.ts", "src/main.ts"]);
    assert.deepEqual(config.layers["http"], ["src/http/**"]);
    assert.deepEqual(config.layers["tests"], []);
    assert.deepEqual(config.exclude, ["vendor/**"]);
  }));

/** A small deterministic generator, so a failing placement can be reproduced from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("shapes placed anywhere by hand: the grid router runs no line through a shape, on 150 random placements", async () => {
  const { routeFree } = await import("../src/export/route-free.ts");

  for (let seed = 1; seed <= 150; seed++) {
    const random = mulberry32(seed);
    const count = 6 + Math.floor(random() * 16);
    const nodes: Shape[] = [];

    // Shapes on a jittered grid, so none overlaps another; some cells left empty.
    for (let i = 0; i < count; i++) {
      const column = i % 5;
      const row = Math.floor(i / 5);
      const w = 120 + Math.floor(random() * 90);
      const h = 40 + Math.floor(random() * 40);
      nodes.push({ id: `n${i}`, kind: "module", label: `n${i}`, x: 40 + column * 260 + Math.floor(random() * 50), y: 40 + row * 140 + Math.floor(random() * 60), w, h });
    }

    const edges = [];

    for (let i = 0; i < count + 4; i++) {
      const from = nodes[Math.floor(random() * count)]!.id;
      const to = nodes[Math.floor(random() * count)]!.id;

      if (from !== to) edges.push({ from, to, kind: "dependency" as const });
    }

    const diagram: Diagram = { view: `random-${seed}`, title: "random", nodes, edges, groups: [], freeform: true };
    assert.deepEqual(crossings(diagram), [], `seed ${seed}`);
    // Every route is orthogonal and starts and ends on its shapes' sides.
    for (const [edge, points] of routeFree(diagram)) {
      for (let i = 1; i < points.length; i++) assert.ok(points[i]!.x === points[i - 1]!.x || points[i]!.y === points[i - 1]!.y, `seed ${seed}: ${edge.from} → ${edge.to} bends diagonally`);
    }
  }
});
