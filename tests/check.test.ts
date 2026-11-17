// The contract check through the real CLI and the HTTP API on copies of
// tests/fixtures/sample: the baseline of known violations — written,
// honoured, and shrunk as the code is fixed — in the command, the page's
// check and the checks after an agent's run; the rules of archdiff.json,
// each kind violated and satisfied, with the messages of a rule written
// wrong; and an agent's run reported against the violations before it
// (tests/fixtures/fake-edit.mjs fixes one and adds another).
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

/** The layers of the sample, as its archdiff.json names them. */
const LAYERS = { routes: ["src/routes/**"], lib: ["src/lib/**"], db: ["src/db/**"], cartridge: ["cartridges/**"] };

/** A module of routes that reads the store itself: routes → db, past the lib layer. */
const PEEK = 'import { readOrder } from "../db/store.ts";\n\nexport function peek(): unknown {\n  return readOrder("x");\n}\n';

/**
 * A copy of the sample without a contract, for `body`: `check` runs it under the rules given (archdiff.json's
 * `rules`, beside the sample's layers) and gives the exit code, the bullets of the report's violations and stderr.
 */
function withRules(body: (check: (rules: unknown) => { status: number | null; violations: string[]; stderr: string }, dir: string) => void): Promise<void> {
  return withTempDir("archdiff-rules-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    body((rules) => {
      writeFileSync(join(dir, "archdiff.json"), JSON.stringify({ layers: LAYERS, rules }));
      const { status, stdout, stderr } = archdiff(["check", dir]);

      return { status, violations: stdout.split("\n").filter((line) => line.startsWith("- `")), stderr };
    }, dir);
  });
}

const FOLLOWED = "archdiff check: the code follows the rules of archdiff.json\n";

test("a naming rule: the files of a layer match a glob of the name or of the path, or a regular expression", () =>
  withRules((check) => {
    const violated = check([{ kind: "naming", layer: "lib", pattern: "*.service.ts" }]);
    assert.equal(violated.status, 1);
    assert.deepEqual(violated.violations, [
      "- `src/lib/log.ts:1`: the files of layer **lib** are named `*.service.ts` (rule `naming:lib`). Rename the file, or place it in the layer it belongs to.",
      "- `src/lib/orders.ts:1`: the files of layer **lib** are named `*.service.ts` (rule `naming:lib`). Rename the file, or place it in the layer it belongs to.",
    ]);
    assert.equal(violated.stderr, "archdiff check: 2 violations of the rules of archdiff.json\n");
    // Satisfied: by the name, by the path (a glob with a slash), by a regular expression of the name.
    const satisfied = check([{ kind: "naming", layer: "lib", pattern: "*.ts" }, { kind: "naming", name: "lib lives in src/lib", layer: "lib", pattern: "src/lib/*.ts" }, { kind: "naming", layer: "routes", regex: "^[a-z]+\\.tsx$" }]);
    assert.equal(satisfied.status, 0, satisfied.stderr);
    assert.equal(satisfied.stderr, FOLLOWED);
    assert.deepEqual(check([{ kind: "naming", name: "capitals", layer: "routes", regex: "^[A-Z]" }]).violations, ["- `src/routes/checkout.tsx:1`: the files of layer **routes** are named `/^[A-Z]/` (rule `capitals`). Rename the file, or place it in the layer it belongs to."]);
    assert.deepEqual(check([{ kind: "naming", layer: "lib", pattern: "src/lib/services/*.ts" }]).violations.length, 2);
  }));

test("a threshold rule: a number metrics measures stays under max and over min, in a layer or everywhere", () =>
  withRules((check) => {
    // orders.ts: Ca 1, Ce 2, instability 0.67, 31 lines; checkout.tsx: cohesion 0.
    const violated = check([{ kind: "threshold", metric: "instability", max: 0.5, layer: "lib" }, { kind: "threshold", metric: "lines", max: 30 }, { kind: "threshold", metric: "cohesion", min: 0.5 }, { kind: "threshold", metric: "fanOut", max: 1 }, { kind: "threshold", name: "someone uses it", metric: "fanIn", min: 1, layer: "routes" }]);
    assert.equal(violated.status, 1);
    assert.deepEqual(violated.violations, [
      "- `src/lib/orders.ts:1`: its instability is 0.67, over the 0.5 allowed (rule `instability:lib`).",
      "- `src/lib/orders.ts:1`: it has 31 lines, over the 30 allowed (rule `lines`).",
      "- `src/routes/checkout.tsx:1`: its cohesion is 0, under the 0.5 asked for (rule `cohesion`).",
      "- `src/lib/orders.ts:1`: its fan-out (Ce) is 2, over the 1 allowed (rule `fanOut`).",
      "- `src/routes/checkout.tsx:1`: its fan-in (Ca) is 0, under the 1 asked for (rule `someone uses it`).",
    ]);
    // The same numbers within their limits; instability over 0.5 is routes' own, where the rule does not look.
    const satisfied = check([{ kind: "threshold", metric: "instability", max: 0.7, layer: "lib" }, { kind: "threshold", metric: "lines", max: 31, min: 3 }, { kind: "threshold", metric: "cohesion", min: 0.5, layer: "lib" }, { kind: "threshold", metric: "distance", max: 1 }, { kind: "threshold", metric: "abstractness", max: 0.2 }]);
    assert.equal(satisfied.status, 0, satisfied.violations.join("\n"));
    assert.equal(satisfied.stderr, FOLLOWED);
  }));

test("a cycles rule: no import cycle, or no more than N; an import inside a cycle is the violation, and types make none", () =>
  withRules((check, dir) => {
    // The sample has none: store.ts imports orders.ts for a type only.
    assert.equal(check([{ kind: "cycles" }]).status, 0);
    // log.ts imports orders.ts back: a cycle of two, each import of it a violation at its line.
    writeFileSync(join(dir, "src/lib/log.ts"), 'import { findOrder } from "./orders.ts";\n\nexport function log(message: string): void {\n  console.log(message, findOrder("x"));\n}\n');
    const violated = check([{ kind: "cycles" }]);
    assert.equal(violated.status, 1);
    assert.deepEqual(violated.violations, [
      "- `src/lib/log.ts:1` imports `src/lib/orders.ts`: inside an import cycle of 2 modules (rule `cycles`). `archdiff diagram cycle:src/lib/log.ts` draws the cycle and the imports to cut.",
      "- `src/lib/orders.ts:3` imports `src/lib/log.ts`: inside an import cycle of 2 modules (rule `cycles`). `archdiff diagram cycle:src/lib/orders.ts` draws the cycle and the imports to cut.",
    ]);
    // One cycle is allowed by `max: 1`; a second one is one too many, and every import of both is listed.
    assert.equal(check([{ kind: "cycles", max: 1 }]).status, 0);
    writeFileSync(join(dir, "src/db/a.ts"), 'import { b } from "./b.ts";\n\nexport const a = (): number => b() + 1;\n');
    writeFileSync(join(dir, "src/db/b.ts"), 'import { a } from "./a.ts";\n\nexport const b = (): number => a() + 1;\n');
    const two = check([{ kind: "cycles", max: 1 }]);
    assert.equal(two.status, 1);
    assert.equal(two.violations.length, 4);
    assert.ok(two.violations[0]!.startsWith("- `src/db/a.ts:1` imports `src/db/b.ts`: inside an import cycle of 2 modules (2 cycles, 1 allowed) (rule `cycles`)."), two.violations[0]);
  }));

test("a through rule: a layer is reached only through the module named, from one layer or from every other", () =>
  withRules((check, dir) => {
    // Only orders.ts imports the store: the rule holds.
    const rule = { kind: "through", to: "db", through: "src/lib/orders.ts" };
    assert.equal(check([rule]).status, 0);
    assert.equal(check([rule]).stderr, FOLLOWED);
    // A route that reads the store itself goes past it.
    writeFileSync(join(dir, "src/routes/peek.ts"), PEEK);
    const violated = check([rule]);
    assert.equal(violated.status, 1);
    assert.deepEqual(violated.violations, ["- `src/routes/peek.ts:1` imports `src/db/store.ts`: layer **routes** reaches **db** only through `src/lib/orders.ts` (rule `through:*→db`)."]);
    // The rule of one layer does not judge another's imports; a facade inside the layer reached is named the same way.
    assert.equal(check([{ ...rule, from: "lib" }]).status, 0);
    assert.equal(check([{ kind: "through", from: "routes", to: "db", through: ["src/db/index.ts", "src/db/st*.ts"] }]).status, 0);
    assert.deepEqual(check([{ kind: "through", name: "the db facade", from: "routes", to: "db", through: "src/db/index.ts" }]).violations, ["- `src/routes/peek.ts:1` imports `src/db/store.ts`: layer **routes** reaches **db** only through `src/db/index.ts` (rule `the db facade`)."]);
  }));

test("a forbidden rule: a module, a glob, a package or a built-in is not imported from a layer, or from anywhere", () =>
  withRules((check, dir) => {
    // The store reads node:fs: named by its ID or by its name.
    const violated = check([{ kind: "forbidden", from: "db", imports: ["node:fs"] }]);
    assert.equal(violated.status, 1);
    assert.deepEqual(violated.violations, ["- `src/db/store.ts:1` imports `node:fs`: layer **db** is not to import `node:fs` (rule `forbidden:db`)."]);
    assert.deepEqual(check([{ kind: "forbidden", name: "no files", imports: "fs" }]).violations, ["- `src/db/store.ts:1` imports `node:fs`: `node:fs` is not to be imported (rule `no files`)."]);
    // Another layer may; and the store's `import type` of lib runs nothing, so it breaks no rule.
    assert.equal(check([{ kind: "forbidden", from: "lib", imports: ["node:fs"] }, { kind: "forbidden", name: "db stays below lib", from: "db", imports: "src/lib/**" }]).status, 0);
    // A module of the repository, by a glob.
    writeFileSync(join(dir, "src/routes/peek.ts"), PEEK);
    assert.deepEqual(check([{ kind: "forbidden", from: "routes", imports: ["src/db/**"] }]).violations, ["- `src/routes/peek.ts:1` imports `src/db/store.ts`: layer **routes** is not to import `src/db/store.ts` (rule `forbidden:routes`)."]);
  }));

test("a rule written wrong names its field; a layer the repository lacks is a wrong call of check", () =>
  withRules((check) => {
    const refused = (rules: unknown, message: string): void => {
      const result = check(rules);
      assert.equal(result.status, 2, JSON.stringify(rules));
      assert.equal(result.stderr, `archdiff: archdiff.json: ${message}\n`);
    };
    refused({}, '"rules" must be a list of rules: { "kind": "naming" | "threshold" | "cycles" | "through" | "forbidden", … }');
    refused(["cycles"], '"rules[0]" must be an object with a "kind": naming, threshold, cycles, through, forbidden');
    refused([{ kind: "cycles" }, { kind: "nope" }], '"rules[1].kind" must be one of naming, threshold, cycles, through, forbidden');
    refused([{ kind: "naming", layer: "lib" }], '"rules[0]" needs one of "pattern" (a glob) and "regex"');
    refused([{ kind: "naming", pattern: "*.ts" }], '"rules[0].layer" must be the name of a layer');
    assert.match(check([{ kind: "naming", layer: "lib", regex: "(" }]).stderr, /^archdiff: archdiff\.json: "rules\[0\]\.regex" is no regular expression \(/);
    refused([{ kind: "threshold", metric: "speed", max: 1 }], '"rules[0].metric" must be one of fanIn, fanOut, instability, abstractness, distance, cohesion, lines');
    refused([{ kind: "threshold", metric: "lines" }], '"rules[0]" needs "max" or "min"');
    refused([{ kind: "threshold", metric: "lines", max: "many" }], '"rules[0].max" must be a number, 0 or more');
    refused([{ kind: "cycles", max: 1.5 }], '"rules[0].max" must be a whole number, 0 or more');
    refused([{ kind: "through", to: "db" }], '"rules[0].through" must be the path of a module, a glob, or a list of them');
    // A field the kind does not take is refused: a misspelt one would loosen the rule unseen.
    refused([{ kind: "forbidden", from: "db", import: ["node:fs"] }], '"rules[0].import" is no field of a forbidden rule (it takes name, from, imports)');
    // A rule is known to the baseline by its name: two of one name are refused, and the contract's own is taken.
    refused([{ kind: "cycles" }, { kind: "cycles", max: 2 }], '"rules[1]" is named "cycles" as rules[0] is: give one of them a "name"');
    refused([{ kind: "cycles", name: "tidy" }, { kind: "naming", name: "tidy", layer: "lib", pattern: "*" }], '"rules[1].name" is rules[0]\'s name too: a rule is known by its name');
    refused([{ kind: "cycles", name: "layers" }], '"rules[0].name" must not be "layers": that is the rule of the contract\'s arrows');
    // The layers are known once the code is read: a rule of one that is not there is told, with the ones that are.
    refused([{ kind: "cycles" }, { kind: "through", from: "route", to: "db", through: "src/lib/orders.ts" }], '"rules[1].from": no layer "route" (the layers: cartridge, db, lib, routes)');
  }));

test("the rules beside the contract: one report, the baseline knows a rule's violation by the rule's name, and the JSON lists them", () =>
  withViolations((dir) => {
    writeFileSync(join(dir, "archdiff.json"), JSON.stringify({ layers: LAYERS, rules: [{ kind: "forbidden", name: "no files in db", from: "db", imports: "fs" }, { kind: "threshold", metric: "lines", max: 30 }] }));
    const red = archdiff(["check", dir]);
    assert.equal(red.status, 1);
    assert.equal(red.stderr, "archdiff check: 4 violations of the intent and the rules of archdiff.json\n");
    assert.ok(red.stdout.includes(`# Check: the code of ${dir} against ARCHITECTURE.md and the rules of archdiff.json\n\n**4 violations of the intent and the rules of archdiff.json.**\n\n## Violations\n\n- \`src/db/report.ts:1\` imports \`src/routes/checkout.tsx\`: layer **db** → **routes** is not in the intent.`), red.stdout);
    // The baseline keeps a rule's violation as the rule's name and the module, with what it imports when it is an import.
    assert.equal(archdiff(["check", dir, "--baseline"]).status, 0);
    assert.deepEqual((JSON.parse(readFileSync(join(dir, "archdiff-baseline.json"), "utf8")) as { violations: unknown }).violations, [
      { rule: "layers", from: "src/db/report.ts", to: "src/lib/log.ts" },
      { rule: "layers", from: "src/db/report.ts", to: "src/routes/checkout.tsx" },
      { rule: "lines", from: "src/lib/orders.ts" },
      { rule: "no files in db", from: "src/db/store.ts", to: "node:fs" },
    ]);
    const green = archdiff(["check", dir]);
    assert.equal(green.status, 0, green.stdout);
    assert.equal(green.stderr, "archdiff check: the code follows the intent and the rules of archdiff.json; 4 known violations in archdiff-baseline.json\n");
    // A rule made stricter finds a module the baseline does not know.
    writeFileSync(join(dir, "archdiff.json"), JSON.stringify({ layers: LAYERS, rules: [{ kind: "forbidden", name: "no files in db", from: "db", imports: "fs" }, { kind: "threshold", metric: "lines", max: 12 }] }));
    const json = JSON.parse(archdiff(["check", dir, "--json"]).stdout) as { ok: boolean; violations: Record<string, unknown>[] };
    assert.equal(json.ok, false);
    assert.deepEqual(json.violations.filter((violation) => violation["known"] === false), [{ rule: "lines", from: "src/db/store.ts", line: 1, problem: "it has 13 lines, over the 12 allowed", known: false }]);
    assert.deepEqual(json.violations.find((violation) => violation["rule"] === "no files in db"), { rule: "no files in db", from: "src/db/store.ts", to: "node:fs", line: 1, problem: "layer db is not to import node:fs", known: true });
  }));

test("the rules need no contract on the page: the check and the checks after a run hold the code to them", () =>
  withOwnServer(
    "archdiff-rules-web-",
    (dir) => writeFileSync(join(dir, "archdiff.json"), JSON.stringify({ layers: LAYERS, rules: [{ kind: "forbidden", from: "db", imports: "fs" }] })),
    async (origin) => {
      const check = (await (await fetch(`${origin}/api/check`)).json()) as { exists: boolean; ok: boolean; markdown: string };
      assert.equal(check.exists, false, "there is no ARCHITECTURE.md");
      assert.equal(check.ok, false);
      assert.ok(check.markdown.includes("- `src/db/store.ts:1` imports `node:fs`: layer **db** is not to import `node:fs` (rule `forbidden:db`)."), check.markdown);
      const { events } = (await (await fetch(`${origin}/api/checks`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { events: { text: string }[] };
      assert.deepEqual(events.map((event) => event.text), ["✘ archdiff check\n1 violation of the rules of archdiff.json\nsrc/db/store.ts:1 imports node:fs: layer db is not to import node:fs (rule forbidden:db)"]);
    },
  ));

/** report.ts without its import of the log: db → lib is fixed, db → routes stays. */
const REPORT_FIXED = 'import { action } from "../routes/checkout.tsx";\n\nexport function report(): unknown {\n  return action({ total: 1 });\n}\n';

/** The task that has the fake agent (tests/fixtures/fake-edit.mjs) write `files`, by their paths from the root. */
function editTask(files: Record<string, string>): string {
  return ["Tidy the imports.", ...Object.entries(files).map(([path, content]) => `write: ${path} ${JSON.stringify(content)}`)].join("\n");
}

/**
 * A copy of the sample for a run's report: the contract, two imports against it in report.ts, a rule the store
 * breaks (which the baseline knows), and the agent that edits as its task says.
 */
function prepareRun(dir: string): void {
  writeFileSync(join(dir, "ARCHITECTURE.md"), CONTRACT);
  writeFileSync(join(dir, "src/db/report.ts"), REPORT);
  writeFileSync(join(dir, "archdiff.json"), JSON.stringify({ layers: LAYERS, rules: [{ kind: "forbidden", from: "db", imports: "fs" }], agent: { name: "editor", command: [process.execPath, join(root, "tests/fixtures/fake-edit.mjs")] } }));
  writeFileSync(join(dir, "archdiff-baseline.json"), JSON.stringify({ violations: [{ rule: "forbidden:db", from: "src/db/store.ts", to: "node:fs" }] }));
}

/** What a run of the report's test is expected to say under its checks. */
const RUN_REPORT = [
  "✔ the run fixed 1 violation\n  src/db/report.ts:2 imports src/lib/log.ts: layer db → lib is not in the intent",
  "• 2 violations survive the run (1 known, in archdiff-baseline.json)\n  src/db/report.ts:1 imports src/routes/checkout.tsx: layer db → routes is not in the intent\n  src/db/store.ts:1 imports node:fs: layer db is not to import node:fs (rule forbidden:db) (known)",
  "✘ the run added 1 violation\n  src/routes/peek.ts:1 imports src/db/store.ts: layer routes → db is not in the intent",
];

test("an agent run is reported against the state before it: the violations it fixed, the ones that survive, the ones it added", () =>
  withOwnServer("archdiff-run-report-", prepareRun, async (origin, dir) => {
    const run = async (prompt: string): Promise<{ kind: string; text: string }[]> => {
      const started = await fetch(`${origin}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "layers", prompt, resume: null }) });
      const body = await started.text();
      assert.equal(started.status, 200, body);

      return (await (await fetch(`${origin}/api/agent/events?id=${(JSON.parse(body) as { id: string }).id}`)).text()).split("\n\n").filter((chunk) => chunk.startsWith("data: ")).map((chunk) => JSON.parse(chunk.slice(6)) as { kind: string; text: string });
    };
    // The agent drops report.ts's import of the log (one violation fixed) and writes a route that reads the store (one added).
    const events = await run(editTask({ "src/db/report.ts": REPORT_FIXED, "src/routes/peek.ts": PEEK }));
    assert.equal(readFileSync(join(dir, "src/db/report.ts"), "utf8"), REPORT_FIXED, "the agent edited the repository");
    // The checks first, as they were; then the report, of layers and rules alike; then the exit.
    assert.deepEqual(events.map((event) => event.kind), ["init", "tool", "tool", "result", "check", "report", "report", "report", "exit"]);
    assert.equal(events[4]!.text, "✘ archdiff check\n2 new violations of ARCHITECTURE.md and the rules of archdiff.json; 1 known violation in archdiff-baseline.json\nsrc/db/report.ts:1 imports src/routes/checkout.tsx: layer db → routes is not in the intent\nsrc/routes/peek.ts:1 imports src/db/store.ts: layer routes → db is not in the intent");
    assert.deepEqual(events.filter((event) => event.kind === "report").map((event) => event.text), RUN_REPORT);
    // A run that changes nothing of them: they survive, and nothing is said of fixing or adding.
    const idle = await run("Change nothing.");
    assert.deepEqual(idle.filter((event) => event.kind === "report").map((event) => event.text), ["• 3 violations survive the run (1 known, in archdiff-baseline.json)\n  src/db/report.ts:1 imports src/routes/checkout.tsx: layer db → routes is not in the intent\n  src/routes/peek.ts:1 imports src/db/store.ts: layer routes → db is not in the intent\n  src/db/store.ts:1 imports node:fs: layer db is not to import node:fs (rule forbidden:db) (known)"]);
    // A violation whose line moved is the same one: it survives, at its new line.
    const moved = await run(editTask({ "src/db/report.ts": `// moved\n${REPORT_FIXED}` }));
    assert.match(moved.find((event) => event.kind === "report")!.text, /^• 3 violations survive the run .*\n {2}src\/db\/report\.ts:2 imports src\/routes\/checkout\.tsx/);
    // The last violations fixed: the run says so, and with nothing left the next run has nothing to report.
    const clean = await run(`${editTask({ "src/db/report.ts": "export const report = 1;\n", "src/db/store.ts": "export const rows = new Map<string, unknown>();\n\nexport function readOrder(id: string): unknown {\n  return rows.get(id) ?? null;\n}\n\nexport function saveOrder(order: { id: string }): void {\n  rows.set(order.id, order);\n}\n" })}\nremove: src/routes/peek.ts`);
    assert.deepEqual(clean.filter((event) => event.kind === "report").map((event) => event.text.split("\n")[0]), ["✔ the run fixed 3 violations"]);
    assert.deepEqual((await run("Change nothing.")).filter((event) => event.kind === "report"), []);
    // A long list is cut at ten lines, with the count of the rest: a dozen routes that read the store, added at once.
    const routes = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/routes/peek${String(i).padStart(2, "0")}.ts`, 'import "../db/store.ts";\n']));
    const many = (await run(editTask(routes))).filter((event) => event.kind === "report").map((event) => event.text.split("\n"));
    assert.equal(many.length, 1);
    assert.deepEqual([many[0]![0], many[0]![1], many[0]!.length, many[0]!.at(-1)], ["✘ the run added 12 violations", "  src/routes/peek00.ts:1 imports src/db/store.ts: layer routes → db is not in the intent", 12, "  … and 2 more: archdiff check lists them"]);
  }));
