// A stand-in for archdiff in the editor test (run.mjs installs it in the
// test's workspace as `node_modules/.bin/archdiff`): it answers the two
// commands the extension runs, as archdiff does, and its page says what
// happens to it, which no test can ask the real page inside a webview.
//
// `web <dir> --port 0` serves a page that reports to its server when it is
// loaded and when its hash changes (`seen.log` in the workspace: one JSON
// line each, with an ID of the load, so a page loaded again shows), and,
// hosted, tells its host of a place to open after each change of the hash —
// as a reader who taps a shape of the new picture. `/api/diagram` names one
// function of src/place.ts. `check <dir> --json` reports one import against
// the contract and counts its runs (`checks.log`).
//
// Entry point: run as `archdiff` by the extension under test.

import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [command, dir] = process.argv.slice(2);

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>stand-in</title>
<p>The stand-in page of the editor test.</p>
<script>
const load = Math.random().toString(36).slice(2);
const hosted = new URLSearchParams(location.search).get("host") === "1" && window.parent !== window;
const seen = (what) => fetch("/seen?" + new URLSearchParams({ load, what, hash: location.hash, search: location.search, hosted: String(hosted) }));
seen("loaded");
addEventListener("hashchange", () => {
  seen("hashchange");
  if (hosted) window.parent.postMessage({ type: "archdiff:open", file: "src/other.ts", line: 2, endLine: 3 }, "*");
});
</script>
`;

if (command === "check") {
  appendFileSync(join(dir, "checks.log"), `${new Date().toISOString()}\n`);
  process.stdout.write(`${JSON.stringify({ planned: [], plannedEdges: [], beyond: [], violations: [{ from: "src/place.ts", to: "src/other.ts", fromLayer: "app", toLayer: "db", line: 1 }], unintended: [], ok: false }, null, 2)}\n`);
  process.stderr.write("archdiff check: 1 import goes against the intent\n");
  process.exitCode = 1;
} else if (command === "web") {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/seen") {
      appendFileSync(join(dir, "seen.log"), `${JSON.stringify(Object.fromEntries(url.searchParams))}\n`);
      response.end("ok");
    } else if (url.pathname === "/api/diagram") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ diagram: { nodes: [{ id: "src/place.ts#place", kind: "fn", ref: { id: "src/place.ts#place", file: "src/place.ts", line: 3, endLine: 5 } }] }, markdown: "" }));
    } else {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(PAGE);
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    // For the test's runner: the process to find gone once the window has closed.
    writeFileSync(join(dir, "server.json"), JSON.stringify({ pid: process.pid, port }));
    process.stderr.write(`archdiff web: http://127.0.0.1:${port}/  (${dir})\n`);
  });
} else {
  process.stderr.write(`archdiff: the stand-in knows web and check, not "${command}"\n`);
  process.exitCode = 2;
}
