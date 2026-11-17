// Behavioural tests of `archdiff mcp` through its real stdin and stdout:
// the handshake, the list of tools, an answer from every tool on
// tests/fixtures/sample, the wrong calls as JSON-RPC errors in the CLI's
// words, and — on a copy with a contract, a test file and a commit — the
// answers that follow an edit made between two calls.
//
// Entry point: run by `npm test`.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { withTempDir } from "./temp-dir.ts";

const root = join(import.meta.dirname, "..");

const fixture = join(root, "tests/fixtures/sample");

const bin = join(root, "bin/archdiff.js");

/** A JSON-RPC response as the server writes it. */
interface Response {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: { content?: { type: string; text: string }[]; isError?: boolean; [key: string]: unknown };
  error?: { code: number; message: string };
}

interface Client {
  /** Sends one request and waits for its response. */
  request(method: string, params?: unknown): Promise<Response>;
  /** Calls a tool and gives its text; fails the test when the call is refused or the tool failed. */
  ask(name: string, args?: Record<string, unknown>): Promise<string>;
  /** Calls a tool that must be refused, and gives the JSON-RPC error. */
  refused(name: string, args?: Record<string, unknown>): Promise<{ code: number; message: string }>;
  /** Writes text to the server's stdin as it is. */
  write(text: string): void;
  /** The responses no request of `request` waited for: an answer to a raw line, an array for a batch. */
  stray: unknown[];
  /** Ends the input and waits for the server to stop: its exit code and what it said on stderr. */
  close(): Promise<{ code: number | null; stderr: string }>;
}

/** The servers the tests started: a test that fails before it closes its own would leave one waiting on its input, and the run with it. */
const servers: ReturnType<typeof spawn>[] = [];
after(() => servers.forEach((server) => server.kill()));

/** A client of a real `archdiff mcp` on `dir`; every line the server writes to stdout must be one JSON-RPC message. */
function connect(dir: string): Client {
  const child = spawn(process.execPath, [bin, "mcp", dir], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  servers.push(child);
  const waiting = new Map<number, (response: Response) => void>();
  const stray: unknown[] = [];
  let stderr = "";
  let next = 1;
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Response | Response[];
    const resolve = !Array.isArray(message) && typeof message.id === "number" ? waiting.get(message.id) : undefined;

    if (!Array.isArray(message)) assert.equal(message.jsonrpc, "2.0", line);

    if (resolve) resolve(message as Response);
    else stray.push(message);
  });
  const exited = new Promise<number | null>((done) => child.on("close", done));
  const request = (method: string, params?: unknown): Promise<Response> => {
    const id = next++;
    const answered = new Promise<Response>((done) => waiting.set(id, done));
    child.stdin.write(`${JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params })}\n`);

    return answered;
  };

  return {
    request,
    ask: async (name, args) => {
      const response = await request("tools/call", args === undefined ? { name } : { name, arguments: args });
      assert.ok(response.result, `${name}: ${JSON.stringify(response.error)}`);
      assert.equal(response.result.isError, false, response.result.content?.[0]?.text);
      assert.equal(response.result.content?.length, 1);
      assert.equal(response.result.content[0]!.type, "text");

      return response.result.content[0]!.text;
    },
    refused: async (name, args) => {
      const response = await request("tools/call", args === undefined ? { name } : { name, arguments: args });
      assert.ok(response.error, `${name} was answered: ${JSON.stringify(response.result)}`);

      return response.error;
    },
    write: (text) => void child.stdin.write(text),
    stray,
    close: async () => {
      child.stdin.end();

      return { code: await exited, stderr };
    },
  };
}

/** git in `dir` as a test's author, failing the test when git refuses. */
function gitIn(dir: string): (...args: string[]) => void {
  return (...args) => {
    const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
}

/** What the CLI says on stderr for a wrong call, without its `archdiff: ` and the line break: the message a tool must refuse with. */
function cliMessage(args: string[]): string {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^archdiff: .*\n$/);

  return result.stderr.slice("archdiff: ".length, -1);
}

test("initialize agrees on the revision and names the server; ping answers; a notification gets no answer; the server stops when its input ends", async () => {
  const client = connect(fixture);
  const hello = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  const { version } = (await import("node:module")).createRequire(import.meta.url)("../package.json") as { version: string };
  assert.equal(hello.result?.["protocolVersion"], "2025-06-18");
  assert.deepEqual(hello.result?.["capabilities"], { tools: {} });
  assert.deepEqual(hello.result?.["serverInfo"], { name: "archdiff", version });
  assert.match(String(hello.result?.["instructions"]), /may_import.*impact.*diagram.*check.*review/);
  client.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  // A revision the server does not speak is answered with the newest it does, and the client decides.
  assert.equal((await client.request("initialize", { protocolVersion: "1999-01-01", capabilities: {} })).result?.["protocolVersion"], "2025-11-25");
  assert.deepEqual((await client.request("ping")).result, {});
  const { code, stderr } = await client.close();
  assert.equal(code, 0, stderr);
  assert.deepEqual(client.stray, []);
});

test("tools/list names the six tools, each with what it answers, the schema of its arguments and the read-only hint; a picture's options are the one table", async () => {
  const client = connect(fixture);
  const listed = (await client.request("tools/list")).result?.["tools"] as { name: string; title: string; description: string; inputSchema: { type: string; properties: Record<string, { type: string; enum?: string[]; items?: { enum?: string[] } }>; required?: string[]; additionalProperties: boolean }; annotations: { readOnlyHint: boolean } }[];
  assert.deepEqual(
    listed.map((tool) => tool.name),
    ["views", "diagram", "check", "may_import", "impact", "review"],
  );

  for (const tool of listed) {
    assert.ok(tool.title.length > 0 && tool.description.length > 40, tool.name);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, true);
  }

  const diagram = listed.find((tool) => tool.name === "diagram")!.inputSchema;
  assert.deepEqual(diagram.required, ["view"]);
  // Every option of the picture, by the name the API's query gives it, typed as the table types it.
  assert.deepEqual(
    Object.keys(diagram.properties),
    ["view", "base", "head", "heads", "depth", "limit", "weight", "hubs", "packages", "expand", "hide", "overlay", "changes", "only", "changed", "mermaid", "lanes", "types"],
  );
  assert.equal(diagram.properties["depth"]!.type, "integer");
  assert.equal(diagram.properties["hubs"]!.type, "boolean");
  assert.deepEqual(diagram.properties["overlay"]!.items?.enum, ["tests", "storages", "heat", "instability"]);
  assert.ok(diagram.properties["mermaid"]!.enum?.includes("flowchart"));
  assert.deepEqual(listed.find((tool) => tool.name === "may_import")!.inputSchema.required, ["from", "to"]);
  assert.deepEqual(Object.keys(listed.find((tool) => tool.name === "check")!.inputSchema.properties), []);
  await client.close();
});

test("every tool answers on the fixture: the views, a picture with its options, the check, an import asked about, the impact of a function and of a module, the review", async () => {
  const client = connect(fixture);
  // The list `archdiff views` prints, line for line; one kind of it on request.
  const views = await client.ask("views");
  assert.equal(views, spawnSync(process.execPath, [bin, "views", fixture], { encoding: "utf8" }).stdout);
  assert.deepEqual(
    (await client.ask("views", { kind: "module" })).trim().split("\n").map((line) => line.split("\t")[0]),
    ["module:cartridges/base/cartridge/scripts/hooks/basket.js", "module:src/db/store.ts", "module:src/lib/log.ts", "module:src/lib/orders.ts", "module:src/routes/checkout.tsx"],
  );
  // A view by its key, as Markdown with Mermaid; the options change the picture as the CLI's flags do.
  const calls = await client.ask("diagram", { view: "calls:src/lib/orders.ts#placeOrder" });
  assert.match(calls, /^<!-- archdiff:generated — view calls:src\/lib\/orders\.ts#placeOrder — commit [0-9a-f]+ \(\d{4}-\d\d-\d\d\) -->\n# Calls from placeOrder\n/);
  assert.ok(calls.includes("```mermaid\n") && calls.includes("src_lib_orders_ts_placeOrder ==> src_db_store_ts_saveOrder"), calls);
  const alone = await client.ask("diagram", { view: "module:src/db/store.ts", depth: 0, packages: true });
  assert.equal(alone, spawnSync(process.execPath, [bin, "diagram", "module:src/db/store.ts", fixture, "--depth", "0", "--packages"], { encoding: "utf8" }).stdout);
  assert.ok(alone.includes("node:fs") && !alone.includes("src/lib/orders.ts"), alone);
  assert.ok((await client.ask("diagram", { view: "layers", mermaid: "pie", overlay: ["tests"], hide: [] })).includes("pie"));
  // The fixture has no contract: the check and the question about an import say so, in the CLI's words.
  assert.equal(await client.ask("check"), "no ARCHITECTURE.md, nothing to check against (archdiff intent --init)\n");
  assert.equal(await client.ask("may_import", { from: "src/routes/checkout.tsx", to: "src/db/store.ts" }), "Not judged: no ARCHITECTURE.md, nothing to check against (archdiff intent --init).\n");
  // A function's callers by distance, each with the call that makes it one and where.
  const fn = await client.ask("impact", { target: "src/db/store.ts#saveOrder" });
  assert.ok(fn.includes("A function of `src/db/store.ts` (layer **db**), src/db/store.ts:6. Within 3 steps: 3 callers in 2 modules; 0 test files reach it."), fn);
  assert.ok(fn.includes("1 step away:\n\n- `src/lib/orders.ts#placeOrder` calls it — src/lib/orders.ts:10\n"), fn);
  assert.ok(fn.includes("3 steps away:\n\n- `src/routes/checkout.tsx#action` calls `src/lib/orders.ts#OrderService.place` — src/routes/checkout.tsx:5\n"), fn);
  // A module's importers and the callers of its functions; the depth cuts the lists and counts the rest.
  const module = await client.ask("impact", { target: "module:src/db/store.ts", depth: 1 });
  assert.ok(module.includes("## Importers (1)\n\n1 step away:\n\n- `src/lib/orders.ts` imports it — src/lib/orders.ts:2\n\n… 1 more further than 1 step away"), module);
  assert.ok(module.includes("- `src/lib/orders.ts#placeOrder` calls `src/db/store.ts#saveOrder` — src/lib/orders.ts:10\n"), module);
  // A type flows by imports: its module's importers stand for it, the one that takes only types told apart.
  assert.ok((await client.ask("impact", { target: "src/lib/orders.ts#Order" })).includes("- `src/db/store.ts` imports the types of its module — src/db/store.ts:2\n"));
  // The working tree against its own commit.
  assert.match(await client.ask("review", { base: "HEAD" }), /^<!-- archdiff:generated — review since HEAD -->\n# Architecture changes since HEAD\n/);
  const { code, stderr } = await client.close();
  assert.equal(code, 0, stderr);
  assert.deepEqual(client.stray, []);
});

test("a wrong call is a JSON-RPC error carrying the CLI's message, and the server answers on: a view, a subject, an option, a ref, an argument, a tool, a method, a line that is no JSON", async () => {
  const client = connect(fixture);
  /** The call is refused as invalid params with exactly this message. */
  const refused = async (name: string, args: Record<string, unknown> | undefined, message: string): Promise<void> => assert.deepEqual(await client.refused(name, args), { code: -32602, message });
  // What the CLI says for the same mistake, word for word.
  await refused("diagram", { view: "nope" }, cliMessage(["diagram", "nope", fixture]));
  await refused("diagram", { view: "module:src/none.ts" }, cliMessage(["diagram", "module:src/none.ts", fixture]));
  await refused("diagram", { view: "machine:src/nope.ts#f" }, cliMessage(["diagram", "machine:src/nope.ts#f", fixture]));
  await refused("diagram", {}, cliMessage(["diagram"]));
  await refused("diagram", { view: "layers", head: "no-such-branch" }, cliMessage(["diagram", "layers", fixture, "--head", "no-such-branch"]));
  await refused("review", { base: "-x" }, 'not a git ref: "-x"');
  // An option is refused as the API's query refuses it: by the name the table gives it.
  await refused("diagram", { view: "layers", depth: 1.5 }, "diagram: depth must be a whole number");
  await refused("diagram", { view: "layers", limit: 0 }, "diagram: limit must be a whole number of at least 1");
  await refused("diagram", { view: "layers", overlay: ["glow"] }, 'diagram: unknown overlay "glow" (tests, storages, heat, instability)');
  await refused("diagram", { view: "layers", hubs: "maybe" }, "diagram: hubs must be 1 or 0");
  await refused("diagram", { view: "layers", depth: true }, "diagram: depth must be a whole number");
  await refused("diagram", { view: "layers", expand: "src/x.ts", mermaid: ["pie"] }, "diagram: mermaid must be one of auto, flowchart, c4, quadrant, pie, gitgraph, mindmap, state");
  // An argument a tool does not know is a typo, as a flag the CLI does not know.
  await refused("diagram", { view: "layers", dpth: 2 }, 'diagram: unknown argument "dpth" (view, base, head, heads, depth, limit, weight, hubs, packages, expand, hide, overlay, changes, only, changed, mermaid, lanes, types)');
  await refused("check", { json: true }, 'check: unknown argument "json" (it takes none)');
  assert.match((await client.refused("views", { kind: "nope" })).message, /^views: unknown kind "nope" \(layers, layer, dir, module, .*, compare\)$/);
  await refused("may_import", { from: "src/lib/log.ts" }, "may_import: from and to are required: a module's path or a layer's name each");
  await refused("impact", { target: "src/none.ts" }, 'impact: no module or function "src/none.ts" (archdiff views lists them)');
  await refused("impact", { target: "src/db/store.ts", depth: 0 }, "impact: depth must be a whole number of at least 1");
  await refused("impact", { target: 5 }, 'impact: "target" must be a string');
  await refused("frobnicate", undefined, "Unknown tool: frobnicate (views, diagram, check, may_import, impact, review)");
  assert.deepEqual((await client.request("tools/call", { name: "views", arguments: [] })).error, { code: -32602, message: "views: the arguments must be an object" });
  // A method the server does not have — the probe of a later revision among them — is not found, so that client falls back to the handshake.
  assert.deepEqual((await client.request("server/discover", {})).error, { code: -32601, message: "Method not found: server/discover" });
  assert.deepEqual((await client.request("resources/list")).error, { code: -32601, message: "Method not found: resources/list" });
  // A line that is no JSON, a message that is no request, a batch: each answered, none ends the server.
  client.write("not json\n");
  client.write(`${JSON.stringify({ id: 99, method: "ping" })}\n`);
  client.write(`${JSON.stringify([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: "b", method: "nope" }])}\n`);
  assert.deepEqual((await client.request("ping")).result, {});
  const { code, stderr } = await client.close();
  assert.equal(code, 0, stderr);
  assert.equal(client.stray.length, 3, JSON.stringify(client.stray));
  const alone = client.stray.filter((message): message is Response => !Array.isArray(message));
  assert.equal(alone.find((message) => message.id === null)?.error?.code, -32700);
  assert.deepEqual(alone.find((message) => message.id === 99), { jsonrpc: "2.0", id: 99, error: { code: -32600, message: "Invalid Request: not a JSON-RPC 2.0 message" } });
  assert.deepEqual(client.stray.find(Array.isArray), [
    { jsonrpc: "2.0", id: "a", result: {} },
    { jsonrpc: "2.0", id: "b", error: { code: -32601, message: "Method not found: nope" } },
  ]);
});

test("a request the client gave up is not answered; a tool that ran and failed says why in a result marked as an error", async () =>
  withTempDir("archdiff-mcp-plain-", async (dir) => {
    cpSync(fixture, dir, { recursive: true });
    const client = connect(dir);
    // The request and its cancellation arrive together: the answer is dropped, the next request is answered.
    client.write(`${JSON.stringify({ jsonrpc: "2.0", id: "gone", method: "tools/call", params: { name: "views" } })}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "gone", reason: "the user moved on" } })}\n`);
    // Outside a git repository the review cannot be made: the tool ran, and git's refusal is its answer.
    const failed = await client.request("tools/call", { name: "review" });
    assert.equal(failed.error, undefined);
    assert.deepEqual(failed.result, { content: [{ type: "text", text: `${dir} is not a git repository` }], isError: true });
    // The views of the changed files, outside git: every view, and why, as the CLI's `views --changed` says on stderr.
    assert.match(await client.ask("views", { changed: true, kind: "layers" }), /^the changed files could not be told apart: .* is not a git repository; every view listed\nlayers\tLayers\n$/);
    const { code, stderr } = await client.close();
    assert.equal(code, 0, stderr);
    assert.deepEqual(client.stray, []);
  }));

test("with a contract, a test file and a commit: an import asked about is allowed, forbidden or not judged; the impact names the tests to run; an edit made between two calls is in the next check and review", async () =>
  withTempDir("archdiff-mcp-contract-", async (dir) => {
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(join(dir, "ARCHITECTURE.md"), "# Architecture\n\n```mermaid\nflowchart LR\n  subgraph routes\n    r[src/routes/checkout.tsx]\n  end\n  subgraph lib\n    o[src/lib/orders.ts]\n    l[src/lib/log.ts]\n  end\n  subgraph db\n    s[src/db/store.ts]\n  end\n  r --> o\n  o --> s\n  o --> l\n```\n");
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/orders.test.ts"), `import { test } from "node:test";\nimport { placeOrder } from "../src/lib/orders.ts";\n\ntest("an order is placed", () => {\n  placeOrder("a", 1);\n});\n`);
    // A test that takes the store whole and calls nothing archdiff can follow: it reaches the store by its import alone.
    writeFileSync(join(dir, "tests/store.test.ts"), `import { test } from "node:test";\nimport * as store from "../src/db/store.ts";\n\ntest("the store exports its functions", () => {\n  Object.keys(store);\n});\n`);
    const git = gitIn(dir);
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const client = connect(dir);
    // The contract's arrows decide: inside a layer and along an arrow yes, across two layers without one no.
    assert.equal(await client.ask("may_import", { from: "src/lib/orders.ts", to: "src/db/store.ts" }), "Allowed: `src/lib/orders.ts` (layer **lib**) → `src/db/store.ts` (layer **db**). ARCHITECTURE.md has an import across these layers (`src/lib/orders.ts` → `src/db/store.ts`).\n");
    assert.equal(await client.ask("may_import", { from: "src/lib/orders.ts", to: "src/lib/log.ts" }), "Allowed: `src/lib/orders.ts` (layer **lib**) → `src/lib/log.ts` (layer **lib**). Both ends are in one layer.\n");
    assert.equal(
      await client.ask("may_import", { from: "src/routes/checkout.tsx", to: "src/db/store.ts" }),
      "Not allowed: `src/routes/checkout.tsx` (layer **routes**) → `src/db/store.ts` (layer **db**). The layer **routes** → **db** is not in the intent: `archdiff check` would report the import. **routes** may import **lib**. Add the arrow to ARCHITECTURE.md if the import is wanted, else move it; an import of types only (`import type`) is never a violation.\n",
    );
    // A file still to be written is placed by its path, a layer is named as itself, a layer the contract lacks is not judged.
    assert.match(await client.ask("may_import", { from: "src/db/new-table.ts", to: "src/routes/checkout.tsx" }), /^Not allowed: `src\/db\/new-table\.ts` \(layer \*\*db\*\*\) → .*\*\*db\*\* may import no other layer\./);
    assert.match(await client.ask("may_import", { from: "routes", to: "lib" }), /^Allowed: the layer \*\*routes\*\* → the layer \*\*lib\*\*\. /);
    assert.equal(await client.ask("may_import", { from: "tests/orders.test.ts", to: "src/lib/orders.ts" }), "Not judged: `tests/orders.test.ts` (layer **other**) → `src/lib/orders.ts` (layer **lib**). ARCHITECTURE.md does not name the layer **other**, so it neither allows nor forbids the import.\n");
    // One test calls placeOrder at its top level, which calls saveOrder: two calls away, however short the list. The
    // other imports the store's module and makes no call archdiff follows: found by the import. Both are the tests to run.
    const impact = await client.ask("impact", { target: "src/db/store.ts#saveOrder", depth: 1 });
    assert.ok(impact.includes("Within 1 step: 1 caller in 1 module; 2 test files reach it."), impact);
    assert.ok(impact.includes("… 3 more further than 1 step away"), impact);
    assert.ok(impact.includes("## Tests that reach it (2)\n\n- `tests/store.test.ts` — imports its module, 1 step away\n- `tests/orders.test.ts` — calls it, 2 steps away\n"), impact);
    assert.ok((await client.ask("impact", { target: "src/lib/orders.ts#placeOrder" })).includes("- `tests/orders.test.ts` (its top level) calls it — tests/orders.test.ts:5\n"));
    assert.ok((await client.ask("check")).includes("**The code follows the intent.**"));
    // The agent's edit: the route reads the store directly. The next answers are of the code as it is now.
    writeFileSync(join(dir, "src/routes/checkout.tsx"), `import { readOrder } from "@/db/store";\n\nexport function loader() {\n  return readOrder("y");\n}\n`);
    const broken = await client.ask("check");
    assert.ok(broken.includes("**1 violation of the intent.**"), broken);
    assert.ok(broken.includes("- `src/routes/checkout.tsx:1` imports `src/db/store.ts`: layer **routes** → **db** is not in the intent."), broken);
    const review = await client.ask("review", { base: "HEAD" });
    assert.ok(review.includes("## ⚠ New dependencies between layers") && review.includes("- **routes → db** — against ARCHITECTURE.md"), review);
    assert.ok((await client.ask("views", { changed: true, base: "HEAD", kind: "module" })).startsWith("1 file changed since HEAD\nmodule:src/routes/checkout.tsx\t"));
    const { code, stderr } = await client.close();
    assert.equal(code, 0, stderr);
  }));
