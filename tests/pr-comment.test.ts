// The body of the pull request's comment (scripts/pr-comment.ts), without
// GitHub: built from a review's Markdown as diff.ts writes it and a check's
// report as `check --json` prints it. A change, no change, a failing check,
// no contract, a report longer than a comment may be; the script as the
// action runs it; and the action naming the marker the script writes.
//
// Entry point: run by `npm test`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMENT_LIMIT, COMMENT_MARKER, commentBody } from "../scripts/pr-comment.ts";
import type { Diagram, Shape } from "../src/diagram.ts";
import { reviewMarkdown, type GraphDiff } from "../src/diff.ts";
import type { IntentReport } from "../src/intent.ts";
import { withTempDir } from "./temp-dir.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const NOTHING: GraphDiff = { base: "0123456789abcdef0123456789abcdef01234567", changedFiles: [], modulesAdded: [], modulesRemoved: [], nodesAdded: [], nodesRemoved: [], nodesChanged: [], depsAdded: [], depsRemoved: [], callsAdded: [], callsRemoved: [], layerEdgesAdded: [], layerEdgesRemoved: [], externalsAdded: [], externalsRemoved: [] };

const FOLLOWS: IntentReport = { planned: [], plannedEdges: [], beyond: ["src/lib/log.ts"], violations: [], unintended: [], ok: true };

/** The picture of a review of these modules, each `layer/name.ts` in its layer, with one line between the first two. */
function pictureOf(modules: readonly string[]): Diagram {
  const nodes = modules.map((id): Shape => ({ id, kind: "module", label: id, group: id.split("/")[1]!, diff: "changed", x: 0, y: 0, w: 0, h: 0 }));
  const groups = [...new Set(nodes.map((node) => node.group!))].map((id) => ({ id, label: id, kind: "lane" as const, x: 0, y: 0, w: 0, h: 0 }));
  const picture: Diagram = { view: "review", title: "Changes", nodes, edges: modules.length > 1 ? [{ from: modules[0]!, to: modules[1]!, kind: "dependency", diff: "added" }] : [], groups };

  if (nodes.length === 0) picture.reason = "no module, function, import or call changed";

  return picture;
}

/** A route that reads the store directly: one module added, one function changed, a new import across two layers, against the contract. */
const CHANGE: GraphDiff = {
  ...NOTHING,
  changedFiles: ["src/db/report.ts", "src/routes/checkout.tsx"],
  modulesAdded: ["src/db/report.ts"],
  nodesAdded: [{ id: "src/db/report.ts#report", kind: "fn", module: "src/db/report.ts", line: 3 }],
  nodesChanged: [{ id: "src/routes/checkout.tsx#action", kind: "fn", module: "src/routes/checkout.tsx", line: 12, what: ["body"] }],
  depsAdded: [{ from: "src/routes/checkout.tsx", to: "src/db/report.ts" }],
  callsAdded: [{ from: "src/routes/checkout.tsx#action", to: "src/db/report.ts#report" }],
  layerEdgesAdded: [{ from: "routes", to: "db", against: true }],
};

const CHANGE_MARKDOWN = reviewMarkdown(CHANGE, pictureOf(["src/routes/checkout.tsx", "src/db/report.ts"]), true);

/** The Mermaid block of a review's Markdown, fences included. */
function mermaidOf(markdown: string): string {
  const block = /```mermaid\n[\s\S]*?\n```/.exec(markdown);
  assert.ok(block, "the review has a Mermaid block");

  return block[0];
}

test("a change: the marker first, the review's title and counts, the verdict, the layer dependencies and the picture, every change folded below", () => {
  const body = commentBody(CHANGE_MARKDOWN, JSON.stringify(FOLLOWS));
  const lines = body.split("\n");
  assert.equal(lines[0], COMMENT_MARKER);
  assert.equal(lines[1], "## Architecture changes since 0123456");
  assert.ok(body.includes("**✔ No import between layers goes against ARCHITECTURE.md.**"));
  assert.ok(body.includes("2 source files changed; modules +1 −0; functions +1 −0 ~1; imports +1 −0; calls +1 −0; packages +0 −0."));
  // The picture as the review drew it, whole, after the dependencies between layers and before the lists.
  const picture = mermaidOf(CHANGE_MARKDOWN);
  assert.ok(body.includes(picture));
  assert.ok(body.indexOf("### ⚠ New dependencies between layers\n\n- **routes → db** — against ARCHITECTURE.md") < body.indexOf(picture));
  assert.ok(body.indexOf(picture) < body.indexOf("<details>\n<summary>Every change, by kind (5)</summary>"));
  // Every list of the review, with its count, inside the fold; nothing left out.
  for (const section of ["### Modules added (1)\n\n- src/db/report.ts", "### Functions added (1)\n\n- fn `report` — src/db/report.ts:3", "### Functions changed (1)\n\n- fn `action` — src/routes/checkout.tsx:12 (body)", "### Imports added (1)\n\n- src/routes/checkout.tsx → src/db/report.ts", "### Calls added (1)\n\n- src/routes/checkout.tsx#action → src/db/report.ts#report"]) assert.ok(body.includes(section), section);
  assert.ok(body.trimEnd().endsWith("</details>"));
  assert.ok(!body.includes("not shown"));
  // The review's own generated mark is not the comment's: one hidden line, the marker.
  assert.equal(lines.filter((line) => line.startsWith("<!--")).length, 1);
});

test("no change: one line says so in place of an empty picture, and the verdict stays", () => {
  const quiet = reviewMarkdown({ ...NOTHING, changedFiles: ["src/lib/log.ts", "src/lib/orders.ts"] }, pictureOf([]), true);
  assert.equal(commentBody(quiet, JSON.stringify(FOLLOWS)), `${COMMENT_MARKER}\n**No architectural change since 0123456**: no module, function, import or call was added, removed or changed; 2 source files changed in what the diff does not show (comments, code outside the declarations).\n\n**✔ No import between layers goes against ARCHITECTURE.md.**\n`);
  // No source file changed either: the line ends there. No picture, no fold, no heading.
  const untouched = commentBody(reviewMarkdown(NOTHING, pictureOf([]), false), "");
  assert.equal(untouched.split("\n")[1], "**No architectural change since 0123456**: no module, function, import or call was added, removed or changed.");
  assert.ok(!/```|<details>|^#/m.test(untouched));
});

test("a failing check: the count of the imports against the contract, and each with its place and its layers", () => {
  const against: IntentReport = { ...FOLLOWS, ok: false, violations: [{ from: "src/routes/checkout.tsx", to: "src/db/report.ts", fromLayer: "routes", toLayer: "db", line: 4 }, { from: "src/lib/log.ts", to: "src/routes/checkout.tsx", fromLayer: "lib", toLayer: "routes", line: 1 }] };
  const body = commentBody(CHANGE_MARKDOWN, JSON.stringify(against));
  assert.ok(body.includes("**✘ 2 imports go against ARCHITECTURE.md.**\n\n- `src/routes/checkout.tsx:4` imports `src/db/report.ts`: layer **routes** → **db** is not in ARCHITECTURE.md\n- `src/lib/log.ts:1` imports `src/routes/checkout.tsx`: layer **lib** → **routes** is not in ARCHITECTURE.md\n"));
  // The verdict stands above the counts and the picture: it is what fails the job.
  assert.ok(body.indexOf("✘ 2 imports go") < body.indexOf("2 source files changed"));
  assert.ok(commentBody(CHANGE_MARKDOWN, JSON.stringify({ ...against, violations: against.violations.slice(0, 1) })).includes("**✘ 1 import goes against ARCHITECTURE.md.**"));
  // What the check lists as news (built beyond the intent, planned and not built) is not the comment's.
  assert.ok(!body.includes("- `src/lib/log.ts`") && !body.includes("beyond"));
});

test("no contract, or an output that is no report: the body says which, and the review is whole", () => {
  // `check` prints nothing when there is no ARCHITECTURE.md that names layers.
  const none = commentBody(CHANGE_MARKDOWN, "");
  assert.ok(none.includes("_No ARCHITECTURE.md that names layers: nothing to check the code against"));
  assert.ok(none.includes(mermaidOf(CHANGE_MARKDOWN)));
  assert.ok(commentBody(CHANGE_MARKDOWN, "not json").includes("_The output of `archdiff check` could not be read: no verdict._"));
  assert.ok(commentBody(CHANGE_MARKDOWN, '{"violations":[]}').includes("could not be read"));
});

/** A review of `count` added calls and half as many changed functions among `modules` modules: longer than a comment may be from a few hundred up. */
function longReview(count: number, modules: number): string {
  const ids = Array.from({ length: modules }, (_, i) => `src/lib/module-with-a-long-name-${i}.ts`);
  const diff: GraphDiff = {
    ...NOTHING,
    changedFiles: ids,
    nodesChanged: Array.from({ length: count / 2 }, (_, i) => ({ id: `${ids[i % modules]!}#changedFunction${i}`, kind: "fn" as const, module: ids[i % modules]!, line: i + 1, what: ["body" as const] })),
    callsAdded: Array.from({ length: count }, (_, i) => ({ from: `${ids[i % modules]!}#caller${i}`, to: `${ids[(i + 1) % modules]!}#callee${i}` })),
  };

  return reviewMarkdown(diff, pictureOf(ids), false);
}

test("an over-long report: under the limit, the picture whole, every list cut to the same number of its first items, what was left out counted", () => {
  const review = longReview(1200, 40);
  assert.ok(review.length > COMMENT_LIMIT * 1.5, "the review alone is over the limit");
  const body = commentBody(review, JSON.stringify(FOLLOWS));
  assert.ok(body.length <= COMMENT_LIMIT, `${body.length} characters`);
  // Close to the limit, not cut in half: within a few lines of it.
  assert.ok(body.length > COMMENT_LIMIT - 1000, `${body.length} characters`);
  assert.ok(body.includes(mermaidOf(review)));
  assert.ok(body.includes("<summary>Every change, by kind (1 800)</summary>"));
  // Both lists keep their headings and their counts, and the same number of items; each says how many it lacks.
  const kept = (title: string): { shown: number; more: number } => {
    const section = new RegExp(`### ${title} \\((\\d[\\d ]*)\\)\\n\\n((?:- .*\\n)+)`).exec(body);
    assert.ok(section, title);
    const items = section[2]!.trimEnd().split("\n");
    const more = /^- … (\d[\d ]*) more not shown$/.exec(items[items.length - 1]!);
    assert.ok(more, `${title} is cut`);

    return { shown: items.length - 1, more: Number(more[1]!.replace(/ /g, "")) };
  };
  const changed = kept("Functions changed");
  const calls = kept("Calls added");
  assert.equal(changed.shown, calls.shown);
  assert.ok(changed.shown > 100);
  assert.equal(changed.shown + changed.more, 600);
  assert.equal(calls.shown + calls.more, 1200);
  // The first items, in the review's order.
  assert.ok(body.includes("### Calls added (1 200)\n\n- src/lib/module-with-a-long-name-0.ts#caller0 → src/lib/module-with-a-long-name-1.ts#callee0\n"));
  // The count of what was left out, and where it can be read.
  const left = changed.more + calls.more;
  assert.ok(body.includes(`_${String(left).replace(/\B(?=(\d{3})+$)/g, " ")} of the 1 800 changes are not shown: a comment on GitHub holds 65 536 characters at most; the job summary has them all._`));
  // With room for all of it (the job summary's limit) nothing is cut.
  const whole = commentBody(review, JSON.stringify(FOLLOWS), 300_000);
  assert.ok(!whole.includes("not shown") && whole.includes("#callee1199"));
});

test("past the lists the violations are cut, and a picture longer than a comment gives way to a line: the body is never over the limit", () => {
  // Violations by the hundred: no item of the lists is shown, and of the violations as many as fit, the rest counted.
  const violations = Array.from({ length: 900 }, (_, i) => ({ from: `src/routes/a-route-with-a-long-name-${i}.tsx`, to: `src/db/a-table-with-a-long-name-${i}.ts`, fromLayer: "routes", toLayer: "db", line: i + 1 }));
  const many = commentBody(CHANGE_MARKDOWN, JSON.stringify({ ...FOLLOWS, ok: false, violations }));
  assert.ok(many.length <= COMMENT_LIMIT);
  assert.ok(many.includes("**✘ 900 imports go against ARCHITECTURE.md.**"));
  const cut = /^- … (\d+) more not shown$/m.exec(many.slice(0, many.indexOf("2 source files changed")));
  assert.ok(cut && Number(cut[1]) > 0 && Number(cut[1]) < 900);
  assert.ok(many.includes(mermaidOf(CHANGE_MARKDOWN)));
  assert.ok(many.includes("_The 5 changes are not listed (modules added 1, functions added 1, functions changed 1, imports added 1, calls added 1): a comment on GitHub holds 65 536 characters at most; the job summary has them all._"));
  assert.ok(!many.includes("<details>"));
  // A picture of 1500 modules is longer than a comment by itself: a line stands for it, and the lists have the room.
  const huge = longReview(40, 1500);
  assert.ok(mermaidOf(huge).length > COMMENT_LIMIT);
  const body = commentBody(huge, JSON.stringify(FOLLOWS));
  assert.ok(body.length <= COMMENT_LIMIT);
  assert.ok(!body.includes("```mermaid"));
  assert.ok(/_The picture is left out \(\d[\d ]* characters of Mermaid\): a comment on GitHub holds 65 536 characters at most; the job summary has it\._/.test(body));
  assert.ok(body.includes("#callee39") && !body.includes("changes are not shown"));
  // Any limit holds, down to one a title does not fit in.
  for (const limit of [20_000, 2000, 300, 40]) assert.ok(commentBody(huge, JSON.stringify({ ...FOLLOWS, ok: false, violations }), limit).length <= limit, `limit ${limit}`);
});

test("the script prints the body of the two files it is given, as the action runs it; a wrong call is exit 2", () =>
  withTempDir("archdiff-pr-comment-", (dir) => {
    const script = join(ROOT, "scripts/pr-comment.ts");
    const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    // The review as a shell on Windows would write it: CRLF, and a byte order mark.
    writeFileSync(join(dir, "review.md"), `﻿${CHANGE_MARKDOWN.replace(/\n/g, "\r\n")}`);
    writeFileSync(join(dir, "check.json"), JSON.stringify(FOLLOWS, null, 2));
    const whole = run([join(dir, "review.md"), join(dir, "check.json")]);
    assert.equal(whole.status, 0, whole.stderr);
    assert.equal(whole.stdout, commentBody(CHANGE_MARKDOWN, JSON.stringify(FOLLOWS)));
    // A limit of its own (the action's, for the job summary) words what is left out by that limit.
    const short = run([join(dir, "review.md"), join(dir, "check.json"), "--limit", "1000"]);
    assert.equal(short.status, 0, short.stderr);
    assert.equal(short.stdout, commentBody(CHANGE_MARKDOWN, JSON.stringify(FOLLOWS), 1000));
    assert.ok(short.stdout.length <= 1000 && short.stdout.includes("_The picture is left out (") && short.stdout.includes("the limit is 1 000 characters._"));
    assert.equal(run([join(dir, "review.md")]).status, 2);
    assert.equal(run([join(dir, "review.md"), join(dir, "check.json"), "--limit", "many"]).status, 2);
    const missing = run([join(dir, "nope.md"), join(dir, "check.json")]);
    assert.equal(missing.status, 2);
    assert.ok(missing.stderr.startsWith("pr-comment: ") && missing.stdout === "");
  }));

test("the action finds its comment by the marker the script writes, and runs the script from its own checkout", () => {
  const action = readFileSync(join(ROOT, "action.yml"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(action.includes(`startswith("${COMMENT_MARKER}")`));
  assert.ok(action.includes('node "$GITHUB_ACTION_PATH/scripts/pr-comment.ts"'));

  for (const input of ["base", "fail-on-check", "comment", "working-directory"]) assert.ok(new RegExp(`^  ${input}:$`, "m").test(action), input);
});
