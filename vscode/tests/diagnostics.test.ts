// The check's JSON as findings (src/diagnostics.ts): the report `archdiff
// check --json` prints, a violation with a reason of its own, the ones that
// cannot be placed, and the outputs that are no report.
//
// Entry point: run by `npm test` in vscode/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { byFile, findingsOf } from "../src/diagnostics.ts";

/** A report as archdiff prints it: one import against the contract, and its news. */
const REPORT = {
  planned: ["src/domain/types.ts"],
  plannedEdges: ["src/services/health.ts → src/domain/types.ts"],
  beyond: [],
  violations: [{ from: "src/routes/health.ts", to: "src/db/store.ts", fromLayer: "routes", toLayer: "db", line: 2 }],
  unintended: [],
  ok: false,
};

test("a violation is a finding on the line of its import, with the contract's reason", () => {
  assert.deepEqual(findingsOf(`${JSON.stringify(REPORT, null, 2)}\n`), {
    ok: true,
    findings: [{ file: "src/routes/health.ts", line: 2, message: "imports src/db/store.ts: layer routes → db is not in ARCHITECTURE.md. Add the arrow there if it is wanted, else move the import." }],
    unplaced: 0,
  });
  // What is planned and not built, or built beyond the contract, is news of the report, not a problem of a line.
  assert.deepEqual(findingsOf(JSON.stringify({ ...REPORT, violations: [], ok: true })), { ok: true, findings: [], unplaced: 0 });
});

test("no output is no report: nothing to check against, and no finding", () => {
  assert.deepEqual(findingsOf(""), { ok: true, findings: [], unplaced: 0 });
  assert.deepEqual(findingsOf("\n"), { ok: true, findings: [], unplaced: 0 });
});

test("a violation with a reason of its own is shown with it; one without a line on the first line; one without a file is counted", () => {
  const report = {
    violations: [
      { from: "src/a.ts", to: "src/b.ts", line: 4, reason: "src/a.ts may not import src/b.ts (rule no-cross)" },
      { from: "src/a.ts", to: "src/c.ts", fromLayer: "app", toLayer: "db" },
      { from: "src/d.ts", line: 0 },
      { to: "src/e.ts", line: 3 },
      "not a violation",
    ],
  };

  assert.deepEqual(findingsOf(JSON.stringify(report)), {
    ok: true,
    findings: [
      { file: "src/a.ts", line: 4, message: "imports src/b.ts: src/a.ts may not import src/b.ts (rule no-cross)" },
      { file: "src/a.ts", line: 1, message: "imports src/c.ts: layer app → db is not in ARCHITECTURE.md. Add the arrow there if it is wanted, else move the import." },
      { file: "src/d.ts", line: 1, message: "against ARCHITECTURE.md" },
    ],
    unplaced: 2,
  });
});

test("an output that is no report is a problem, said", () => {
  const cut = findingsOf('{"violations": [');
  assert.ok(!cut.ok && cut.problem.startsWith("archdiff check --json did not print JSON ("), JSON.stringify(cut));

  for (const other of ["[]", "null", '"text"', '{"ok":true}', '{"violations":{}}']) assert.deepEqual(findingsOf(other), { ok: false, problem: "archdiff check --json printed no list of violations" });
});

test("the findings are shown file by file, in the order found", () => {
  const first = { file: "src/a.ts", line: 4, message: "one" };
  const second = { file: "src/b.ts", line: 1, message: "two" };
  const third = { file: "src/a.ts", line: 9, message: "three" };

  assert.deepEqual([...byFile([first, second, third])], [["src/a.ts", [first, third]], ["src/b.ts", [second]]]);
  assert.deepEqual([...byFile([])], []);
});
