// Behavioural tests through the real CLI on tests/fixtures/sample: the
// analysis, the views, every export format, the coverage map, and the
// review of a change in a temporary git repository.
//
// Entry point: run by `npm test`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withTempDir } from "./temp-dir.ts";

const root = join(import.meta.dirname, "..");

const require = (await import("node:module")).createRequire(import.meta.url);

const fixture = join(root, "tests/fixtures/sample");

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
});

test("every export format is well formed and byte-stable", () => {
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

test("a wrong view, format or command exits 2 with a message on stderr", () => {
  assert.equal(archdiff(["diagram", "nothing:x", fixture]).status, 2);
  assert.equal(archdiff(["diagram", "layers", fixture, "--format", "png"]).status, 2);
  const unknown = archdiff(["frobnicate"]);
  assert.equal(unknown.status, 2);
  assert.ok(unknown.stderr.includes('unknown command "frobnicate"'));
  assert.equal(archdiff([]).status, 2);
  assert.equal(archdiff(["--help"]).status, 0);
});

test("review reports the architectural diff of the working tree against a base commit", () =>
  withTempDir("archdiff-review-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = (...args: string[]): void => {
      const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "base");
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
    const json = JSON.parse(archdiff(["review", dir, "--base", "HEAD", "--format", "json"]).stdout) as { callsAdded: { from: string; to: string }[] };
    assert.ok(json.callsAdded.some((edge) => edge.from === "src/routes/checkout.tsx#action" && edge.to === "src/db/store.ts#readOrder"));
    // No change: exit 0 and an empty picture.
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-am", "change");
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
  }));

test("review measures the change from the merge-base, not from the tip of main", () =>
  withTempDir("archdiff-mb-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = (...args: string[]): string => {
      const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);

      return result.stdout.trim();
    };
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
  assert.ok(unknown.stderr.includes("not claude or cursor"));
});

test("history lists the drift commit by commit, and review --head compares two refs", () =>
  withTempDir("archdiff-history-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = (...args: string[]): string => {
      const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);

      return result.stdout.trim();
    };
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "src/lib/extra.ts"), "export function extra(): number {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "add extra");
    writeFileSync(join(dir, "src/routes/checkout.tsx"), 'import { OrderService } from "@/lib/orders";\nimport { readOrder } from "@/db/store";\n\nexport async function action(request: { total: number }) {\n  readOrder("x");\n  return new OrderService("web").place(request.total);\n}\n');
    git("commit", "-q", "-am", "route reads the store");
    const { status, stdout } = archdiff(["history", dir, "--base", "main", "--head", "feature"]);
    assert.equal(status, 0, stdout);
    const rows = stdout.split("\n").filter((line) => line.startsWith("| `"));
    assert.equal(rows.length, 2);
    assert.ok(rows[0]!.includes("add extra | ") && rows[0]!.includes("| +1 −0 |"), rows[0]);
    assert.ok(rows[1]!.includes("route reads the store") && rows[1]!.includes("+routes→db"), rows[1]);
    // Two refs: the first commit alone adds a module and no coupling.
    const first = archdiff(["review", dir, "--base", "main", "--head", "feature~1"]);
    assert.equal(first.status, 0, first.stdout);
    assert.ok(first.stdout.includes("## Modules added\n\n- src/lib/extra.ts"), first.stdout);
    assert.ok(!first.stdout.includes("routes → db"));
    const second = archdiff(["review", dir, "--base", "feature~1", "--head", "feature"]);
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
    const listed = archdiff(["drawings", dir]);
    assert.equal(listed.status, 0);
    assert.ok(listed.stdout.includes("module_src_lib_orders.ts.json\tmodule:src/lib/orders.ts\tok"));
    assert.ok(listed.stdout.includes("module_src_lib_gone.ts.json\tmodule:src/lib/gone.ts\torphan"));
    // The command still answers to its old name.
  const pruned = archdiff(["layouts", dir, "--prune"]);
    assert.ok(pruned.stdout.includes("orphan\tdeleted"));
    assert.ok(existsSync(join(dir, ".archdiff/layouts/module_src_lib_orders.ts.json")));
    assert.ok(!existsSync(join(dir, ".archdiff/layouts/module_src_lib_gone.ts.json")));
    assert.ok(archdiff(["--version"]).stdout.trim().match(/^\d+\.\d+\.\d+$/));
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
    assert.equal(tests.nodes.find((node) => node.id === "packages/app/src/b.ts")?.diff, "changed");
    assert.ok(!tests.nodes.some((node) => node.id.includes("test/")));
    const packages = archdiff(["diagram", "packages", dir, "--format", "mermaid"]).stdout;
    // app declares lib and its test imports one file of it.
    assert.ok(packages.includes('acme_app -->|"declared, 1 imports"| acme_lib'), packages);
    // The timeline needs commits.
    const git = (...args: string[]): void => {
      const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(dir, "packages/lib/src/extra.ts"), "export function extra(): number {\n  return 2;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "lib: extra");
    const timeline = JSON.parse(archdiff(["diagram", "timeline", dir, "--base", "main~1", "--head", "main", "--format", "json"]).stdout) as { placed?: boolean; nodes: { id: string; label: string }[]; title: string };
    assert.equal(timeline.placed, true);
    assert.ok(timeline.title.includes("1 commits"), timeline.title);
    assert.ok(timeline.nodes.some((node) => node.id.startsWith("commit:") && node.label.includes("lib: extra")), JSON.stringify(timeline.nodes));
  }));

test("branches lists the branches with the default base, and compare puts several heads against it", () =>
  withTempDir("archdiff-branches-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = (...args: string[]): void => {
      const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
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
    // A third head: the working tree on develop with a change of its own.
    writeFileSync(join(dir, "src/lib/log.ts"), "export function log(message: string): void {\n  console.warn(message);\n}\n");
    const branches = archdiff(["branches", dir]);
    assert.equal(branches.status, 0, branches.stderr);
    assert.ok(branches.stdout.startsWith("base: develop\ncurrent: develop\n"), branches.stdout);
    assert.ok(branches.stdout.includes("  feature-a\t") && branches.stdout.includes("* develop\t"), branches.stdout);
    const compare = archdiff(["compare", dir, "--heads", "feature-a,feature-b,WORKTREE"]);
    assert.equal(compare.status, 1, compare.stdout);
    assert.ok(compare.stdout.includes("# 3 heads against develop"), compare.stdout);
    assert.ok(compare.stdout.includes("| feature-a | 1 | +1 −0 |"), compare.stdout);
    assert.ok(compare.stdout.includes("| feature-b | 2 |") && compare.stdout.includes("⚠ +routes→db"), compare.stdout);
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
});

test("classes draws the class diagram with fields, methods, extends and implements, as boxes and as Mermaid", () =>
  withTempDir("archdiff-classes-", (dir) => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/repo.ts"), "export interface Repo {\n  save(o: Order): void;\n  readonly name: string;\n}\nexport type Order = { id: string; total: number };\n");
    writeFileSync(join(dir, "src/service.ts"), 'import type { Repo, Order } from "./repo.ts";\n\nexport abstract class Base {\n  abstract go(): void;\n  stop(): void {}\n}\n\nexport class Service extends Base implements Repo {\n  readonly name = "svc";\n  constructor(private readonly repo: Repo, public label?: string) {\n    super();\n  }\n  go(): void {\n    this.save({ id: "1", total: 1 });\n  }\n  save(o: Order): void {\n    this.repo.save(o);\n  }\n  get size(): number {\n    return 1;\n  }\n}\n');
    const md = archdiff(["diagram", "classes", dir]).stdout;
    assert.ok(md.includes("classDiagram"), md);
    assert.ok(md.includes("<<interface>>"), md);
    assert.ok(md.includes("-repo: Repo") && md.includes("+label?: string"), md);
    assert.ok(md.includes("+save(o: Order) → void") || md.includes("+save(o: Order) returns void"), md);
    assert.ok(md.includes("src_service_ts_Base <|-- src_service_ts_Service"), md);
    assert.ok(md.includes("src_repo_ts_Repo <|.. src_service_ts_Service"), md);
    assert.ok(md.includes("## «interface» Repo — src/repo.ts:1") && md.includes("- field `+name: string`"), md);
    const json = JSON.parse(archdiff(["diagram", "classes:src/service.ts", dir, "--format", "json"]).stdout) as { nodes: { id: string; kind: string; h: number; label: string }[]; edges: { label?: string }[]; groups: { id: string }[] };
    // The scope is one module; the interface it implements comes along from repo.ts, in its own lane.
    assert.deepEqual(json.groups.map((group) => group.id).sort(), ["src/repo.ts", "src/service.ts"]);
    const service = json.nodes.find((node) => node.id === "src/service.ts#Service")!;
    assert.equal(service.kind, "class");
    assert.ok(service.h > 100 && service.label.startsWith("Service\n"), service.label);
    assert.deepEqual(json.edges.map((edge) => edge.label).sort(), ["extends", "implements"]);
  }));

test("--changes lays the review's marks over any view", () =>
  withTempDir("archdiff-overlay-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const git = (...args: string[]): void => {
      const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
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
    assert.ok(only.reason?.includes("only the 1 changed shapes and their neighbours"), only.reason);
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
  assert.ok(json.reason?.includes("storages") && json.reason.includes("no test"), json.reason);
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
    // A design note with a flowchart replaces the intent; archdiff.json's layers follow it.
    writeFileSync(join(dir, "note.md"), "# Note\n\n```mermaid\nflowchart TD\n  subgraph http[\"http — the edge\"]\n    A[\"src/http/orders.ts<br>POST /orders\"]\n  end\n  subgraph app\n    S[\"src/app/orders.ts: places orders\"]\n  end\n  A -->|validated| S\n```\n");
    const imported = archdiff(["import", join(dir, "note.md"), target]);
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

test("metrics: coupling and cohesion by module and layer, as Markdown and JSON; the pictures of cycles say where to cut", () => {
  const { status, stdout } = archdiff(["metrics", fixture]);
  assert.equal(status, 0, stdout);
  assert.ok(stdout.includes("| **lib** | 2 | 1 | 1 | 0.50 |"), stdout);
  assert.ok(stdout.includes("| src/routes/checkout.tsx | routes | 0 | 1 | 1.00 | 0.00 | 0.00 |"), stdout);
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
    const git = (...args: string[]): void => {
      const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "base");
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
    // A module that calls fetch is a storage by what it does, without a name or a package that says so.
    writeFileSync(join(dir, "src/lib/remote.ts"), `export async function load(id: string): Promise<unknown> {\n  const response = await fetch(\`/api/\${id}\`);\n  return response.json();\n}\n`);
    const storages = archdiff(["diagram", "layer:lib", dir, "--overlay", "storages"]).stdout;
    assert.ok(storages.includes("⛁ HTTP (fetch)"), storages);
    // archdiff.json names a storage by glob, and a package by name.
    writeFileSync(join(dir, "archdiff.json"), JSON.stringify({ storages: { "src/lib/log.ts": "the log file" }, storagePackages: {} }));
    assert.ok(archdiff(["diagram", "layer:lib", dir, "--overlay", "storages"]).stdout.includes("⛁ the log file"));
  }));

test("state machines: the implicit ones written with literals, the explicit ones a library declares, in TypeScript and Python", () => {
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
  // The list of machines, and a machine that does not exist.
  const list = archdiff(["diagram", "machines", machines]).stdout;
  assert.ok(list.includes("# State machines (3)") && list.includes("1 declared by a library, 2 written with literals"), list);
  assert.equal(archdiff(["diagram", "machine:src/order.ts#nope", machines]).status, 2);
  // A sequence frames the calls under a loop, a branch, a try and a catch, nesting the branch inside the loop.
  const sequence = archdiff(["diagram", "sequence:src/checkout.ts#checkout", machines]).stdout;
  assert.ok(sequence.includes("  loop const order of orders\n  P0->>P1: 1. pay()\n    opt rush\n  P0->>P1: 2. ship()\n    end\n    opt not rush\n  P0->>P1: 3. cancel()\n    end\n  end\n  opt try\n  P0->>P0: 4. audit()\n  end\n  opt catch\n  P0->>P1: 5. cancel()\n  end"), sequence);
  assert.ok(sequence.includes("- _loop [const order of orders]_ — messages 1–3"), sequence);
  const json = JSON.parse(archdiff(["diagram", "sequence:src/checkout.ts#checkout", machines, "--format", "json"]).stdout) as { nodes: { kind: string; label: string }[] };
  assert.deepEqual(json.nodes.filter((node) => node.kind === "fragment").map((node) => node.label), ["loop [const order of orders]", "opt [rush]", "opt [not rush]", "opt [try]", "opt [catch]"]);
});

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
  // A thrown error is the run's error, exit 1; a method and an unknown function are refused with a reason.
  const negative = archdiff(["run", "calls:src/lib/orders.ts#placeOrder", fixture, "--input", '{"id":"o2","total":-1}']);
  assert.equal(negative.status, 1);
  assert.ok(negative.stdout.includes("**Error:** Error: negative"), negative.stdout);
  assert.ok(archdiff(["run", "calls:src/lib/orders.ts#OrderService.place", fixture]).stdout.includes("a method cannot be run on its own"));
  assert.equal(archdiff(["run", "calls:src/lib/orders.ts#nope", fixture]).status, 1);
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
