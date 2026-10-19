// Behavioural tests through the real CLI on tests/fixtures/sample: the
// analysis, the views, every export format, the coverage map, and the
// review of a change in a temporary git repository.
//
// Entry point: run by `npm test`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withTempDir } from "./temp-dir.ts";

const root = join(import.meta.dirname, "..");

const require = (await import("node:module")).createRequire(import.meta.url);

const fixture = join(root, "tests/fixtures/sample");

/** git in `dir` as a test's author, failing the test when git refuses; its output, trimmed. */
function gitIn(dir: string): (...args: string[]) => string {
  return (...args) => {
    const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    return result.stdout.trim();
  };
}

function archdiff(args: string[], cwd = root): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "bin/archdiff.js"), ...args], { cwd, encoding: "utf8" });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("analyze reports the size of the fixture as JSON on stdout only", () => {
  const { status, stdout, stderr } = archdiff(["analyze", fixture, "--json", "--no-cache"]);
  assert.equal(status, 0, stderr);
  const stats = JSON.parse(stdout) as Record<string, number>;
  assert.equal(stats["files"], 5);
  assert.equal(stats["modules"], 5);
  assert.equal(stats["unresolvedImports"], 0);
  assert.ok(stats["calls"]! >= 7, `calls ${stats["calls"]}`);
  assert.equal(stderr, "");
});

test("views list the layers of archdiff.json, the modules, the route and hook entry points", () => {
  const { status, stdout } = archdiff(["views", fixture]);
  assert.equal(status, 0);
  const keys = stdout.trim().split("\n").map((line) => line.split("\t")[0]);
  assert.deepEqual(keys.slice(0, 5), ["layers", "layer:cartridge", "layer:db", "layer:lib", "layer:routes"]);
  assert.ok(keys.includes("module:src/lib/orders.ts"));
  assert.ok(stdout.includes("calls:src/routes/checkout.tsx#action\taction (src/routes/checkout.tsx) — route checkout.tsx: action"));
  assert.ok(stdout.includes("hook dw.ocapi.shop.basket.modifyGETResponse"));
  assert.ok(keys.includes("coverage") && keys.includes("matrix") && keys.includes("timeline"));
});

test("the layers diagram follows tsconfig paths and counts the imports between layers", () => {
  const { status, stdout } = archdiff(["diagram", "layers", fixture, "--format", "mermaid"]);
  assert.equal(status, 0);
  assert.ok(stdout.includes('routes -->|"1"| lib'), stdout);
  assert.ok(stdout.includes('lib -->|"1"| db'), stdout);
  // A type-only import does not couple layers.
  assert.ok(!stdout.includes("db -->"), stdout);
});

test("a calls view draws the call tree from an entry point in lanes, as Markdown with Mermaid", () => {
  const { status, stdout } = archdiff(["diagram", "calls:src/lib/orders.ts#placeOrder", fixture]);
  assert.equal(status, 0);
  assert.match(stdout, /^<!-- archdiff:generated — view calls:src\/lib\/orders\.ts#placeOrder — commit [0-9a-f]+ \(\d{4}-\d\d-\d\d\) -->\n# Calls from placeOrder\n/);
  assert.ok(stdout.includes('subgraph "lib"'));
  assert.ok(stdout.includes("src_lib_orders_ts_placeOrder ==> src_db_store_ts_saveOrder"), stdout);
  assert.ok(stdout.includes("src_lib_orders_ts_placeOrder ==> src_lib_orders_ts_validate"), stdout);
  assert.ok(stdout.includes("- **saveOrder** `(order: Order) → void` — src/db/store.ts:"), stdout);
});

test("the module view shows its neighbours; --packages adds the packages, --depth 0 the module alone", () => {
  const deep = archdiff(["diagram", "module:src/db/store.ts", fixture, "--format", "json"]);
  assert.equal(deep.status, 0);
  const diagram = JSON.parse(deep.stdout) as { nodes: { id: string; kind: string; x: number; w: number }[]; edges: { from: string; to: string }[] };
  assert.deepEqual(
    diagram.nodes.map((node) => node.id).sort(),
    ["src/db/store.ts", "src/lib/orders.ts"],
  );
  assert.ok(diagram.nodes.every((node) => node.w > 0));
  const packages = JSON.parse(archdiff(["diagram", "module:src/db/store.ts", fixture, "--format", "json", "--packages"]).stdout) as { nodes: { id: string }[] };
  assert.deepEqual(
    packages.nodes.map((node) => node.id).sort(),
    ["node:fs", "src/db/store.ts", "src/lib/orders.ts"],
  );
  const shallow = archdiff(["diagram", "module:src/db/store.ts", fixture, "--format", "json", "--depth", "0", "--packages"]);
  const own = JSON.parse(shallow.stdout) as { nodes: { id: string }[] };
  assert.deepEqual(
    own.nodes.map((node) => node.id).sort(),
    ["node:fs", "src/db/store.ts"],
  );
});

test("a big view folds its tail into shapes by directory and says so", () => {
  const { status, stdout } = archdiff(["diagram", "layer:lib", fixture, "--format", "json", "--limit", "2"]);
  assert.equal(status, 0);
  const diagram = JSON.parse(stdout) as { nodes: { id: string; kind: string; count?: number }[]; edges: { from: string; to: string }[]; reason?: string };
  const more = diagram.nodes.filter((node) => node.kind === "more");
  assert.deepEqual(
    more.map((node) => [node.id, node.count]),
    [
      ["more:src/db", 1],
      ["more:src/routes", 1],
    ],
  );
  assert.ok(diagram.edges.some((edge) => edge.from.startsWith("more:") || edge.to.startsWith("more:")));
  assert.ok(diagram.reason?.includes("folded"));
  // The Markdown lists what each folded shape stands for, as the reason says.
  const markdown = archdiff(["diagram", "layer:lib", fixture, "--limit", "2"]).stdout;
  assert.ok(markdown.includes("- **… 1 in src/db/**\n  - src/db/store.ts\n"), markdown);
});

test("the whole map keeps every module up to 200 where the other views fold above 40", () =>
  withTempDir("archdiff-map-", (dir) => {
    // Fifty modules in a chain, each importing the next.
    mkdirSync(join(dir, "src"));

    for (let i = 0; i < 50; i++) writeFileSync(join(dir, `src/m${String(i).padStart(2, "0")}.ts`), i < 49 ? `import { f${i + 1} } from "./m${String(i + 1).padStart(2, "0")}";\n\nexport function f${i}(): number {\n  return f${i + 1}() + 1;\n}\n` : `export function f${i}(): number {\n  return ${i};\n}\n`);
    const shapes = (...args: string[]): { kinds: string[]; reason?: string } => {
      const diagram = JSON.parse(archdiff(["diagram", ...args, dir, "--format", "json"]).stdout) as { nodes: { kind: string }[]; reason?: string };

      return { kinds: diagram.nodes.map((node) => node.kind), ...(diagram.reason ? { reason: diagram.reason } : {}) };
    };
    const directory = shapes("dir:src");
    assert.ok(directory.kinds.includes("more") && (directory.reason ?? "").includes("folded"), JSON.stringify(directory));
    const map = shapes("modules");
    assert.equal(map.kinds.filter((kind) => kind === "module").length, 50);
    assert.ok(!map.kinds.includes("more"), JSON.stringify(map));
    // A limit given still folds it.
    assert.ok(shapes("modules", "--limit", "40").kinds.includes("more"));
  }));

/**
 * The first reason `xml` is not well-formed XML, or null: one root element, every tag closed in order, attribute
 * values quoted with no `<` in them, `&` only in an entity. Enough for the files archdiff writes (no DTD, no CDATA).
 */
function xmlProblem(xml: string): string | null {
  const body = xml.replace(/^<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  const bareAmpersand = (text: string): boolean => text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, "").includes("&");
  const open: string[] = [];
  let roots = 0;

  for (const piece of body.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (!piece.startsWith("<")) {
      if (bareAmpersand(piece)) return `a bare & in text: ${piece.slice(0, 60)}`;

      if (open.length === 0 && piece.trim() !== "") return `text outside the root: ${piece.slice(0, 60)}`;
      continue;
    }

    const tag = piece.match(/^<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*(\/?)>$/);

    if (!tag) return `not a tag: ${piece.slice(0, 80)}`;
    const [, closing, name, attributes, selfClosing] = tag;

    if (bareAmpersand(attributes ?? "")) return `a bare & in an attribute of <${name}>`;

    if (closing) {
      if (open.pop() !== name) return `</${name}> closes nothing open`;
    } else {
      if (open.length === 0) roots++;

      if (!selfClosing) open.push(name!);
    }
  }

  if (open.length > 0) return `<${open.at(-1)}> is never closed`;

  return roots === 1 ? null : `${roots} root elements`;
}

test("every export is well formed: the XML parses, every Excalidraw ID is unique and a bound text's element exists", () => {
  const machines = join(root, "tests/fixtures/machines");
  const pictures: [string, string][] = [
    ["layers", fixture],
    ["modules", fixture],
    ["module:src/lib/orders.ts", fixture],
    ["inside:src/lib/orders.ts", fixture],
    ["calls:src/routes/checkout.tsx#action", fixture],
    ["sequence:src/checkout.ts#checkout", machines],
    ["logic:src/order.ts#pay", machines],
    ["machine:src/order.ts#status", machines],
    // Two transitions between one pair of states, a line each.
    ["machine:src/light.ts#light", machines],
    ["classes", fixture],
    ["matrix", fixture],
    ["metrics", fixture],
    ["hotspots", fixture],
  ];

  for (const [view, dir] of pictures) {
    for (const format of ["drawio", "archimate"]) {
      const { status, stdout } = archdiff(["diagram", view, dir, "--format", format]);
      assert.equal(status, 0, `${view} ${format}`);
      assert.equal(xmlProblem(stdout), null, `${view} as ${format}`);
      const identifiers = [...stdout.matchAll(/identifier="([^"]+)"/g)].map((match) => match[1]);
      assert.equal(new Set(identifiers).size, identifiers.length, `${view} as ${format}: an identifier twice`);
    }

    const scene = JSON.parse(archdiff(["diagram", view, dir, "--format", "excalidraw"]).stdout) as { elements: { id: string; type: string; containerId?: string | null; boundElements: { id: string }[] | null }[] };
    const ids = scene.elements.map((element) => element.id);
    assert.equal(new Set(ids).size, ids.length, `${view}: an Excalidraw ID twice: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`);
    const known = new Set(ids);

    for (const element of scene.elements) {
      if (element.containerId) assert.ok(known.has(element.containerId), `${view}: ${element.id} is bound to a missing ${element.containerId}`);

      for (const bound of element.boundElements ?? []) assert.ok(known.has(bound.id), `${view}: ${element.id} names a missing bound element ${bound.id}`);
    }
  }

  // Mermaid 11 refuses an empty label (`[""]`), a bare parenthesis on an axis, a bracket in a mindmap's text.
  const matrix = archdiff(["diagram", "matrix", fixture, "--format", "mermaid"]).stdout;
  assert.ok(!matrix.includes('[""]') && matrix.includes('[" "]'), matrix);
  assert.ok(archdiff(["diagram", "metrics", fixture, "--format", "mermaid"]).stdout.includes('  x-axis "stable (depended upon)" --> "unstable (depends on others)"'));
  assert.match(archdiff(["diagram", "modules", fixture, "--format", "mermaid", "--mermaid", "mindmap"]).stdout, /\n {6}n\d+\["src\/lib\/orders\.ts"\]\n/);
  // A quadrant draws the hotspots or the metrics, nothing else.
  assert.ok(archdiff(["diagram", "matrix", fixture, "--format", "mermaid", "--mermaid", "quadrant"]).stdout.includes("%% --mermaid quadrant: quadrant draws the hotspots or the metrics, so the picture is written as its own type"));

  // The checker itself refuses what it should.
  assert.equal(xmlProblem('<a x="1"><b/></a>'), null);
  assert.notEqual(xmlProblem("<a><b></a></b>"), null);
  assert.notEqual(xmlProblem('<a x="R&D"/>'), null);
  assert.notEqual(xmlProblem("<a/><b/>"), null);
});

test("every export format is byte-stable and carries what it stands for", () => {
  const drawio = archdiff(["diagram", "layers", fixture, "--format", "drawio"]).stdout;
  assert.ok(drawio.startsWith('<mxfile host="archdiff"'));
  assert.ok(drawio.includes('archdiff_kind="layer" archdiff_id="lib"'));
  const excalidraw = JSON.parse(archdiff(["diagram", "layers", fixture, "--format", "excalidraw"]).stdout) as { type: string; elements: { id: string; type: string }[] };
  assert.equal(excalidraw.type, "excalidraw");
  assert.ok(excalidraw.elements.some((element) => element.id === "lib" && element.type === "rectangle"));
  assert.ok(excalidraw.elements.some((element) => element.type === "arrow"));
  const archimate = archdiff(["diagram", "layers", fixture, "--format", "archimate"]).stdout;
  assert.ok(archimate.includes('xmlns="http://www.opengroup.org/xsd/archimate/3.0/"'));
  assert.ok(archimate.includes('xsi:type="ApplicationComponent"><name xml:lang="en">lib</name>'));
  assert.ok(archimate.includes('xsi:type="Serving"'));
  assert.equal(archdiff(["diagram", "layers", fixture, "--format", "archimate"]).stdout, archimate);
});

test("coverage names what the diagrams cannot show, and counts only blind calls against the repository", () => {
  const { status, stdout } = archdiff(["coverage", fixture, "--json"]);
  assert.equal(status, 0);
  const report = JSON.parse(stdout) as { ratio: number; blind: number; byReason: Record<string, number>; markdown: string };
  assert.equal(report.blind, 0);
  assert.equal(report.ratio, 1);
  assert.ok(report.byReason["member-of-value"]! >= 1);
  assert.ok(report.markdown.includes("\n# Coverage: what the diagrams cannot show\n"));
});

test("a gap says why it is one: a long chain is a value's member, a Promise's resolve and a Map's method the language's, a call through a missing module a blind spot; the constructs not followed are listed", () =>
  withTempDir("archdiff-gaps-", (dir) => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/store.ts"), 'export const cache = new Map<string, number>();\nexport const NAMES = ["a", "b"];\nexport class Foo { constructor(n: number) {} run(): number { return n; } }\n');
    writeFileSync(join(dir, "src/use.ts"), 'import { cache, NAMES, Foo } from "./store";\nimport { gone } from "./missing";\nexport function use(name: string): Promise<number> {\n  fetch("/api/a/very/long/path/that/goes/on/and/on", { method: "POST", headers: { "x-one": "1" } }).then(() => 1);\n  cache.get(name);\n  NAMES.includes(name);\n  gone();\n  eval("1");\n  return new Promise((resolve, reject) => (name ? resolve(new Foo(1).run()) : reject(new Error(name))));\n}\n');
    const report = JSON.parse(archdiff(["coverage", dir, "--json"]).stdout) as { blind: number; byReason: Record<string, number>; unsupported: { module: string; line: number; reason: string }[]; markdown: string };
    const gaps = archdiff(["coverage", dir]).stdout;
    // The one blind spot is the call through the import that names no file; `new Foo(1).run()` is followed.
    assert.equal(report.blind, 1, gaps);
    assert.equal(report.byReason.unresolved, 1, gaps);
    assert.equal(report.byReason.dynamic, undefined, gaps);
    assert.ok(gaps.includes("- `gone` — unresolved (src/use.ts:7)"), gaps);
    assert.ok(archdiff(["diagram", "calls:src/use.ts#use", dir, "--format", "mermaid", "--depth", "1"]).stdout.includes("src_use_ts_use ==> src_store_ts_Foo_run"));
    // `eval` is read and not followed: the summary counts it and a section lists it.
    assert.deepEqual(report.unsupported.map((fact) => [fact.module, fact.line, fact.reason]), [["src/use.ts", 8, "unsupported construct `eval`"]]);
    assert.ok(gaps.includes("1 construct read but not followed.") && gaps.includes("## Constructs read but not followed\n\n- `eval` — unsupported construct `eval` (src/use.ts:8)"), gaps);
  }));

test("a wrong call exits 2 with one plain line on stderr: the view, the format, the command, an argument, a flag, --out, --port, archdiff.json, git", () =>
  withTempDir("archdiff-wrong-", (dir) => {
    /** The call exits 2 and says exactly this on stderr, nothing on stdout. */
    const refused = (args: string[], message: string): void => {
      const result = archdiff(args);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(result.stderr, `archdiff: ${message}\n`);
      assert.equal(result.stdout, "");
    };
    assert.equal(archdiff(["diagram", "nothing:x", fixture]).status, 2);
    assert.equal(archdiff(["diagram", "layers", fixture, "--format", "png"]).status, 2);
    refused(["frobnicate"], 'unknown command "frobnicate" (archdiff --help)');
    assert.equal(archdiff([]).status, 2);
    assert.equal(archdiff(["--help"]).status, 0);
    refused(["views", fixture, "extra"], 'views: unexpected argument "extra" (archdiff --help)');
    refused(["diagram", "layers", fixture, "--dpth", "2"], "diagram: unknown flag --dpth (did you mean --depth?)");
    refused(["diagram", "layers", fixture, "--out", dir], `--out ${dir}: a directory; name a file`);
    refused(["web", fixture, "--port", "abc"], "web: --port must be a port number");
    refused(["web", fixture, "--port", "70000"], "web: --port must be a port number");
    // A directory that is not there, a flag written short, a view plan does not know: said plainly.
    refused(["views", join(dir, "nope")], `views: no directory ${join(dir, "nope")}`);
    refused(["views", fixture, "-d"], "views: unknown flag -d (flags are written --name; archdiff --help lists them)");
    refused(["plan", "nope", fixture], 'plan: unknown view "nope" (archdiff views lists them)');
    // A flag of a value never takes the next flag for it, and alone it is a call without its value.
    refused(["metrics", fixture, "--out", "--json"], "metrics: --out needs a value");
    refused(["compare", fixture, "--heads", "--base", "main"], "compare: --heads needs a value");
    refused(["flow", "calls:src/lib/orders.ts#placeOrder", fixture, "--depth"], "flow: --depth needs a value");
    // A subject the code does not have: the reason, and once where the subjects are listed.
    refused(["diagram", "logic:src/nope.ts#f", fixture], 'diagram: no function "src/nope.ts#f" (archdiff views lists them)');
    refused(["diagram", "machine:src/nope.ts#f", fixture], 'diagram: no state machine "src/nope.ts#f" (archdiff diagram machines lists them)');
    refused(["flow", "calls:src/lib/orders.ts#nope", fixture], 'flow: no function "src/lib/orders.ts#nope"');
    refused(["spec", fixture, "--prompt", "module:src/lib/nope.ts"], 'spec: no module "src/lib/nope.ts"');
    // A broken archdiff.json names the file and the field; outside git, review says so.
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(join(dir, "archdiff.json"), '{ "layers": { "lib": "src/lib/**" } }');
    refused(["analyze", dir], 'archdiff.json: "layers.lib" must be a list of strings');
    writeFileSync(join(dir, "archdiff.json"), '{ "agent": 5 }');
    refused(["analyze", dir], 'archdiff.json: agent: must be "claude", "cursor", "codex", "opencode" or { "command": ["…"], "resume": "--flag" }');
    writeFileSync(join(dir, "archdiff.json"), '{ "layers": ');
    assert.match(archdiff(["analyze", dir]).stderr, /^archdiff: archdiff\.json: not valid JSON \(/);
    rmSync(join(dir, "archdiff.json"));
    refused(["review", dir], `${dir} is not a git repository`);
  }));

test("review reports the architectural diff of the working tree against a base commit", () =>
  withTempDir("archdiff-review-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = gitIn(dir);
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    // The change: the route imports the db directly (a new layer dependency), a function changes, one is added.
    writeFileSync(
      join(dir, "src/routes/checkout.tsx"),
      `import { OrderService } from "@/lib/orders";
import { readOrder } from "@/db/store";

export async function action(request: { total: number }) {
  const service = new OrderService("web");
  readOrder("x");
  return service.place(request.total);
}

export function loader() {
  return readOrder("y");
}

export default function Checkout() {
  return null;
}
`,
    );
    const { status, stdout } = archdiff(["review", dir, "--base", "HEAD"]);
    assert.equal(status, 1, stdout);
    assert.ok(stdout.includes("\n# Architecture changes since HEAD\n"));
    assert.ok(stdout.includes("## ⚠ New dependencies between layers\n\n- **routes → db**"), stdout);
    assert.ok(stdout.includes("- fn `action` — src/routes/checkout.tsx:4 (body)"), stdout);
    assert.ok(stdout.includes("## Functions added\n\n- fn `loader`"), stdout);
    assert.ok(stdout.includes("- src/routes/checkout.tsx → src/db/store.ts"), stdout);
    assert.ok(stdout.includes("class src_routes_checkout_tsx changed"), stdout);
    // The import added is coloured as its module is: a line keeps its mark in Mermaid too.
    assert.match(stdout, /src_routes_checkout_tsx --> src_db_store_ts\n(.*\n)*  linkStyle \d+(,\d+)* stroke:#2e7d32,stroke-width:3px\n/);
    const json = JSON.parse(archdiff(["review", dir, "--base", "HEAD", "--format", "json"]).stdout) as { callsAdded: { from: string; to: string }[] };
    assert.ok(json.callsAdded.some((edge) => edge.from === "src/routes/checkout.tsx#action" && edge.to === "src/db/store.ts#readOrder"));
    // No change: exit 0 and an empty picture.
    git("commit", "-q", "-am", "change");
    const clean = archdiff(["review", dir, "--base", "HEAD"]);
    assert.equal(clean.status, 0);
    assert.ok(clean.stdout.includes("_no module, function, import or call changed_"));
  }));

test("--out writes a new file or one archdiff wrote, and refuses any other file", () =>
  withTempDir("archdiff-out-", (dir) => {
    const out = join(dir, "layers.md");
    assert.equal(archdiff(["diagram", "layers", fixture, "--out", out]).status, 0);
    const first = readFileSync(out, "utf8");
    assert.ok(first.startsWith("<!-- archdiff:generated"));
    // Written again: the same bytes.
    assert.equal(archdiff(["diagram", "layers", fixture, "--out", out]).status, 0);
    assert.equal(readFileSync(out, "utf8"), first);
    const theirs = join(dir, "notes.md");
    writeFileSync(theirs, "# my notes\n");
    const refused = archdiff(["diagram", "layers", fixture, "--out", theirs]);
    assert.equal(refused.status, 2);
    assert.ok(refused.stderr.includes("not written by archdiff; nothing written"));
    assert.equal(readFileSync(theirs, "utf8"), "# my notes\n");
    // A file that only mentions archdiff is the reader's; archdiff's own JSON of a command is written again.
    const manifest = join(dir, "package.json");
    writeFileSync(manifest, '{"devDependencies":{"@ivlad003/archdiff":"^0.5.0"}}\n');
    assert.equal(archdiff(["diagram", "layers", fixture, "--out", manifest]).status, 2);
    assert.equal(readFileSync(manifest, "utf8"), '{"devDependencies":{"@ivlad003/archdiff":"^0.5.0"}}\n');
    const metrics = join(dir, "metrics.json");
    assert.equal(archdiff(["metrics", fixture, "--json", "--out", metrics]).status, 0);
    assert.equal(archdiff(["metrics", fixture, "--json", "--out", metrics]).status, 0);
    for (const format of ["mermaid", "drawio", "excalidraw", "archimate", "json"]) {
      const exported = join(dir, `layers.${format}`);
      assert.equal(archdiff(["diagram", "layers", fixture, "--format", format, "--out", exported]).status, 0, format);
      assert.equal(archdiff(["diagram", "layers", fixture, "--format", format, "--out", exported]).status, 0, format);
    }
  }));

test("a file over the size limit is left out and named by the coverage report", () =>
  withTempDir("archdiff-big-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(join(dir, "src/lib/vendor.js"), `export const big = "${"x".repeat(1_600_000)}";\n`);
    const stats = JSON.parse(archdiff(["analyze", dir, "--json", "--no-cache"]).stdout) as { files: number };
    assert.equal(stats.files, 5);
    const report = JSON.parse(archdiff(["coverage", dir, "--json"]).stdout) as { skipped: { path: string; reason: string }[]; markdown: string };
    assert.deepEqual(
      report.skipped.map((file) => file.path),
      ["src/lib/vendor.js"],
    );
    assert.ok(report.markdown.includes("## Files not analysed\n\n- src/lib/vendor.js — 1.6 MB, over the 1.5 MB limit"));
    // After the modules' own sections: none of them reads as a file not analysed.
    assert.ok(report.markdown.indexOf("## Files not analysed") > report.markdown.lastIndexOf("\n### "), report.markdown);
  }));

test("a review of a directory inside the repository reads the files of that directory from git", () =>
  withTempDir("archdiff-subdir-", (dir) => {
    // The sample lives in app/ of the repository, beside a README at the top.
    cpSync(fixture, join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# top\n");
    const git = gitIn(dir);
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "report");
    writeFileSync(join(dir, "app/src/db/report.ts"), 'import { action } from "../routes/checkout.tsx";\n\nexport function report(): unknown {\n  return action({ total: 1 });\n}\n');
    git("add", ".");
    git("commit", "-q", "-m", "a report");
    git("checkout", "-q", "main");
    const review = JSON.parse(archdiff(["review", join(dir, "app"), "--head", "report", "--format", "json"]).stdout) as { modulesAdded: string[]; depsAdded: { from: string; to: string }[]; changedFiles: string[]; layerEdgesAdded: { from: string; to: string }[] };
    assert.deepEqual(review.modulesAdded, ["src/db/report.ts"]);
    assert.deepEqual(review.depsAdded, [{ from: "src/db/report.ts", to: "src/routes/checkout.tsx" }]);
    assert.deepEqual(review.changedFiles, ["src/db/report.ts"]);
    assert.deepEqual(review.layerEdgesAdded.map((edge) => `${edge.from}→${edge.to}`), ["db→routes"]);
    // The code of a branch, from the directory: the module is there.
    assert.ok(archdiff(["diagram", "modules", join(dir, "app"), "--head", "report", "--format", "mermaid"]).stdout.includes("src_db_report_ts"));
  }));

test("review measures the change from the merge-base, not from the tip of main", () =>
  withTempDir("archdiff-mb-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = gitIn(dir);
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "src/lib/log.ts"), "export function log(message: string): void {\n  console.error(message);\n}\n");
    git("commit", "-q", "-am", "feature: log to stderr");
    // Main moves on after the branch point: a new module there is not this change.
    git("checkout", "-q", "main");
    writeFileSync(join(dir, "src/lib/extra.ts"), "export function extra(): number {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "main: extra");
    git("checkout", "-q", "feature");
    const { status, stdout } = archdiff(["review", dir]);
    assert.equal(status, 0, stdout);
    assert.ok(stdout.includes("- fn `log` — src/lib/log.ts:1 (body)"), stdout);
    assert.ok(!stdout.includes("extra"), stdout);
    // Reviewing the branch from main: its own start, not the checkout's (which is main's tip): extra is still not its doing.
    git("checkout", "-q", "main");
    const other = archdiff(["review", dir, "--head", "feature"]);
    assert.equal(other.status, 0, other.stdout);
    assert.ok(other.stdout.includes("- fn `log` — src/lib/log.ts:1 (body)") && !other.stdout.includes("extra"), other.stdout);
    // So do the commits of its range and its history.
    const history = archdiff(["history", dir, "--head", "feature", "--json"]);
    assert.deepEqual((JSON.parse(history.stdout) as { commit: { subject: string } }[]).map((row) => row.commit.subject), ["feature: log to stderr"]);
  }));

test("flow lists the steps from an entry with their types, the storages, and the mocks carried by name", () =>
  withTempDir("archdiff-flow-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const plain = archdiff(["flow", "calls:src/lib/orders.ts#placeOrder", dir]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(plain.stdout.includes("- **placeOrder**(id: string, total: number) → Order — src/lib/orders.ts:7"), plain.stdout);
    assert.ok(plain.stdout.includes("  - **saveOrder**(order: Order) → void — src/db/store.ts:6 — storage: the file system"), plain.stdout);
    assert.ok(plain.stdout.includes("## Storages on the way\n\n- src/db/store.ts — the file system"), plain.stdout);
    // Mocks saved by the page: the input's keys reach the parameters of the same name.
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, ".archdiff/layouts"), { recursive: true });
    writeFileSync(
      join(dir, ".archdiff/layouts/calls_src_lib_orders.ts_placeOrder.json"),
      JSON.stringify({ format: 1, view: "calls:src/lib/orders.ts#placeOrder", elements: [], mocks: [{ id: "src/lib/orders.ts#placeOrder", kind: "input", value: '{"id": "o-1", "total": 42}' }, { id: "src/db/store.ts", kind: "storage", value: '{"order": {"id": "o-0"}}' }], saved: "2026-10-15T00:00:00.000Z" }),
    );
    const mocked = JSON.parse(archdiff(["flow", "calls:src/lib/orders.ts#placeOrder", dir, "--json"]).stdout) as { input?: string; steps: { name: string; params: { name: string; value?: string; from?: string }[]; content?: string }[] };
    assert.equal(mocked.input, '{"id": "o-1", "total": 42}');
    const entry = mocked.steps.find((step) => step.name === "placeOrder")!;
    assert.deepEqual(
      entry.params.map((param) => [param.name, param.value, param.from]),
      [
        ["id", '"o-1"', "input"],
        ["total", "42", "input"],
      ],
    );
    const save = mocked.steps.find((step) => step.name === "saveOrder")!;
    assert.equal(save.content, '{"order": {"id": "o-0"}}');
  }));

test("plan refuses a view without a drawing and web --agent refuses an unknown agent", () => {
  const missing = archdiff(["plan", "module:src/lib/orders.ts", fixture]);
  assert.equal(missing.status, 2);
  assert.ok(missing.stderr.includes("has no saved drawing"));
  const unknown = archdiff(["web", fixture, "--agent", "copilot"]);
  assert.equal(unknown.status, 2);
  assert.ok(unknown.stderr.includes(`"copilot" is not claude, cursor, codex or opencode`), unknown.stderr);
});

test("a repository with no commit yet says so: history and the timeline, and the branch checked out", () =>
  withTempDir("archdiff-unborn-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    gitIn(dir)("init", "-q", "-b", "trunk");
    for (const args of [["history", dir], ["diagram", "timeline", dir]]) {
      const result = archdiff(args);
      assert.equal(result.status, 2, args.join(" "));
      assert.equal(result.stderr, `archdiff: ${dir} has no commits yet\n`);
    }

    assert.ok(archdiff(["branches", dir]).stdout.includes("current: trunk\n"));
  }));

test("history lists the drift commit by commit, and review --head compares two refs", () =>
  withTempDir("archdiff-history-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = gitIn(dir);
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "src/lib/extra.ts"), "export function extra(): number {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "add extra");
    writeFileSync(join(dir, "src/routes/checkout.tsx"), 'import { OrderService } from "@/lib/orders";\nimport { readOrder } from "@/db/store";\n\nexport async function action(request: { total: number }) {\n  readOrder("x");\n  return new OrderService("web").place(request.total);\n}\n');
    git("commit", "-q", "-am", "route reads the store");
    writeFileSync(join(dir, "src/db/store.ts"), 'import type { Order } from "../lib/orders.ts";\n\nconst rows = new Map<string, Order>();\n\nexport function saveOrder(order: Order): void {\n  rows.set(order.id, order);\n}\n\nexport function readOrder(id: string): Order | null {\n  return rows.get(id) ?? null;\n}\n');
    git("commit", "-q", "-am", "the store reads no file");
    git("checkout", "-q", "main");
    const { status, stdout } = archdiff(["history", dir, "--base", "main", "--head", "feature"]);
    assert.equal(status, 0, stdout);
    const rows = stdout.split("\n").filter((line) => line.startsWith("| `"));
    assert.equal(rows.length, 3);
    // Functions added, removed and changed apart; a package that goes, as much as one that comes.
    assert.ok(rows[0]!.includes("add extra | ") && rows[0]!.includes("| +1 −0 | +1 −0 ~0 |"), rows[0]);
    assert.ok(rows[1]!.includes("route reads the store") && rows[1]!.includes("+routes→db"), rows[1]);
    assert.ok(rows[2]!.includes("the store reads no file") && rows[2]!.includes("| −node:fs |"), rows[2]);
    // The commits' files are cached apart from the working tree's, which a history run leaves whole.
    assert.ok(existsSync(join(dir, ".archdiff/revisions.json.gz")));
    assert.equal((JSON.parse(archdiff(["analyze", dir, "--json"]).stdout) as { cacheMisses: number }).cacheMisses, 0);
    // So does a review whose base differs in no source file (a README commit): its empty batch of revision files is no listing of the working tree.
    writeFileSync(join(dir, "README.md"), "# sample\n");
    git("add", ".");
    git("commit", "-q", "-m", "readme");
    assert.equal(archdiff(["review", dir, "--base", "HEAD~1"]).status, 0);
    assert.equal((JSON.parse(archdiff(["analyze", dir, "--json"]).stdout) as { cacheMisses: number }).cacheMisses, 0);
    git("checkout", "-q", "feature");
    // Two refs: the first commit alone adds a module and no coupling.
    const first = archdiff(["review", dir, "--base", "main", "--head", "feature~2"]);
    assert.equal(first.status, 0, first.stdout);
    assert.ok(first.stdout.includes("## Modules added\n\n- src/lib/extra.ts"), first.stdout);
    assert.ok(!first.stdout.includes("routes → db"));
    const second = archdiff(["review", dir, "--base", "feature~2", "--head", "feature~1"]);
    assert.equal(second.status, 1);
    assert.ok(second.stdout.includes("- **routes → db**"));
  }));

test("a package of a monorepo resolves imports through its own tsconfig, and extends reaches node_modules", () =>
  withTempDir("archdiff-mono-", (dir) => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "packages/app/src"), { recursive: true });
    mkdirSync(join(dir, "packages/app/node_modules/@acme/tsconfig"), { recursive: true });
    writeFileSync(join(dir, "packages/app/node_modules/@acme/tsconfig/base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["./src/*"] } } }));
    // The package's own config only extends the shared one; baseUrl there is relative to the shared file, so the path is rebased by the package.
    writeFileSync(join(dir, "packages/app/tsconfig.json"), JSON.stringify({ extends: "@acme/tsconfig/base.json", compilerOptions: { baseUrl: ".", paths: { "~/*": ["./src/*"] } } }));
    writeFileSync(join(dir, "packages/app/src/a.ts"), 'import { b } from "~/b";\nexport function a(): number {\n  return b();\n}\n');
    writeFileSync(join(dir, "packages/app/src/b.ts"), "export function b(): number {\n  return 2;\n}\n");
    const { status, stdout } = archdiff(["analyze", dir, "--json", "--no-cache"]);
    assert.equal(status, 0);
    const stats = JSON.parse(stdout) as { unresolvedImports: number; calls: number; deps: number };
    assert.equal(stats.unresolvedImports, 0);
    assert.equal(stats.deps, 1);
    assert.equal(stats.calls, 1);
  }));

test("dir views list directories with two modules, and a folded picture groups by directory", () => {
  const { stdout } = archdiff(["views", fixture]);
  assert.ok(stdout.includes("dir:src/lib\tsrc/lib/ (2)"), stdout);
  const folded = JSON.parse(archdiff(["diagram", "layer:lib", fixture, "--format", "json", "--limit", "1"]).stdout) as { nodes: { id: string; kind: string; label: string; opens?: string; ref?: { id?: string } }[] };
  const groups = folded.nodes.filter((node) => node.kind === "more");
  // A folded shape opens its directory's view; its `ref` is no view key.
  assert.ok(groups.some((node) => node.id === "more:src/lib" && node.label === "… 1 in src/lib/" && node.opens === "dir:src/lib" && node.ref === undefined), JSON.stringify(groups));
  const dir = archdiff(["diagram", "dir:src/lib", fixture, "--format", "mermaid", "--depth", "0"]);
  assert.equal(dir.status, 0);
  assert.ok(dir.stdout.includes("src_lib_orders_ts --> src_lib_log_ts"), dir.stdout);
});

test("flow carries a mock into a destructured parameter, key by key", () =>
  withTempDir("archdiff-flow2-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(join(dir, "src/lib/log.ts"), "export function log({ message, level }: { message: string; level?: number }): void {\n  console.log(level, message);\n}\n");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, ".archdiff/layouts"), { recursive: true });
    writeFileSync(join(dir, ".archdiff/layouts/calls_src_lib_log.ts_log.json"), JSON.stringify({ format: 1, view: "calls:src/lib/log.ts#log", elements: [], mocks: [{ id: "src/lib/log.ts#log", kind: "input", value: '{"message": "hi", "other": 1}' }], saved: "2026-10-16T00:00:00.000Z" }));
    const flow = JSON.parse(archdiff(["flow", "calls:src/lib/log.ts#log", dir, "--json"]).stdout) as { steps: { params: { name: string; value?: string }[] }[] };
    assert.equal(flow.steps[0]?.params[0]?.value, '{ message: "hi" }');
  }));

test("drawings lists the drawings and --prune deletes the orphans", () =>
  withTempDir("archdiff-layouts-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, ".archdiff/layouts"), { recursive: true });
    const file = (view: string, name: string): void => writeFileSync(join(dir, ".archdiff/layouts", name), JSON.stringify({ format: 1, view, elements: [], mocks: [], saved: "2026-10-16T00:00:00.000Z" }));
    file("module:src/lib/orders.ts", "module_src_lib_orders.ts.json");
    file("module:src/lib/gone.ts", "module_src_lib_gone.ts.json");
    // Views the list does not name live as long as their subject does: an inside, a focus, a sequence.
    file("inside:src/lib/orders.ts", "inside_src_lib_orders.ts.json");
    file("focus:src/lib/orders.ts#placeOrder", "focus_src_lib_orders.ts_placeOrder.json");
    file("sequence:src/routes/checkout.tsx#action", "sequence_src_routes_checkout.tsx_action.json");
    const listed = archdiff(["drawings", dir]);
    assert.equal(listed.status, 0);
    assert.ok(listed.stdout.includes("module_src_lib_orders.ts.json\tmodule:src/lib/orders.ts\tok"));
    const status = (name: string): string | undefined => listed.stdout.split("\n").find((line) => line.includes(`/${name}\t`))?.split("\t")[2];

    for (const name of ["inside_src_lib_orders.ts.json", "focus_src_lib_orders.ts_placeOrder.json", "sequence_src_routes_checkout.tsx_action.json"]) assert.equal(status(name), "ok", listed.stdout);
    assert.ok(listed.stdout.includes("module_src_lib_gone.ts.json\tmodule:src/lib/gone.ts\torphan"));
    // The command still answers to its old name.
  const pruned = archdiff(["layouts", dir, "--prune"]);
    assert.ok(pruned.stdout.includes("orphan\tdeleted"));
    assert.ok(existsSync(join(dir, ".archdiff/layouts/module_src_lib_orders.ts.json")));
    assert.ok(!existsSync(join(dir, ".archdiff/layouts/module_src_lib_gone.ts.json")));
    assert.ok(archdiff(["--version"]).stdout.trim().match(/^\d+\.\d+\.\d+$/));
  }));

test("facts never guessed: a parameter or a local spelled like a function, super, imports of types only, another module's name, assets, top-level listeners", () =>
  withTempDir("archdiff-facts-", (dir) => {
    const write = (path: string, text: string): void => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    write("src/a.ts", "function save() {}\nexport function run(save: () => void) { save(); }\nexport function run2() { const save = () => 1; save(); }\nexport function run3() { try { run2(); } catch (save) { save(); } }\n");
    write("src/k.ts", "export class Base { save(): number { return 1; } }\nexport class Child extends Base { save(): number { return super.save() + 1; } }\n");
    write("src/ta.ts", 'import { type B } from "./tb";\nexport function makeA(): number { return 1; }\nexport const use = (b: B) => b;\n');
    write("src/tb.ts", 'import { makeA, type A } from "./ta";\nexport interface B { a: number }\nexport const x = makeA();\n');
    write("src/ua.ts", 'export function format(): string { return "a"; }\nexport function parse(): string { return "p"; }\n');
    write("src/ub.ts", 'export function format(): string { return "b"; }\n');
    write("src/user.ts", 'import { parse } from "./ua";\nimport { format } from "./ub";\nexport function both(): string { return parse() + format(); }\n');
    write("src/assets.ts", 'import data from "./data.json";\nimport "./styles.css";\nconst dir = new URL("./assetsdir", import.meta.url);\nexport const all = [data, dir];\n');
    write("src/data.json", '{"a":1}\n');
    write("src/styles.css", "a {}\n");
    write("src/assetsdir/x.txt", "x\n");
    write("src/bus.ts", 'import { EventEmitter } from "node:events";\nexport const bus = new EventEmitter();\nexport function onShipped(): void {}\nbus.on("order:shipped", onShipped);\n');
    write("src/fraction.ts", "export class Fraction { add(): number { return helper(); } }\nfunction helper(): number { return 1; }\n");
    write("src/ab-test.ts", 'export function variant(): string { return "a"; }\n');
    write("polls/__init__.py", "");
    write("polls/models.py", "class Poll:\n    pass\n");
    write("polls/tests.py", "from polls.models import Poll\ndef test_poll():\n    assert Poll()\n");
    write("py/__init__.py", "");
    write("py/a.py", "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from py.b import B\ndef make_a():\n    return 1\n");
    write("py/b.py", "from py.a import make_a\nclass B:\n    pass\nx = make_a()\n");
    const mermaid = (view: string): string => archdiff(["diagram", view, dir, "--format", "mermaid"]).stdout;
    // A parameter, a local, a caught error named `save` are not the module's save: holes, never an edge to it.
    for (const fn of ["run", "run2", "run3"]) assert.ok(!mermaid(`calls:src/a.ts#${fn}`).includes("==> src_a_ts_save"), fn);
    assert.ok(mermaid("calls:src/a.ts#run").includes("src_a_ts_run ==> hole_src_a_ts_run_save"));
    // super.save() is the base class's, not the method calling itself.
    assert.ok(mermaid("calls:src/k.ts#Child.save").includes("src_k_ts_Child_save ==> src_k_ts_Base_save"));
    // `import { type B }` is erased without verbatimModuleSyntax, and an import under `if TYPE_CHECKING:` never runs: no cycles.
    assert.ok(mermaid("cycles").includes("no import cycles"), mermaid("cycles"));
    assert.ok(mermaid("module:src/ta.ts").includes("src_ta_ts -.-> src_tb_ts"), "a line of types only is dashed");
    // The format of another module is no use of this one's.
    assert.ok(mermaid("usage:src/ua.ts").includes("format<br/>(unused outside)"), mermaid("usage:src/ua.ts"));
    // A JSON or a stylesheet of the repository is no missing module, nor is an optional URL of a directory.
    const coverage = JSON.parse(archdiff(["coverage", dir, "--json"]).stdout) as { unresolvedImports: number };
    assert.equal(coverage.unresolvedImports, 0);
    // A listener at a module's top level is drawn with the function it registers.
    assert.ok(mermaid("events").includes('event_order_shipped -.->|"on"| src_bus_ts_onShipped'), mermaid("events"));
    // Django's tests.py is a test, an A/B test module is none; a word inside a name makes no handler module.
    assert.ok(archdiff(["diagram", "tests", dir]).stdout.includes("# Tests: 1 test file covers 1 of"), archdiff(["diagram", "tests", dir]).stdout.slice(0, 300));
    assert.ok(!archdiff(["views", dir]).stdout.includes("uncalled method of a handler"));
  }));

test("calls reach what the code names: an interface's implementers, a namespace by its name, a module bound whole, a glob import, a private method, a module a function loads", () =>
  withTempDir("archdiff-reach-", (dir) => {
    const write = (path: string, text: string): void => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    write("src/r.ts", "export interface Repo { save(): void }\nexport interface Store extends Repo { load(): void }\nexport class DbRepo implements Repo { save(): void {} }\nexport class FileStore implements Store { save(): void {} load(): void {} }\nexport function use(r: Repo): void { r.save(); }\n");
    write("src/ns.ts", "export function nsf(): number { return 1; }\n");
    write("src/index.ts", 'export * as nsx from "./ns";\n');
    write("src/use.ts", 'import { nsx } from "./index";\nexport function use(): number { return nsx.nsf(); }\n');
    write("src/priv.ts", "export class C { #priv(): number { return 1; } run(): number { return this.#priv(); } }\n");
    write("pkg/__init__.py", "");
    write("pkg/core.py", "def helper():\n    return 1\n");
    write("pkg/app.py", "from . import core\nfrom .core import *\n\ndef run():\n    return core.helper()\n\ndef run2():\n    return helper()\n");
    write("rs/Cargo.toml", '[package]\nname = "rs"\nversion = "0.1.0"\n');
    write("rs/src/lib.rs", "mod util;\nuse crate::util::{self};\nuse crate::util::*;\npub fn run() -> i32 { util::helper() }\npub fn run2() -> i32 { helper() }\n");
    write("rs/src/util.rs", "pub fn helper() -> i32 { 1 }\n");
    write("src/features.ts", "export function getSetting(k: string): string { return k; }\n");
    write("src/panel.ts", 'export async function onLogin(): Promise<string> {\n  const { getSetting } = await import("./features");\n  return getSetting("pm");\n}\nexport function cjs(): string {\n  const features = require("./features");\n  return features.getSetting("x");\n}\n');
    const calls = (view: string): string[] => archdiff(["diagram", view, dir, "--format", "mermaid"]).stdout.split("\n").filter((line) => line.includes("==>")).map((line) => line.trim()).sort();
    // Through an interface: every class implementing it, through an interface that extends it too.
    assert.deepEqual(calls("calls:src/r.ts#use"), ["src_r_ts_use ==> src_r_ts_DbRepo_save", "src_r_ts_use ==> src_r_ts_FileStore_save"]);
    assert.deepEqual(calls("calls:src/use.ts#use"), ["src_use_ts_use ==> src_ns_ts_nsf"]);
    assert.deepEqual(calls("calls:src/priv.ts#C.run"), ["src_priv_ts_C_run ==> src_priv_ts_C_priv"]);
    assert.deepEqual(calls("calls:pkg/app.py#run"), ["pkg_app_py_run ==> pkg_core_py_helper"]);
    assert.deepEqual(calls("calls:pkg/app.py#run2"), ["pkg_app_py_run2 ==> pkg_core_py_helper"]);
    assert.deepEqual(calls("calls:rs/src/lib.rs#run"), ["rs_src_lib_rs_run ==> rs_src_util_rs_helper"]);
    assert.deepEqual(calls("calls:rs/src/lib.rs#run2"), ["rs_src_lib_rs_run2 ==> rs_src_util_rs_helper"]);
    // A `require` or an awaited `import()` in a function binds the module's exports there.
    assert.deepEqual(calls("calls:src/panel.ts#onLogin"), ["src_panel_ts_onLogin ==> src_features_ts_getSetting"]);
    assert.deepEqual(calls("calls:src/panel.ts#cjs"), ["src_panel_ts_cjs ==> src_features_ts_getSetting"]);
  }));

test("a method called on a value reaches its class wherever the code names the class: a singleton, a factory's result, a field, a parameter, a trait", () =>
  withTempDir("archdiff-receivers-", (dir) => {
    const write = (path: string, text: string): void => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    write("src/store.ts", "export class Store { save(): number { return 1; } }\nexport const store = new Store();\nexport const made = createStore();\nfunction createStore() { return new Store(); }\nexport async function load(): Promise<Store> { return new Store(); }\n");
    write("src/use.ts", 'import { store, made, load, Store } from "./store";\nexport function single(): number { return store.save() + made.save(); }\nexport async function awaited(): Promise<number> {\n  const s = await load();\n  return s.save();\n}\nexport function pending(): void {\n  const p = load();\n  void p.then();\n}\nexport function inParens(): number { return (new Store()).save(); }\n');
    write("app/svc.py", "class Repo:\n    def save(self):\n        return 1\n\ndef make_repo() -> Repo:\n    return Repo()\n\nclass Service:\n    def __init__(self, repo: Repo):\n        self.repo = repo\n        self.spare = Repo()\n\n    def run(self):\n        self.repo.save()\n        return self.spare.save()\n\ndef made():\n    r = make_repo()\n    return r.save()\n");
    write("src/B.php", "<?php\nnamespace App;\n\ntrait Logs {\n    public function log(): int { return 1; }\n}\n\nclass Svc {\n    public function go(): int { return 2; }\n}\n\nclass S {\n    public static function make(): Svc { return new Svc(); }\n}\n\nclass B {\n    use Logs;\n    public function go(): int { return $this->log(); }\n}\n\nfunction run(): int {\n    $s = S::make();\n    return (new B())->go() + $s->go();\n}\n");
    write("rs/Cargo.toml", '[package]\nname = "rs"\nversion = "0.1.0"\n');
    write("rs/src/lib.rs", "pub struct Repo {}\nimpl Repo { pub fn save(&self) -> i32 { 1 } }\npub struct Svc { repo: Box<Repo> }\nimpl Svc { pub fn run(&self) -> i32 { self.repo.save() } }\npub fn direct(r: &Repo) -> i32 { r.save() }\n");
    // The calls of the entry itself, one level deep.
    const calls = (view: string): string[] => archdiff(["diagram", view, dir, "--format", "mermaid", "--depth", "1"]).stdout.split("\n").filter((line) => line.includes("==>")).map((line) => line.trim()).sort();
    // A constant made with `new` or by a factory, used here or where it is imported.
    assert.deepEqual(calls("calls:src/use.ts#single"), ["src_use_ts_single ==> src_store_ts_Store_save"]);
    // A Promise of a Store is a Store once awaited, and only then.
    assert.deepEqual(calls("calls:src/use.ts#awaited"), ["src_use_ts_awaited ==> src_store_ts_Store_save", "src_use_ts_awaited ==> src_store_ts_load"]);
    assert.deepEqual(calls("calls:src/use.ts#pending"), ["src_use_ts_pending ==> src_store_ts_load"]);
    assert.ok(calls("calls:src/use.ts#inParens").includes("src_use_ts_inParens ==> src_store_ts_Store_save"));
    // Python: an attribute the constructor fills from a typed parameter or with `Repo()`; a function annotated `-> Repo`.
    assert.deepEqual(calls("calls:app/svc.py#Service.run"), ["app_svc_py_Service_run ==> app_svc_py_Repo_save"]);
    assert.ok(calls("calls:app/svc.py#made").includes("app_svc_py_made ==> app_svc_py_Repo_save"));
    // PHP: a trait's method is the class's own; `(new B())->go()`; the declared result type of `S::make()`.
    assert.deepEqual(calls("calls:src/B.php#B.go"), ["src_B_php_B_go ==> src_B_php_Logs_log"]);
    assert.deepEqual(calls("calls:src/B.php#run"), ["src_B_php_run ==> src_B_php_B", "src_B_php_run ==> src_B_php_B_go", "src_B_php_run ==> src_B_php_S_make", "src_B_php_run ==> src_B_php_Svc_go"]);
    // Rust: a field the struct types (through a Box), a parameter typed with a reference.
    assert.deepEqual(calls("calls:rs/src/lib.rs#Svc.run"), ["rs_src_lib_rs_Svc_run ==> rs_src_lib_rs_Repo_save"]);
    assert.deepEqual(calls("calls:rs/src/lib.rs#direct"), ["rs_src_lib_rs_direct ==> rs_src_lib_rs_Repo_save"]);
  }));

test("imports resolve as the tools resolve them: baseUrl, a jsconfig, the longest paths pattern, a missing alias, a monorepo's own packages, a Python project in a directory", () =>
  withTempDir("archdiff-resolve-", (dir) => {
    const write = (path: string, text: string): void => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    const edges = (view: string): string[] => archdiff(["diagram", view, dir, "--format", "mermaid", "--packages"]).stdout.split("\n").filter((line) => line.includes("-->")).map((line) => line.trim());
    write("web/src/lib/util/deep.ts", "export const deep = 1;\n");
    write("web/src/util/deep.ts", "export const deep = 2;\n");
    write("web/src/lib/u.ts", "export const u = 1;\n");
    write("web/src/main.ts", 'import { deep } from "util/deep";\nimport { u } from "lib/u";\nimport { m } from "@/nope";\nexport const all = [deep, u, m];\n');
    // TypeScript takes the pattern with the longest prefix; a bare specifier is a file under baseUrl too.
    write("web/tsconfig.json", '{ "compilerOptions": { "baseUrl": ".", "paths": { "*": ["src/*"], "util/*": ["src/lib/util/*"], "@/*": ["src/missing/*"] } } }');
    assert.deepEqual(edges("module:web/src/main.ts"), ["web_src_main_ts --> web_src_lib_util_deep_ts", "web_src_main_ts --> web_src_lib_u_ts"]);
    // An alias whose file is missing is no package (none is named `@/nope`): unresolved, with the pattern.
    const coverage = JSON.parse(archdiff(["coverage", dir, "--json"]).stdout) as { unresolvedImports: number; markdown: string };
    assert.equal(coverage.unresolvedImports, 1);
    assert.ok(coverage.markdown.includes("- import `@/nope` — no file for the tsconfig path @/*: @/nope (web/src/main.ts:3)"), coverage.markdown);
    // A JavaScript project's jsconfig.json reads the same.
    rmSync(join(dir, "web/tsconfig.json"));
    write("web/jsconfig.json", '{ "compilerOptions": { "baseUrl": "src" } }');
    assert.ok(edges("module:web/src/main.ts").includes("web_src_main_ts --> web_src_lib_u_ts"));
    // A monorepo's package imported by its name is its source: the entry its package.json names, built or not.
    write("packages/core/package.json", '{ "name": "@acme/core", "main": "dist/index.js" }');
    write("packages/core/src/index.ts", "export function core(): number {\n  return 1;\n}\n");
    write("packages/core/src/utils.ts", "export const helper = 2;\n");
    write("packages/app/package.json", '{ "name": "@acme/app", "dependencies": { "@acme/core": "*" } }');
    write("packages/app/src/index.ts", 'import { core } from "@acme/core";\nimport { helper } from "@acme/core/utils";\nexport function app(): number {\n  return core() + helper;\n}\n');
    assert.deepEqual(edges("module:packages/app/src/index.ts"), ["packages_app_src_index_ts --> packages_core_src_index_ts", "packages_app_src_index_ts --> packages_core_src_utils_ts"]);
    assert.ok(archdiff(["diagram", "packages", dir, "--format", "mermaid"]).stdout.includes('acme_app -->|"declared, 2 imports"| acme_core'));
    // A Python project in a directory of the repository imports from that directory.
    write("backend/pyproject.toml", "[project]\nname = 'app'\n");
    write("backend/app/__init__.py", "");
    write("backend/app/models.py", "def load():\n    return 1\n");
    write("backend/app/api.py", "from app.models import load\n\ndef run():\n    return load()\n");
    assert.ok(archdiff(["diagram", "calls:backend/app/api.py#run", dir, "--format", "mermaid"]).stdout.includes("backend_app_api_py_run ==> backend_app_models_py_load"));
  }));

test("Python, Rust and PHP are read with the same graph: imports resolve and calls are followed", () => {
  const polyglot = join(root, "tests/fixtures/polyglot");
  const stats = JSON.parse(archdiff(["analyze", polyglot, "--json", "--no-cache"]).stdout) as { files: number; unresolvedImports: number; calls: number };
  assert.equal(stats.files, 12);
  assert.equal(stats.unresolvedImports, 0);
  const python = archdiff(["diagram", "calls:app/services/orders.py#place_order", polyglot, "--format", "mermaid"]).stdout;
  assert.ok(python.includes("app_services_orders_py_place_order ==> app_store_py_save_order"), python);
  const rust = archdiff(["diagram", "calls:crate/src/orders.rs#place_order", polyglot, "--format", "mermaid"]).stdout;
  assert.ok(rust.includes("crate_src_orders_rs_place_order ==> crate_src_store_rs_save_order"), rust);
  const php = archdiff(["diagram", "calls:php/src/Http/Checkout.php#checkout", polyglot, "--format", "mermaid", "--depth", "3"]).stdout;
  assert.ok(php.includes("php_src_Http_Checkout_php_checkout ==> php_src_Domain_Orders_php_Orders_place"), php);
  assert.ok(php.includes("php_src_Domain_Orders_php_Orders_place ==> php_src_Store_OrderStore_php_OrderStore_save"), php);
  const layers = archdiff(["diagram", "layers", polyglot, "--format", "mermaid"]).stdout;
  assert.ok(layers.includes('php_http -->|"1"| php_domain'), layers);
  const coverage = JSON.parse(archdiff(["coverage", polyglot, "--json"]).stdout) as { blind: number };
  assert.equal(coverage.blind, 0);
});

test("CommonJS: chained exports, a re-exporting index and a module binding called as a function all resolve", () =>
  withTempDir("archdiff-cjs-", (dir) => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "lib"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sample-lib", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), "module.exports = require('./lib/app');\n");
    writeFileSync(join(dir, "lib/app.js"), "exports = module.exports = createApp;\nfunction createApp() {\n  return mount();\n}\nfunction mount() {\n  return 1;\n}\nexports.Router = function Router() {\n  return 2;\n};\n");
    writeFileSync(join(dir, "test/app.test.js"), "var app = require('..');\nvar lib = require('../lib/app');\nfunction t() {\n  app();\n  app.Router();\n  lib.Router();\n}\nt();\n");
    const stats = JSON.parse(archdiff(["analyze", dir, "--json", "--no-cache"]).stdout) as { unresolvedImports: number; calls: number };
    assert.equal(stats.unresolvedImports, 0);
    const calls = archdiff(["diagram", "calls:test/app.test.js#t", dir, "--format", "mermaid"]).stdout;
    assert.ok(calls.includes("test_app_test_js_t ==> lib_app_js_createApp"), calls);
    assert.ok(calls.includes("test_app_test_js_t ==> lib_app_js_Router"), calls);
    assert.ok(calls.includes("lib_app_js_createApp ==> lib_app_js_mount"), calls);
    // The package's main file is an entry point, even though the tests call it.
    const views = archdiff(["views", dir]).stdout;
    assert.ok(views.includes("calls:index.js#default\tdefault (index.js) — main of sample-lib") || views.includes("main of sample-lib"), views);
  }));

test("Rust: a facade crate's renamed re-exports and `use self::` of the file's own types resolve", () =>
  withTempDir("archdiff-rust-", (dir) => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "crates/facade/src"), { recursive: true });
    mkdirSync(join(dir, "crates/printer/src"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nfacade = { path = "crates/facade" }\n\n[workspace]\nmembers = ["crates/facade", "crates/printer"]\n');
    writeFileSync(join(dir, "crates/facade/Cargo.toml"), '[package]\nname = "facade"\nversion = "0.1.0"\n\n[dependencies]\ngrep-printer = { path = "../printer" }\n');
    writeFileSync(join(dir, "crates/facade/src/lib.rs"), "pub use grep_printer as printer;\n");
    writeFileSync(join(dir, "crates/printer/Cargo.toml"), '[package]\nname = "grep-printer"\nversion = "0.1.0"\n');
    writeFileSync(join(dir, "crates/printer/src/lib.rs"), "pub struct ColorSpecs;\n\npub fn specs() -> ColorSpecs {\n    ColorSpecs\n}\n");
    writeFileSync(join(dir, "src/main.rs"), "use facade::printer::specs;\n\nenum Kind {\n    A,\n}\n\nuse self::Kind::*;\n\nfn main() {\n    let _ = specs();\n    let _ = A;\n}\n");
    const stats = JSON.parse(archdiff(["analyze", dir, "--json", "--no-cache"]).stdout) as { unresolvedImports: number; deps: number };
    assert.equal(stats.unresolvedImports, 0);
    const calls = archdiff(["diagram", "calls:src/main.rs#main", dir, "--format", "mermaid"]).stdout;
    assert.ok(calls.includes("src_main_rs_main ==> crates_printer_src_lib_rs_specs"), calls);
  }));

test("a class extending a package's class: a missing member is the package's, not a blind spot", () =>
  withTempDir("archdiff-base-", (dir) => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/view.ts"), 'import { Component } from "react";\n\nexport class View extends Component {\n  render() {\n    this.setState({});\n    return this.own();\n  }\n  own() {\n    return 1;\n  }\n}\n');
    const coverage = JSON.parse(archdiff(["coverage", dir, "--json"]).stdout) as { blind: number; byReason: Record<string, number> };
    assert.equal(coverage.blind, 0);
    assert.equal(coverage.byReason["external"], 1);
  }));

test("inside shows a module's functions and their calls in module lanes; sequence lists the calls in order", () => {
  const inside = archdiff(["diagram", "inside:src/lib/orders.ts", fixture, "--format", "mermaid"]).stdout;
  assert.ok(inside.includes('subgraph "src/lib/orders.ts"'), inside);
  assert.ok(inside.includes("src_lib_orders_ts_placeOrder ==> src_lib_orders_ts_validate"), inside);
  // Depth 1 brings the functions of other modules the module calls, each in its module's lane.
  assert.ok(inside.includes('subgraph "src/db/store.ts"') && inside.includes("src_lib_orders_ts_placeOrder ==> src_db_store_ts_saveOrder"), inside);
  const sequence = archdiff(["diagram", "sequence:src/routes/checkout.tsx#action", fixture]).stdout;
  assert.ok(sequence.includes("sequenceDiagram"), sequence);
  assert.ok(sequence.includes("participant P0 as src/routes/checkout.tsx"), sequence);
  assert.ok(sequence.includes("## Messages\n\n1. `src/routes/checkout.tsx` → `src/lib/orders.ts`: **OrderService()**"), sequence);
  const json = JSON.parse(archdiff(["diagram", "sequence:src/routes/checkout.tsx#action", fixture, "--format", "json"]).stdout) as { placed?: boolean; nodes: { kind: string }[]; edges: { kind: string; route?: unknown[] }[] };
  assert.equal(json.placed, true);
  assert.ok(json.nodes.some((node) => node.kind === "participant"));
  assert.ok(json.edges.every((edge) => edge.kind === "lifeline" || edge.kind === "message") && json.edges.every((edge) => Array.isArray(edge.route)));
  assert.equal(archdiff(["diagram", "inside:nope.ts", fixture]).status, 2);
});

test("a picture that goes a depth tells each shape its neighbours beyond it: before on the left, after on the right", () => {
  const json = (view: string, ...flags: string[]): { nodes: { id: string; beyond?: { before: { count: number; ids: string[] }; after: { count: number; ids: string[] } } }[] } => JSON.parse(archdiff(["diagram", view, fixture, "--format", "json", ...flags]).stdout);
  // log.ts at depth 1: orders.ts imports it; what imports orders.ts and what orders.ts imports lie beyond.
  const module = json("module:src/lib/log.ts");
  assert.deepEqual(module.nodes.find((node) => node.id === "src/lib/orders.ts")?.beyond, { before: { count: 1, ids: ["src/routes/checkout.tsx"] }, after: { count: 1, ids: ["src/db/store.ts"] } });
  assert.equal(module.nodes.find((node) => node.id === "src/lib/log.ts")?.beyond, undefined);
  // One step deeper draws them: nothing lies beyond orders.ts any more.
  assert.equal(json("module:src/lib/log.ts", "--depth", "2").nodes.find((node) => node.id === "src/lib/orders.ts")?.beyond, undefined);
  // Functions count calls: log is called from placeOrder, which the inside of log.ts does not draw.
  assert.deepEqual(json("inside:src/lib/log.ts").nodes.find((node) => node.id === "src/lib/log.ts#log")?.beyond?.before.ids, ["src/lib/orders.ts#placeOrder"]);
  // A view that goes no depth has nothing beyond.
  assert.ok(json("layers").nodes.every((node) => node.beyond === undefined));
  // The canvas counts them under the shape's corners; the Markdown says them beside the shape.
  const scene = JSON.parse(archdiff(["diagram", "module:src/lib/log.ts", fixture, "--format", "excalidraw"]).stdout) as { elements: { id: string; text?: string; customData?: { archdiff?: string } }[] };
  assert.deepEqual(scene.elements.filter((element) => element.customData?.archdiff === "beyond").map((element) => [element.id, element.text]), [["beyond:src/lib/orders.ts:before", "◂ 1"], ["beyond:src/lib/orders.ts:after", "1 ▸"]]);
  assert.ok(archdiff(["diagram", "module:src/lib/log.ts", fixture]).stdout.includes("- **src/lib/orders.ts** — src/lib/orders.ts:1 — beyond the picture: ◂ 1 before, 1 after ▸"));
});

test("a script without functions: inside draws its top level and what it calls; a module or a function alone says why", () =>
  withTempDir("archdiff-script-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(join(dir, "src/lib/seed.ts"), 'import { placeOrder } from "./orders";\n\nplaceOrder("1", 10);\n');
    writeFileSync(join(dir, "src/lib/banner.js"), 'console.log("archdiff");\n');
    const picture = (view: string, ...flags: string[]): { reason?: string; nodes: { id: string; kind: string; label: string }[]; edges: { from: string; to: string }[] } => JSON.parse(archdiff(["diagram", view, dir, "--format", "json", ...flags]).stdout);
    // The script's calls come from its top level: the module stands for it, in its own lane, and calls on.
    const seed = picture("inside:src/lib/seed.ts");
    assert.deepEqual(seed.nodes.map((node) => [node.id, node.kind]), [["src/lib/seed.ts", "module"], ["src/lib/orders.ts#placeOrder", "fn"]]);
    assert.equal(seed.nodes[0]!.label, "src/lib/seed.ts\n(top level)");
    assert.ok(seed.edges.some((edge) => edge.from === "src/lib/seed.ts" && edge.to === "src/lib/orders.ts#placeOrder"), JSON.stringify(seed.edges));
    assert.equal(seed.reason, "the module declares no function or class: its top level, and what it calls");
    // A script whose top level calls only the platform: an empty picture that says so.
    const banner = picture("inside:src/lib/banner.js");
    assert.equal(banner.nodes.length, 0);
    assert.equal(banner.reason, "the module declares no function or class, and its top level calls none archdiff followed (1 call into packages, the platform or values it cannot see)");
    // Nothing imports the banner and it imports nothing: its module picture is the module alone, and says why.
    assert.equal(picture("module:src/lib/banner.js").reason, "no module of the repository imports src/lib/banner.js, and it imports none of them");
    // A function that calls no function of the repository: its call tree is itself, and says why.
    assert.match(picture("calls:src/routes/checkout.tsx#Checkout").reason ?? "", /^Checkout calls no function of the repository/);
    // The module alone on purpose (depth 0) needs no reason; a function alone at depth 0 is not said to call nothing.
    assert.equal(picture("module:src/lib/banner.js", "--depth", "0").reason, undefined);
    assert.equal(picture("calls:src/routes/checkout.tsx#action", "--depth", "0").reason, "depth 0 draws action alone, without the 2 functions it calls (--depth 1 draws them)");
    assert.equal(picture("sequence:src/routes/checkout.tsx#action", "--depth", "0").reason, "depth 0 draws no message (--depth 1 draws the function's own calls)");
  }));

test("matrix, usage, type flow, path to the storages and hotspots on the fixture", () => {
  const matrix = JSON.parse(archdiff(["diagram", "matrix", fixture, "--format", "json"]).stdout) as { placed?: boolean; nodes: { id: string; label: string; diff?: string }[]; reason?: string };
  assert.equal(matrix.placed, true);
  assert.ok(matrix.nodes.some((node) => node.id === "cell:routes>lib" && node.label === "1"), JSON.stringify(matrix.nodes.filter((node) => node.label !== "")));
  assert.ok(matrix.reason?.includes("every import follows the layer order"), matrix.reason);
  const contract = archdiff(["diagram", "usage:src/lib/orders.ts", fixture, "--format", "mermaid"]).stdout;
  // The old name of the view still opens it.
  assert.equal(archdiff(["diagram", "contract:src/lib/orders.ts", fixture, "--format", "mermaid"]).stdout, contract);
  assert.ok(contract.includes("src_routes_checkout_tsx --> src_lib_orders_ts_OrderService"), contract);
  assert.ok(contract.includes("findOrder<br/>(unused outside)"), contract);
  const type = archdiff(["diagram", "type:src/lib/orders.ts#Order", fixture]).stdout;
  assert.ok(type.includes("# Where Order flows"), type);
  assert.ok(type.includes("placeOrder<br/>produces"), type);
  assert.ok(type.includes("saveOrder<br/>consumes · storage"), type);
  const path = archdiff(["diagram", "path:src/routes/checkout.tsx#action", fixture, "--format", "mermaid"]).stdout;
  assert.ok(path.includes("src_lib_orders_ts_placeOrder ==> src_db_store_ts_saveOrder"), path);
  assert.ok(!path.includes("validate"), path);
  const hotspots = JSON.parse(archdiff(["diagram", "hotspots", fixture, "--format", "json"]).stdout) as { nodes: { id: string; w: number; heat?: number }[] };
  const orders = hotspots.nodes.find((node) => node.id === "src/lib/orders.ts")!;
  const log = hotspots.nodes.find((node) => node.id === "src/lib/log.ts")!;
  assert.ok(orders.w > log.w);
  assert.ok((orders.heat ?? 0) > 0);
});

test("cycles, events, tests, packages and timeline on a repository that has them", () =>
  withTempDir("archdiff-views-", (dir) => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "packages/app/src"), { recursive: true });
    mkdirSync(join(dir, "packages/lib/src"), { recursive: true });
    mkdirSync(join(dir, "packages/app/test"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    writeFileSync(join(dir, "packages/app/package.json"), JSON.stringify({ name: "@acme/app", dependencies: { "@acme/lib": "1" } }));
    writeFileSync(join(dir, "packages/lib/package.json"), JSON.stringify({ name: "@acme/lib" }));
    writeFileSync(join(dir, "packages/app/src/a.ts"), 'import { b } from "./b.ts";\nimport { bus } from "./bus.ts";\nexport function a(): number {\n  bus.emit("order:placed", 1);\n  return b();\n}\n');
    writeFileSync(join(dir, "packages/app/src/b.ts"), 'import { a } from "./a.ts";\nimport { bus } from "./bus.ts";\nexport function b(): number {\n  bus.on("order:placed", onPlaced);\n  return a();\n}\nfunction onPlaced(): void {}\n');
    writeFileSync(join(dir, "packages/app/src/bus.ts"), 'import { EventEmitter } from "node:events";\nexport const bus = new EventEmitter();\n');
    writeFileSync(join(dir, "packages/lib/src/index.ts"), "export function util(): number {\n  return 1;\n}\n");
    writeFileSync(join(dir, "packages/app/test/a.test.ts"), 'import { a } from "../src/a.ts";\nimport { util } from "../../lib/src/index.ts";\na();\nutil();\n');
    const cycles = archdiff(["diagram", "cycles", dir, "--format", "json"]).stdout;
    const parsed = JSON.parse(cycles) as { groups: { id: string }[]; nodes: { id: string }[] };
    assert.deepEqual(parsed.groups.map((group) => group.id), ["cycle 1 (2 modules)"]);
    assert.deepEqual(parsed.nodes.map((node) => node.id).sort(), ["packages/app/src/a.ts", "packages/app/src/b.ts"]);
    const one = archdiff(["diagram", "cycle:packages/app/src/bus.ts", dir]).stdout;
    assert.ok(one.includes("is in no import cycle"), one);
    const events = archdiff(["diagram", "events", dir, "--format", "mermaid"]).stdout;
    assert.ok(events.includes('event_order_placed(("order:placed"))'), events);
    assert.ok(events.includes("packages_app_src_a_ts_a ==>|\"emit\"| event_order_placed"), events);
    assert.ok(events.includes("event_order_placed -.->|\"on\"| packages_app_src_b_ts_onPlaced"), events);
    const tests = JSON.parse(archdiff(["diagram", "tests", dir, "--format", "json"]).stdout) as { nodes: { id: string; count?: number; diff?: string }[] };
    assert.equal(tests.nodes.find((node) => node.id === "packages/app/src/a.ts")?.count, 1);
    assert.equal(tests.nodes.find((node) => node.id === "packages/app/src/b.ts")?.diff, "warning");
    assert.ok(!tests.nodes.some((node) => node.id.includes("test/")));
    const packages = archdiff(["diagram", "packages", dir, "--format", "mermaid"]).stdout;
    // app declares lib and its test imports one file of it.
    assert.ok(packages.includes('acme_app -->|"declared, 1 imports"| acme_lib'), packages);
    // The timeline needs commits.
    const git = gitIn(dir);
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(dir, "packages/lib/src/extra.ts"), "export function extra(): number {\n  return 2;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "lib: extra");
    const timeline = JSON.parse(archdiff(["diagram", "timeline", dir, "--base", "main~1", "--head", "main", "--format", "json"]).stdout) as { placed?: boolean; nodes: { id: string; label: string }[]; title: string };
    assert.equal(timeline.placed, true);
    assert.ok(timeline.title.includes("1 commit"), timeline.title);
    assert.ok(timeline.nodes.some((node) => node.id.startsWith("commit:") && node.label.includes("lib: extra")), JSON.stringify(timeline.nodes));
  }));

test("review without --base measures from the merge-base with develop when the repository has no main", () =>
  withTempDir("archdiff-develop-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = gitIn(dir);
    git("init", "-q", "-b", "develop");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "src/lib/log.ts"), "export function log(message: string): void {\n  console.error(message);\n}\n");
    git("commit", "-q", "-am", "feature: log to stderr");
    const { status, stdout } = archdiff(["review", dir]);
    assert.equal(status, 0, stdout);
    assert.ok(stdout.includes("- fn `log` — src/lib/log.ts:1 (body)"), stdout);
    // The changes laid over a picture name the base commit as git shows it, by seven characters, and count in the singular.
    const marked = JSON.parse(archdiff(["diagram", "modules", dir, "--changes", "--format", "json"]).stdout) as { title: string; reason: string };
    assert.match(marked.reason, /^1 shape changed since [0-9a-f]{7}(;|$)/);
    assert.match(marked.title, / — changes since [0-9a-f]{7}$/);
  }));

test("a deep depth is drawn with a warning, not refused; a Mermaid type asked for is written, or the picture's own type with the reason", () => {
  const deep = archdiff(["diagram", "calls:src/routes/checkout.tsx#action", fixture, "--depth", "20"]);
  assert.equal(deep.status, 0, deep.stderr);
  assert.equal(deep.stderr, "archdiff: ⚠ depth 20 is deeper than 12: the picture may be big and slow to draw (the fold keeps it readable)\n");
  assert.ok(deep.stdout.includes("_⚠ depth 20 is deeper than 12: the picture may be big and slow to draw (the fold keeps it readable)"), deep.stdout);
  // A view the depth does not change says nothing of it.
  assert.equal(archdiff(["diagram", "layers", fixture, "--depth", "20"]).stderr, "");
  const mermaid = (view: string, dir: string, style: string): string => archdiff(["diagram", view, dir, "--format", "mermaid", "--mermaid", style]).stdout;
  const machines = join(root, "tests/fixtures/machines");
  // A gitGraph of no timeline, a state diagram of no machine: the picture's own type, and why.
  const gitgraph = mermaid("module:src/lib/orders.ts", fixture, "gitgraph");
  assert.ok(gitgraph.includes("%% --mermaid gitgraph: gitgraph draws the commits of the timeline or of the branches, so the picture is written as its own type\n") && gitgraph.includes("\nflowchart LR\n"), gitgraph);
  const state = mermaid("module:src/lib/orders.ts", fixture, "state");
  assert.ok(state.includes("%% --mermaid state: state draws a machine, so the picture is written as its own type") && state.includes("\nflowchart LR\n"), state);
  assert.ok(mermaid("machine:src/order.ts#status", machines, "state").includes("\nstateDiagram-v2\n"));
  // A flowchart asked for is a flowchart, whatever the view's own type: a machine's states, a sequence's participants and messages.
  const machine = mermaid("machine:src/order.ts#status", machines, "flowchart");
  assert.ok(machine.includes("\nflowchart LR\n") && !machine.includes("stateDiagram"), machine);
  const sequence = mermaid("sequence:src/routes/checkout.tsx#action", fixture, "flowchart");
  assert.ok(sequence.includes('src_routes_checkout_tsx ==>|"1. OrderService()"| src_lib_orders_ts') && !sequence.includes("foot_") && !sequence.includes("sequenceDiagram"), sequence);
});

test("a sequence keeps twelve lifelines, the rest sharing one, and a call repeated in a row is one message ×N", () =>
  withTempDir("archdiff-sequence-", (dir) => {
    mkdirSync(join(dir, "src"), { recursive: true });
    const names = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);

    for (const name of names) writeFileSync(join(dir, `src/${name}.ts`), `export function ${name}(): number {\n  return 1;\n}\n`);
    // Thirteen modules on the way: main and twelve it calls, the first twice in a row.
    writeFileSync(join(dir, "src/main.ts"), `${names.map((name) => `import { ${name} } from "./${name}";`).join("\n")}\n\nexport function main(): void {\n  m1();\n  m1();\n${names.slice(1).map((name) => `  ${name}();`).join("\n")}\n}\n`);
    const { status, stdout, stderr } = archdiff(["diagram", "sequence:src/main.ts#main", dir, "--format", "json"]);
    assert.equal(status, 0, stderr);
    const picture = JSON.parse(stdout) as { reason?: string; sequence: { participants: string[]; messages: { from: string; to: string; label: string; line: number; times?: number }[] }; edges: { kind: string; label?: string }[] };
    assert.equal(picture.sequence.participants.length, 12);
    assert.deepEqual(picture.sequence.participants.slice(-2), ["src/m10.ts", "… 2 more"]);
    assert.deepEqual(picture.sequence.messages[0], { from: "src/main.ts", to: "src/m1.ts", label: "m1", line: 15, times: 2 });
    assert.deepEqual(picture.sequence.messages.slice(-2).map((message) => message.to), ["… 2 more", "… 2 more"]);
    assert.equal(picture.edges.find((edge) => edge.kind === "message")?.label, "1. m1() ×2");
    assert.ok(picture.reason?.includes("2 modules share the last lifeline (at most 12)"), picture.reason);
  }));

test("branches lists the branches with the default base, and compare puts several heads against it", () =>
  withTempDir("archdiff-branches-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = gitIn(dir);
    git("init", "-q", "-b", "develop");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature-a");
    writeFileSync(join(dir, "src/lib/extra.ts"), "export function extra(): number {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "a: extra module");
    git("checkout", "-q", "develop");
    git("checkout", "-q", "-b", "feature-b");
    writeFileSync(join(dir, "src/routes/checkout.tsx"), 'import { OrderService } from "@/lib/orders";\nimport { readOrder } from "@/db/store";\n\nexport async function action(request: { total: number }) {\n  readOrder("x");\n  return new OrderService("web").place(request.total);\n}\n');
    writeFileSync(join(dir, "src/lib/log.ts"), "export function log(message: string): void {\n  console.error(message);\n}\n");
    git("commit", "-q", "-am", "b: route reads the store, log to stderr");
    git("checkout", "-q", "develop");
    const forked = git("rev-parse", "--short=7", "HEAD").trim();
    // develop moves on after the heads left it: an audit module neither head removed.
    writeFileSync(join(dir, "src/lib/audit.ts"), "export function audit(): number {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "develop: audit");
    const tip = git("rev-parse", "--short=7", "HEAD").trim();
    // A third head: the working tree on develop with a change of its own.
    writeFileSync(join(dir, "src/lib/log.ts"), "export function log(message: string): void {\n  console.warn(message);\n}\n");
    const branches = archdiff(["branches", dir]);
    assert.equal(branches.status, 0, branches.stderr);
    assert.ok(branches.stdout.startsWith("base: develop\ncurrent: develop\n"), branches.stdout);
    assert.ok(branches.stdout.includes("  feature-a\t") && branches.stdout.includes("* develop\t"), branches.stdout);
    const compare = archdiff(["compare", dir, "--heads", "feature-a,feature-b,WORKTREE"]);
    assert.equal(compare.status, 1, compare.stdout);
    assert.ok(compare.stdout.includes("# 3 heads against develop"), compare.stdout);
    // Each head from where it left develop: the audit module develop added since is no head's doing.
    assert.ok(compare.stdout.includes(`| feature-a | ${forked} | 1 | +1 −0 |`), compare.stdout);
    assert.ok(compare.stdout.includes(`| feature-b | ${forked} | 2 |`) && compare.stdout.includes("⚠ +routes→db"), compare.stdout);
    assert.ok(compare.stdout.includes(`| working tree | ${tip} | 1 | +0 −0 |`), compare.stdout);
    assert.ok(!compare.stdout.includes("audit"), compare.stdout);
    assert.ok(compare.stdout.includes("## Touched by every head\n\n- none"), compare.stdout);
    assert.ok(compare.stdout.includes("- src/lib/extra.ts — feature-a"), compare.stdout);
    const json = JSON.parse(archdiff(["compare", dir, "--heads", "feature-a,feature-b,WORKTREE", "--format", "json"]).stdout) as { base: string; heads: { head: string }[] };
    assert.equal(json.base, "develop");
    assert.deepEqual(json.heads.map((head) => head.head), ["feature-a", "feature-b", "WORKTREE"]);
    const picture = JSON.parse(archdiff(["compare", dir, "--heads", "feature-a,feature-b,WORKTREE", "--format", "json"]).stdout);
    assert.ok(picture);
    const excalidraw = archdiff(["compare", dir, "--heads", "feature-b,WORKTREE", "--format", "excalidraw"]).stdout;
    // log.ts changed in both heads: the shape says so.
    assert.ok(excalidraw.includes("every head") || excalidraw.includes("~ feature-b"), excalidraw.slice(0, 200));
    // A head named twice is compared once; a ref git does not know is refused by name.
    assert.equal(archdiff(["compare", dir, "--heads", "feature-a,feature-a", "--format", "json"]).stdout.match(/"head": "feature-a"/g)?.length, 1);
    const unknown = archdiff(["compare", dir, "--heads", "feature-a,nope"]);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr, 'archdiff: no branch, tag or commit "nope" (archdiff branches lists the branches)\n');
  }));

test("the branches picture lays each branch from the commit it left, and a commit's picture is its own change", () =>
  withTempDir("archdiff-branch-graph-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = gitIn(dir);
    const sha = (ref: string): string => git("rev-parse", ref).trim();
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    // level: a branch with nothing of its own; feature-a: one commit off the base; stacked: one more on feature-a.
    git("branch", "level");
    git("checkout", "-q", "-b", "feature-a");
    writeFileSync(join(dir, "src/lib/extra.ts"), "export function extra(): number {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "a: extra module");
    git("checkout", "-q", "-b", "stacked");
    writeFileSync(join(dir, "src/lib/extra.ts"), "export function extra(): number {\n  return 2;\n}\n");
    git("commit", "-q", "-am", "stacked: two");
    git("checkout", "-q", "main");
    writeFileSync(join(dir, "src/lib/audit.ts"), "export function audit(): number {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "main: audit");
    const picture = JSON.parse(archdiff(["diagram", "branches", dir, "--format", "json"]).stdout) as { title: string; reason?: string; groups: { label: string }[]; nodes: { id: string; label: string; opens?: string; group?: string }[]; edges: { from: string; to: string }[] };
    assert.equal(picture.title, "Branches against main");
    assert.deepEqual(picture.groups.map((lane) => lane.label), ["main (base, checked out)", "feature-a — 1 ahead, 1 behind", "stacked — 2 ahead, 1 behind"]);
    // Every commit opens its own change; the base's first commit names the branch that points at it.
    const [base, a, stacked] = [sha("main~1"), sha("feature-a"), sha("stacked")];
    assert.ok(picture.nodes.every((node) => node.opens === node.id), JSON.stringify(picture.nodes.map((node) => node.id)));
    assert.ok(picture.nodes.find((node) => node.id === `commit:${base}`)?.label.endsWith("\n⌂ level"), JSON.stringify(picture.nodes));
    // feature-a leaves the base's first commit; stacked leaves feature-a's commit, not the base.
    assert.ok(picture.edges.some((edge) => edge.from === `commit:${base}` && edge.to === `commit:${a}`));
    assert.ok(picture.edges.some((edge) => edge.from === `commit:${a}` && edge.to === `commit:${stacked}`));
    assert.equal(picture.nodes.filter((node) => node.group === "stacked").length, 1);
    assert.ok(picture.reason?.includes("level with main or merged: level"), picture.reason);
    // As Mermaid, a gitGraph: each branch opened where it left, the stacked one from feature-a.
    const graph = archdiff(["diagram", "branches", dir, "--format", "mermaid"]).stdout;
    assert.ok(graph.includes('%%{init: { "gitGraph": { "mainBranchName": "main" } } }%%\ngitGraph\n'), graph);
    assert.ok(graph.includes(`  branch "feature-a"\n  checkout "feature-a"\n  commit id: "${a.slice(0, 7)} · `), graph);
    assert.ok(/checkout "feature-a"\n {2}commit id: "[^"]+"\n {2}branch "stacked"/.test(graph), graph);
    // A commit's picture: what it did against the commit before it, headed and stamped by the commit.
    const commit = archdiff(["diagram", `commit:${a.slice(0, 7)}`, dir]);
    assert.equal(commit.status, 0, commit.stderr);
    assert.ok(commit.stdout.startsWith(`<!-- archdiff:generated — commit ${a.slice(0, 7)} -->\n# Architecture changes of commit ${a.slice(0, 7)}: a: extra module\n`), commit.stdout.slice(0, 200));
    assert.ok(commit.stdout.includes("## Modules added\n\n- src/lib/extra.ts\n") && !commit.stdout.includes("audit"), commit.stdout);
    assert.ok(archdiff(["diagram", `commit:${a}`, dir, "--format", "mermaid"]).stdout.includes(`%% commit ${a.slice(0, 7)} (`));
    // The first commit has no parent: against the empty tree, every module is added.
    const first = archdiff(["diagram", `commit:${base}`, dir]);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(first.stdout.includes("## Modules added\n\n- cartridges/") && first.stdout.includes("\n- src/db/store.ts\n"), first.stdout.slice(0, 600));
    const unknown = archdiff(["diagram", "commit:nope", dir]);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr, 'archdiff: no commit "nope" (archdiff branches lists the branches)\n');
  }));

test("a comparison says what each head did: apart where they differ, every function in each head's own section", () =>
  withTempDir("archdiff-heads-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = gitIn(dir);
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    // gone: log.ts removed, orders.ts no longer logs; loud: log.ts writes to stderr, and store.ts counts its rows.
    git("checkout", "-q", "-b", "gone");
    rmSync(join(dir, "src/lib/log.ts"));
    writeFileSync(join(dir, "src/lib/orders.ts"), readFileSync(join(fixture, "src/lib/orders.ts"), "utf8").replace('import { log } from "./log.ts";\n', "").replace("  log(`placed ${id}`);\n", ""));
    git("add", "-A");
    git("commit", "-q", "-m", "gone: no log");
    git("checkout", "-q", "main");
    git("checkout", "-q", "-b", "loud");
    writeFileSync(join(dir, "src/lib/log.ts"), "export function log(message: string): void {\n  console.error(message);\n}\n");
    writeFileSync(join(dir, "src/db/store.ts"), `${readFileSync(join(fixture, "src/db/store.ts"), "utf8")}\nexport function countOrders(): number {\n  return rows.size;\n}\n`);
    git("commit", "-q", "-am", "loud: log to stderr, count the orders");
    git("checkout", "-q", "main");
    const markdown = archdiff(["compare", dir, "--heads", "gone,loud"]).stdout;
    // log.ts: removed by one head, changed by the other — not "every head".
    const picture = JSON.parse(archdiff(["compare", dir, "--heads", "gone,loud", "--format", "excalidraw"]).stdout) as { elements: { id: string; text?: string }[] };
    assert.equal(picture.elements.find((element) => element.id === "src/lib/log.ts:text")?.text?.includes("every head"), false);
    // Each head's own section lists what it did, functions added and removed among it.
    assert.ok(markdown.includes("## loud\n\n### Functions added\n\n- fn `countOrders`"), markdown);
    assert.ok(markdown.includes("## gone\n\n### Modules removed\n\n- src/lib/log.ts"), markdown);
    // Both heads touched log.ts (the one removed it, the other changed it): touched by every head.
    assert.ok(markdown.includes("## Touched by every head\n\n- src/lib/log.ts"), markdown);
    assert.ok(archdiff(["compare", dir, "--heads", "loud"]).stdout.includes("# 1 head against main"));
    // Any picture at --head is that branch's code, read from git without a checkout, stamped with its commit.
    const at = JSON.parse(archdiff(["diagram", "modules", dir, "--head", "gone", "--format", "json"]).stdout) as { nodes: { id: string }[]; stamp?: { commit: string } };
    assert.ok(!at.nodes.some((node) => node.id === "src/lib/log.ts"), JSON.stringify(at.nodes.map((node) => node.id)));
    assert.equal(at.stamp?.commit, git("rev-parse", "--short=7", "gone"));
    assert.ok((JSON.parse(archdiff(["diagram", "modules", dir, "--format", "json"]).stdout) as { nodes: { id: string }[] }).nodes.some((node) => node.id === "src/lib/log.ts"));
    const nope = archdiff(["diagram", "modules", dir, "--head", "nope"]);
    assert.equal(nope.status, 2);
    assert.equal(nope.stderr, 'archdiff: no branch, tag or commit "nope" (archdiff branches lists the branches)\n');
  }));

test("a head of a review or a comparison is held to its own ARCHITECTURE.md, not the checkout's", () =>
  withTempDir("archdiff-own-contract-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = gitIn(dir);
    const contract = (arrows: string): string => `# Architecture\n\n\`\`\`mermaid\nflowchart LR\n  subgraph routes\n    r[src/routes/checkout.tsx]\n  end\n  subgraph lib\n    o[src/lib/orders.ts]\n  end\n  subgraph db\n    s[src/db/store.ts]\n  end\n${arrows}\`\`\`\n`;
    const report = 'import { action } from "../routes/checkout.tsx";\n\nexport function report(): unknown {\n  return action({ total: 1 });\n}\n';
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    // allowed: its contract lets the store read a route, and a report does; against: the same report, no contract.
    git("checkout", "-q", "-b", "allowed");
    writeFileSync(join(dir, "ARCHITECTURE.md"), contract("  r --> o\n  o --> s\n  s --> r\n"));
    writeFileSync(join(dir, "src/db/report.ts"), report);
    git("add", ".");
    git("commit", "-q", "-m", "allowed");
    git("checkout", "-q", "main");
    git("checkout", "-q", "-b", "against");
    writeFileSync(join(dir, "src/db/report.ts"), report);
    git("add", ".");
    git("commit", "-q", "-m", "against");
    git("checkout", "-q", "main");
    // The checkout holds a contract of its own, not committed, that allows no db → routes.
    writeFileSync(join(dir, "ARCHITECTURE.md"), contract("  r --> o\n  o --> s\n"));
    const alone = archdiff(["compare", dir, "--heads", "allowed"]);
    assert.equal(alone.status, 0, alone.stdout);
    assert.ok(alone.stdout.includes("- **db → routes** — allowed by ARCHITECTURE.md"), alone.stdout);
    assert.equal(archdiff(["compare", dir, "--heads", "allowed,against"]).status, 1);
    const review = archdiff(["review", dir, "--head", "allowed"]);
    assert.equal(review.status, 0, review.stdout);
    assert.ok(review.stdout.includes("- **db → routes** — allowed by ARCHITECTURE.md"), review.stdout);
  }));

test("agent events name the files a tool touches, for the page to light their shapes", async () => {
  const { parseAgentLine } = await import("../src/agent.ts");
  const event = parseAgentLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/src/lib/orders.ts", old_string: "a", new_string: "b" } }] } }));
  assert.equal(event.kind, "tool");
  assert.deepEqual(event.files, ["/repo/src/lib/orders.ts"]);
  const { mockFromType } = await import("../src/flow.ts");
  assert.deepEqual(mockFromType("{ total: number; customer?: { name: string } }", "request"), { total: 1, customer: { name: "example" } });
  assert.equal(mockFromType("'a' | 'b'"), "a");
  assert.deepEqual(mockFromType("Order[]"), []);
  // Codex resumes by another command (`codex exec resume <id>`): the session ID takes its place, and its events read the same.
  const { AgentRunner, AGENTS } = await import("../src/agent.ts");
  assert.deepEqual(AGENTS.codex.resumeCommand?.slice(0, 4), ["codex", "exec", "resume", "{session}"]);
  const codex = { name: "codex-fake", label: "Codex", command: [process.execPath, join(root, "tests/fixtures/fake-codex.mjs")], resumeFlag: null, resumeCommand: [process.execPath, join(root, "tests/fixtures/fake-codex.mjs"), "resume", "{session}"], protocol: "codex" as const };
  const runner = new AgentRunner(root);
  const ended = (run: ReturnType<typeof runner.start>): Promise<string[]> => new Promise((resolve) => run.subscribe(0, (each) => each.kind === "exit" && resolve(run.events.map((one) => `${one.kind}: ${one.text}`))));
  assert.deepEqual(await ended(runner.start(codex, "say done", null)), ["init: session 0199aaaa-fake-thread-0001", "text: Reading the task (8 chars).", "text: done", "result: done", "exit: exited with 0"]);
  assert.ok((await ended(runner.start(codex, "again", "thread-9"))).includes("text: Resumed thread-9."));
});

test("classes draws the class diagram with fields, methods, extends, implements, has and uses, as boxes and as Mermaid", () =>
  withTempDir("archdiff-classes-", (dir) => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/repo.ts"), "export interface Repo {\n  save(o: Order): void;\n  readonly name: string;\n}\nexport type Order = { id: string; total: number };\nexport class Memory implements Repo {\n  readonly name = \"mem\";\n  save(o: Order): void {}\n}\n");
    writeFileSync(join(dir, "src/service.ts"), 'import type { Repo, Order } from "./repo.ts";\n\nexport abstract class Base {\n  abstract go(): void;\n  stop(): void {}\n}\n\nexport class Service extends Base implements Repo {\n  readonly name = "svc";\n  constructor(private readonly repo: Repo, public label?: string) {\n    super();\n  }\n  go(): void {\n    this.save({ id: "1", total: 1 });\n  }\n  save(o: Order): void {\n    this.repo.save(o);\n  }\n  get size(): number {\n    return 1;\n  }\n}\n');
    const md = archdiff(["diagram", "classes", dir]).stdout;
    assert.ok(md.includes("classDiagram"), md);
    assert.ok(md.includes("<<interface>>"), md);
    assert.ok(md.includes("-repo: Repo") && md.includes("+label?: string"), md);
    assert.ok(md.includes("+save(o: Order) → void") || md.includes("+save(o: Order) returns void"), md);
    assert.ok(md.includes("src_service_ts_Base <|-- src_service_ts_Service"), md);
    assert.ok(md.includes("src_repo_ts_Repo <|.. src_service_ts_Service"), md);
    // A field typed with a class of the picture is a `has` line; a call from a method to another class's member (here through the interface, to the class implementing it) a `uses` line.
    assert.ok(md.includes("src_service_ts_Service --> src_repo_ts_Repo : has"), md);
    assert.ok(md.includes("src_service_ts_Service ..> src_repo_ts_Memory : uses"), md);
    assert.ok(md.includes("- has `src/repo.ts#Repo`") && md.includes("- uses `src/repo.ts#Memory`"), md);
    assert.ok(md.includes("## «interface» Repo — src/repo.ts:1") && md.includes("- field `+name: string`"), md);
    const json = JSON.parse(archdiff(["diagram", "classes:src/service.ts", dir, "--format", "json"]).stdout) as { nodes: { id: string; kind: string; h: number; label: string }[]; edges: { label?: string }[]; groups: { id: string }[] };
    // The scope is one module; the interface it implements comes along from repo.ts, in its own lane.
    assert.deepEqual(json.groups.map((group) => group.id).sort(), ["src/repo.ts", "src/service.ts"]);
    const service = json.nodes.find((node) => node.id === "src/service.ts#Service")!;
    assert.equal(service.kind, "class");
    assert.ok(service.h > 100 && service.label.startsWith("Service\n"), service.label);
    // The interface the field is typed with comes along too; the class only used by a call stays out of a module's scope.
    assert.deepEqual(json.edges.map((edge) => edge.label).sort(), ["extends", "has", "implements"]);
  }));

test("--changes lays the review's marks over any view", () =>
  withTempDir("archdiff-overlay-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = gitIn(dir);
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src/lib/log.ts"), "export function log(message: string): void {\n  console.error(message);\n}\nexport function debug(): void {}\n");
    const inside = JSON.parse(archdiff(["diagram", "inside:src/lib/log.ts", dir, "--changes", "--base", "HEAD", "--format", "json"]).stdout) as { title: string; reason?: string; nodes: { id: string; diff?: string }[] };
    assert.ok(inside.title.endsWith("— changes since HEAD"), inside.title);
    assert.equal(inside.nodes.find((node) => node.id === "src/lib/log.ts#log")?.diff, "changed");
    assert.equal(inside.nodes.find((node) => node.id === "src/lib/log.ts#debug")?.diff, "added");
    const layer = JSON.parse(archdiff(["diagram", "layer:lib", dir, "--changes", "--base", "HEAD", "--format", "json", "--depth", "0"]).stdout) as { nodes: { id: string; diff?: string }[] };
    assert.equal(layer.nodes.find((node) => node.id === "src/lib/log.ts")?.diff, "changed");
    assert.equal(layer.nodes.find((node) => node.id === "src/lib/orders.ts")?.diff, undefined);
    // --only-changes: the changed module, its importer, nothing else.
    const only = JSON.parse(archdiff(["diagram", "layer:lib", dir, "--changes", "--base", "HEAD", "--only-changes", "--format", "json"]).stdout) as { nodes: { id: string }[]; reason?: string };
    assert.deepEqual(only.nodes.map((node) => node.id).sort(), ["src/lib/log.ts", "src/lib/orders.ts"]);
    assert.ok(only.reason?.includes("only the 1 changed shape and their neighbours"), only.reason);
  }));

test("--mermaid picks a Mermaid type that fits the view", () => {
  assert.ok(archdiff(["diagram", "layers", fixture, "--format", "mermaid", "--mermaid", "c4"]).stdout.includes("C4Context"));
  assert.ok(archdiff(["diagram", "hotspots", fixture, "--format", "mermaid", "--mermaid", "quadrant"]).stdout.includes("quadrantChart"));
  assert.ok(archdiff(["diagram", "layers", fixture, "--format", "mermaid", "--mermaid", "pie"]).stdout.includes('"lib" : 2'));
  assert.ok(archdiff(["diagram", "layer:lib", fixture, "--mermaid", "mindmap"]).stdout.includes("mindmap"));
  assert.equal(archdiff(["diagram", "layers", fixture, "--mermaid", "venn"]).status, 2);
});

test("spec lists the specification and prints the agent's task", () => {
  assert.ok(archdiff(["spec", fixture]).stdout.includes("no specs yet"));
  const listed = archdiff(["spec", root]).stdout;
  assert.ok(listed.includes("openspec/specs/views/spec.md\tViews Specification") && listed.includes("features/page.feature\tThe page"), listed);
  const prompt = archdiff(["spec", fixture, "--prompt", "module:src/lib/orders.ts"]).stdout;
  assert.ok(prompt.startsWith("# Specify src/lib/orders.ts") && prompt.includes("The system SHALL"), prompt.slice(0, 200));
  assert.ok(archdiff(["spec", fixture, "--prompt", "update"]).stdout.includes("Review the specification"));
  assert.equal(archdiff(["spec", fixture, "--prompt", "nope:x"]).status, 2);
});

test("modules is the whole map: every module in its layer and every import between them", () => {
  const json = JSON.parse(archdiff(["diagram", "modules", fixture, "--format", "json"]).stdout) as { title: string; nodes: { id: string; kind: string; group?: string }[]; edges: { from: string; to: string }[]; groups: { id: string }[]; question?: string };
  assert.equal(json.title, "Modules: 5 in 4 layers");
  assert.equal(json.nodes.filter((node) => node.kind === "module").length, 5);
  assert.equal(json.nodes.find((node) => node.id === "src/db/store.ts")?.group, "db");
  assert.ok(json.edges.some((edge) => edge.from === "src/routes/checkout.tsx" && edge.to === "src/lib/orders.ts"));
  assert.deepEqual(json.groups.map((group) => group.id).sort(), ["cartridge", "db", "lib", "routes"]);
  assert.ok(json.question?.includes("every module"), json.question);
  assert.ok(archdiff(["views", fixture]).stdout.includes("modules\tModules: the whole map"));
});

test("--hide-lanes leaves lanes and their shapes out of the picture", () => {
  const json = JSON.parse(archdiff(["diagram", "layer:lib", fixture, "--hide-lanes", "routes,nowhere", "--format", "json"]).stdout) as { groups: { id: string }[]; nodes: { id: string }[]; reason?: string };
  assert.ok(!json.groups.some((group) => group.id === "routes"));
  assert.ok(!json.nodes.some((node) => node.id === "src/routes/checkout.tsx"));
  assert.ok(json.nodes.some((node) => node.id === "src/lib/orders.ts"));
  assert.ok(json.reason?.includes("lanes hidden: routes (1 shapes)"), json.reason);
});

test("--expand opens a module in place: a lane of its functions, the lines landing on the functions they concern", () => {
  const json = JSON.parse(archdiff(["diagram", "layer:lib", fixture, "--expand", "src/lib/orders.ts", "--format", "json"]).stdout) as { groups: { id: string }[]; nodes: { id: string; kind: string; group?: string }[]; edges: { kind: string; from: string; to: string }[]; reason?: string };
  assert.ok(json.groups.some((group) => group.id === "inside:src/lib/orders.ts"), JSON.stringify(json.groups));
  assert.ok(!json.nodes.some((node) => node.id === "src/lib/orders.ts"), "the module shape stayed");
  assert.equal(json.nodes.find((node) => node.id === "src/lib/orders.ts#placeOrder")?.group, "inside:src/lib/orders.ts");
  assert.ok(json.nodes.some((node) => node.id === "src/lib/orders.ts#(rest)" && node.kind === "module"));
  assert.ok(json.edges.some((edge) => edge.from === "src/routes/checkout.tsx" && edge.to === "src/lib/orders.ts#OrderService.place" && edge.kind === "call"), JSON.stringify(json.edges));
  assert.ok(json.edges.some((edge) => edge.from === "src/lib/orders.ts#placeOrder" && edge.to === "src/db/store.ts"));
  assert.ok(json.edges.some((edge) => edge.from === "src/db/store.ts" && edge.to === "src/lib/orders.ts#(rest)"));
  assert.ok(json.reason?.includes("opened in place: src/lib/orders.ts"), json.reason);
});

test("matrix:<dir> is the dependency structure matrix of a directory's modules; --weight leaves light lines out", () => {
  const matrix = archdiff(["diagram", "matrix:src", fixture]).stdout;
  assert.ok(matrix.includes("# Matrix of src: rows import columns"), matrix.slice(0, 200));
  assert.ok(matrix.includes("| **lib/orders.ts** |") && matrix.includes("| imports → |"), matrix);
  assert.equal(archdiff(["diagram", "matrix:nowhere", fixture]).status, 2);
  const light = JSON.parse(archdiff(["diagram", "layers", fixture, "--weight", "5", "--format", "json"]).stdout) as { edges: unknown[]; reason?: string; question?: string; stamp?: { commit: string; date: string } };
  assert.equal(light.edges.length, 0);
  assert.ok(light.reason?.includes("lighter than 5 left out"), light.reason);
  assert.ok(light.question?.includes("which layers import which"), light.question);
  assert.match(light.stamp?.commit ?? "", /^[0-9a-f]{7,}$/);
  assert.equal(archdiff(["diagram", "layers", fixture, "--weight", "0"]).status, 2);
  // Every export names the commit it was drawn from.
  assert.ok(archdiff(["diagram", "layers", fixture, "--format", "mermaid"]).stdout.includes("%% commit "));
  assert.ok(archdiff(["diagram", "layers", fixture, "--format", "drawio"]).stdout.includes('agent="archdiff commit '));
});

test("--overlay marks untested modules, labels storages and shades by calls in, on any view", () => {
  const json = JSON.parse(archdiff(["diagram", "layer:lib", fixture, "--overlay", "tests,storages,heat", "--format", "json"]).stdout) as { nodes: { id: string; label: string; diff?: string; heat?: number }[]; reason?: string };
  const store = json.nodes.find((node) => node.id === "src/db/store.ts")!;
  assert.ok(store.label.includes("⛁ the file system"), store.label);
  assert.ok(store.label.includes("no tests") && store.diff === "warning", store.label);
  assert.ok((store.heat ?? 0) > 0 && store.label.includes("calls in"), store.label);
  assert.ok(json.reason?.includes("1 storage (⛁)") && json.reason.includes("no test"), json.reason);
  assert.equal(archdiff(["diagram", "layers", fixture, "--overlay", "nope"]).status, 2);
});

test("new scaffolds a project with its intent and first commit; import, intent and check work on it", () =>
  withTempDir("archdiff-new-", (dir) => {
    const target = join(dir, "shop-api");
    const made = archdiff(["new", target, "--lang", "ts", "--template", "api"]);
    assert.equal(made.status, 0, made.stderr);

    for (const file of ["package.json", "tsconfig.json", "archdiff.json", "ARCHITECTURE.md", ".gitignore", "README.md", "src/routes/.gitkeep"]) assert.ok(existsSync(join(target, file)), file);
    assert.ok(made.stderr.includes("committed on main"), made.stderr);
    assert.equal(spawnSync("git", ["-C", target, "log", "--oneline"], { encoding: "utf8" }).stdout.trim().split("\n").length, 1);
    assert.equal(archdiff(["new", target]).status, 2, "a non-empty directory was scaffolded again");
    assert.equal(archdiff(["new", join(dir, "x"), "--template", "nope"]).status, 2);
    // The intent view: every module planned, nothing built; check: no violation, four planned.
    const intent = JSON.parse(archdiff(["diagram", "intent", target, "--format", "json"]).stdout) as { nodes: { id: string; diff?: string }[]; groups: { id: string }[] };
    assert.equal(intent.nodes.length, 4);
    assert.ok(intent.nodes.every((node) => node.diff === "planned"));
    assert.deepEqual(intent.groups.map((group) => group.id), ["routes", "services", "domain", "db"]);
    const check = archdiff(["check", target]);
    assert.equal(check.status, 0, check.stderr);
    assert.ok(check.stdout.includes("## Planned, not built (4)"), check.stdout);
    // Code built to the contract, plus one import against it: check fails and names it.
    mkdirSync(join(target, "src/routes"), { recursive: true });
    mkdirSync(join(target, "src/services"), { recursive: true });
    mkdirSync(join(target, "src/db"), { recursive: true });
    writeFileSync(join(target, "src/db/store.ts"), "export function read(): string {\n  return 'ok';\n}\n");
    writeFileSync(join(target, "src/services/health.ts"), "import { read } from '../db/store.ts';\nexport function health(): string {\n  return read();\n}\n");
    writeFileSync(join(target, "src/routes/health.ts"), "import { health } from '../services/health.ts';\nimport { read } from '../db/store.ts';\nexport function get(): string {\n  return health() + read();\n}\n");
    const failing = archdiff(["check", target]);
    assert.equal(failing.status, 1, failing.stdout);
    assert.ok(failing.stdout.includes("`src/routes/health.ts:2` imports `src/db/store.ts`: layer **routes** → **db** is not in the intent"), failing.stdout);
    assert.ok(failing.stdout.includes("- `src/domain/types.ts`"), "the unbuilt module is not listed");
    const drawn = JSON.parse(archdiff(["diagram", "intent", target, "--format", "json"]).stdout) as { nodes: { id: string; diff?: string }[]; edges: { from: string; to: string; diff?: string }[] };
    assert.equal(drawn.nodes.find((node) => node.id === "src/db/store.ts")?.diff, undefined);
    assert.equal(drawn.edges.find((edge) => edge.from === "src/routes/health.ts" && edge.to === "src/db/store.ts")?.diff, "warning");
    // A design note with a flowchart replaces the intent when asked (the contract is the reader's text too); archdiff.json's layers follow it.
    writeFileSync(join(dir, "note.md"), "# Note\n\n```mermaid\nflowchart TD\n  subgraph http[\"http — the edge\"]\n    A[\"src/http/orders.ts<br>POST /orders\"]\n  end\n  subgraph app\n    S[\"src/app/orders.ts: places orders\"]\n  end\n  A -->|validated| S\n```\n");
    const contract = readFileSync(join(target, "ARCHITECTURE.md"), "utf8");
    const kept = archdiff(["import", join(dir, "note.md"), target]);
    assert.equal(kept.status, 2);
    assert.equal(kept.stderr, `archdiff: import: ARCHITECTURE.md exists; --force replaces it with ${join(dir, "note.md")}\n`);
    assert.equal(readFileSync(join(target, "ARCHITECTURE.md"), "utf8"), contract);
    const imported = archdiff(["import", join(dir, "note.md"), target, "--force"]);
    assert.equal(imported.status, 0, imported.stderr);
    const config = JSON.parse(readFileSync(join(target, "archdiff.json"), "utf8")) as { layers: Record<string, string[]> };
    // The intent's layers first (a specific layer beats a catch-all), the template's after.
    assert.deepEqual(Object.keys(config.layers), ["http", "app", "routes", "services", "domain", "db"]);
    assert.deepEqual(config.layers["http"], ["src/http/**"]);
    const printed = JSON.parse(archdiff(["intent", target, "--json"]).stdout) as { layers: { name: string; description?: string }[]; modules: { id: string; description?: string }[]; edges: { from: string; to: string; label?: string }[] };
    assert.deepEqual(printed.layers, [{ name: "http", description: "the edge" }, { name: "app" }]);
    assert.equal(printed.modules.find((module) => module.id === "src/app/orders.ts")?.description, "places orders");
    assert.deepEqual(printed.edges, [{ from: "src/http/orders.ts", to: "src/app/orders.ts", label: "validated" }]);
    // --init from the code refuses to overwrite without --force.
    assert.equal(archdiff(["intent", target, "--init"]).status, 2);
    assert.equal(archdiff(["intent", target, "--init", "--force"]).status, 0);
    const seeded = JSON.parse(archdiff(["intent", target, "--json"]).stdout) as { modules: { id: string }[] };
    assert.ok(seeded.modules.some((module) => module.id === "src/services/health.ts"));
  }));

test("a browser extension's listeners are entry points, labelled with the role manifest.json gives the script", () => {
  const extension = join(root, "tests/fixtures/extension");
  const views = archdiff(["views", extension]).stdout;
  assert.ok(views.includes("calls:background.js#onConnect\tonConnect (background.js) — listener chrome.runtime.onConnect of the background"), views);
  assert.ok(views.includes("calls:background.js#openPanel\topenPanel (background.js) — listener chrome.action.onClicked of the background"), views);
  assert.ok(views.includes("calls:content.js#onMessage\tonMessage (content.js) — listener chrome.runtime.onMessage of the content script"), views);
  assert.ok(views.includes("calls:panel.js#onMessage\tonMessage (panel.js) — listener port.onMessage of the side panel"), views);
  // A page the manifest does not name is a page of the extension still, by its file.
  assert.ok(views.includes("calls:options.js#onChanged\tonChanged (options.js) — listener chrome.storage.onChanged of the page options.html"), views);
  // The function a listener written in place calls is reached from the listener's own tree, no entry of its own.
  assert.ok(!views.includes("calls:background.js#fromPanel"), views);
  const tree = archdiff(["diagram", "calls:background.js#onConnect", extension, "--format", "mermaid"]).stdout;
  assert.ok(tree.includes("background_js_onConnect ==> background_js_fromPanel"), tree);
});

test("a message sent with a type is an event: from the sender to every function that switches on that type", () => {
  const extension = join(root, "tests/fixtures/extension");
  const mermaid = archdiff(["diagram", "events", extension, "--format", "mermaid"]).stdout;
  // The panel's top level sends `ping`; the background's `fromPanel` handles it and answers `pong`, which the panel's listener handles.
  assert.ok(mermaid.includes('panel_js ==>|"postMessage"| event_ping') && mermaid.includes('event_ping -.->|"handles"| background_js_fromPanel'), mermaid);
  assert.ok(mermaid.includes('background_js_fromPanel ==>|"postMessage"| event_pong') && mermaid.includes('event_pong -.->|"handles"| panel_js_onMessage'), mermaid);
  // `chrome.tabs.sendMessage(tabId, { type })` names its message in the second argument; the content script handles it.
  assert.ok(mermaid.includes('background_js_fromPanel ==>|"sendMessage"| event_highlight') && mermaid.includes('event_highlight -.->|"handles"| content_js_onMessage'), mermaid);
  // A type nothing sends is no event: `msg.type === 'x'` alone draws nothing.
  const json = JSON.parse(archdiff(["diagram", "events", extension, "--format", "json"]).stdout) as { nodes: { id: string }[] };
  assert.deepEqual(json.nodes.filter((node) => node.id.startsWith("event:")).map((node) => node.id).sort(), ["event:highlight", "event:ping", "event:pong"]);
});

test("messages draws what the parts say to each other as a sequence: a typed message from its sender's module to each handler's", () => {
  const extension = join(root, "tests/fixtures/extension");
  assert.ok(archdiff(["views", extension]).stdout.includes("messages\tMessages: who sends what to whom, by type"));
  const mermaid = archdiff(["diagram", "messages", extension, "--format", "mermaid"]).stdout;
  assert.ok(mermaid.includes("sequenceDiagram") && mermaid.includes("participant P0 as background.js") && mermaid.includes("participant P1 as panel.js") && mermaid.includes("participant P2 as content.js"), mermaid);
  // One arrow per sender, handler and type, in the order the senders' code sends them; a type is no call, so no `()`.
  assert.ok(mermaid.includes("P0->>P1: 1. pong") && mermaid.includes("P0->>P2: 3. highlight") && mermaid.includes("P1->>P0: 4. ping") && !mermaid.includes("pong()"), mermaid);
  const md = archdiff(["diagram", "messages", extension]).stdout;
  assert.ok(md.includes("# Messages: 4 messages between 3 parts") && md.includes("4. `panel.js` → `background.js`: **ping** — panel.js:4"), md);
  // A module as the scope keeps the messages it sends or handles.
  const own = archdiff(["diagram", "messages:panel.js", extension, "--format", "mermaid"]).stdout;
  assert.ok(own.includes("P1->>P0: 1. pong") && own.includes("P0->>P1: 2. ping") && !own.includes("highlight"), own);
  assert.equal(archdiff(["diagram", "messages:nope.js", extension]).status, 2);
});

test("a file named by a URL — a worker, a child process, a registered hook — is a dashed `loads` line, not an import", () =>
  withTempDir("archdiff-loads-", (dir) => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/main.ts"), 'import { spawn } from "node:child_process";\nimport { fileURLToPath } from "node:url";\nimport { helper } from "./helper.ts";\n\nexport function start(): void {\n  helper();\n  new Worker(new URL("./worker.ts", import.meta.url));\n  spawn(process.execPath, [fileURLToPath(new URL("./child.ts", import.meta.url))]);\n}\n');
    writeFileSync(join(dir, "src/helper.ts"), "export function helper(): void {}\n");
    writeFileSync(join(dir, "src/worker.ts"), "export function work(): void {}\n");
    writeFileSync(join(dir, "src/child.ts"), "export function child(): void {}\n");
    const json = JSON.parse(archdiff(["diagram", "module:src/main.ts", dir, "--format", "json"]).stdout) as { edges: { from: string; to: string; label?: string; loads?: true }[] };
    const lines = json.edges.map((edge) => `${edge.to}${edge.loads ? " loads" : ""}${edge.label ? ` [${edge.label}]` : ""}`).sort();
    assert.deepEqual(lines, ["src/child.ts loads [loads]", "src/helper.ts", "src/worker.ts loads [loads]"]);
    const mermaid = archdiff(["diagram", "module:src/main.ts", dir, "--format", "mermaid"]).stdout;
    assert.ok(mermaid.includes('src_main_ts -.->|"loads"| src_worker_ts') && mermaid.includes("src_main_ts --> src_helper_ts"), mermaid);
  }));

test("an import type expression does not make a file a syntax error; a dynamic import call is still a call", () =>
  withTempDir("archdiff-import-type-", (dir) => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/scene.ts"), "export interface SceneElement {\n  id: string;\n}\n");
    writeFileSync(join(dir, "src/page.ts"), "export function elements(list: import(\"./scene.ts\").SceneElement[]): number {\n  return list.length;\n}\nexport type Scene = typeof import(\"./scene.ts\");\nexport async function load(): Promise<unknown> {\n  return import(\"./scene.ts\").then((m) => m);\n}\n");
    const report = JSON.parse(archdiff(["coverage", dir, "--json"]).stdout) as { parseErrors: string[]; modules: unknown[] };
    assert.deepEqual(report.parseErrors, []);
    const inside = JSON.parse(archdiff(["diagram", "inside:src/page.ts", dir, "--format", "json"]).stdout) as { nodes: { id: string; ref?: { line?: number } }[] };
    assert.deepEqual(inside.nodes.map((node) => node.id).filter((id) => id.startsWith("src/page.ts#")).sort(), ["src/page.ts#elements", "src/page.ts#load"]);
    assert.equal(inside.nodes.find((node) => node.id === "src/page.ts#load")?.ref?.line, 5);
  }));

test("hotspots of a big repository keeps a screen's shape: 400 modules draw wider than tall, not a column", () =>
  withTempDir("archdiff-hotspots-big-", (dir) => {
    mkdirSync(join(dir, "src"), { recursive: true });

    for (let i = 0; i < 400; i++) writeFileSync(join(dir, `src/m${i}.ts`), `export function f${i}(): number {\n  return ${i};\n}\n`);
    const picture = JSON.parse(archdiff(["diagram", "hotspots", dir, "--format", "json"]).stdout) as { nodes: { x: number; y: number; w: number; h: number }[] };
    assert.equal(picture.nodes.length, 400);
    const right = Math.max(...picture.nodes.map((node) => node.x + node.w));
    const bottom = Math.max(...picture.nodes.map((node) => node.y + node.h));
    assert.ok(right > bottom, `${right} wide, ${bottom} tall`);
  }));

test("run accepts a CommonJS export (`exports.f = f`, an SFCC hook with its `public` flag): the function is exported, not refused", () =>
  withTempDir("archdiff-run-cjs-", (dir) => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/hook.js"), "function modifyGETResponse(doc) {\n  return { ...doc, seen: true };\n}\nexports.modifyGETResponse = modifyGETResponse;\nexports.modifyGETResponse.public = true;\n");
    const ran = JSON.parse(archdiff(["run", "calls:src/hook.js#modifyGETResponse", dir, "--input", '{"doc":{"id":"c1"}}', "--json"]).stdout) as { steps: { id: string }[]; result: unknown; error: string | null };
    assert.equal(ran.error, null);
    assert.deepEqual(ran.steps.map((step) => step.id), ["src/hook.js#modifyGETResponse"]);
    assert.deepEqual(ran.result, { id: "c1", seen: true });
  }));

test("a bare & in JSX text is no syntax error: the file is read whole; a real error still marks its file", () =>
  withTempDir("archdiff-jsx-amp-", (dir) => {
    mkdirSync(join(dir, "src"), { recursive: true });
    // An emoji before the ampersands: the offsets blanked are UTF-16 ones, as the source is indexed.
    writeFileSync(join(dir, "src/features.tsx"), 'import { count } from "./count";\nexport const smile = "😀";\nexport function Features() {\n  return <section><h3>Cart & Checkout</h3><p>{count()} items &more</p></section>;\n}\nexport function Footer() {\n  return <><b>a</b> & <i>b</i></>;\n}\n');
    writeFileSync(join(dir, "src/count.ts"), "export function count(): number { return 1; }\n");
    writeFileSync(join(dir, "src/broken.ts"), "export function a(): number {\n  const x = ;\n  return 1;\n}\n");
    const report = JSON.parse(archdiff(["coverage", dir, "--json"]).stdout) as { parseErrors: string[] };
    assert.deepEqual(report.parseErrors, ["src/broken.ts"]);
    const calls = archdiff(["diagram", "calls:src/features.tsx#Features", dir, "--format", "mermaid"]).stdout;
    assert.ok(calls.includes("src_features_tsx_Features ==> src_count_ts_count"), calls);
    const inside = JSON.parse(archdiff(["diagram", "inside:src/features.tsx", dir, "--format", "json"]).stdout) as { nodes: { id: string }[] };
    assert.deepEqual(inside.nodes.map((node) => node.id).filter((id) => id.startsWith("src/features.tsx#")).sort(), ["src/features.tsx#Features", "src/features.tsx#Footer"]);
  }));

test("metrics: coupling and cohesion by module and layer, as Markdown and JSON; the pictures of cycles say where to cut", () => {
  const { status, stdout } = archdiff(["metrics", fixture]);
  assert.equal(status, 0, stdout);
  assert.ok(stdout.includes("| **lib** | 2 | 1 | 1 | 0.50 |"), stdout);
  assert.ok(stdout.includes("| src/routes/checkout.tsx | routes | 0 | 1 | 1.00 | 0.00 | 0.00 |"), stdout);
  // An isolated script (nothing imports it, it imports nothing of the repository): D is 1 and carries no ⚠.
  assert.ok(stdout.includes("| cartridges/base/cartridge/scripts/hooks/basket.js | cartridge | 0 | 0 | 0.00 | 0.00 | 1.00 | 1.00 | 1 | 3 |"), stdout);
  const json = JSON.parse(archdiff(["metrics", fixture, "--json", "--layer", "db"]).stdout) as { modules: { id: string; ca: number; instability: number }[]; layers: { name: string }[] };
  assert.deepEqual(json.modules.map((row) => [row.id, row.ca, row.instability]), [["src/db/store.ts", 1, 0]]);
  assert.deepEqual(json.layers.map((layer) => layer.name), ["db"]);
  assert.equal(archdiff(["metrics", fixture, "--layer", "nope"]).status, 2);
  // The metrics picture is a table; its Mermaid is a quadrant chart of instability against abstractness.
  const picture = archdiff(["diagram", "metrics", fixture]).stdout;
  assert.ok(picture.includes("quadrantChart") && picture.includes("zone of pain") && picture.includes("## Modules"), picture);
  // Type-only imports count only when asked: the store imports the Order type, which closes a circle with orders.
  assert.ok(archdiff(["diagram", "cycles", fixture]).stdout.includes("no import cycles"));
  const typed = archdiff(["diagram", "cycles", fixture, "--types", "--format", "mermaid"]).stdout;
  assert.ok(typed.includes('src_db_store_ts -.->|"cut: 1 import"| src_lib_orders_ts'), typed);
  assert.ok(typed.includes("layers in a circle: db ⇄ lib"), typed);
  assert.ok(archdiff(["diagram", "cycles:fns", fixture]).stdout.includes("no call cycles"));
  // The instability overlay shades modules and names the unstable ones others depend on.
  const overlay = archdiff(["diagram", "layer:lib", fixture, "--overlay", "instability"]).stdout;
  assert.ok(overlay.includes("shade: instability") && overlay.includes("I 0.67 · Ca 1"), overlay);
});

test("review against the contract: a new layer dependency ARCHITECTURE.md forbids fails, one it allows is news; a storage is known by its calls", () =>
  withTempDir("archdiff-contract-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(join(dir, "ARCHITECTURE.md"), "# Architecture\n\n```mermaid\nflowchart LR\n  subgraph routes\n    r[src/routes/checkout.tsx]\n  end\n  subgraph lib\n    o[src/lib/orders.ts]\n    l[src/lib/log.ts]\n  end\n  subgraph db\n    s[src/db/store.ts]\n  end\n  r --> o\n  o --> s\n  o --> l\n  s --> l\n```\n");
    const git = gitIn(dir);
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    // Allowed by the contract (db → lib): news, exit 0.
    writeFileSync(join(dir, "src/db/store.ts"), `${readFileSync(join(dir, "src/db/store.ts"), "utf8")}import { log } from "../lib/log.ts";\nexport function note(): void { log("x"); }\n`);
    const allowed = archdiff(["review", dir, "--base", "HEAD"]);
    assert.equal(allowed.status, 0, allowed.stdout);
    assert.ok(allowed.stdout.includes("- **db → lib** — allowed by ARCHITECTURE.md"), allowed.stdout);
    // Against the contract (routes → db): a finding, exit 1.
    writeFileSync(join(dir, "src/routes/checkout.tsx"), `import { readOrder } from "@/db/store";\nexport function loader() {\n  return readOrder("y");\n}\n`);
    const against = archdiff(["review", dir, "--base", "HEAD"]);
    assert.equal(against.status, 1, against.stdout);
    assert.ok(against.stdout.includes("## ⚠ New dependencies between layers") && against.stdout.includes("- **routes → db** — against ARCHITECTURE.md"), against.stdout);
    // A contract in prose only names no layer: it judges nothing, and the review holds the change as without one.
    const contract = readFileSync(join(dir, "ARCHITECTURE.md"), "utf8");
    writeFileSync(join(dir, "ARCHITECTURE.md"), "# Architecture\n\nRoutes must never touch db.\n");
    const prose = archdiff(["review", dir, "--base", "HEAD"]);
    assert.equal(prose.status, 1, prose.stdout);
    assert.ok(prose.stdout.includes("- **routes → db**\n") && !prose.stdout.includes("allowed by ARCHITECTURE.md"), prose.stdout);
    const nothing = archdiff(["check", dir]);
    assert.equal(nothing.status, 0);
    assert.ok(nothing.stderr.includes("ARCHITECTURE.md names no layer"), nothing.stderr);
    writeFileSync(join(dir, "ARCHITECTURE.md"), contract);
    // A module that calls fetch is a storage by what it does, without a name or a package that says so.
    writeFileSync(join(dir, "src/lib/remote.ts"), `export async function load(id: string): Promise<unknown> {\n  const response = await fetch(\`/api/\${id}\`);\n  return response.json();\n}\n`);
    const storages = archdiff(["diagram", "layer:lib", dir, "--overlay", "storages"]).stdout;
    assert.ok(storages.includes("⛁ HTTP (fetch)"), storages);
    // archdiff.json names a storage by glob, and a package by name.
    writeFileSync(join(dir, "archdiff.json"), JSON.stringify({ storages: { "src/lib/log.ts": "the log file" }, storagePackages: {} }));
    assert.ok(archdiff(["diagram", "layer:lib", dir, "--overlay", "storages"]).stdout.includes("⛁ the log file"));
  }));

test("state machines: the implicit ones written with literals, the explicit ones a library declares (XState, javascript-state-machine, transitions), in TypeScript, JavaScript and Python", () => {
  const machines = join(root, "tests/fixtures/machines");
  const views = archdiff(["views", machines]).stdout;
  assert.ok(views.includes("machine:src/order.ts#status\tstatus (src/order.ts) — 5 states"), views);
  assert.ok(views.includes("machine:src/light.ts#light\tlight (src/light.ts) — 3 states"), views);
  assert.ok(views.includes("machine:src/door.py#state\tstate (src/door.py) — 3 states"), views);
  // An implicit machine: states from the assignments, the comparisons and the union type; transitions from the case or if the assignment sits under.
  const order = archdiff(["diagram", "machine:src/order.ts#status", machines]).stdout;
  assert.ok(order.includes("stateDiagram-v2"), order);
  assert.ok(order.includes("s_new --> s_paid: pay") && order.includes("s_paid --> s_shipped: ship") && order.includes("s_new --> s_cancelled: cancel") && order.includes("s_any --> s_new: reset"), order);
  assert.ok(order.includes("- **refunded** — declared by the type, never set"), order);
  assert.ok(order.includes("| new | pay | paid | src/order.ts:12 |"), order);
  // An explicit XState machine: its initial state, its events, `after` and object targets.
  const light = archdiff(["diagram", "machine:src/light.ts#light", machines, "--format", "mermaid"]).stdout;
  assert.ok(light.includes("[*] --> s_green") && light.includes("s_yellow --> s_red: TIMER") && light.includes("s_red --> s_green: after 5000") && light.includes("s_red --> s_red: PANIC"), light);
  // Python: `self.state` set in __init__ (initial), under an `if` and a `match`.
  const door = archdiff(["diagram", "machine:src/door.py#state", machines, "--format", "mermaid"]).stdout;
  assert.ok(door.includes("[*] --> s_closed") && door.includes("s_closed --> s_open: Door.open") && door.includes("s_closed --> s_locked: Door.lock"), door);
  // javascript-state-machine: `init`, and a transition from a list of states.
  const water = archdiff(["diagram", "machine:src/water.js#water", machines, "--format", "mermaid"]).stdout;
  assert.ok(water.includes("%% declared with javascript-state-machine") && water.includes("[*] --> s_solid") && water.includes("s_solid --> s_liquid: melt") && water.includes("s_liquid --> s_solid: reset") && water.includes("s_gas --> s_solid: reset"), water);
  // Python's `transitions`: a dictionary and a list per transition, and `add_transition` from two states folded in.
  const ticket = archdiff(["diagram", "machine:src/ticket.py#machine", machines, "--format", "mermaid"]).stdout;
  assert.ok(ticket.includes("[*] --> s_open") && ticket.includes("s_open --> s_assigned: assign") && ticket.includes("s_assigned --> s_closed: close") && ticket.includes("s_closed --> s_open: reopen") && ticket.includes("s_assigned --> s_open: reopen"), ticket);
  // The list of machines, and a machine that does not exist.
  const list = archdiff(["diagram", "machines", machines]).stdout;
  assert.ok(list.includes("# State machines (5)") && list.includes("3 declared by a library, 2 written with literals"), list);
  assert.equal(archdiff(["diagram", "machine:src/order.ts#nope", machines]).status, 2);
  // A sequence frames the calls under a loop, a branch, a try and a catch, nesting the branch inside the loop.
  const sequence = archdiff(["diagram", "sequence:src/checkout.ts#checkout", machines]).stdout;
  assert.ok(sequence.includes("  loop const order of orders\n  P0->>P1: 1. pay()\n    opt rush\n  P0->>P1: 2. ship()\n    end\n    opt not rush\n  P0->>P1: 3. cancel()\n    end\n  end\n  opt try\n  P0->>P0: 4. audit()\n  end\n  opt catch\n  P0->>P1: 5. cancel()\n  end"), sequence);
  assert.ok(sequence.includes("- _loop [const order of orders]_ — messages 1–3"), sequence);
  const json = JSON.parse(archdiff(["diagram", "sequence:src/checkout.ts#checkout", machines, "--format", "json"]).stdout) as { nodes: { kind: string; label: string }[] };
  assert.deepEqual(json.nodes.filter((node) => node.kind === "fragment").map((node) => node.label), ["loop [const order of orders]", "opt [rush]", "opt [not rush]", "opt [try]", "opt [catch]"]);
});

test("two entities with a field of one name are two machines: by the class the code names, else by the object's name, two names of one entity as one", () =>
  withTempDir("archdiff-machines-", (dir) => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/flows.ts"), 'interface Order { status: string }\ninterface Payment { status: string }\nexport function toggle(order: Order): void {\n  if (order.status === "open") order.status = "closed";\n  else order.status = "open";\n}\nexport function settle(payment: Payment): void {\n  if (payment.status === "pending") payment.status = "settled";\n}\nexport function fail(p: Payment): void {\n  if (p.status === "pending") p.status = "failed";\n}\n');
    writeFileSync(join(dir, "src/flows.js"), 'export function confirm(order) {\n  if (order.status === "draft") order.status = "confirmed";\n}\nexport function ship(o) {\n  if (o.status === "confirmed") o.status = "shipped";\n}\nexport function settle(payment) {\n  if (payment.status === "pending") payment.status = "settled";\n}\n');
    writeFileSync(join(dir, "src/door.py"), 'class Door:\n    def __init__(self):\n        self.state = "closed"\n\n    def open(self):\n        if self.state == "closed":\n            self.state = "open"\n\nclass Lock:\n    def __init__(self):\n        self.state = "locked"\n\n    def unlock(self):\n        if self.state == "locked":\n            self.state = "unlocked"\n');
    const machines = archdiff(["views", dir]).stdout.split("\n").filter((line) => line.startsWith("machine:")).map((line) => line.split("\t")[0]);
    assert.deepEqual(machines, ["machine:src/door.py#Door.state", "machine:src/door.py#Lock.state", "machine:src/flows.js#order.status", "machine:src/flows.js#payment.status", "machine:src/flows.ts#Order.status", "machine:src/flows.ts#Payment.status"]);
    // The states of one entity only; `o` and `order` share a state, so they are one order.
    const states = (view: string): string[] => (JSON.parse(archdiff(["diagram", view, dir, "--format", "json"]).stdout) as { machine: { states: { name: string }[] } }).machine.states.map((state) => state.name).sort();
    assert.deepEqual(states("machine:src/flows.ts#Payment.status"), ["failed", "pending", "settled"]);
    assert.deepEqual(states("machine:src/flows.js#order.status"), ["confirmed", "draft", "shipped"]);
  }));

test("Rust integration tests are crates of their own: `mod util;` and `use <crate>::` resolve from tests/", () => {
  const polyglot = join(root, "tests/fixtures/polyglot");
  // The test functions themselves carry no architecture (#[test] is left out); the imports of the test crate resolve.
  const edges = (key: string): [string, string][] => (JSON.parse(archdiff(["diagram", key, polyglot, "--format", "json"]).stdout) as { edges: { from: string; to: string }[] }).edges.map((edge) => [edge.from, edge.to]);
  assert.ok(edges("module:crate/tests/integration.rs").some(([from, to]) => from === "crate/tests/integration.rs" && to === "crate/src/orders.rs"), "use sample::orders resolves to the library");
  assert.ok(edges("module:crate/tests/util.rs").some(([from, to]) => from === "crate/tests/util.rs" && to === "crate/src/orders.rs"), "the helper's use resolves too");
  // `util::sample_order()` from the test file: `mod util;` makes tests/util.rs a child of this crate root.
  const calls = archdiff(["diagram", "calls:crate/tests/integration.rs#setup", polyglot, "--format", "mermaid"]).stdout;
  assert.ok(calls.includes("crate_tests_integration_rs_setup ==> crate_tests_util_rs_sample_order"), calls);
});

test("a symbolic link to a file or a directory inside the root is read, once, under its own path", () =>
  withTempDir("archdiff-links-", (dir) => {
    mkdirSync(join(dir, "src/real"), { recursive: true });
    writeFileSync(join(dir, "src/real/a.ts"), "export function a(): number { return 1; }\n");
    writeFileSync(join(dir, "src/b.ts"), "import { a } from \"./real/a.ts\";\nexport function b(): number { return a(); }\n");
    symlinkSync(join(dir, "src/real"), join(dir, "src/linked"), "dir");
    symlinkSync(join(dir, "src/b.ts"), join(dir, "src/c.ts"), "file");
    // A link back up the tree is not walked again; a link to a directory already walked under its own path is left out.
    symlinkSync(dir, join(dir, "src/loop"), "dir");
    const views = archdiff(["views", dir]).stdout;
    assert.ok(views.includes("module:src/real/a.ts") && views.includes("module:src/c.ts") && views.includes("module:src/b.ts"), views);
    assert.ok(!views.includes("src/loop/") && !views.includes("src/linked/"), views);
    const calls = archdiff(["diagram", "calls:src/c.ts#b", dir, "--format", "mermaid"]).stdout;
    assert.ok(calls.includes("src_c_ts_b ==> src_real_a_ts_a"), calls);
  }));

test("the mix puts a class's methods in a lane of the class; lanes lie as columns on request and on a map of many layers", () => {
  const mixed = JSON.parse(archdiff(["diagram", "layer:lib", fixture, "--expand", "src/lib/orders.ts", "--format", "json"]).stdout) as { groups: { id: string; label: string }[]; nodes: { id: string; group?: string }[] };
  assert.ok(mixed.groups.some((group) => group.id === "inside:src/lib/orders.ts#OrderService" && group.label === "OrderService (class of orders.ts)"), JSON.stringify(mixed.groups));
  assert.equal(mixed.nodes.find((node) => node.id === "src/lib/orders.ts#OrderService.place")?.group, "inside:src/lib/orders.ts#OrderService");
  assert.equal(mixed.nodes.find((node) => node.id === "src/lib/orders.ts#placeOrder")?.group, "inside:src/lib/orders.ts");
  const columns = JSON.parse(archdiff(["diagram", "modules", fixture, "--lanes", "columns", "--format", "json"]).stdout) as { lanes?: string; groups: { id: string; x: number; y: number; w: number; h: number }[]; nodes: { id: string; group?: string; x: number; y: number; w: number; h: number }[] };
  assert.equal(columns.lanes, "columns");
  const sorted = [...columns.groups].sort((a, b) => a.x - b.x);

  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i]!.x >= sorted[i - 1]!.x + sorted[i - 1]!.w, "lanes side by side");

  for (const node of columns.nodes) {
    const lane = columns.groups.find((group) => group.id === node.group);

    if (lane) assert.ok(node.x >= lane.x && node.x + node.w <= lane.x + lane.w && node.y >= lane.y && node.y + node.h <= lane.y + lane.h, `${node.id} inside its lane`);
  }

  // The lines flow forward: the routes lane (which imports) sits left of the lib lane (which it imports).
  const at = (id: string): number => columns.groups.find((group) => group.id === id)!.x;
  assert.ok(at("routes") < at("lib"), sorted.map((group) => `${group.id}@${group.x}`).join(" "));
  // The layout says how it laid the lanes: four lanes stay rows by default.
  assert.equal(JSON.parse(archdiff(["diagram", "modules", fixture, "--format", "json"]).stdout).lanes, "rows", "four lanes stay rows by default");
});

test("run executes an entry for real with the storages mocked, traced function by function, writes and the network refused", () => {
  const placed = archdiff(["run", "calls:src/lib/orders.ts#placeOrder", fixture, "--input", '{"id":"o1","total":5}']);
  assert.equal(placed.status, 0, placed.stdout + placed.stderr);
  assert.ok(placed.stdout.includes("## Steps, as they happened\n\n1. `src/lib/orders.ts#placeOrder`\n2. `src/lib/orders.ts#validate`\n3. `src/db/store.ts#saveOrder`\n4. `src/lib/log.ts#log`"), placed.stdout);
  assert.ok(placed.stdout.includes('"id": "o1"') && placed.stdout.includes("0 predicted steps not entered"), placed.stdout);
  // The file system is a mock: the read is recorded and answered from the mock, nothing on disk is touched.
  const found = JSON.parse(archdiff(["run", "calls:src/lib/orders.ts#findOrder", fixture, "--input", '{"id":"o1"}', "--storages", '{"node:fs": {"readFileSync": "nothing"}}', "--json"]).stdout) as { steps: { id: string }[]; storageCalls: { module: string; member: string; args: unknown[] }[]; result: unknown; error: string | null };
  assert.deepEqual(found.steps.map((step) => step.id), ["src/lib/orders.ts#findOrder", "src/db/store.ts#readOrder"]);
  assert.deepEqual(found.storageCalls, [{ module: "node:fs", member: "readFileSync", args: ["/dev/null"] }]);
  assert.equal(found.error, null);
  // A thrown error is the run's error, exit 1; a method and an unknown function are refused with a reason before anything runs, exit 2.
  const negative = archdiff(["run", "calls:src/lib/orders.ts#placeOrder", fixture, "--input", '{"id":"o2","total":-1}']);
  assert.equal(negative.status, 1);
  assert.ok(negative.stdout.includes("**Error:** Error: negative"), negative.stdout);
  const method = archdiff(["run", "calls:src/lib/orders.ts#OrderService.place", fixture]);
  assert.equal(method.status, 2);
  assert.ok(method.stderr.includes("a method cannot be run on its own"), method.stderr);
  const unknown = archdiff(["run", "calls:src/lib/orders.ts#nope", fixture]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stderr, 'archdiff: run: no function "src/lib/orders.ts#nope" (archdiff views lists the entry points)\n');
  assert.equal(archdiff(["run", "layers", fixture]).status, 2);
  assert.ok(!existsSync(join(fixture, ".archdiff")) || !readdirSync(join(fixture, ".archdiff")).some((name) => name.startsWith("run-")), "the plan file is removed after the run");
});

test("spec --tests writes a test skeleton per Gherkin scenario and keeps a test file archdiff did not write", () =>
  withTempDir("archdiff-gherkin-", (dir) => {
    mkdirSync(join(dir, "features"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "features/orders.feature"), "# a comment\n@tag\nFeature: Orders\n  Orders are placed and paid.\n\n  Background:\n    Given a store\n\n  Scenario: Place an order\n    When I place an order of 5\n    Then it is saved\n    And it is logged\n\n  Scenario Outline: Pay\n    Given an order\n    When I pay <amount>\n    Then it is paid\n");
    writeFileSync(join(dir, "features/mine.feature"), "Feature: Mine\n  Scenario: Kept\n    Then nothing\n");
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/mine.test.ts"), "// my own test file\n");
    const { status, stdout } = archdiff(["spec", dir, "--tests"]);
    assert.equal(status, 0, stdout);
    assert.ok(stdout.includes("tests/orders.test.ts\twritten") && stdout.includes("tests/mine.test.ts\tkept"), stdout);
    const written = readFileSync(join(dir, "tests/orders.test.ts"), "utf8");
    assert.ok(written.startsWith("// archdiff:generated — test skeletons of features/orders.feature"), written);
    assert.ok(written.includes("// Background: Given a store"), written);
    assert.ok(written.includes('test("Place an order", { todo: "not written yet" }, () => {\n  // When I place an order of 5\n  // Then it is saved\n  // And it is logged\n});'), written);
    assert.ok(written.includes('test("Pay", { todo: "not written yet" }, () => {'), written);
    assert.equal(readFileSync(join(dir, "tests/mine.test.ts"), "utf8"), "// my own test file\n");
    // A directory given as an absolute path is where the skeletons go (not under the root), and the output names it so.
    const elsewhere = join(dir, "elsewhere", "skeletons");
    const absolute = archdiff(["spec", dir, "--tests", elsewhere]);
    assert.equal(absolute.status, 0, absolute.stdout);
    assert.ok(absolute.stdout.includes(`${join(elsewhere, "orders.test.ts")}\twritten`), absolute.stdout);
    assert.ok(existsSync(join(elsewhere, "orders.test.ts")) && !existsSync(join(dir, elsewhere)), "the skeleton sits at the absolute path and nowhere under the root");
    // The skeleton is a valid test file: node runs it with every test marked to do.
    // Outside this test run's own context, so the child's reporter writes to its stdout as it would for a user.
    const env = { ...process.env };
    delete env["NODE_TEST_CONTEXT"];
    const ran = spawnSync(process.execPath, ["--test", join(dir, "tests/orders.test.ts")], { encoding: "utf8", env });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.ok(ran.stdout.includes("todo 2"), ran.stdout);
  }));

test("focus draws everything joined to a function or a module; logic draws a function's body as a flowchart with its paths as rules", () => {
  const machines = join(root, "tests/fixtures/machines");
  const focus = archdiff(["diagram", "focus:src/lib/orders.ts#placeOrder", fixture]);
  assert.equal(focus.status, 0, focus.stderr);
  assert.ok(focus.stdout.includes("# Everything joined to placeOrder") && focus.stdout.includes("src_lib_orders_ts_OrderService_place ==> src_lib_orders_ts_placeOrder") && focus.stdout.includes('subgraph "src/db/store.ts"'), focus.stdout);
  const moduleFocus = JSON.parse(archdiff(["diagram", "focus:src/lib/orders.ts", fixture, "--format", "json"]).stdout) as { groups: { id: string }[]; nodes: { id: string }[]; reason: string };
  assert.ok(moduleFocus.groups.map((group) => group.id).includes("src/routes/checkout.tsx") && moduleFocus.nodes.some((node) => node.id === "src/routes/checkout.tsx#action"), moduleFocus.reason);
  assert.equal(archdiff(["diagram", "focus:src/nope.ts", fixture]).status, 2);
  // A loop, a branch inside it and a try: diamonds with labelled arrows, and every path from the start to the return as a rule.
  const logic = archdiff(["diagram", "logic:src/checkout.ts#checkout", machines]);
  assert.equal(logic.status, 0, logic.stderr);
  assert.ok(logic.stdout.includes("flowchart TB") && logic.stdout.includes('n2{{"↻ const order of orders"}}') && logic.stdout.includes('n4{"rush"}') && logic.stdout.includes('n2 -->|"each"| n3') && logic.stdout.includes('n7 -->|"error"| n9') && logic.stdout.includes('n5 --> n2'), logic.stdout);
  assert.ok(logic.stdout.includes("| `const order of orders: each` and `rush: yes` and `try: ok` | `pay`, `ship`, `audit` | **return shipped** |"), logic.stdout);
  assert.ok(logic.stdout.includes("| `const order of orders: done` and `try: error` | `cancel` | **return shipped** |"), logic.stdout);
  // A switch: one arrow per case, the default a throw (orange); a Python match: no match carries on.
  const pay = archdiff(["diagram", "logic:src/order.ts#pay", machines]).stdout;
  assert.ok(pay.includes('n1{"switch order.status"}') && pay.includes('n1 -->|"#quot;new#quot;"| n2') && pay.includes("class n3 warning") && pay.includes("| `switch order.status: default` |  | **throw new Error"), pay);
  const door = archdiff(["diagram", "logic:src/door.py#Door.lock", machines]).stdout;
  assert.ok(door.includes('n1{"match self.state"}') && door.includes('n1 -->|"no match"| n4') && door.includes("**raise ValueError"), door);
  // The list of branching functions, in the views and as a picture; an unknown function is refused; the Excalidraw export draws diamonds.
  const list = archdiff(["diagram", "logic", machines]).stdout;
  assert.ok(list.includes("# Logic: 7 functions with branches") && list.includes("checkout<br/>3 branches"), list);
  assert.ok(archdiff(["views", machines]).stdout.includes("logic:src/checkout.ts#checkout\tcheckout (src/checkout.ts) — 3 branches"));
  assert.equal(archdiff(["diagram", "logic:src/nope.ts#f", machines]).status, 2);
  const excalidraw = archdiff(["diagram", "logic:src/checkout.ts#checkout", machines, "--format", "excalidraw"]).stdout;
  assert.equal((excalidraw.match(/"type": "diamond"/g) ?? []).length, 3, "three diamonds: the loop, the branch, the try");
});

test("logic walks every loop and every way out: a loop in a loop, a branch back into a loop, a labelled jump, a finally after a return, Python's elif and else", () =>
  withTempDir("archdiff-logic-", (dir) => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/grid.ts"), "export function grid(rows: number[][]): number {\n  for (const row of rows) {\n    for (const cell of row) {\n      if (cell > 0) work(cell);\n    }\n  }\n  return 1;\n}\nexport function withLock(n: number): number {\n  acquire();\n  try {\n    if (n > 0) return work(n);\n    return 0;\n  } finally {\n    release();\n  }\n}\nexport function labeled(rows: number[][]): number {\n  outer: for (const row of rows) {\n    for (const cell of row) {\n      if (cell === 0) continue outer;\n      if (cell < 0) break outer;\n      work(cell);\n    }\n  }\n  return 1;\n}\nfunction work(n: number): number { return n; }\nfunction acquire(): void {}\nfunction release(): void {}\n");
    writeFileSync(join(dir, "src/conn.py"), 'def guarded(conn, mode):\n    if mode == "a":\n        conn.reset()\n    elif mode == "b":\n        conn.flush()\n    else:\n        conn.drain()\n    try:\n        conn.open()\n    except OSError:\n        return False\n    finally:\n        conn.close()\n    return True\n');
    const rules = (view: string): string[] => archdiff(["diagram", view, dir]).stdout.split("\n").filter((line) => line.startsWith("| `") || line.startsWith("| |"));
    // The inner loop's body is on a path of its own, and the branch that goes back into the loop keeps its condition.
    assert.deepEqual(rules("logic:src/grid.ts#grid"), ["| `const row of rows: each` and `const cell of row: each` and `cell > 0: yes` | `work` | **return 1** |", "| `const row of rows: each` and `const cell of row: each` and `cell > 0: no` |  | **return 1** |", "| `const row of rows: each` and `const cell of row: done` |  | **return 1** |", "| `const row of rows: done` |  | **return 1** |"]);
    // `finally` runs after the return, on every way out of the try.
    assert.deepEqual(rules("logic:src/grid.ts#withLock"), ["| `try: ok` and `n > 0: yes` | `acquire`, `work`, `release` | **return work(n)** |", "| `try: ok` and `n > 0: no` | `acquire`, `release` | **return 0** |"]);
    // `continue outer` goes back to the outer loop, `break outer` past it.
    const picture = JSON.parse(archdiff(["diagram", "logic:src/grid.ts#labeled", dir, "--format", "json"]).stdout) as { nodes: { id: string; label: string }[]; edges: { from: string; to: string; label?: string }[] };
    const labelOf = (id: string): string => picture.nodes.find((node) => node.id === id)?.label ?? id;
    const yesOf = (label: string): string => labelOf(picture.edges.find((edge) => labelOf(edge.from) === label && edge.label === "yes")?.to ?? "");
    assert.equal(yesOf("cell === 0"), "↻ const row of rows");
    assert.equal(yesOf("cell < 0"), "return 1");
    // Python: `elif` leads on to `else`; an `except` that returns runs `finally` first.
    const python = archdiff(["diagram", "logic:src/conn.py#guarded", dir]).stdout;
    assert.ok(python.includes('|"no"| ') && python.includes("conn.drain()"), python);
    assert.ok(rules("logic:src/conn.py#guarded").includes('| `mode == "a": no` and `mode == "b": no` and `try: error OSError` | `conn.drain`, `conn.close` | **return False** |'), python);
  }));
