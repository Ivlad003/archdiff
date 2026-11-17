// What a change did to the logic of a function, and to the lines of a
// file: the diff of two flowcharts (a statement added shifts no box into
// "changed", a condition rewritten is one step, a branch that came or went
// is drawn with its arrows), the `logic:` view with `--changes` through
// the CLI on a real repository, and through the HTTP API the page of a
// module in a review (a line per function the change touched) and the
// hunks the Code tab lays on a file.
//
// Entry point: run by `npm test`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readLogic, type LogicFact } from "../src/extract/logic.ts";
import { GONE, logicDelta } from "../src/logic-diff.ts";
import { changedSample } from "./changed-sample.ts";
import { withTempDir } from "./temp-dir.ts";
import { withOwnServer } from "./web-server.ts";

const root = join(import.meta.dirname, "..");
const fixture = join(root, "tests/fixtures/sample");

/** The body of `price` with the lines given between its first statement and its return. */
function priceOf(body: readonly string[]): string {
  return ["export function price(order: { total: number }): number {", ...body.map((line) => `  ${line}`), "}", ""].join("\n");
}

const BASE = ["const net = order.total;", "const tax = net * 0.2;", "const fee = 1;", "const sum = net + tax + fee;", "if (sum < 0) {", '  throw new Error("negative");', "}", "return sum;"];

async function logicOf(body: readonly string[]): Promise<LogicFact> {
  const fact = await readLogic("src/price.ts", priceOf(body), "price", 1);
  assert.ok(fact, "the body is read");

  return fact;
}

test("the logic of a function held against what it was: a statement added changes the one box that holds it, a condition rewritten is one step changed, a branch come or gone is drawn with its arrows", async () => {
  const base = await logicOf(BASE);
  // Nothing changed: nothing marked.
  const same = logicDelta(base, await logicOf(BASE));
  assert.deepEqual([same.added.length, same.changed.length, same.removed.length, same.arrowsAdded.size, same.arrowsRemoved.length], [0, 0, 0, 0, 0]);

  // One statement added at the top: a box holds two statements, so every box after it holds other ones than before —
  // and still only the box with the new statement is changed, and no arrow is new or gone.
  const audited = logicDelta(base, await logicOf(["audit(order);", ...BASE]));
  assert.deepEqual([audited.added.length, audited.removed.length, audited.arrowsAdded.size, audited.arrowsRemoved.length], [0, 0, 0, 0], JSON.stringify(audited, (_, value: unknown) => (value instanceof Set ? [...value] : value)));
  assert.equal(audited.changed.length, 1);
  assert.deepEqual([audited.changed[0]!.came.length, audited.changed[0]!.went.length], [1, 0]);
  assert.match(audited.changed[0]!.came[0]!, /audit\(order\)/);

  // A condition rewritten: the one decision, with what it reads now and what it read.
  const stricter = logicDelta(base, await logicOf(BASE.map((line) => line.replace("sum < 0", "sum <= 0"))));
  assert.deepEqual([stricter.added.length, stricter.removed.length, stricter.changed.length], [0, 0, 1]);
  assert.equal(stricter.changed[0]!.step.kind, "decision");
  assert.deepEqual([stricter.changed[0]!.came, stricter.changed[0]!.went], [["sum <= 0"], ["sum < 0"]]);
  assert.deepEqual([stricter.arrowsAdded.size, stricter.arrowsRemoved.length], [0, 0]);

  // A branch added before the return: its decision and its exit are new, with the arrows into and out of them.
  const discounted = logicDelta(base, await logicOf([...BASE.slice(0, -1), "if (order.total > 1000) {", "  return sum * 0.9;", "}", "return sum;"]));
  assert.deepEqual(discounted.added.map((step) => step.kind).sort(), ["decision", "return"]);
  assert.deepEqual([discounted.removed.length, discounted.changed.length], [0, 0]);
  assert.ok(discounted.arrowsAdded.size >= 3, "into the new decision, and its two branches");

  // The guard removed: the decision and its throw are gone, drawn with the arrows that hung on them, and the way past them is new.
  const unguarded = logicDelta(base, await logicOf([...BASE.slice(0, 4), "return sum;"]));
  assert.deepEqual(unguarded.removed.map((step) => step.kind).sort(), ["decision", "throw"]);
  assert.ok(unguarded.removed.every((step) => step.id.startsWith(GONE)));
  assert.deepEqual([unguarded.added.length, unguarded.changed.length], [0, 0]);
  assert.ok(unguarded.arrowsRemoved.some((arrow) => arrow.to.startsWith(GONE)) && unguarded.arrowsRemoved.some((arrow) => arrow.from.startsWith(GONE)));
  assert.equal(unguarded.arrowsAdded.size, 1);
});

test("diagram logic:<fn> --changes draws the function's logic against the base: the new guard marked, the rules that came, and a function the change left alone says so", () =>
  withTempDir("archdiff-logic-diff-", (dir) => {
    cpSync(fixture, dir, { recursive: true });
    changedSample(dir);
    const run = (subject: string): string => {
      const result = spawnSync(process.execPath, [join(root, "bin/archdiff.js"), "diagram", `logic:src/lib/orders.ts#${subject}`, dir, "--changes", "--base", "HEAD"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);

      return result.stdout;
    };
    const placed = run("placeOrder");
    // The base is called as it was named. The way past the new guard is a rule with one more condition: two came, one went.
    assert.match(placed, /^# Logic of placeOrder \(src\/lib\/orders\.ts\) — changes since HEAD$/m);
    assert.match(placed, /## What the change did to the logic, since `HEAD`\n\nSteps \+2 −0 ~0; rules \+2 −1\./);
    assert.match(placed, /- \*\*\+ decision\*\* `readOrder\(id\)` — line 10/);
    assert.match(placed, /- \*\*\+ throw\*\* `throw new Error\("placed twice"\)` — line 10/);
    assert.match(placed, /Rules that came:\n\n\| when \| calls \| ends with \|\n\| --- \| --- \| --- \|\n\| `readOrder\(id\): yes` /);
    // The picture wears the marks: the new steps and the arrows into them.
    assert.match(placed, /class n\d+(,n\d+)* added/);
    // A condition rewritten is one step changed, said with what it reads now and what it read.
    const validated = run("validate");
    assert.match(validated, /Steps \+0 −0 ~1; rules \+2 −2\./);
    assert.match(validated, /- \*\*~ decision\*\* at line 17: \+ `order\.total <= 0`; − `order\.total < 0`/);
    // A function the change did not touch.
    assert.match(run("findOrder"), /## What the change did to the logic, since `HEAD`\n\nNothing: every step and every rule is as it was\./);
  }));

test("in a review the page of a module lists what the change did to the logic of its functions, and the Code tab's diff is the change's lines on the file", () =>
  withOwnServer("archdiff-logic-diff-api-", changedSample, async (origin) => {
    const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(`${origin}${path}`);

      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    // The module's page: a line per function the change touched, each named by the view of its flowchart.
    const page = (await get(`/api/shape?view=review&base=HEAD&id=${encodeURIComponent("src/lib/orders.ts")}`)).body["markdown"] as string;
    assert.ok(page.includes("## What the change did to the logic of its functions\n\n- `logic:src/lib/orders.ts#placeOrder` — steps +2 −0 ~0, rules +2 −1\n- `logic:src/lib/orders.ts#validate` — steps +0 −0 ~1, rules +2 −2\n"), page);
    assert.ok(page.includes("A function named here opens its flowchart with the marks of the change."), page);
    // A module the change left alone has no such section.
    assert.ok(!((await get(`/api/shape?view=review&base=HEAD&id=${encodeURIComponent("src/routes/checkout.tsx")}`)).body["markdown"] as string | undefined)?.includes("the logic of its functions"));

    // The file's diff, on the file as the working tree has it: a line that came, and a line rewritten with what it was.
    const diff = await get("/api/diff?view=review&base=HEAD&path=src/lib/orders.ts");
    assert.equal(diff.body["since"], "HEAD");
    assert.deepEqual(diff.body["hunks"], [
      { at: 10, removed: [], added: { from: 10, to: 10 } },
      { at: 17, removed: ['  if (order.total < 0) throw new Error("negative");'], added: { from: 17, to: 17 } },
    ]);
    // The same range for the changes laid over another picture; a picture of no change has none, and no path leaves the repository.
    assert.equal(((await get("/api/diff?view=layers&changes=1&base=HEAD&path=src/lib/orders.ts")).body["hunks"] as unknown[]).length, 2);
    assert.deepEqual((await get("/api/diff?view=layers&path=src/lib/orders.ts")).body, { since: null, hunks: [] });
    assert.equal((await get("/api/diff?view=review&base=HEAD&path=../outside.ts")).status, 404);
    // A file the change did not touch has no hunk.
    assert.deepEqual((await get("/api/diff?view=review&base=HEAD&path=src/lib/log.ts")).body["hunks"], []);
  }));

test("grep searches the code and the lines of a change: by a text, by a regular expression; through the CLI and the API", () =>
  withOwnServer("archdiff-grep-", changedSample, async (origin, dir) => {
    const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } => spawnSync(process.execPath, [join(root, "bin/archdiff.js"), "grep", ...args], { encoding: "utf8" });
    // The code: every line that has the text, with its place; a capital makes the case count.
    const code = run("saveorder", dir);
    assert.equal(code.status, 0, code.stderr);
    assert.match(code.stdout, /^\*\*\d+ lines\*\* of the code, in \d+ files, have `saveorder`:\n\n/);
    assert.ok(code.stdout.includes("- `src/db/store.ts:") && code.stdout.includes("- `src/lib/orders.ts:11` — `saveOrder(order);`"), code.stdout);
    assert.equal(run("SaveOrder", dir).status, 1);
    assert.match(run("SaveOrder", dir).stdout, /^No line of the code has `SaveOrder`\.$/m);
    // A regular expression, between slashes or by the flag; a broken one is a wrong call.
    assert.match(run("place\\w+\\(", dir, "--regex").stdout, /`src\/lib\/orders\.ts:7` — `export function placeOrder\(/);
    // A text is taken as it is typed: its dot is a dot, where the expression's stands for any letter.
    assert.deepEqual([run("o.der", dir).status, run("o.der", dir, "--regex").status], [1, 0]);
    assert.equal(run("(", dir, "--regex").status, 2);
    assert.match(run("(", dir, "--regex").stderr, /grep: not a regular expression/);
    // The change: the lines it added and the lines it removed, each with its sign and its own line.
    const change = run("order.total", dir, "--diff", "--base", "HEAD");
    assert.equal(change.stdout, "**2 lines** of the change since HEAD, in 1 file, have `order.total`:\n\n- `src/lib/orders.ts:17` **−** `if (order.total < 0) throw new Error(\"negative\");`\n- `src/lib/orders.ts:17` **+** `if (order.total <= 0) throw new Error(\"negative\");`\n");
    const json = JSON.parse(run("placed twice", dir, "--diff", "--base", "HEAD", "--json").stdout) as { matches: { file: string; line: number; sign: string }[]; more: number; files: number };
    assert.deepEqual([json.matches.map((match) => [match.file, match.line, match.sign]), json.more, json.files], [[["src/lib/orders.ts", 10, "+"]], 0, 1]);
    // A file git does not track yet is part of the working tree's change: every line of it came.
    writeFileSync(join(dir, "src/lib/refunds.ts"), "export function refund(): number {\n  return 1;\n}\n");
    assert.match(run("refund", dir, "--diff", "--base", "HEAD").stdout, /- `src\/lib\/refunds\.ts:1` \*\*\+\*\* `export function refund\(\): number \{`/);

    // The same through the API, as the Chat tab asks: the list as Markdown, and the lines.
    const api = async (query: string): Promise<{ status: number; body: { markdown?: string; matches?: unknown[]; error?: string } }> => {
      const response = await fetch(`${origin}/api/grep?${query}`);

      return { status: response.status, body: (await response.json()) as { markdown?: string; matches?: unknown[]; error?: string } };
    };
    const inCode = await api("view=layers&q=saveOrder");
    assert.match(inCode.body.markdown ?? "", /of the code, in \d+ files, have `saveOrder`/);
    assert.ok((inCode.body.matches ?? []).length >= 3);
    // On a picture of no change, the change is the one since the default base (here the last commit: the branch is the main line).
    assert.match((await api("view=layers&diff=1&q=order.total")).body.markdown ?? "", /^\*\*2 lines\*\* of the change since \S+, in 1 file/);
    assert.equal((await api("view=layers&q=")).status, 400);
    assert.match((await api(`view=layers&q=${encodeURIComponent("/(/")}`)).body.error ?? "", /not a regular expression/);
  }));
