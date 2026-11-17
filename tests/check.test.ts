// The contract check through the real CLI and the HTTP API on copies of
// tests/fixtures/sample: the baseline of known violations — written,
// honoured, and shrunk as the code is fixed — in the command, the page's
// check and the checks after an agent's run.
//
// Entry point: run by `npm test`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withTempDir } from "./temp-dir.ts";
import { withOwnServer } from "./web-server.ts";

const root = join(import.meta.dirname, "..");
const fixture = join(root, "tests/fixtures/sample");

function archdiff(args: string[], cwd = root): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "bin/archdiff.js"), ...args], { cwd, encoding: "utf8" });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The sample's contract: routes → lib → db, and no other way between the layers. */
const CONTRACT = "# Architecture\n\n```mermaid\nflowchart LR\n  subgraph routes\n    r[src/routes/checkout.tsx]\n  end\n  subgraph lib\n    o[src/lib/orders.ts]\n  end\n  subgraph db\n    s[src/db/store.ts]\n  end\n  r --> o\n  o --> s\n```\n";

/** A module of db that imports upwards twice: db → routes and db → lib, both against the contract. */
const REPORT = 'import { action } from "../routes/checkout.tsx";\nimport { log } from "../lib/log.ts";\n\nexport function report(): unknown {\n  log("r");\n  return action({ total: 1 });\n}\n';

/** A copy of the sample with the contract and the two imports against it, for `body`. */
function withViolations(body: (dir: string) => void): Promise<void> {
  return withTempDir("archdiff-check-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(join(dir, "ARCHITECTURE.md"), CONTRACT);
    writeFileSync(join(dir, "src/db/report.ts"), REPORT);
    body(dir);
  });
}

test("a baseline is written, honoured and shrunk: the known violations do not fail check, a new one does, a fixed one is named", () =>
  withViolations((dir) => {
    const baseline = join(dir, "archdiff-baseline.json");
    const entries = (): unknown => (JSON.parse(readFileSync(baseline, "utf8")) as { violations: unknown }).violations;
    // Without a baseline the two imports fail the check.
    const red = archdiff(["check", dir]);
    assert.equal(red.status, 1, red.stdout);
    assert.ok(red.stdout.includes("**2 violations of the intent.**") && red.stdout.includes("## Violations\n"), red.stdout);
    assert.ok(!existsSync(baseline));
    // --baseline writes them to the file at the root, by what they are and without a line; the check is green from then on.
    const written = archdiff(["check", dir, "--baseline"]);
    assert.equal(written.status, 0, written.stderr);
    assert.ok(written.stderr.includes("archdiff check: 2 violations known from now on: commit the file, and check fails on any other"), written.stderr);
    assert.deepEqual(entries(), [
      { rule: "layers", from: "src/db/report.ts", to: "src/lib/log.ts" },
      { rule: "layers", from: "src/db/report.ts", to: "src/routes/checkout.tsx" },
    ]);
    const green = archdiff(["check", dir]);
    assert.equal(green.status, 0, green.stdout);
    assert.equal(green.stderr, "archdiff check: the code follows the intent; 2 known violations in archdiff-baseline.json\n");
    assert.ok(green.stdout.includes("## Known violations (2)\n\nListed in `archdiff-baseline.json`: they do not fail the check.\n\n- `src/db/report.ts:1` imports `src/routes/checkout.tsx`: layer **db** → **routes** is not in the intent.\n- `src/db/report.ts:2` imports `src/lib/log.ts`: layer **db** → **lib** is not in the intent.\n"), green.stdout);
    assert.ok(!green.stdout.includes("## Violations") && !green.stdout.includes("## New violations"), green.stdout);
    // A violation is known by what it is, not by its line: the imports moved down are the same two.
    writeFileSync(join(dir, "src/db/report.ts"), `// moved\n\n${REPORT}`);
    const moved = archdiff(["check", dir]);
    assert.equal(moved.status, 0, moved.stdout);
    assert.ok(moved.stdout.includes("- `src/db/report.ts:3` imports `src/routes/checkout.tsx`"), moved.stdout);
    // A violation that is not in the file fails the check, listed apart from the known ones.
    writeFileSync(join(dir, "src/routes/peek.ts"), 'import { readOrder } from "../db/store.ts";\n\nexport function peek(): unknown {\n  return readOrder("x");\n}\n');
    const fresh = archdiff(["check", dir]);
    assert.equal(fresh.status, 1, fresh.stdout);
    assert.equal(fresh.stderr, "archdiff check: 1 new violation of the intent; 2 known violations in archdiff-baseline.json\n");
    assert.ok(fresh.stdout.includes("## New violations (1)\n\n- `src/routes/peek.ts:1` imports `src/db/store.ts`: layer **routes** → **db** is not in the intent. Add the arrow to ARCHITECTURE.md if it is wanted, else move the import.\n\n## Known violations (2)"), fresh.stdout);
    // The JSON lists every violation, each with its rule and whether the baseline knows it; `ok` is the exit code.
    const json = JSON.parse(archdiff(["check", dir, "--json"]).stdout) as { ok: boolean; baseline: string; violations: Record<string, unknown>[]; stale: unknown[] };
    assert.equal(json.ok, false);
    assert.equal(json.baseline, "archdiff-baseline.json");
    assert.deepEqual(json.violations.map((violation) => [violation["from"], violation["to"], violation["rule"], violation["known"]]), [["src/db/report.ts", "src/routes/checkout.tsx", "layers", true], ["src/db/report.ts", "src/lib/log.ts", "layers", true], ["src/routes/peek.ts", "src/db/store.ts", "layers", false]]);
    assert.deepEqual(json.violations[2], { rule: "layers", from: "src/routes/peek.ts", to: "src/db/store.ts", fromLayer: "routes", toLayer: "db", line: 1, problem: "layer routes → db is not in the intent", known: false });
    assert.deepEqual(json.stale, []);
    // The new one fixed, and one of the known ones: the check is green and says which entry the file can drop.
    rmSync(join(dir, "src/routes/peek.ts"));
    writeFileSync(join(dir, "src/db/report.ts"), 'import { action } from "../routes/checkout.tsx";\n\nexport function report(): unknown {\n  return action({ total: 1 });\n}\n');
    const fixed = archdiff(["check", dir]);
    assert.equal(fixed.status, 0, fixed.stdout);
    assert.equal(fixed.stderr, "archdiff check: the code follows the intent; 1 known violation in archdiff-baseline.json; 1 entry of archdiff-baseline.json no longer occurs\n");
    assert.ok(fixed.stdout.includes("## Fixed since the baseline (1)\n\nThese entries of `archdiff-baseline.json` no longer occur: remove them (`archdiff check --baseline` writes the file anew).\n\n- `src/db/report.ts` imports `src/lib/log.ts` — layers\n"), fixed.stdout);
    // Written anew, the file is one entry shorter.
    assert.equal(archdiff(["check", dir, "--baseline"]).status, 0);
    assert.deepEqual(entries(), [{ rule: "layers", from: "src/db/report.ts", to: "src/routes/checkout.tsx" }]);
    // --no-baseline holds the code to none: the known violation fails the check again.
    const bare = archdiff(["check", dir, "--no-baseline"]);
    assert.equal(bare.status, 1, bare.stdout);
    assert.equal(bare.stderr, "archdiff check: 1 violation of the intent\n");
  }));

test("the baseline's file: another path by archdiff.json or --baseline FILE, never written over a file that is not archdiff's, refused when it is wrong", () =>
  withViolations((dir) => {
    // --baseline FILE writes there, and says that check reads the configured path.
    const elsewhere = join(dir, "known.json");
    const written = archdiff(["check", dir, "--baseline", elsewhere]);
    assert.equal(written.status, 0, written.stderr);
    assert.ok(existsSync(elsewhere) && !existsSync(join(dir, "archdiff-baseline.json")));
    assert.ok(written.stderr.includes(`check reads archdiff-baseline.json; name ${elsewhere} as "baseline" in archdiff.json to have it read`), written.stderr);
    assert.equal(archdiff(["check", dir]).status, 1, "a baseline check does not read was honoured");
    // archdiff.json names the file: check reads it, and --baseline writes it.
    const config = JSON.parse(readFileSync(join(dir, "archdiff.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "archdiff.json"), JSON.stringify({ ...config, baseline: "known.json" }));
    const named = archdiff(["check", dir]);
    assert.equal(named.status, 0, named.stdout);
    assert.ok(named.stdout.includes("Listed in `known.json`"), named.stdout);
    rmSync(elsewhere);
    assert.equal(archdiff(["check", dir, "--baseline"]).status, 0);
    assert.ok(existsSync(elsewhere));
    // A file archdiff did not write is kept as it is.
    writeFileSync(elsewhere, '{ "mine": true }\n');
    const kept = archdiff(["check", dir, "--baseline"]);
    assert.equal(kept.status, 2);
    assert.ok(kept.stderr.includes("the file exists and was not written by archdiff; nothing written"), kept.stderr);
    assert.equal(readFileSync(elsewhere, "utf8"), '{ "mine": true }\n');
    // A baseline that is not one is a wrong call, naming the file and the entry.
    const wrong = archdiff(["check", dir]);
    assert.equal(wrong.status, 2);
    assert.equal(wrong.stderr, 'archdiff: known.json: must be a JSON object with a list "violations" (archdiff check --baseline writes it)\n');
    writeFileSync(elsewhere, JSON.stringify({ violations: [{ rule: "layers", from: "src/db/report.ts" }, { rule: "layers" }] }));
    assert.equal(archdiff(["check", dir]).stderr, 'archdiff: known.json: "violations[1]" must be { "rule": "…", "from": "…" }, with "to" for an import\n');
    writeFileSync(join(dir, "archdiff.json"), JSON.stringify({ ...config, baseline: 3 }));
    assert.equal(archdiff(["check", dir]).stderr, 'archdiff: archdiff.json: "baseline" must be the path of the baseline\'s file from the root (default archdiff-baseline.json)\n');
    // The two flags together ask for both a baseline and none.
    assert.equal(archdiff(["check", dir, "--baseline", "--no-baseline"]).status, 2);
  }));

test("a baseline of nothing: code that follows its contract writes an empty file and says it can go", () =>
  withTempDir("archdiff-check-clean-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(join(dir, "ARCHITECTURE.md"), CONTRACT);
    const written = archdiff(["check", dir, "--baseline"]);
    assert.equal(written.status, 0, written.stderr);
    assert.ok(written.stderr.includes("archdiff check: 0 violations known from now on (an empty baseline: the file can go)"), written.stderr);
    assert.deepEqual((JSON.parse(readFileSync(join(dir, "archdiff-baseline.json"), "utf8")) as { violations: unknown[] }).violations, []);
    assert.equal(archdiff(["check", dir]).stderr, "archdiff check: the code follows the intent\n");
  }));

test("the page's check and the checks after a run hold the code to the baseline as the command does", () =>
  withOwnServer(
    "archdiff-check-web-",
    (dir) => {
      writeFileSync(join(dir, "ARCHITECTURE.md"), CONTRACT);
      writeFileSync(join(dir, "src/db/report.ts"), REPORT);
      // One of the two imports against the contract is known.
      writeFileSync(join(dir, "archdiff-baseline.json"), JSON.stringify({ violations: [{ rule: "layers", from: "src/db/report.ts", to: "src/routes/checkout.tsx" }] }));
    },
    async (origin, dir) => {
      const check = (await (await fetch(`${origin}/api/check`)).json()) as { ok: boolean; markdown: string; report: { baseline: string; violations: { known: boolean }[] } };
      assert.equal(check.ok, false);
      assert.ok(check.markdown.includes("## New violations (1)\n\n- `src/db/report.ts:2` imports `src/lib/log.ts`") && check.markdown.includes("## Known violations (1)"), check.markdown);
      assert.deepEqual(check.report.violations.map((violation) => violation.known), [true, false]);
      const run = async (): Promise<string[]> => ((await (await fetch(`${origin}/api/checks`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { events: { text: string }[] }).events.map((event) => event.text);
      assert.deepEqual(await run(), ["✘ archdiff check\n1 new violation of ARCHITECTURE.md; 1 known violation in archdiff-baseline.json\nsrc/db/report.ts:2 imports src/lib/log.ts: layer db → lib is not in the intent"]);
      // Both known: the check passes and counts them.
      writeFileSync(join(dir, "archdiff-baseline.json"), JSON.stringify({ violations: [{ rule: "layers", from: "src/db/report.ts", to: "src/routes/checkout.tsx" }, { rule: "layers", from: "src/db/report.ts", to: "src/lib/log.ts" }] }));
      assert.deepEqual(await run(), ["✔ archdiff check: the code follows ARCHITECTURE.md; 2 known violations in archdiff-baseline.json"]);
      // A baseline that cannot be read fails the check, saying why.
      writeFileSync(join(dir, "archdiff-baseline.json"), "{");
      assert.match((await run())[0]!, /^✘ archdiff check\narchdiff-baseline\.json: not valid JSON/);
    },
  ));
