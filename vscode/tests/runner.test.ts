// archdiff as the extension runs it (src/runner.ts): the line a server
// says where it listens on, the arguments of the two commands, and the
// processes themselves — first on stand-ins written here (a server that
// starts, one that ends early, a check), then, in the repository, on the
// archdiff of this checkout: the server's answer names the function under a
// cursor, and the check's report becomes findings. That last part is what
// holds the extension to the command line it reads.
//
// Entry point: run by `npm test` in vscode/.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Start } from "../src/command.ts";
import { findingsOf } from "../src/diagnostics.ts";
import { checkArguments, originOf, runCheck, startWeb, webArguments } from "../src/runner.ts";
import { functionAt, functionsOfInside, insideRequest } from "../src/views.ts";

const scratch = mkdtempSync(join(tmpdir(), "archdiff-vscode-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A stand-in for archdiff: node on a script written for the test. */
function standIn(name: string, script: string): Start {
  const file = join(scratch, `${name}.mjs`);
  writeFileSync(file, script);

  return { file: process.execPath, args: [file], from: "setting" };
}

function getText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve(text));
    }).on("error", reject);
  });
}

test("the origin is read from the line the server writes once it listens, whatever came before it", () => {
  assert.equal(originOf(""), null);
  assert.equal(originOf("npm warn exec The following package was not found and will be installed: @ivlad003/archdiff@0.6.0\n"), null);
  assert.equal(originOf("archdiff web: http://127.0.0.1:7123/  (/home/dev/shop)\n"), "http://127.0.0.1:7123");
  assert.equal(originOf("npm warn exec …\narchdiff web: http://127.0.0.1:50211/  (C:\\Users\\dev\\shop)  (port 7080 was taken)\n"), "http://127.0.0.1:50211");
  // Half a line is not the line yet.
  assert.equal(originOf("archdiff web: http://127.0.0.1:71"), null);
});

test("the server is started on the folder with a port the system picks, the check with its report as JSON, after the command's own arguments", () => {
  const npx: Start = { file: "/usr/bin/npx", args: ["--yes", "@ivlad003/archdiff"], from: "npx" };

  assert.deepEqual(webArguments(npx, "/home/dev/my shop"), ["--yes", "@ivlad003/archdiff", "web", "/home/dev/my shop", "--port", "0"]);
  assert.deepEqual(checkArguments({ file: "/repo/node_modules/.bin/archdiff", args: [], from: "workspace" }, "/repo"), ["check", "/repo", "--json"]);
});

test("a server that starts is known by its origin, logged line by line, and stopped; one that ends first is refused with what it wrote", async () => {
  const listens = standIn(
    "listens",
    `import { createServer } from "node:http";
const server = createServer((request, response) => response.end(JSON.stringify(process.argv.slice(2))));
process.stderr.write("fetching…\\n");
server.listen(0, "127.0.0.1", () => process.stderr.write("archdiff web: http://127.0.0.1:" + server.address().port + "/  (" + process.cwd() + ")\\n"));
`,
  );
  const logged: string[] = [];
  const server = await startWeb(listens, scratch, (text) => logged.push(text));

  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(server.port, Number(server.origin.split(":")[2]));
  assert.ok(logged.join("").startsWith("fetching…\narchdiff web: http://127.0.0.1:"), logged.join(""));
  // It was started as archdiff would be: `web`, the folder, a port the system picks.
  assert.deepEqual(JSON.parse(await getText(`${server.origin}/`)), ["web", scratch, "--port", "0"]);
  server.stop();
  await server.ended;
  await assert.rejects(getText(`${server.origin}/`), "the server still answers after it was stopped");
  // Stopping what has ended is nothing.
  server.stop();

  const falls = standIn("falls", `process.stderr.write("archdiff: web: no directory nowhere\\n"); process.exit(2);`);
  await assert.rejects(startWeb(falls, scratch, () => undefined), { message: "archdiff web ended with 2 before it listened: archdiff: web: no directory nowhere" });
  await assert.rejects(startWeb({ file: join(scratch, "no-such-program"), args: [], from: "setting" }, scratch, () => undefined), /could not be started/);
});

test("a check runs to its end with its output and exit code; stopped for a newer run, it has no code", async () => {
  const checks = standIn("checks", `process.stdout.write(JSON.stringify({ args: process.argv.slice(2) })); process.stderr.write("archdiff check: 1 import goes against the intent\\n"); process.exitCode = 1;`);
  const run = await runCheck(checks, scratch, new AbortController().signal);

  assert.deepEqual(run, { code: 1, stdout: JSON.stringify({ args: ["check", scratch, "--json"] }), stderr: "archdiff check: 1 import goes against the intent\n" });

  const hangs = standIn("hangs", `setInterval(() => undefined, 1000);`);
  const stopping = new AbortController();
  const hung = runCheck(hangs, scratch, stopping.signal);
  setTimeout(() => stopping.abort(), 300);
  assert.equal((await hung).code, null);
  await assert.rejects(runCheck({ file: join(scratch, "no-such-program"), args: [], from: "setting" }, scratch, new AbortController().signal), /could not be started/);
});

// ── On the archdiff of this checkout ─────────────────────────────────────────

const repository = join(import.meta.dirname, "..", "..");
const archdiff: Start = { file: process.execPath, args: [join(repository, "bin", "archdiff.js")], from: "setting" };
const outside = !existsSync(archdiff.args[0]!) && "not in the archdiff repository";

test("archdiff's own server names the functions of a file, and the cursor's line finds the one it is in", { skip: outside }, async () => {
  // A home of the test's own: the server reads no settings of the person who runs the tests.
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const server = await startWeb(archdiff, join(repository, "tests", "fixtures", "sample"), () => undefined, { ...process.env, ARCHDIFF_HOME: home });

  try {
    const functions = functionsOfInside(JSON.parse(await getText(`${server.origin}${insideRequest("src/lib/orders.ts")}`)), "src/lib/orders.ts");

    assert.deepEqual(functions.map((fn) => fn.id), ["src/lib/orders.ts#placeOrder", "src/lib/orders.ts#validate", "src/lib/orders.ts#findOrder", "src/lib/orders.ts#OrderService", "src/lib/orders.ts#OrderService.constructor", "src/lib/orders.ts#OrderService.place", "src/lib/orders.ts#OrderService.nextId"]);
    // `return placeOrder(…)` inside OrderService.place, and the line of `export function placeOrder`.
    assert.equal(functionAt(functions, 26)?.id, "src/lib/orders.ts#OrderService.place");
    assert.equal(functionAt(functions, 7)?.id, "src/lib/orders.ts#placeOrder");
    assert.equal(functionAt(functions, 1), null);
    // A file archdiff does not read has no inside: the server says so, and no function is named.
    assert.deepEqual(functionsOfInside(JSON.parse(await getText(`${server.origin}${insideRequest("README.md")}`)), "README.md"), []);
  } finally {
    server.stop();
    await server.ended;
  }
});

test("archdiff's own check, run as the extension runs it, gives the finding of an import against the contract, and none where nothing is against it", { skip: outside }, async () => {
  const project = join(scratch, "shop");
  mkdirSync(join(project, "src", "routes"), { recursive: true });
  mkdirSync(join(project, "src", "services"), { recursive: true });
  mkdirSync(join(project, "src", "db"), { recursive: true });
  writeFileSync(join(project, "src", "db", "store.ts"), "export function read(): string {\n  return 'ok';\n}\n");
  writeFileSync(join(project, "src", "services", "health.ts"), "import { read } from '../db/store.ts';\nexport function health(): string {\n  return read();\n}\n");
  writeFileSync(join(project, "src", "routes", "health.ts"), "import { health } from '../services/health.ts';\nexport function get(): string {\n  return health();\n}\n");
  writeFileSync(
    join(project, "ARCHITECTURE.md"),
    ["# Architecture", "", "```mermaid", "flowchart LR", '  subgraph routes["routes"]', '    r["src/routes/health.ts"]', "  end", '  subgraph services["services"]', '    s["src/services/health.ts"]', "  end", '  subgraph db["db"]', '    d["src/db/store.ts"]', "  end", "  r --> s", "  s --> d", "```", ""].join("\n"),
  );
  const signal = new AbortController().signal;
  const clean = await runCheck(archdiff, project, signal);

  assert.equal(clean.code, 0, clean.stderr);
  assert.deepEqual(findingsOf(clean.stdout), { ok: true, findings: [], unplaced: 0 });

  // The route reads the store itself, on its second line: no arrow of the contract goes from routes to db.
  writeFileSync(join(project, "src", "routes", "health.ts"), "import { health } from '../services/health.ts';\nimport { read } from '../db/store.ts';\nexport function get(): string {\n  return health() + read();\n}\n");
  const failing = await runCheck(archdiff, project, signal);

  assert.equal(failing.code, 1, failing.stderr);
  assert.deepEqual(findingsOf(failing.stdout), {
    ok: true,
    findings: [{ file: "src/routes/health.ts", line: 2, message: "imports src/db/store.ts: layer routes → db is not in ARCHITECTURE.md. Add the arrow there if it is wanted, else move the import.", known: false }],
    unplaced: 0,
  });

  // Without a contract there is nothing to check against: no output, and so no finding.
  rmSync(join(project, "ARCHITECTURE.md"));
  const nothing = await runCheck(archdiff, project, signal);

  assert.deepEqual([nothing.code, nothing.stdout], [0, ""], nothing.stderr);
  assert.deepEqual(findingsOf(nothing.stdout), { ok: true, findings: [], unplaced: 0 });
});
