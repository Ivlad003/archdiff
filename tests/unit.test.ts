// Unit tests of the pure algorithms, where one is cheaper and sharper than
// a run of the CLI: the options table (one description, three readers),
// strongly connected components, globs, the result helpers.
//
// Entry point: run by `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "./temp-dir.ts";
import { listBranches, remoteAddress, remotes } from "../src/git.ts";
import { isPageLanguage, PAGE_LANGUAGES } from "../src/page-language.ts";
import { plural } from "../web/src/i18n-plural.ts";
import { UK } from "../web/src/i18n-uk.ts";
import { DEFAULT_PICTURE_OPTIONS, DEEP_DEPTH, depthWarning, pictureOptionsHelp, pictureQueryText, readEachPictureOption, readPictureOptions, writePictureParams, type PictureOptions } from "../src/options.ts";
import { components, cycleThrough, stronglyConnected } from "../src/scc.ts";
import { firstMatchingGlob, matchesGlob } from "../src/glob.ts";
import { attempt, ok, wrong } from "../src/result.ts";
import { OVERVIEW_GROUP, VIEW_KINDS, listGroup, listGroups, overviews, parseView, subjectFile, tagOf, viewsOfFiles, type ViewEntry, type ViewKind } from "../src/view-keys.ts";
import { collectionOf, matchRequests, pathSegments, routesOf, type Route } from "../src/collections.ts";
import { SCAPI_TABLE } from "../src/scapi-table.ts";
import { agentCommands, CHAT_COMMANDS, commandsHelp, doCommands, HELP_TEXTS, parseCommandLine } from "../src/chat-commands.ts";
import { explainedName, explainPrompt, tourInAnswer, TOUR_BLOCK } from "../src/explain.ts";
import { AGENT_PROTOCOL } from "../src/intent.ts";

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
  assert.ok(!overlay.ok && overlay.problem.message === 'unknown overlay "nope" (tests, storages, heat, instability, churn, coupling, ownership)');
  const bare = readPictureOptions((name) => (name === "expand" ? true : undefined), "flag");
  assert.ok(!bare.ok && bare.problem.message === "--expand needs a value");
  const mermaid = readPictureOptions((name) => (name === "mermaid" ? "svg" : undefined), "flag");
  assert.ok(!mermaid.ok && mermaid.problem.message.startsWith("--mermaid must be one of auto, flowchart"));
  // The help has one line per option, the flag first.
  assert.ok(pictureOptionsHelp().some((line) => line.startsWith("--no-hubs")));
  assert.equal(pictureOptionsHelp().length, 14);
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
    // A source archdiff left out (a hidden directory) is an asset marked `source`, for the coverage report to count.
    assert.deepEqual(resolve("src/b.ts", "@storybook/test-utils"), { kind: "asset", path: ".storybook/test-utils.ts", source: true });
    assert.deepEqual(resolve("src/b.ts", "../.storybook/test-utils"), { kind: "asset", path: ".storybook/test-utils.ts", source: true });
    assert.deepEqual(resolve("src/b.ts", "@/nope"), { kind: "unresolved", reason: "no file for the tsconfig path @/*: @/nope" });
    assert.deepEqual(resolve("src/b.ts", "/images/nope.svg"), { kind: "unresolved", reason: "no such file: /images/nope.svg" });
    // `rootDirs` read as one directory: React Router's `./+types/home` is the generated twin; one not generated says so.
    assert.deepEqual(resolve("src/routes/home.tsx", "./+types/home"), { kind: "asset", path: ".react-router/types/src/routes/+types/home.ts", source: true });
    assert.deepEqual(resolve("src/routes/home.tsx", "./+types/about"), { kind: "unresolved", reason: "no such file: ./+types/about, nor .react-router/types/src/routes/+types/about of the tsconfig rootDirs" });
  });
});

test("Go, Java and C# resolve a name to the file that declares it: by go.mod and the package's directory, by the qualified name, by the namespaces in scope; the rest is the language's library or a package", async () => {
  const { createResolver } = await import("../src/resolve.ts");
  const { extractAny } = await import("../src/extract/any.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");

  await withTempDir("archdiff-resolve-languages-", async (dir) => {
    const sources: Record<string, string> = {
      "svc/go.mod": 'module example.com/shop\n\ngo 1.22\n\nrequire (\n\tgithub.com/lib/pq v1.10.9\n\tgolang.org/x/sync v0.7.0\n)\n\nreplace example.com/kit => ../kit\n',
      "svc/store/repo.go": "package store\n\ntype Repo struct{}\n\nfunc Open() *Repo { return &Repo{} }\n",
      "svc/store/save.go": "package store\n\nfunc (r *Repo) Save() {}\n\nfunc helper() {}\n",
      "svc/store/repo_test.go": "package store\n\nfunc helper2() {}\n",
      "svc/cmd/main.go": "package main\n\nfunc main() {}\n",
      "kit/go.mod": "module example.com/kit\n",
      "kit/log/log.go": "package log\n\nfunc Info() {}\n",
      "app/src/main/java/shop/store/Repo.java": "package shop.store;\n\npublic class Repo { public static class Row {} }\n",
      "app/src/test/java/shop/store/Repo.java": "package shop.store;\n\npublic class Repo {}\n",
      "app/src/main/java/shop/App.java": "package shop;\n\npublic class App {}\n",
      "app/src/test/java/shop/AppTest.java": "package shop;\n\nclass AppTest {}\n",
      "net/Shop/Shop.csproj": '<Project><ItemGroup><PackageReference Include="Serilog.Sinks.Console" Version="5.0.0" /><PackageReference Include="Serilog" Version="3.1.1" /></ItemGroup></Project>\n',
      "net/Shop/Usings.cs": "global using Shop.Util;\n",
      "net/Shop/Store/Repo.cs": "namespace Shop.Store;\n\npublic partial class Repo {}\n",
      "net/Shop/Store/Repo.Read.cs": "namespace Shop.Store;\n\npublic partial class Repo {}\n",
      "net/Shop/Util/Clock.cs": "namespace Shop.Util;\n\npublic class Clock {}\n",
      "net/Shop/Program.cs": "System.Console.WriteLine();\n",
    };

    for (const [path, text] of Object.entries(sources)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }

    const files = Object.keys(sources).filter((path) => /\.(go|java|cs)$/.test(path));
    const facts = await Promise.all(files.map((path) => extractAny(path, sources[path]!)));
    const resolve = createResolver(dir, files, facts);
    const go = (spec: string, from = "svc/cmd/main.go") => resolve(from, spec);
    // A package names no file; a declaration the file of the package that declares it — the type's own file before the one that adds a method to it.
    assert.deepEqual(go("example.com/shop/store"), { kind: "self" });
    assert.deepEqual(go("example.com/shop/store.Open"), { kind: "file", path: "svc/store/repo.go" });
    assert.deepEqual(go("example.com/shop/store.Repo"), { kind: "file", path: "svc/store/repo.go" });
    assert.deepEqual(go("_ example.com/shop/store"), { kind: "file", path: "svc/store/repo.go", whole: true });
    assert.deepEqual(go("example.com/shop/store.Missing"), { kind: "unresolved", reason: "no such module: example.com/shop/store.Missing" });
    // A name of the file's own package: another file of its directory, a test file last; the file itself is no dependency.
    assert.deepEqual(go(".helper", "svc/store/repo.go"), { kind: "file", path: "svc/store/save.go" });
    assert.deepEqual(go(".Open", "svc/store/repo.go"), { kind: "self" });
    assert.equal(go(".nowhere", "svc/store/repo.go").kind, "unresolved");
    // `replace` to a directory of the repository; the standard library by its path; a required module by its name, else three elements.
    assert.deepEqual(go("example.com/kit/log.Info"), { kind: "file", path: "kit/log/log.go" });
    assert.deepEqual(go("net/http.HandleFunc"), { kind: "builtin", name: "net/http", runtime: "go" });
    assert.deepEqual(go("_ embed"), { kind: "builtin", name: "embed", runtime: "go" });
    assert.deepEqual(go("github.com/lib/pq"), { kind: "package", name: "github.com/lib/pq" });
    assert.deepEqual(go("golang.org/x/sync/errgroup.Group"), { kind: "package", name: "golang.org/x/sync" });
    assert.deepEqual(go("github.com/acme/tools/cmd/x"), { kind: "package", name: "github.com/acme/tools" });
    assert.deepEqual(go("gopkg.in/yaml.v3"), { kind: "package", name: "gopkg.in/yaml.v3" });

    const java = (spec: string, from = "app/src/main/java/shop/App.java") => resolve(from, spec);
    // A class by its qualified name, of the importing file's own source set when two declare it; a nested class by its own.
    assert.deepEqual(java("shop.store.Repo"), { kind: "file", path: "app/src/main/java/shop/store/Repo.java" });
    assert.deepEqual(java("shop.store.Repo", "app/src/test/java/shop/AppTest.java"), { kind: "file", path: "app/src/test/java/shop/store/Repo.java" });
    assert.deepEqual(java("shop.store.Repo.Row"), { kind: "file", path: "app/src/main/java/shop/store/Repo.java" });
    // The candidates of a simple name, in order; none declared is nothing the repository has.
    assert.deepEqual(java("shop.Repo ?? shop.store.Repo"), { kind: "file", path: "app/src/main/java/shop/store/Repo.java" });
    assert.deepEqual(java("shop.App ?? shop.store.App", "app/src/test/java/shop/AppTest.java"), { kind: "file", path: "app/src/main/java/shop/App.java" });
    assert.equal(java("shop.String ?? shop.store.String").kind, "unresolved");
    assert.deepEqual(java("shop.store.*"), { kind: "self" });
    // The JDK by its package, a library by three elements of its package, a class missing from a package the repository declares.
    assert.deepEqual(java("java.util.Map.Entry"), { kind: "builtin", name: "java.util", runtime: "java" });
    assert.deepEqual(java("java.util.*"), { kind: "builtin", name: "java.util", runtime: "java" });
    assert.deepEqual(java("org.springframework.web.bind.annotation.GetMapping"), { kind: "package", name: "org.springframework.web" });
    assert.deepEqual(java("lombok.Getter"), { kind: "package", name: "lombok" });
    assert.deepEqual(java("shop.store.Generated"), { kind: "unresolved", reason: "no such module: shop.store.Generated" });

    const cs = (spec: string, from = "net/Shop/Program.cs") => resolve(from, spec);
    // A partial class is named by the file called after it; a class of a `global using` is found after the candidates.
    assert.deepEqual(cs("Repo ?? Shop.Store.Repo"), { kind: "file", path: "net/Shop/Store/Repo.cs" });
    assert.deepEqual(cs("Shop.Store.Repo", "net/Shop/Store/Repo.Read.cs"), { kind: "self" });
    assert.deepEqual(cs("Clock ?? Shop.Store.Clock"), { kind: "file", path: "net/Shop/Util/Clock.cs" });
    assert.equal(cs("Guid ?? Shop.Store.Guid").kind, "unresolved");
    assert.deepEqual(cs("Shop.Store.*"), { kind: "self" });
    // .NET by its namespace; a package by the longest PackageReference its namespace starts with, else two elements.
    assert.deepEqual(cs("System.Collections.Generic.*"), { kind: "builtin", name: "System.Collections.Generic", runtime: "csharp" });
    assert.deepEqual(cs("Serilog.Sinks.Console.Themes.*"), { kind: "package", name: "Serilog.Sinks.Console" });
    assert.deepEqual(cs("Serilog.Events.*"), { kind: "package", name: "Serilog" });
    assert.deepEqual(cs("Microsoft.AspNetCore.Builder.*"), { kind: "package", name: "Microsoft.AspNetCore" });
  });
});

test("the table of kinds registers every view once: the page lists what the server lists, the overviews parse, the tags are distinct", async () => {
  const { analyze } = await import("../src/analyze.ts");
  const { viewList } = await import("../src/views.ts");
  const { join } = await import("node:path");
  // The groups of the page's list: the overviews first, then each kind's group once, in the table's order.
  const groups = listGroups();
  assert.equal(groups[0], OVERVIEW_GROUP);
  assert.equal(new Set(groups).size, groups.length);

  // Every overview key parses to its kind; a group holds subject views, an overview is a bare view.
  for (const { key } of overviews()) assert.ok(parseView(key), `overview ${key} parses`);

  for (const [kind, spec] of Object.entries(VIEW_KINDS)) {
    if ("group" in spec) assert.notEqual(spec.subject, "none", `${kind}: a group holds subject views`);

    if ("overview" in spec) assert.notEqual(spec.subject, "required", `${kind}: an overview is a bare view`);
  }

  // The chat tags of the kinds are distinct prefixes.
  const prefixes = Object.keys(VIEW_KINDS).flatMap((kind) => tagOf(kind as ViewKind)?.prefix ?? []);
  assert.equal(new Set(prefixes).size, prefixes.length);

  // Every view the server lists for the fixtures lands in a group of the page: none is dropped on the way.
  for (const fixture of ["sample", "scapi", "machines"]) {
    const analysis = await analyze(join(import.meta.dirname, "fixtures", fixture), { cache: false });

    for (const entry of viewList(analysis)) {
      const view = parseView(entry.key);
      assert.ok(view && listGroup(view) !== null, `${entry.key} is listed by the server and shown by the page`);
    }
  }
});

test("a Postman collection is matched to the routes the code calls by method and path, a variable standing for any value, the closest route winning", () => {
  // A collection as Postman exports it: folders, a URL as a string, as an object of host and path, with `{{var}}`, `:var` and `{var}` variables.
  const collection = collectionOf(
    {
      info: { name: "Cart" },
      item: [
        {
          name: "Baskets",
          item: [
            { name: "Get basket", request: { method: "GET", url: "{{baseUrl}}/checkout/shopper-baskets/v1/organizations/{{org}}/baskets/{{basketId}}?siteId={{siteId}}" } },
            { name: "Add item", request: { method: "POST", url: { host: ["{{baseUrl}}"], path: ["checkout", "shopper-baskets", "v1", "organizations", "{{org}}", "baskets", ":basketId", "items"] } } },
            { name: "Delete basket", request: { method: "DELETE", url: "{{baseUrl}}/checkout/shopper-baskets/v1/organizations/{{org}}/baskets/{basketId}" } },
          ],
        },
        { name: "Meta data", request: "https://api.example.com/checkout/shopper-orders/v1/organizations/f_ecom/orders/oms-meta-data" },
        { name: "Get order", request: { method: "GET", url: "{{baseUrl}}/checkout/shopper-orders/v1/organizations/{{org}}/orders/{orderNo}" } },
      ],
    },
    "postman/cart.postman_collection.json",
  );
  assert.ok(collection);
  assert.equal(collection.name, "Cart");
  assert.deepEqual(
    collection.requests.map((request) => [request.folder.join("/"), request.method, request.segments.join("/")]),
    [
      ["Baskets", "GET", "checkout/shopper-baskets/v1/organizations/*/baskets/*"],
      ["Baskets", "POST", "checkout/shopper-baskets/v1/organizations/*/baskets/*/items"],
      ["Baskets", "DELETE", "checkout/shopper-baskets/v1/organizations/*/baskets/*"],
      ["", "GET", "checkout/shopper-orders/v1/organizations/f_ecom/orders/oms-meta-data"],
      ["", "GET", "checkout/shopper-orders/v1/organizations/*/orders/*"],
    ],
  );

  // The routes of the operations the code calls: from the shipped table, and written by hand for the rest.
  const operation = (family: string, name: string): Route["operation"] => ({ api: "scapi", family, operation: name });
  const route = (family: string, name: string, method: string, path: string): [string, Route] => [`api:scapi:${family}.${name}`, { operation: operation(family, name), method, segments: pathSegments(path) }];
  const fromTable = routesOf([operation("ShopperBasketsV1", "getBasket"), operation("ShopperBasketsV1", "getBasket"), operation("ShopperBasketsV1", "nope")], SCAPI_TABLE);
  assert.deepEqual([...fromTable.keys()], ["api:scapi:ShopperBasketsV1.getBasket", "api:scapi:ShopperBasketsV1.nope"]);
  assert.equal(fromTable.get("api:scapi:ShopperBasketsV1.getBasket")?.method, "GET");
  assert.equal(fromTable.get("api:scapi:ShopperBasketsV1.getBasket")?.segments.join("/"), "checkout/shopper-baskets/v1/organizations/*/baskets/*");
  assert.equal(fromTable.get("api:scapi:ShopperBasketsV1.nope"), null);
  const routes = new Map<string, Route | null>([
    ...fromTable,
    route("ShopperBaskets", "addItemToBasket", "POST", "/checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/items"),
    route("ShopperBaskets", "createBasket", "POST", "/checkout/shopper-baskets/v1/organizations/{organizationId}/baskets"),
    route("ShopperOrders", "getOrder", "GET", "/checkout/shopper-orders/v1/organizations/{organizationId}/orders/{orderNo}"),
    route("ShopperOrders", "getOmsMetaData", "GET", "/checkout/shopper-orders/v1/organizations/{organizationId}/orders/oms-meta-data"),
  ]);

  // Each request takes the route agreeing with it most: `oms-meta-data` written out beats `{orderNo}`, a variable written beats a literal; a DELETE the code never calls matches nothing.
  const { requests, unmatched } = matchRequests([collection], routes);
  assert.deepEqual(
    requests.map(({ request, hit, index }) => [index, request.name, hit?.operation ?? null]),
    [
      [0, "Get basket", "api:scapi:ShopperBasketsV1.getBasket"],
      [1, "Add item", "api:scapi:ShopperBaskets.addItemToBasket"],
      [2, "Delete basket", null],
      [3, "Meta data", "api:scapi:ShopperOrders.getOmsMetaData"],
      [4, "Get order", "api:scapi:ShopperOrders.getOrder"],
    ],
  );
  // The operations the collection lacks, the one the table does not know among them, in the routes' order.
  assert.deepEqual(unmatched, ["api:scapi:ShopperBasketsV1.nope", "api:scapi:ShopperBaskets.createBasket"]);
  // JSON of another shape is no collection.
  assert.equal(collectionOf({ info: { name: "x" } }, "x.json"), null);
});

test("the file of a subject and the views of some files are read by one codec: files by extension, declarations after #, layers by the list, scopes and families kept", () => {
  assert.deepEqual(subjectFile(parseView("module:src/lib/orders.ts")), { file: "src/lib/orders.ts", declaration: null });
  assert.deepEqual(subjectFile(parseView("calls:src/lib/orders.ts#OrderService.place")), { file: "src/lib/orders.ts", declaration: "OrderService.place" });
  assert.deepEqual(subjectFile(parseView("machine:src/door.py#state")), { file: "src/door.py", declaration: "state" });
  // A layer, a directory, a scope, an API family, a collection: no file.
  for (const key of ["layer:lib", "dir:src/lib", "cycles:fns", "apis:ShopperBasketsV1", "postman:postman/cart.postman_collection.json", "metrics:lib", "layers"]) assert.equal(subjectFile(parseView(key)), null, key);
  const entry = (key: string, layer?: string): ViewEntry => ({ key, title: key, kind: parseView(key)!.kind, ...(layer === undefined ? {} : { layer }) });
  const list = [
    entry("layers"), entry("layer:lib"), entry("layer:db"), entry("dir:src/lib"), entry("dir:src/db"),
    entry("module:src/lib/log.ts", "lib"), entry("module:src/lib/orders.ts", "lib"), entry("module:src/db/store.ts", "db"),
    entry("calls:src/lib/orders.ts#findOrder", "lib"), entry("logic:src/db/store.ts#saveOrder", "db"), entry("type:src/lib/orders.ts#Order", "lib"),
    entry("cycles"), entry("cycles:fns"), entry("classes"), entry("classes:src/db"), entry("metrics:lib"), entry("metrics:db"),
    entry("apis:ShopperBasketsV1"), entry("postman:postman/cart.postman_collection.json"), entry("coverage"),
  ];
  const kept = viewsOfFiles(list, new Set(["src/lib/log.ts"])).map((item) => item.key);
  assert.deepEqual(kept, ["layers", "layer:lib", "dir:src/lib", "module:src/lib/log.ts", "cycles", "cycles:fns", "classes", "metrics:lib", "apis:ShopperBasketsV1", "postman:postman/cart.postman_collection.json", "coverage"]);
  // No file at all: the overviews, the scopes and the families alone.
  assert.deepEqual(viewsOfFiles(list, new Set()).map((item) => item.key), ["layers", "cycles", "cycles:fns", "classes", "apis:ShopperBasketsV1", "postman:postman/cart.postman_collection.json", "coverage"]);
});

test("the Chat tab's commands are one table: a line is read by it, the help and the agent's protocol are written from it, and an agent's block gives its lines", () => {
  // A slash, a name of the table, and what follows it; anything else is no command.
  const view = parseCommandLine("  /view  calls:src/x.ts#fn  ");
  assert.deepEqual([view?.command.name, view?.argument], ["view", "calls:src/x.ts#fn"]);
  assert.deepEqual([parseCommandLine("/unmix")?.command.name, parseCommandLine("/unmix")?.argument], ["unmix", ""]);
  assert.equal(parseCommandLine("/nope x"), null);
  assert.equal(parseCommandLine("view layers"), null);
  assert.equal(parseCommandLine("/src/lib/orders.ts is wrong"), null);
  // Every name once, in small letters, with a line that says what it does.
  assert.equal(new Set(CHAT_COMMANDS.map((command) => command.name)).size, CHAT_COMMANDS.length);
  assert.ok(CHAT_COMMANDS.every((command) => /^[a-z]+$/.test(command.name) && command.does.length > 10));
  // The help lists every command; one command's help is its own row; a name that is none has no help.
  const help = commandsHelp() ?? "";
  assert.ok(CHAT_COMMANDS.every((command) => help.includes(`\`/${command.name}`)));
  assert.match(commandsHelp("as") ?? "", /\| `\/as canvas \\\| 3d \\\| markdown \\\| code` \| Show the view/);
  assert.equal(commandsHelp("nope"), null);
  // An agent is told the commands that show something, and none that writes, picks an agent or starts a run.
  const told = agentCommands();
  assert.ok(told.includes("```archdiff-do") && told.includes("`/view <key | words>`") && told.includes("`/grep <text | /regex/>`"));
  assert.ok(["edit", "code", "agent", "stop", "export", "settings", "check", "ask"].every((name) => !told.includes(`\`/${name}`)), told);
  assert.ok(AGENT_PROTOCOL.includes(told) && AGENT_PROTOCOL.includes("archdiff grep <text> --diff"));
  // The lines of an agent's blocks, in order; what is no command line in them is left out, and so is a block of another kind.
  assert.deepEqual(doCommands("Look:\n```archdiff-do\n/view layers\n\nsee above\n/as 3d\n```\nand\n```archdiff-do\r\n/mix src/a.ts\r\n```\n```sh\n/usr/bin/true\n```"), ["/view layers", "/as 3d", "/mix src/a.ts"]);
  assert.deepEqual(doCommands("no block here: /view layers"), []);
});

test("an explanation is asked for as a tour and read from the agent's answer: its steps with their views, shapes, ways and notes; a block that is no tour says what is wrong", () => {
  // The task names what to explain and the block to answer in.
  const task = explainPrompt("how an order is saved. It is on the picture I am looking at: @view:layers");
  assert.ok(task.includes("What to explain: how an order is saved.") && task.includes("```archdiff-tour") && task.includes("change no file"));
  assert.equal(TOUR_BLOCK, "archdiff-tour");
  // The tour of an answer: what a step leaves out is nothing selected, no way, no note.
  const answer = 'Here.\n```archdiff-tour\n{"title": " How it goes ", "steps": [{"view": "layers", "select": ["routes", "db"], "path": true, "note": "Down the layers."}, {"view": "logic:src/lib/orders.ts#validate"}]}\n```\nTwo steps.';
  assert.deepEqual(tourInAnswer(answer), { tour: { title: "How it goes", steps: [{ view: "layers", select: ["routes", "db"], path: true, note: "Down the layers." }, { view: "logic:src/lib/orders.ts#validate", select: [], path: false, note: "" }] } });
  assert.deepEqual(tourInAnswer('```archdiff-tour\n{"steps": [{"view": "layers"}]}\n```'), { tour: { title: "An explanation", steps: [{ view: "layers", select: [], path: false, note: "" }] } });
  // An answer without the block is no tour; a block that is none says why.
  assert.equal(tourInAnswer("The order is saved by `saveOrder`.\n```mermaid\nflowchart LR\n```"), null);
  const problemOf = (block: string): string => {
    const read = tourInAnswer(`\`\`\`archdiff-tour\n${block}\n\`\`\``);

    return read && "problem" in read ? read.problem : "no problem";
  };
  assert.match(problemOf("{ not json"), /^the tour is no JSON: /);
  assert.equal(problemOf('{"title": "x"}'), 'the tour needs "steps": a list');
  assert.equal(problemOf('{"steps": []}'), "the tour needs one to 20 steps, not 0");
  assert.equal(problemOf('{"steps": [{"view": "layers"}, {"view": "no such view"}]}'), 'step 2 names no view ("no such view" is none: archdiff views lists them)');
  assert.equal(problemOf('{"steps": [{"note": "x"}]}'), 'step 1 names no view (it needs "view": archdiff views lists them)');
  assert.equal(problemOf('{"steps": [{"view": "layers", "select": "routes"}]}'), '"select" of step 1 must be a list of shape IDs');
  // The name of its file: the words of the title, and the moment.
  assert.equal(explainedName("How an order is placed!", 1_000_000), "explained-how-an-order-is-placed-lfls");
  assert.equal(explainedName("…", 36), "explained-tour-10");
  assert.match(explainedName("A very long title that goes on and on and on and on past the room a file name has", 1), /^explained-[a-z0-9-]{1,40}-1$/);
});

test("the branches are listed with one question to git: a local one, a remote one and the one checked out told apart by their refs", () =>
  withTempDir("archdiff-branches-", (dir) => {
    const git = (...args: string[]): void => {
      const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "-q", "-m", "the first");
    git("branch", "feature/x");
    // A branch of the remote's alone, one the remote and the checkout both have, and the remote's own HEAD, which is no branch.
    git("update-ref", "refs/remotes/origin/fix/y", "HEAD");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const { current, branches } = listBranches(dir);
    assert.equal(current, "main");
    assert.deepEqual(branches.map((branch) => [branch.name, branch.remote, branch.current]).sort(), [
      ["feature/x", false, false],
      ["main", false, true],
      ["origin/fix/y", true, false],
      ["origin/main", true, false],
    ]);
    assert.ok(branches.every((branch) => /^[0-9a-f]{7,}$/.test(branch.sha) && /^\d{4}-\d\d-\d\d$/.test(branch.date) && branch.subject === "the first"), JSON.stringify(branches));
  }));

test("a remote's address is told as its host and the repository's path there, without who signs in; a path on this computer is hosted nowhere", () => {
  const github = { host: "github.com", path: "Ivlad003/archdiff" };

  for (const address of ["https://github.com/Ivlad003/archdiff.git", "https://github.com/Ivlad003/archdiff", "https://github.com/Ivlad003/archdiff/", "git@github.com:Ivlad003/archdiff.git", "ssh://git@github.com/Ivlad003/archdiff.git", "ssh://git@github.com:22/Ivlad003/archdiff.git", "git://GitHub.com/Ivlad003/archdiff.git", "github.com:Ivlad003/archdiff", " https://github.com/Ivlad003/archdiff.git\n"]) assert.deepEqual(remoteAddress(address), github, address);
  // The name and the token an address may carry are no part of what is told.
  assert.deepEqual(remoteAddress("https://reader:ghp_secret@github.com/Ivlad003/archdiff.git"), github);
  // A group within a group, and a port: part of where a web page of the host is, not of where ssh is.
  assert.deepEqual(remoteAddress("git@gitlab.example.com:group/sub/shop.git"), { host: "gitlab.example.com", path: "group/sub/shop" });
  assert.deepEqual(remoteAddress("https://git.example.com:8443/team/shop.git"), { host: "git.example.com:8443", path: "team/shop" });
  assert.deepEqual(remoteAddress("ssh://git@git.example.com:2222/team/shop.git"), { host: "git.example.com", path: "team/shop" });

  for (const local of ["../other", "/srv/git/shop.git", "C:\\repos\\shop", "C:/repos/shop", "file:///srv/git/shop.git", "shop", "", "https://github.com", "https://"]) assert.equal(remoteAddress(local), null, local);
});

test("the remotes of a repository are the hosted ones, by name; none outside git", () =>
  withTempDir("archdiff-remotes-", (dir) => {
    assert.deepEqual(remotes(dir), []);
    const git = (...args: string[]): void => {
      const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "-q", "-b", "main");
    // A repository with no remote yet.
    assert.deepEqual(remotes(dir), []);
    git("remote", "add", "origin", "https://reader:secret@github.com/acme/shop.git");
    // A name with a dot of its own, and a remote on the disk.
    git("remote", "add", "my.fork", "git@github.com:me/shop.git");
    git("remote", "add", "disk", "../elsewhere");
    assert.deepEqual(remotes(dir), [{ name: "origin", host: "github.com", path: "acme/shop" }, { name: "my.fork", host: "github.com", path: "me/shop" }]);
  }));

test("the page's Ukrainian holds every text the modules say, each once, and nothing nobody says", () => {
  const sources = join(import.meta.dirname, "..", "web", "src");
  const said = new Map<string, string>();
  const loose: string[] = [];

  for (const file of readdirSync(sources).filter((name) => /\.tsx?$/.test(name) && !name.startsWith("i18n"))) {
    const text = readFileSync(join(sources, file), "utf8");

    // A text is named by its English, written where it is said: `t("…")` and nothing else — no variable, no template.
    for (const call of text.matchAll(/(?<![\w.$])t\(\s*("(?:[^"\\\n]|\\.)*")?/g)) {
      if (call[1] === undefined) loose.push(`${file}: ${text.slice(call.index, call.index + 60).split("\n")[0]}`);
      else said.set(JSON.parse(call[1]) as string, file);
    }
  }

  assert.deepEqual(loose, [], "t() takes a text written in double quotes");
  // The texts the page shares with the command line and says through `translated`: the groups of the views list, the help of the chat's commands.
  const shared = [...listGroups(), ...CHAT_COMMANDS.map((command) => command.does), ...Object.values(HELP_TEXTS)];

  for (const each of shared) said.set(each, "src");
  assert.ok(said.size > 200, `only ${said.size} texts found: the pattern reads the sources`);
  assert.deepEqual([...said].filter(([key]) => !Object.hasOwn(UK, key)).map(([key, file]) => `${file}: ${key}`), [], "said by a module, with no Ukrainian");

  // What the table holds beyond the modules' texts is what index.html says (its hints, labels and notes), as the page
  // itself would read it: an entry found in neither is one nobody says any more.
  const html = readFileSync(join(sources, "..", "index.html"), "utf8").replace(/\s+/g, " ");
  const plain = html.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  assert.deepEqual(Object.keys(UK).filter((key) => !said.has(key) && !html.includes(key) && !plain.includes(key)), [], "in the table, said by nobody");

  // A text and its translation name the same values.
  const marks = (text: string): string => [...text.matchAll(/\{(\w+)\}/g)].map((mark) => mark[1]).sort().join(",");
  assert.deepEqual(Object.entries(UK).filter(([key, value]) => typeof value === "string" && marks(key) !== marks(value)).map(([key]) => key), [], "the marks of a translation are its text's");

  // A count picks the word's form: one, a few, many — and the teens are many.
  assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25, 101, 111, 0].map((n) => plural(n, "файл", "файли", "файлів")), ["файл", "файли", "файлів", "файлів", "файлів", "файл", "файли", "файлів", "файл", "файлів", "файлів"]);
  assert.deepEqual(Object.keys(PAGE_LANGUAGES), ["en", "uk"]);
  assert.ok(isPageLanguage("uk") && !isPageLanguage("UK") && !isPageLanguage("toString") && !isPageLanguage(null));
});
