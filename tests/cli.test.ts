// Behavioural tests through the real CLI on tests/fixtures/sample: the
// analysis, the views, every export format, the coverage map, and the
// review of a change in a temporary git repository.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

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
  assert.equal(keys[keys.length - 1], "coverage");
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

test("the module view, with depth 0, is the module and its packages only", () => {
  const deep = archdiff(["diagram", "module:src/db/store.ts", fixture, "--format", "json"]);
  assert.equal(deep.status, 0);
  const diagram = JSON.parse(deep.stdout) as { nodes: { id: string; kind: string; x: number; w: number }[]; edges: { from: string; to: string }[] };
  assert.deepEqual(
    diagram.nodes.map((node) => node.id).sort(),
    ["node:fs", "src/db/store.ts", "src/lib/orders.ts"],
  );
  assert.ok(diagram.nodes.every((node) => node.w > 0));
  const shallow = archdiff(["diagram", "module:src/db/store.ts", fixture, "--format", "json", "--depth", "0"]);
  const own = JSON.parse(shallow.stdout) as { nodes: { id: string }[] };
  assert.deepEqual(
    own.nodes.map((node) => node.id).sort(),
    ["node:fs", "src/db/store.ts"],
  );
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
