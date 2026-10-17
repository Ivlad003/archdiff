// Behavioural tests through the real CLI on tests/fixtures/sample: the
// analysis, the views, every export format, the coverage map, and the
// review of a change in a temporary git repository.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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
  assert.ok(stdout.startsWith("<!-- archdiff:generated — view calls:src/lib/orders.ts#placeOrder -->\n# Calls from placeOrder\n"));
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

test("review reports the architectural diff of the working tree against a base commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-review-"));

  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--out writes a new file or one archdiff wrote, and refuses any other file", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-out-"));

  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file over the size limit is left out and named by the coverage report", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-big-"));

  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review measures the change from the merge-base, not from the tip of main", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-mb-"));

  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flow lists the steps from an entry with their types, the storages, and the mocks carried by name", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-flow-"));

  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan refuses a view without a drawing and web --agent refuses an unknown agent", () => {
  const missing = archdiff(["plan", "module:src/lib/orders.ts", fixture]);
  assert.equal(missing.status, 2);
  assert.ok(missing.stderr.includes("has no saved drawing"));
  const unknown = archdiff(["web", fixture, "--agent", "copilot"]);
  assert.equal(unknown.status, 2);
  assert.ok(unknown.stderr.includes("not claude or cursor"));
});

test("history lists the drift commit by commit, and review --head compares two refs", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-history-"));

  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a package of a monorepo resolves imports through its own tsconfig, and extends reaches node_modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-mono-"));

  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dir views list directories with two modules, and a folded picture groups by directory", () => {
  const { stdout } = archdiff(["views", fixture]);
  assert.ok(stdout.includes("dir:src/lib\tsrc/lib/ (2)"), stdout);
  const folded = JSON.parse(archdiff(["diagram", "layer:lib", fixture, "--format", "json", "--limit", "1"]).stdout) as { nodes: { id: string; kind: string; label: string; ref?: { id?: string } }[] };
  const groups = folded.nodes.filter((node) => node.kind === "more");
  assert.ok(groups.some((node) => node.id === "more:src/lib" && node.label === "… 1 in src/lib/" && node.ref?.id === "dir:src/lib"), JSON.stringify(groups));
  const dir = archdiff(["diagram", "dir:src/lib", fixture, "--format", "mermaid", "--depth", "0"]);
  assert.equal(dir.status, 0);
  assert.ok(dir.stdout.includes("src_lib_orders_ts --> src_lib_log_ts"), dir.stdout);
});

test("flow carries a mock into a destructured parameter, key by key", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-flow2-"));

  try {
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(join(dir, "src/lib/log.ts"), "export function log({ message, level }: { message: string; level?: number }): void {\n  console.log(level, message);\n}\n");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, ".archdiff/layouts"), { recursive: true });
    writeFileSync(join(dir, ".archdiff/layouts/calls_src_lib_log.ts_log.json"), JSON.stringify({ format: 1, view: "calls:src/lib/log.ts#log", elements: [], mocks: [{ id: "src/lib/log.ts#log", kind: "input", value: '{"message": "hi", "other": 1}' }], saved: "2026-10-16T00:00:00.000Z" }));
    const flow = JSON.parse(archdiff(["flow", "calls:src/lib/log.ts#log", dir, "--json"]).stdout) as { steps: { params: { name: string; value?: string }[] }[] };
    assert.equal(flow.steps[0]?.params[0]?.value, '{ message: "hi" }');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("layouts lists the drawings and --prune deletes the orphans", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-layouts-"));

  try {
    cpSync(fixture, dir, { recursive: true });
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, ".archdiff/layouts"), { recursive: true });
    const file = (view: string, name: string): void => writeFileSync(join(dir, ".archdiff/layouts", name), JSON.stringify({ format: 1, view, elements: [], mocks: [], saved: "2026-10-16T00:00:00.000Z" }));
    file("module:src/lib/orders.ts", "module_src_lib_orders.ts.json");
    file("module:src/lib/gone.ts", "module_src_lib_gone.ts.json");
    const listed = archdiff(["layouts", dir]);
    assert.equal(listed.status, 0);
    assert.ok(listed.stdout.includes("module_src_lib_orders.ts.json\tmodule:src/lib/orders.ts\tok"));
    assert.ok(listed.stdout.includes("module_src_lib_gone.ts.json\tmodule:src/lib/gone.ts\torphan"));
    const pruned = archdiff(["layouts", dir, "--prune"]);
    assert.ok(pruned.stdout.includes("orphan\tdeleted"));
    assert.ok(existsSync(join(dir, ".archdiff/layouts/module_src_lib_orders.ts.json")));
    assert.ok(!existsSync(join(dir, ".archdiff/layouts/module_src_lib_gone.ts.json")));
    assert.ok(archdiff(["--version"]).stdout.trim().match(/^\d+\.\d+\.\d+$/));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python, Rust and PHP are read with the same graph: imports resolve and calls are followed", () => {
  const polyglot = join(root, "tests/fixtures/polyglot");
  const stats = JSON.parse(archdiff(["analyze", polyglot, "--json", "--no-cache"]).stdout) as { files: number; unresolvedImports: number; calls: number };
  assert.equal(stats.files, 10);
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

test("CommonJS: chained exports, a re-exporting index and a module binding called as a function all resolve", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-cjs-"));

  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust: a facade crate's renamed re-exports and `use self::` of the file's own types resolve", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-rust-"));

  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a class extending a package's class: a missing member is the package's, not a blind spot", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-base-"));

  try {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/view.ts"), 'import { Component } from "react";\n\nexport class View extends Component {\n  render() {\n    this.setState({});\n    return this.own();\n  }\n  own() {\n    return 1;\n  }\n}\n');
    const coverage = JSON.parse(archdiff(["coverage", dir, "--json"]).stdout) as { blind: number; byReason: Record<string, number> };
    assert.equal(coverage.blind, 0);
    assert.equal(coverage.byReason["external"], 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("matrix, contract, type flow, path to the storages and hotspots on the fixture", () => {
  const matrix = JSON.parse(archdiff(["diagram", "matrix", fixture, "--format", "json"]).stdout) as { placed?: boolean; nodes: { id: string; label: string; diff?: string }[]; reason?: string };
  assert.equal(matrix.placed, true);
  assert.ok(matrix.nodes.some((node) => node.id === "cell:routes>lib" && node.label === "1"), JSON.stringify(matrix.nodes.filter((node) => node.label !== "")));
  assert.ok(matrix.reason?.includes("every import follows the layer order"), matrix.reason);
  const contract = archdiff(["diagram", "contract:src/lib/orders.ts", fixture, "--format", "mermaid"]).stdout;
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

test("cycles, events, tests, packages and timeline on a repository that has them", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-views-"));

  try {
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
    assert.deepEqual(parsed.groups.map((group) => group.id), ["cycle 1 (2)"]);
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("branches lists the branches with the default base, and compare puts several heads against it", () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-branches-"));

  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
