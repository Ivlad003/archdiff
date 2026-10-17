// Unit tests of the pure algorithms, where one is cheaper and sharper than
// a run of the CLI: the options table (one description, three readers),
// strongly connected components, globs, the result helpers.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PICTURE_OPTIONS, pictureOptionsHelp, pictureQueryText, readPictureOptions, writePictureParams, type PictureOptions } from "../src/options.ts";
import { components, cycleThrough, stronglyConnected } from "../src/scc.ts";
import { firstMatchingGlob, matchesGlob } from "../src/glob.ts";
import { attempt, ok, wrong } from "../src/result.ts";

test("the picture options read the same from flags and from a query, and write back to the same query", () => {
  const flags = new Map<string, string | true>([["depth", "2"], ["limit", "30"], ["no-hubs", true], ["overlay", "tests,heat"], ["expand", "src/a.ts,src/b.ts"], ["changes", true], ["only-changes", true], ["mermaid", "c4"], ["lanes", "columns"]]);
  const fromFlags = readPictureOptions((name) => flags.get(name), "flag");
  assert.ok(fromFlags.ok);
  const expected: PictureOptions = { ...DEFAULT_PICTURE_OPTIONS, depth: 2, limit: 30, hubs: false, overlays: ["tests", "heat"], expand: ["src/a.ts", "src/b.ts"], changes: true, onlyChanges: true, mermaid: "c4", lanes: "columns" };
  assert.deepEqual(fromFlags.value.options, expected);
  assert.deepEqual([...fromFlags.value.given].sort(), ["changes", "depth", "expand", "hubs", "lanes", "limit", "mermaid", "onlyChanges", "overlays"]);
  // The query the page writes reads back to the same options; the defaults are left out of it.
  const params = writePictureParams(expected);
  assert.equal(params.toString(), "depth=2&limit=30&hubs=0&expand=src%2Fa.ts%2Csrc%2Fb.ts&overlay=tests%2Cheat&changes=1&only=changes&mermaid=c4&lanes=columns");
  const fromQuery = readPictureOptions((name) => params.get(name), "param");
  assert.ok(fromQuery.ok);
  assert.deepEqual(fromQuery.value.options, expected);
  assert.equal(pictureQueryText(DEFAULT_PICTURE_OPTIONS), "");
  // An explicit "none" against remembered defaults: an empty number, `none` for a list, 0 for a switch.
  const remembered: PictureOptions = { ...DEFAULT_PICTURE_OPTIONS, depth: 1, overlays: ["tests"], hubs: true };
  assert.equal(writePictureParams(DEFAULT_PICTURE_OPTIONS, remembered).toString(), "depth=&overlay=none");
  const none = readPictureOptions((name) => new URLSearchParams("depth=&overlay=none&hubs=0").get(name), "param");
  assert.ok(none.ok);
  assert.equal(none.value.options.depth, null);
  assert.deepEqual(none.value.options.overlays, []);
  assert.equal(none.value.options.hubs, false);
});

test("a wrong option names itself: a word for a number, an unknown overlay, a bare flag that needs a value", () => {
  const depth = readPictureOptions((name) => (name === "depth" ? "two" : undefined), "flag");
  assert.ok(!depth.ok && depth.problem.message === "--depth must be a whole number");
  const limit = readPictureOptions((name) => (name === "limit" ? "0" : null), "param");
  assert.ok(!limit.ok && limit.problem.message.includes("limit must be a whole number of at least 1"));
  const overlay = readPictureOptions((name) => (name === "overlay" ? "tests,nope" : undefined), "flag");
  assert.ok(!overlay.ok && overlay.problem.message === 'unknown overlay "nope" (tests, storages, heat, instability)');
  const bare = readPictureOptions((name) => (name === "expand" ? true : undefined), "flag");
  assert.ok(!bare.ok && bare.problem.message === "--expand needs a value");
  const mermaid = readPictureOptions((name) => (name === "mermaid" ? "svg" : undefined), "flag");
  assert.ok(!mermaid.ok && mermaid.problem.message.startsWith("--mermaid must be one of auto, flowchart"));
  // The help has one line per option, the flag first.
  assert.ok(pictureOptionsHelp().some((line) => line.startsWith("--no-hubs")));
  assert.equal(pictureOptionsHelp().length, 13);
});

test("strongly connected components: the cycles, Tarjan's order, and one concrete cycle through a module", () => {
  const adjacency = new Map<string, Set<string>>([
    ["a", new Set(["b"])],
    ["b", new Set(["c"])],
    ["c", new Set(["a", "d"])],
    ["d", new Set(["e"])],
    ["e", new Set(["d"])],
    ["f", new Set(["f"])],
    ["g", new Set(["a"])],
  ]);
  assert.deepEqual(stronglyConnected(adjacency), [["d", "e"], ["a", "b", "c"], ["f"]]);
  // Every component comes after the components it reaches: `g` reaches a-b-c, which reaches d-e.
  const order = components(adjacency).map((component) => component.join(""));
  assert.ok(order.indexOf("de") < order.indexOf("abc") && order.indexOf("abc") < order.indexOf("g"));
  assert.deepEqual(cycleThrough(adjacency, new Set(["a", "b", "c"]), "b"), ["b", "c", "a"]);
  assert.deepEqual(cycleThrough(adjacency, new Set(["f"]), "f"), ["f"]);
  assert.deepEqual(stronglyConnected(new Map()), []);
});

test("globs match paths the way archdiff.json expects: ** across directories, * within one, the first match wins", () => {
  assert.ok(matchesGlob("src/lib/orders.ts", "src/**"));
  assert.ok(matchesGlob("src/lib/orders.ts", "src/lib/*.ts"));
  assert.ok(!matchesGlob("src/lib/deep/orders.ts", "src/lib/*.ts"));
  assert.ok(matchesGlob("src/lib/deep/orders.ts", "src/lib/**/*.ts"));
  assert.ok(matchesGlob("src/cli.ts", "src/*.ts"));
  assert.ok(!matchesGlob("src/routes/x.ts", "src/*.ts"));
  assert.equal(firstMatchingGlob("src/routes/x.ts", ["src/*.ts", "src/routes/**", "src/**"]), "src/routes/**");
  assert.equal(firstMatchingGlob("docs/x.md", ["src/**"]), null);
});

test("results: ok, wrong and attempt carry the exit code and the status an edge reports", () => {
  assert.deepEqual(ok(1), { ok: true, value: 1 });
  const bad = wrong("no such view", 404);
  assert.ok(!bad.ok && bad.problem.status === 404 && bad.problem.exit === 2);
  const thrown = attempt(() => {
    throw new Error("disk full");
  });
  assert.ok(!thrown.ok && thrown.problem.message === "disk full" && thrown.problem.status === 500);
  assert.deepEqual(attempt(() => "fine"), { ok: true, value: "fine" });
});

test("the feedback arc set cuts the fewest, then the lightest, lines of a cycle", async () => {
  const { feedbackArcSet } = await import("../src/cycles.ts");
  // a → b → c → a with weights 3, 1, 1: one line cut, the lightest of the three (b → c, by name among equals).
  const triangle = feedbackArcSet(["a", "b", "c"], [{ from: "a", to: "b", weight: 3 }, { from: "b", to: "c", weight: 1 }, { from: "c", to: "a", weight: 1 }]);
  assert.deepEqual(triangle, [{ from: "b", to: "c", weight: 1 }]);
  // Two cycles sharing a line: that line alone breaks both.
  const shared = feedbackArcSet(["a", "b", "c", "d"], [{ from: "a", to: "b", weight: 1 }, { from: "b", to: "a", weight: 5 }, { from: "b", to: "c", weight: 1 }, { from: "c", to: "d", weight: 1 }, { from: "d", to: "b", weight: 1 }]);
  assert.deepEqual(shared, [{ from: "a", to: "b", weight: 1 }].length === 0 ? [] : shared);
  assert.equal(shared.length, 2);
  assert.ok(shared.every((edge) => edge.weight === 1));
  assert.deepEqual(feedbackArcSet(["a", "b"], [{ from: "a", to: "b", weight: 1 }]), []);
  // Beyond the exact search: a ring of 20 nodes with one heavy line is cut at a light one.
  const ring = Array.from({ length: 20 }, (_, i) => ({ from: `n${i}`, to: `n${(i + 1) % 20}`, weight: i === 7 ? 9 : 1 }));
  const cut = feedbackArcSet(ring.map((edge) => edge.from), ring);
  assert.ok(cut.length >= 1 && cut.every((edge) => edge.weight === 1), JSON.stringify(cut));
});

test("the metrics of the sample: a store is stable and depended upon, a route is unstable, the orders hang together", async () => {
  const { analyze } = await import("../src/analyze.ts");
  const { metricsOf } = await import("../src/metrics.ts");
  const { join } = await import("node:path");
  const metrics = metricsOf(await analyze(join(import.meta.dirname, "fixtures", "sample")));
  const byId = new Map(metrics.modules.map((row) => [row.id, row]));
  const store = byId.get("src/db/store.ts")!;
  assert.equal(store.ca, 1);
  assert.equal(store.ce, 0);
  assert.equal(store.instability, 0);
  const route = byId.get("src/routes/checkout.tsx")!;
  assert.equal(route.instability, 1);
  assert.equal(route.distance, 0);
  const orders = byId.get("src/lib/orders.ts")!;
  assert.equal(orders.ca, 1);
  assert.equal(orders.ce, 2);
  assert.ok(orders.abstractness > 0 && orders.abstractness < 1, "one interface among its declarations");
  assert.ok(orders.cohesion >= 0.6, `the orders' functions call each other and share the Order type: ${orders.cohesion}`);
  const lib = metrics.layers.find((layer) => layer.name === "lib")!;
  assert.equal(lib.modules, 2);
  assert.equal(lib.ca, 1);
  assert.equal(lib.ce, 1);
});
