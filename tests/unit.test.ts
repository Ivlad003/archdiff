// Unit tests of the pure algorithms, where one is cheaper and sharper than
// a run of the CLI: the options table (one description, three readers),
// strongly connected components, globs, the result helpers.
//
// Entry point: run by `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { withTempDir } from "./temp-dir.ts";
import { DEFAULT_PICTURE_OPTIONS, DEEP_DEPTH, depthWarning, pictureOptionsHelp, pictureQueryText, readEachPictureOption, readPictureOptions, writePictureParams, type PictureOptions } from "../src/options.ts";
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
  // A query's boolean is 1/0, true/false or yes/no; anything else names the option.
  const yes = readPictureOptions((name) => new URLSearchParams("packages=true&hubs=no&only=changes").get(name), "param");
  assert.ok(yes.ok && yes.value.options.packages && !yes.value.options.hubs && yes.value.options.onlyChanges);
  const maybe = readPictureOptions((name) => (name === "hubs" ? "maybe" : null), "param");
  assert.ok(!maybe.ok && maybe.problem.message === "hubs must be 1 or 0");
});

test("a link read leniently leaves out each wrong value alone and names it; a depth has no ceiling, only a warning past DEEP_DEPTH", () => {
  const params = new URLSearchParams("limit=1.5&depth=2&overlay=tests&mermaid=xyz&hubs=0");
  const read = readEachPictureOption((name) => params.get(name));
  assert.equal(read.options.depth, 2);
  assert.deepEqual(read.options.overlays, ["tests"]);
  assert.equal(read.options.hubs, false);
  // The wrong ones keep their defaults and are not counted as given (a remembered default may take their place).
  assert.equal(read.options.limit, null);
  assert.equal(read.options.mermaid, "auto");
  assert.ok(!read.given.has("limit") && !read.given.has("mermaid") && read.given.has("depth"));
  assert.deepEqual(read.wrong, ["limit=1.5 (limit must be a whole number of at least 1)", "mermaid=xyz (mermaid must be one of auto, flowchart, c4, quadrant, pie, gitgraph, mindmap, state)"]);
  assert.deepEqual(readEachPictureOption(() => null).wrong, []);
  // Any depth reads; past DEEP_DEPTH it carries a warning, none at it or below.
  const deep = readPictureOptions((name) => (name === "depth" ? "40" : null), "param");
  assert.ok(deep.ok && deep.value.options.depth === 40);
  assert.equal(depthWarning(DEEP_DEPTH), null);
  assert.equal(depthWarning(null), null);
  assert.equal(depthWarning(DEEP_DEPTH + 1), `depth ${DEEP_DEPTH + 1} is deeper than ${DEEP_DEPTH}: the picture may be big and slow to draw (the fold keeps it readable)`);
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

/** A small deterministic generator, so a failing case can be reproduced from its seed. */
function random32(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: the fold keeps the limit and the lines it merges count what they stand for, on 200 random pictures", async () => {
  const { fold } = await import("../src/shape.ts");

  for (let seed = 1; seed <= 200; seed++) {
    const random = random32(seed);
    const count = 5 + Math.floor(random() * 80);
    const directories = ["src/a", "src/b", "src/c/d", "lib", ""];
    const nodes = Array.from({ length: count }, (_, i) => {
      const directory = directories[Math.floor(random() * directories.length)]!;

      return { id: `${directory ? `${directory}/` : ""}m${i}.ts`, kind: "module" as const, label: `m${i}`, group: random() < 0.5 ? "one" : "two", x: 0, y: 0, w: 0, h: 0 };
    });
    const edges = Array.from({ length: Math.floor(random() * count * 2) }, () => ({ from: nodes[Math.floor(random() * count)]!.id, to: nodes[Math.floor(random() * count)]!.id, kind: "dependency" as const })).filter((edge) => edge.from !== edge.to);
    const limit = 1 + Math.floor(random() * 30);
    const folded = fold({ view: "test", title: "test", nodes, edges, groups: [{ id: "one", label: "one", kind: "lane", x: 0, y: 0, w: 0, h: 0 }, { id: "two", label: "two", kind: "lane", x: 0, y: 0, w: 0, h: 0 }] }, limit);
    const kept = folded.nodes.filter((node) => node.kind !== "more");
    const more = folded.nodes.filter((node) => node.kind === "more");

    if (count <= limit) {
      assert.equal(folded.nodes.length, count, `seed ${seed}: nothing to fold`);
      continue;
    }

    assert.equal(kept.length, limit, `seed ${seed}: the first ${limit} shapes stay`);
    assert.ok(more.length <= 12, `seed ${seed}: at most a dozen folded shapes`);
    assert.equal(more.reduce((sum, node) => sum + (node.count ?? 0), 0), count - limit, `seed ${seed}: the folded shapes count every dropped shape`);
    // Every line joins shapes of the picture, every line between kept shapes is still there, and the merged lines count at least them.
    const ids = new Set(folded.nodes.map((node) => node.id));
    assert.ok(folded.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)), `seed ${seed}: lines between present shapes`);
    const keptEdges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    assert.ok(keptEdges.every((edge) => folded.edges.some((line) => line.from === edge.from && line.to === edge.to)), `seed ${seed}: lines between kept shapes stay`);
    const total = folded.edges.reduce((sum, edge) => sum + (edge.count ?? 1), 0);
    assert.ok(total >= keptEdges.length && total <= edges.length, `seed ${seed}: ${total} lines stand for at most the ${edges.length} original`);
  }
});

test("property: the intent survives a round trip through its Markdown, on 100 random contracts", async () => {
  const { intentMarkdown, parseIntent } = await import("../src/intent.ts");

  for (let seed = 1; seed <= 100; seed++) {
    const random = random32(seed);
    const layers = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, i) => (random() < 0.5 ? { name: `layer${i}` } : { name: `layer${i}`, description: `what layer ${i} does & why` }));
    const modules = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, i): { id: string; layer: string; description?: string; fns: { name: string; description?: string }[] } => {
      const layer = layers[Math.floor(random() * layers.length)]!.name;
      const fns = Array.from({ length: Math.floor(random() * 3) }, (_, j) => (random() < 0.5 ? { name: `f${j}` } : { name: `f${j}`, description: `does ${j}` }));

      return random() < 0.5 ? { id: `src/${layer}/m${i}.ts`, layer, description: `module ${i} with "quotes" and <a tag>`, fns } : { id: `src/${layer}/m${i}.ts`, layer, fns };
    });
    const edges = Array.from({ length: Math.floor(random() * 6) }, () => ({ from: modules[Math.floor(random() * modules.length)]!.id, to: modules[Math.floor(random() * modules.length)]!.id })).filter((edge, i, all) => edge.from !== edge.to && all.findIndex((other) => other.from === edge.from && other.to === edge.to) === i);
    const intent = { layers, modules, edges, before: "# Architecture\n\nSome prose.\n\n", after: "" };
    const back = parseIntent(intentMarkdown(intent));
    const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : 1);
    assert.deepEqual(back.layers, layers, `seed ${seed}: layers`);
    // The Markdown groups the modules by layer: the same modules, in the layers' order.
    assert.deepEqual([...back.modules].sort(byId), [...modules].sort(byId), `seed ${seed}: modules`);
    assert.deepEqual(back.edges, edges, `seed ${seed}: edges`);
    assert.equal(intentMarkdown(back), intentMarkdown(intent), `seed ${seed}: the Markdown is stable`);
  }
});

test("property: the layout keeps every shape in its lane, apart from the others, with the ranks following the lines, on 150 random pictures", async () => {
  const { layout } = await import("../src/diagram.ts");

  for (let seed = 1; seed <= 150; seed++) {
    const random = random32(seed);
    const count = 2 + Math.floor(random() * 30);
    const lanes = ["a", "b", "c"].slice(0, 1 + Math.floor(random() * 3));
    const nodes = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, kind: "module" as const, label: `n${i}`, group: lanes[Math.floor(random() * lanes.length)]!, x: 0, y: 0, w: 0, h: 0 }));
    // Lines forward in the order of the shapes, so the picture is acyclic and the ranks are known.
    const edges = Array.from({ length: Math.floor(random() * count * 2) }, () => {
      const a = Math.floor(random() * count);
      const b = Math.floor(random() * count);

      return a < b ? { from: `n${a}`, to: `n${b}`, kind: "dependency" as const } : null;
    }).filter((edge): edge is NonNullable<typeof edge> => edge !== null);
    const placed = layout({ view: "test", title: "test", nodes, edges, groups: lanes.map((lane) => ({ id: lane, label: lane, kind: "lane" as const, x: 0, y: 0, w: 0, h: 0 })) });

    for (const node of placed.nodes) {
      const lane = placed.groups.find((group) => group.id === node.group)!;
      assert.ok(node.x >= lane.x && node.x + node.w <= lane.x + lane.w && node.y >= lane.y && node.y + node.h <= lane.y + lane.h, `seed ${seed}: ${node.id} in its lane`);
    }

    for (const a of placed.nodes) for (const b of placed.nodes) if (a.id < b.id) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `seed ${seed}: ${a.id} and ${b.id} apart`);
    const at = new Map(placed.nodes.map((node) => [node.id, node]));

    for (const edge of edges) assert.ok(at.get(edge.to)!.x > at.get(edge.from)!.x, `seed ${seed}: ${edge.from} → ${edge.to} runs forward`);
  }
});

test("the resolver follows tsconfig paths, extensionless specifiers, index files and node built-ins; an asset, a file of public/ or of a hidden directory, a rootDirs twin is an asset", async () => {
  const { createResolver } = await import("../src/resolve.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  await withTempDir("archdiff-resolve-", (dir) => {
    for (const sub of ["src/lib", "src/locales/en", "src/theme", "src/routes", "public/images", ".storybook", ".react-router/types/src/routes/+types"]) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", rootDirs: [".", "./.react-router/types"], paths: { "@/*": ["src/*"], "@storybook/test-utils": ["./.storybook/test-utils"] } } }));
    for (const file of ["src/lib/a.ts", "src/lib/index.ts", "src/b.ts", "src/routes/home.tsx", "src/locales/en/translations.json", "src/theme/index.css", "public/images/a.svg", ".storybook/test-utils.ts", ".react-router/types/src/routes/+types/home.ts"]) writeFileSync(join(dir, file), "");
    const resolve = createResolver(dir, ["src/lib/a.ts", "src/lib/index.ts", "src/b.ts", "src/routes/home.tsx"]);
    assert.deepEqual(resolve("src/b.ts", "@/lib/a"), { kind: "file", path: "src/lib/a.ts" });
    assert.deepEqual(resolve("src/b.ts", "./lib"), { kind: "file", path: "src/lib/index.ts" });
    assert.deepEqual(resolve("src/b.ts", "./lib/a.ts"), { kind: "file", path: "src/lib/a.ts" });
    assert.deepEqual(resolve("src/b.ts", "node:fs"), { kind: "builtin", name: "fs" });
    assert.deepEqual(resolve("src/b.ts", "react-dom/client"), { kind: "package", name: "react-dom" });
    assert.equal(resolve("src/b.ts", "./nope").kind, "unresolved");
    // An alias of a JSON or a stylesheet (with a bundler's `?url`), an absolute path public/ serves, a source under a hidden directory: assets, nothing missing.
    assert.deepEqual(resolve("src/b.ts", "@/locales/en/translations.json"), { kind: "asset", path: "src/locales/en/translations.json" });
    assert.deepEqual(resolve("src/b.ts", "@/theme/index.css?url"), { kind: "asset", path: "src/theme/index.css" });
    assert.deepEqual(resolve("src/b.ts", "/images/a.svg"), { kind: "asset", path: "public/images/a.svg" });
    assert.deepEqual(resolve("src/b.ts", "@storybook/test-utils"), { kind: "asset", path: ".storybook/test-utils.ts" });
    assert.deepEqual(resolve("src/b.ts", "../.storybook/test-utils"), { kind: "asset", path: ".storybook/test-utils.ts" });
    assert.deepEqual(resolve("src/b.ts", "@/nope"), { kind: "unresolved", reason: "no file for the tsconfig path @/*: @/nope" });
    assert.deepEqual(resolve("src/b.ts", "/images/nope.svg"), { kind: "unresolved", reason: "no such file: /images/nope.svg" });
    // `rootDirs` read as one directory: React Router's `./+types/home` is the generated twin; one not generated says so.
    assert.deepEqual(resolve("src/routes/home.tsx", "./+types/home"), { kind: "asset", path: ".react-router/types/src/routes/+types/home.ts" });
    assert.deepEqual(resolve("src/routes/home.tsx", "./+types/about"), { kind: "unresolved", reason: "no such file: ./+types/about, nor .react-router/types/src/routes/+types/about of the tsconfig rootDirs" });
  });
});
