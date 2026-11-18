// The web server through HTTP on a temporary copy of the fixture: the API
// of the page, the drawing saved by the editor and read back into the
// layout, and the refusals (foreign Host, a path out of dist/web).
//
// Entry point: run by `npm test`.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { canLink } from "./temp-dir.ts";
import { fakeCommand, startWeb, TEST_BIN, withOwnServer } from "./web-server.ts";

const root = join(import.meta.dirname, "..");

const fixture = join(root, "tests/fixtures/sample");

let dir = "";
let server: ChildProcess | null = null;
let base = "";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "archdiff-web-"));
  cpSync(fixture, dir, { recursive: true });
  // A fake agent (tests/fixtures/fake-agent.mjs) stands in for claude/cursor: same stream-json, writes the file the prompt names.
  writeFileSync(join(dir, "archdiff.json"), JSON.stringify({ layers: { routes: ["src/routes/**"], lib: ["src/lib/**"], db: ["src/db/**"], cartridge: ["cartridges/**"] }, agent: { name: "fake", command: [process.execPath, join(root, "tests/fixtures/fake-agent.mjs")], resume: "--resume" } }));
  // This one watches the files: the live-reload test needs it.
  const started = startWeb(dir, []);
  server = started.server;
  base = await started.origin;
});

after(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  assert.equal(response.status, 200, `${path}: ${text}`);

  return JSON.parse(text) as T;
}

/** A request with a Host header fetch would not let us set. */
function rawRequest(path: string, host: string, origin = base): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const request = httpRequest({ host: url.hostname, port: url.port, path, headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

test("the API lists the views and draws a placed diagram with its Markdown", async () => {
  const views = await getJson<{ views: { key: string }[]; stats: { files: number } }>("/api/views");
  assert.equal(views.stats.files, 5);
  assert.ok(views.views.some((view) => view.key === "calls:src/routes/checkout.tsx#action"));
  const page = await getJson<{ diagram: { nodes: { id: string; x: number; w: number }[] }; markdown: string; drawn: boolean }>("/api/diagram?view=module:src/lib/orders.ts");
  assert.equal(page.drawn, false);
  assert.ok(page.diagram.nodes.every((node) => node.w > 0));
  assert.ok(page.markdown.includes("# src/lib/orders.ts"));
  const node = await getJson<{ markdown: string }>("/api/shape?view=module:src/lib/orders.ts&id=src/lib/orders.ts");
  assert.ok(node.markdown.includes("## Declarations"));
  const file = await fetch(`${base}/api/file?path=src/lib/orders.ts`);
  assert.equal(file.status, 200);
  assert.ok((await file.text()).includes("export function placeOrder"));
  assert.equal((await fetch(`${base}/api/file?path=package.json`)).status, 404);
});

test("a drawing saved by the editor places the shapes of the live diagram and merges into the next scene", async () => {
  const view = "module:src/lib/orders.ts";
  const scene = await getJson<{ elements: { id: string; type: string; x: number; y: number; width: number; height: number; customData?: { archdiff?: string } }[] }>(`/api/scene?view=${encodeURIComponent(view)}`);
  const shape = scene.elements.find((element) => element.id === "src/db/store.ts");
  assert.ok(shape && shape.customData?.archdiff === "node");
  // The user moves one shape and draws a stroke.
  const moved = scene.elements.map((element) => (element.id === "src/db/store.ts" ? { ...element, x: 900, y: 40 } : element));
  moved.push({ id: "stroke-1", type: "freedraw", x: 10, y: 10, width: 50, height: 20 });
  const saved = await fetch(`${base}/api/drawing?view=${encodeURIComponent(view)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ elements: moved, mocks: [{ id: "src/db/store.ts", kind: "storage", value: '{"rows": []}' }] }) });
  const savedText = await saved.text();
  assert.equal(saved.status, 200, savedText);
  assert.deepEqual(JSON.parse(savedText), { saved: ".archdiff/layouts/module_src_lib_orders.ts.json" });
  assert.ok(existsSync(join(dir, ".archdiff/layouts/module_src_lib_orders.ts.json")));
  const page = await getJson<{ diagram: { nodes: { id: string; x: number; y: number }[] }; drawn: boolean }>(`/api/diagram?view=${encodeURIComponent(view)}`);
  assert.equal(page.drawn, true);
  const placed = page.diagram.nodes.find((node) => node.id === "src/db/store.ts");
  assert.deepEqual({ x: placed?.x, y: placed?.y }, { x: 900, y: 40 });
  const again = await getJson<{ elements: { id: string; x: number }[]; mocks: { id: string }[] }>(`/api/scene?view=${encodeURIComponent(view)}`);
  assert.equal(again.elements.find((element) => element.id === "src/db/store.ts")?.x, 900);
  assert.ok(again.elements.some((element) => element.id === "stroke-1"));
  assert.deepEqual(again.mocks.map((mock) => mock.id), ["src/db/store.ts"]);
  // The export follows the drawing too.
  const drawio = await (await fetch(`${base}/api/export?view=${encodeURIComponent(view)}&format=drawio`)).text();
  assert.ok(drawio.includes('archdiff_id="src/db/store.ts"'));
  // The Postman collection of the operations the code calls downloads as a file: the sample calls none, so it is empty but well-formed.
  const postman = await fetch(`${base}/api/postman`);
  assert.equal(postman.status, 200);
  assert.match(postman.headers.get("content-disposition") ?? "", /^attachment; filename="scapi\.postman_collection\.json"$/);
  const emptyCollection = (await postman.json()) as { info: { schema: string }; item: unknown[] };
  assert.ok(emptyCollection.info.schema.endsWith("/v2.1.0/collection.json") && emptyCollection.item.length === 0, JSON.stringify(emptyCollection).slice(0, 200));
  // A wrong body is refused and nothing changes.
  const bad = await fetch(`${base}/api/drawing?view=${encodeURIComponent(view)}`, { method: "POST", body: JSON.stringify({ elements: "no" }) });
  assert.equal(bad.status, 400);
  // Two views that spell one file name keep a drawing each: the second gets a name of its own.
  const save = async (key: string, id: string): Promise<string> => ((await (await fetch(`${base}/api/drawing?view=${encodeURIComponent(key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ elements: [{ id, type: "freedraw", x: 1, y: 1, width: 5, height: 5 }], mocks: [] }) })).json()) as { saved: string }).saved;
  assert.equal(await save("module:src/lib/log.ts", "stroke-a"), ".archdiff/layouts/module_src_lib_log.ts.json");
  assert.match(await save("module:src/lib_log.ts", "stroke-b"), /^\.archdiff\/layouts\/module_src_lib_log\.ts-[0-9a-f]{10}\.json$/);
  const strokes = async (key: string): Promise<string[]> => (await getJson<{ elements: { id: string }[] }>(`/api/scene?view=${encodeURIComponent(key)}`)).elements.map((element) => element.id).filter((id) => id.startsWith("stroke-"));
  assert.deepEqual(await strokes("module:src/lib/log.ts"), ["stroke-a"]);
  assert.deepEqual(await strokes("module:src/lib_log.ts"), ["stroke-b"]);
});

test("a shape's page is asked for the picture the page shows: an opened module's function has a page, a package.json is a readable file", async () => {
  const expanded = await getJson<{ markdown: string }>(`/api/shape?view=${encodeURIComponent("layer:lib")}&id=${encodeURIComponent("src/lib/orders.ts#placeOrder")}&expand=${encodeURIComponent("src/lib/orders.ts")}`);
  assert.ok(expanded.markdown.startsWith("# placeOrder"), expanded.markdown.slice(0, 80));
  assert.equal((await fetch(`${base}/api/shape?view=${encodeURIComponent("layer:lib")}&id=${encodeURIComponent("src/lib/orders.ts#placeOrder")}`)).status, 404);
  // A shape of a picture that goes a depth names its neighbours beyond the picture, before it and after it.
  const beyond = await getJson<{ markdown: string }>(`/api/shape?view=${encodeURIComponent("module:src/lib/log.ts")}&id=${encodeURIComponent("src/lib/orders.ts")}`);
  assert.ok(beyond.markdown.includes("## Beyond this picture\n\n◂ 1 before it: the modules that import it, not drawn here.\n\n- src/routes/checkout.tsx\n"), beyond.markdown);
  assert.ok(beyond.markdown.includes("1 after it ▸: the modules it imports, not drawn here.\n\n- src/db/store.ts\n"), beyond.markdown);
  const manifest = await fetch(`${base}/api/file?path=tsconfig.json`);
  assert.equal(manifest.status, 200);
  assert.ok((await manifest.text()).includes("compilerOptions"));
  assert.equal((await fetch(`${base}/api/file?path=${encodeURIComponent("../package.json")}`)).status, 404);
  assert.equal((await fetch(`${base}/api/file?path=${encodeURIComponent(".git/config")}`)).status, 404);
});

test("the specs are listed and read from openspec/ and features/ only; the prompt names the subject", async () => {
  const before = await getJson<{ initialised: boolean; specs: unknown[] }>("/api/specs");
  assert.equal(before.initialised, false);
  assert.deepEqual(before.specs, []);
  mkdirSync(join(dir, "openspec/specs/orders"), { recursive: true });
  writeFileSync(join(dir, "openspec/specs/orders/spec.md"), "# Orders Specification\n\n## Purpose\n\nOrders.\n\n## Requirements\n\n### Requirement: Orders are placed\n\nThe system SHALL place an order.\n\n#### Scenario: One order\n\n- **WHEN** placeOrder runs\n- **THEN** the order is saved\n");
  mkdirSync(join(dir, "features"), { recursive: true });
  writeFileSync(join(dir, "features/orders.feature"), "Feature: Orders\n  Scenario: One order\n    When placeOrder runs\n    Then the order is saved\n");
  const after = await getJson<{ initialised: boolean; specs: { path: string; title: string; kind: string }[] }>("/api/specs");
  assert.deepEqual(after.specs, [{ path: "openspec/specs/orders/spec.md", title: "Orders Specification", kind: "openspec" }, { path: "features/orders.feature", title: "Orders", kind: "gherkin" }]);
  const spec = await getJson<{ text: string }>(`/api/spec?path=${encodeURIComponent("features/orders.feature")}`);
  assert.ok(spec.text.startsWith("Feature: Orders"));
  assert.equal((await fetch(`${base}/api/spec?path=${encodeURIComponent("../package.json")}`)).status, 404);
  assert.equal((await fetch(`${base}/api/spec?path=package.json`)).status, 404);
  const prompt = await getJson<{ markdown: string }>(`/api/spec/prompt?mode=generate&view=${encodeURIComponent("layer:lib")}`);
  assert.ok(prompt.markdown.includes("Specify the layer lib") && prompt.markdown.includes("openspec/specs/orders/spec.md") && prompt.markdown.includes("#### Scenario:"), prompt.markdown.slice(0, 400));
  const update = await getJson<{ markdown: string }>("/api/spec/prompt?mode=update");
  assert.ok(update.markdown.startsWith("# Review the specification against the code"));
  assert.equal((await fetch(`${base}/api/spec/prompt?mode=generate&view=nope`)).status, 400);
});

test("a line's page names its ends and the imports and calls behind it", async () => {
  const edge = await getJson<{ markdown: string }>(`/api/line?view=${encodeURIComponent("layer:lib")}&from=${encodeURIComponent("src/lib/orders.ts")}&to=${encodeURIComponent("src/db/store.ts")}&kind=dependency`);
  assert.ok(edge.markdown.startsWith("# src/lib/orders.ts → src/db/store.ts"), edge.markdown.slice(0, 80));
  assert.ok(edge.markdown.includes("- to: **src/db/store.ts** (module)"), edge.markdown);
  assert.ok(edge.markdown.includes("`src/lib/orders.ts:2` → src/db/store.ts") && edge.markdown.includes("placeOrder → src/db/store.ts#saveOrder"), edge.markdown);
  const layers = await getJson<{ markdown: string }>(`/api/line?view=layers&from=routes&to=lib`);
  assert.ok(layers.markdown.includes("routes imports lib") && layers.markdown.includes("src/routes/checkout.tsx:1"), layers.markdown);
  assert.equal((await fetch(`${base}/api/line?view=layers&from=lib&to=nowhere`)).status, 404);
});

test("the scene takes the options of the page: limit, overlays, the Mermaid type; the changes outside git; a wrong boolean", async () => {
  const view = "layer:lib";
  const scene = await getJson<{ diagram: { nodes: { id: string; label: string; kind: string }[]; reason?: string }; markdown: string }>(`/api/scene?view=${encodeURIComponent(view)}&limit=1&overlay=storages&mermaid=mindmap`);
  assert.ok(scene.diagram.nodes.some((node) => node.kind === "more"), JSON.stringify(scene.diagram.nodes.map((node) => node.id)));
  assert.ok(scene.markdown.includes("mindmap"), scene.markdown.slice(0, 300));
  assert.equal((await fetch(`${base}/api/scene?view=${encodeURIComponent(view)}&overlay=nope`)).status, 400);
  const light = await getJson<{ diagram: { edges: unknown[]; reason?: string; stamp?: { commit: string } } }>(`/api/scene?view=layers&weight=9&hubs=0`);
  assert.equal(light.diagram.edges.length, 0);
  // The server runs on a scratch copy outside git here, so the stamp is absent rather than wrong.
  assert.equal(light.diagram.stamp, undefined);
  // Outside git the changes cannot be laid over: the picture is drawn without them and says why.
  const unchanged = await getJson<{ diagram: { nodes: { diff?: string }[]; reason?: string } }>(`/api/scene?view=${encodeURIComponent(view)}&changes=1&overlay=heat`);
  assert.ok(unchanged.diagram.nodes.length > 0 && unchanged.diagram.nodes.every((node) => node.diff === undefined));
  assert.match(unchanged.diagram.reason ?? "", /⚠ the changes are not laid over: .* is not a git repository$/);
  // The views of the changed files cannot be told outside git either: the whole list comes, with the note.
  const whole = await getJson<{ views: unknown[]; changed: unknown; note: string | null }>("/api/views?changed=1");
  assert.ok(whole.views.length > 5 && whole.changed === null, JSON.stringify(whole.changed));
  assert.match(whole.note ?? "", /the changed files could not be read: .* is not a git repository$/);
  // The API reads its query strictly: a boolean is 1 or 0 (true/false, yes/no), anything else is refused.
  assert.equal((await fetch(`${base}/api/scene?view=layers&hubs=true`)).status, 200);
  const maybe = await fetch(`${base}/api/scene?view=layers&hubs=maybe`);
  assert.equal(maybe.status, 400);
  assert.deepEqual(await maybe.json(), { error: "hubs must be 1 or 0" });
});

test("a foreign Host header and a path out of the page directory are refused", async () => {
  assert.equal(await rawRequest("/api/views", "evil.example"), 421);
  assert.equal(await rawRequest("/api/views", "localhost:1"), 200);
  assert.equal(await rawRequest("/../package.json", "127.0.0.1"), 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/chunks/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('<script type="module" src="app.js">'));
});

test("the server refuses what would hang or leak it: a body over the limit, a broken path, a link out of the repository", async () => {
  // A body over 8 MB gets its 413, not a reset connection.
  const big = await fetch(`${base}/api/drawing?view=layers`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(9_000_000) });
  assert.equal(big.status, 413);
  assert.ok(((await big.json()) as { error: string }).error.startsWith("the body is over 8 MB"));
  assert.equal(await rawRequest("/%E0%A4%A", "127.0.0.1"), 400);
  // The flow's depth and subject are checked like the pictures'.
  assert.equal((await fetch(`${base}/api/flow?view=${encodeURIComponent("calls:src/routes/checkout.tsx#action")}&depth=-5`)).status, 400);
  assert.equal((await fetch(`${base}/api/flow?view=${encodeURIComponent("calls:src/lib/orders.ts#nope")}`)).status, 404);
  // A symbolic link to a file outside the repository, or through a directory outside it, is no file of it.
  const outside = mkdtempSync(join(tmpdir(), "archdiff-outside-"));

  try {
    writeFileSync(join(outside, "secret.txt"), "not yours\n");

    // Without the privilege to make a link (Windows) there is no link to refuse.
    if (canLink()) {
      symlinkSync(join(outside, "secret.txt"), join(dir, "notes-link.txt"));
      symlinkSync(outside, join(dir, "up"));
      assert.equal((await fetch(`${base}/api/file?path=notes-link.txt`)).status, 404);
      assert.equal((await fetch(`${base}/api/file?path=${encodeURIComponent("up/secret.txt")}`)).status, 404);
    }

    assert.equal((await fetch(`${base}/api/file?path=tsconfig.json`)).status, 200);
  } finally {
    rmSync(join(dir, "notes-link.txt"), { force: true });
    rmSync(join(dir, "up"), { force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("bound to every address, the server answers to this computer's name and addresses, and still to no other", async () => {
  // An address of a network interface, when the computer has one beside the loopback.
  const address = Object.values(networkInterfaces()).flatMap((addresses) => addresses ?? []).find((item) => item.family === "IPv4" && !item.internal)?.address;
  const started = startWeb(dir, ["--no-watch", "--host", "0.0.0.0"]);

  try {
    const origin = (await started.origin).replace("0.0.0.0", "127.0.0.1");
    assert.equal(await rawRequest("/api/views", "localhost", origin), 200);
    assert.equal(await rawRequest("/api/views", hostname(), origin), 200);

    if (address) assert.equal(await rawRequest("/api/views", `${address}:7080`, origin), 200);
    assert.equal(await rawRequest("/api/views", "evil.example", origin), 421);
  } finally {
    started.server.kill();
  }
});

test("one agent run at a time: the second is refused while the first works, and taken once it is done", () =>
  withOwnServer(
    "archdiff-one-run-",
    (own) => writeFileSync(join(own, "archdiff.json"), JSON.stringify({ agent: { name: "fake", command: [process.execPath, join(root, "tests/fixtures/fake-agent.mjs")], resume: "--resume" } })),
    async (origin) => {
      const run = (prompt: string): Promise<Response> => fetch(`${origin}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "layers", prompt }) });
      // The events of a run stream until it ends.
      const ended = async (id: string): Promise<void> => void (await (await fetch(`${origin}/api/agent/events?id=${id}`)).text());
      const first = await run("Take your time. wait-ms: 1500");
      assert.equal(first.status, 200);
      const { id } = (await first.json()) as { id: string };
      const second = await run("Another task.");
      assert.equal(second.status, 409);
      assert.equal(((await second.json()) as { error: string }).error, `the agent is still running (${id}): stop it first`);
      await ended(id);
      const third = await run("Now.");
      assert.equal(third.status, 200);
      await ended(((await third.json()) as { id: string }).id);
    },
  ));

test("the task drawn on a view is read from its saved scene, and the agent runs it from the page", async () => {
  const view = "module:src/lib/orders.ts";
  const scene = await getJson<{ elements: Record<string, unknown>[] }>(`/api/scene?view=${encodeURIComponent(view)}`);
  // The user draws a new module in the lib lane with a bound label, a function next to orders.ts, and an arrow from orders.ts to the new module.
  const lane = scene.elements.find((element) => element["id"] === "lane:lib") as { x: number; y: number; width: number; height: number };
  const orders = scene.elements.find((element) => element["id"] === "src/lib/orders.ts") as { x: number; y: number; width: number; height: number };
  const drawn = [
    ...scene.elements,
    { id: "shape-1", type: "rectangle", x: lane.x + lane.width - 200, y: lane.y + 10, width: 170, height: 56, boundElements: [{ id: "shape-1-text", type: "text" }] },
    { id: "shape-1-text", type: "text", x: 0, y: 0, width: 100, height: 20, text: "src/lib/refunds.ts", containerId: "shape-1" },
    { id: "shape-2", type: "ellipse", x: orders.x, y: orders.y + orders.height + 8, width: 120, height: 40, boundElements: [{ id: "shape-2-text", type: "text" }] },
    { id: "shape-2-text", type: "text", x: 0, y: 0, width: 100, height: 20, text: "refund", containerId: "shape-2" },
    { id: "arrow-1", type: "arrow", x: 0, y: 0, width: 10, height: 10, startBinding: { elementId: "src/lib/orders.ts" }, endBinding: { elementId: "shape-1" } },
    { id: "note-1", type: "text", x: 0, y: 300, width: 100, height: 20, text: "refunds go through the same store" },
  ];
  const saved = await fetch(`${base}/api/drawing?view=${encodeURIComponent(view)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ elements: drawn, mocks: [] }) });
  assert.equal(saved.status, 200, await saved.text());
  const plan = await getJson<{ markdown: string; drawn: boolean; plan: { added: { kind: string; name: string; module?: string }[]; edges: { kind: string }[]; notes: string[] } }>(`/api/plan?view=${encodeURIComponent(view)}`);
  assert.equal(plan.drawn, true);
  assert.deepEqual(
    plan.plan.added.map((node) => [node.kind, node.name, node.module]),
    [
      ["module", "src/lib/refunds.ts", undefined],
      ["fn", "refund", "src/lib/orders.ts"],
    ],
  );
  assert.equal(plan.plan.edges[0]?.kind, "import");
  assert.deepEqual(plan.plan.notes, ["refunds go through the same store"]);
  assert.ok(plan.markdown.includes("- A new module `src/lib/refunds.ts` in layer **lib**"), plan.markdown);
  assert.ok(plan.markdown.includes("- An exported function `refund` in `src/lib/orders.ts` (drawn next to src/lib/orders.ts)"), plan.markdown);
  assert.ok(plan.markdown.includes("- `src/lib/orders.ts` imports `src/lib/refunds.ts` (new)"), plan.markdown);
  // The run: the fake agent writes the file the prompt names; its events stream back; the task is saved.
  const prompt = `${plan.markdown}\nwrite-file: ${join(dir, "src/lib/refunds.ts")}`;
  const started = await fetch(`${base}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view, prompt, resume: null }) });
  const run = JSON.parse(await started.text()) as { id: string; agent: string; task: string };
  assert.equal(run.agent, "fake");
  assert.ok(run.task.startsWith(".archdiff/tasks/module_src_lib_orders.ts-"));
  const events = await (await fetch(`${base}/api/agent/events?id=${run.id}`)).text();
  const kinds = events.split("\n\n").filter((chunk) => chunk.startsWith("data: ")).map((chunk) => (JSON.parse(chunk.slice(6)) as { kind: string; text: string; sessionId?: string }));
  assert.deepEqual(kinds.map((event) => event.kind), ["init", "text", "tool", "result", "exit"]);
  assert.equal(kinds[0]?.sessionId, "fake-session-1");
  assert.equal(kinds[2]?.text, `▶ Write file_path=${join(dir, "src/lib/refunds.ts")}`);
  assert.ok(existsSync(join(dir, "src/lib/refunds.ts")));
  assert.equal(readdirSync(join(dir, ".archdiff/tasks")).length, 1);
  // The code changed: the next analysis sees the new module.
  const views = await getJson<{ views: { key: string }[] }>("/api/views");
  assert.ok(views.views.some((entry) => entry.key === "module:src/lib/refunds.ts"));
  // A follow-up resumes the session.
  const again = await fetch(`${base}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view, prompt: "also add a test", resume: "fake-session-1" }) });
  const second = JSON.parse(await again.text()) as { id: string };
  const more = await (await fetch(`${base}/api/agent/events?id=${second.id}`)).text();
  assert.ok(more.includes("resumed"));
  assert.equal((await fetch(`${base}/api/agent/stop?id=nothing`, { method: "POST" })).status, 404);
});

test("branches and a multi-head comparison through the API", async () => {
  // The scratch copy is no git repository: the branch list says so plainly.
  const branches = await fetch(`${base}/api/branches`);
  assert.equal(branches.status, 400);
  assert.ok(((await branches.json()) as { error: string }).error.includes("not a git repository"));
  // A comparison is a picture like any other; outside git it is refused with git's words.
  const compare = await fetch(`${base}/api/scene?view=compare&heads=a,b`);
  assert.equal(compare.status, 400);
  assert.ok(((await compare.json()) as { error: string }).error.includes("not a git repository"));
});

test("a module's page in a comparison says what each head did to it", () =>
  withOwnServer(
    "archdiff-compare-page-",
    (dir) => {
      // Two heads off main: gone removes log.ts, loud makes it write to stderr.
      const git = (...args: string[]): void => {
        const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      };
      git("init", "-q", "-b", "main");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      git("checkout", "-q", "-b", "gone");
      rmSync(join(dir, "src/lib/log.ts"));
      writeFileSync(join(dir, "src/lib/orders.ts"), readFileSync(join(dir, "src/lib/orders.ts"), "utf8").replace('import { log } from "./log.ts";\n', "").replace("  log(`placed ${id}`);\n", ""));
      git("add", "-A");
      git("commit", "-q", "-m", "gone");
      git("checkout", "-q", "main");
      git("checkout", "-q", "-b", "loud");
      writeFileSync(join(dir, "src/lib/log.ts"), "export function log(message: string): void {\n  console.error(message);\n}\n");
      git("commit", "-q", "-am", "loud");
      git("checkout", "-q", "main");
    },
    async (origin) => {
      const page = (await (await fetch(`${origin}/api/shape?view=compare&heads=gone,loud&id=${encodeURIComponent("src/lib/log.ts")}`)).json()) as { markdown: string; error?: string };
      assert.ok(page.markdown?.includes("## In this comparison\n\n### gone\n\n- the module removed\n- removed fn `log` — src/lib/log.ts:1\n- import removed: src/lib/orders.ts → src/lib/log.ts\n"), page.markdown ?? page.error);
      assert.ok(page.markdown.includes("### loud\n\n- changed fn `log` — src/lib/log.ts:1 (body)\n"), page.markdown);
      // The code at a head: the views, a picture, a file of a branch, without a checkout; an unknown head is refused by name.
      const views = (await (await fetch(`${origin}/api/views?head=gone`)).json()) as { views: { key: string }[] };
      assert.ok(!views.views.some((view) => view.key === "module:src/lib/log.ts") && views.views.some((view) => view.key === "module:src/lib/orders.ts"));
      const scene = (await (await fetch(`${origin}/api/scene?view=modules&head=gone`)).json()) as { diagram: { nodes: { id: string }[] } };
      assert.ok(!scene.diagram.nodes.some((node) => node.id === "src/lib/log.ts"));
      assert.ok((await (await fetch(`${origin}/api/file?path=${encodeURIComponent("src/lib/log.ts")}&head=loud`)).text()).includes("console.error"));
      assert.equal((await fetch(`${origin}/api/file?path=${encodeURIComponent("src/lib/log.ts")}&head=gone`)).status, 404);
      const unknown = await fetch(`${origin}/api/views?head=nope`);
      assert.equal(unknown.status, 400);
      assert.equal(((await unknown.json()) as { error: string }).error, 'no branch, tag or commit "nope" (archdiff branches lists the branches)');
      // The branches: a lane each; a commit's page is its message and files, read from git.
      const branches = (await (await fetch(`${origin}/api/scene?view=branches`)).json()) as { diagram: { groups: { label: string }[]; nodes: { id: string; label: string }[] } };
      assert.deepEqual(branches.diagram.groups.map((lane) => lane.label), ["main (base, checked out)", "gone — 1 ahead, 0 behind", "loud — 1 ahead, 0 behind"]);
      const gone = branches.diagram.nodes.find((node) => node.label.includes("\ngone"))!;
      const commitPage = (await (await fetch(`${origin}/api/shape?view=branches&id=${encodeURIComponent(gone.id)}`)).json()) as { markdown: string };
      assert.ok(commitPage.markdown.includes("## Files (2)\n\n- deleted src/lib/log.ts\n- modified src/lib/orders.ts\n"), commitPage.markdown);
      // In the commit's own picture, a module's page reads the module at that commit: orders.ts no longer imports log.ts.
      const orders = (await (await fetch(`${origin}/api/shape?${gone.id.replace("commit:", "view=commit:")}&id=${encodeURIComponent("src/lib/orders.ts")}`)).json()) as { markdown: string };
      assert.ok(orders.markdown.includes("## In this change") && !orders.markdown.includes("## Imports\n\n- src/lib/log.ts"), orders.markdown);
    },
  ));

test("the board of the uncommitted changes through the API: the groups in reading order, a group's picture and diff, a module's page", () =>
  withOwnServer(
    "archdiff-board-api-",
    (dir) => {
      const git = (...args: string[]): void => {
        const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      };
      git("init", "-q", "-b", "main");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      // The working tree: the route reads an order through a loader, the store counts its rows, a new module audits.
      writeFileSync(join(dir, "src/routes/checkout.tsx"), 'import { OrderService, findOrder } from "@/lib/orders";\n\nexport async function action(request: { total: number }) {\n  const service = new OrderService("web");\n  return service.place(request.total);\n}\n\nexport async function loader(request: { id: string }) {\n  return findOrder(request.id);\n}\n\nexport default function Checkout() {\n  return null;\n}\n');
      writeFileSync(join(dir, "src/db/audit.ts"), 'import { log } from "../lib/log.ts";\n\nexport function audit(what: string): void {\n  log(`audit ${what}`);\n}\n');
    },
    async (origin) => {
      type BoardAnswer = { board: { base: string; files: number; groups: { id: string; key: string; label: string; modules: { id: string; mark: string; entry: boolean; rank: number | null }[]; functions: { added: number }; imports: { added: number } }[] } | null; markdown: string; change: { kind: string } | null; diagram: { title: string; nodes: { id: string; diff?: string; group?: string }[]; edges: { from: string; to: string; kind: string; diff?: string; label?: string }[] } };
      const board = (await (await fetch(`${origin}/api/diagram?view=changes`)).json()) as BoardAnswer;
      // Both are where execution starts as far as the code says (a route, an export nothing calls): the upper layer is read first.
      assert.deepEqual(board.board?.groups.map((group) => `${group.key} ${group.label}`), ["changes:routes:src/routes routes · src/routes/", "changes:db:src/db db · src/db/"]);
      assert.deepEqual(board.board?.groups.map((group) => group.modules), [[{ id: "src/routes/checkout.tsx", mark: "changed", functions: { added: 1, removed: 0, changed: 0 }, entry: true, rank: 0 }], [{ id: "src/db/audit.ts", mark: "added", functions: { added: 1, removed: 0, changed: 0 }, entry: true, rank: 0 }]]);
      assert.match(board.board!.base, /^the last commit \([0-9a-f]{7}\)$/);
      assert.equal(board.board!.files, 2);
      assert.equal(board.diagram.title, "Uncommitted changes: 2 modules in 2 groups");
      assert.equal(board.change?.kind, "review");
      // The new import goes against the layers (db → lib): the board's page says so first, as a review does.
      assert.ok(board.markdown.includes("## ⚠ New dependencies between layers\n\n- **db → lib**\n"), board.markdown);
      assert.ok(board.diagram.edges.some((edge) => edge.from === "src/db/audit.ts" && edge.to === "src/lib/log.ts" && edge.diff === "added"));
      // A group's own picture: the loader the change added, its call into the library landing on that module, and the diff as text.
      const group = (await (await fetch(`${origin}/api/scene?view=${encodeURIComponent("changes:routes:src/routes")}`)).json()) as BoardAnswer;
      assert.equal(group.diagram.title, "Changes in routes · src/routes/ — step 1 of 2");
      assert.deepEqual(group.diagram.nodes.filter((node) => node.diff).map((node) => `${node.id} ${node.diff}`), ["src/routes/checkout.tsx changed", "src/routes/checkout.tsx#loader added"]);
      assert.ok(group.diagram.edges.some((edge) => edge.from === "src/routes/checkout.tsx#loader" && edge.to === "src/lib/orders.ts" && edge.kind === "call" && edge.diff === "added" && edge.label === "findOrder()"), JSON.stringify(group.diagram.edges));
      assert.ok(group.markdown.includes("## The diff\n\n### src/routes/checkout.tsx\n\n````diff\n") && group.markdown.includes("\n+export async function loader(request: { id: string }) {"), group.markdown);
      assert.equal(group.board?.groups.length, 2);
      // A module's page on the board says what the change did to it.
      const shape = (await (await fetch(`${origin}/api/shape?view=changes&id=${encodeURIComponent("src/routes/checkout.tsx")}`)).json()) as { markdown: string };
      assert.ok(shape.markdown.includes("## In this change\n\n- added fn `loader`"), shape.markdown);
      // Outside git there is no last commit: the picture is refused with git's words.
      const outside = await fetch(`${base}/api/scene?view=changes`);
      assert.equal(outside.status, 400);
      assert.ok(((await outside.json()) as { error: string }).error.includes("not a git repository"));
    },
  ));

/** A branch `feature` off main in `dir`, by two authors: a module added, then changed twice together with the log, then the store reading the log. */
function commitHistory(dir: string): void {
  const git = (author: string, ...args: string[]): void => {
    const result = spawnSync("git", ["-C", dir, "-c", `user.email=${author.toLowerCase()}@example.com`, "-c", `user.name=${author}`, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const commit = (author: string, subject: string, files: Record<string, string>): void => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    git(author, "add", ".");
    git(author, "commit", "-q", "-m", subject);
  };
  const log = (how: string): string => `import { step1 } from "./step1.ts";\n\nexport function log(message: string): void {\n  console.${how}(message, step1());\n}\n`;
  const step1 = (value: number): string => `export function step1(): number {\n  return ${value};\n}\n`;
  git("Ann", "init", "-q", "-b", "main");
  git("Ann", "add", ".");
  git("Ann", "commit", "-q", "-m", "base");
  git("Ann", "checkout", "-q", "-b", "feature");
  commit("Ann", "step 1: a module", { "src/lib/step1.ts": step1(1) });
  commit("Bob", "step 2: the log counts", { "src/lib/log.ts": log("log"), "src/lib/step1.ts": step1(11) });
  commit("Bob", "step 3: louder", { "src/lib/log.ts": log("error"), "src/lib/step1.ts": step1(111) });
  commit("Ann", "step 4: the store logs", { "src/db/store.ts": 'import { log } from "../lib/log.ts";\nimport type { Order } from "../lib/orders.ts";\n\nconst rows = new Map<string, Order>();\n\nexport function saveOrder(order: Order): void {\n  log("save");\n  rows.set(order.id, order);\n}\n\nexport function readOrder(id: string): Order | null {\n  return rows.get(id) ?? null;\n}\n' });
}

test("the timeline at a commit through the API: the map of the code then, a module's page and file as the commit has them, the page of a line of two files changed together", () =>
  withOwnServer("archdiff-slider-api-", commitHistory, async (origin, dir) => {
    const shas = spawnSync("git", ["-C", dir, "log", "--reverse", "--format=%H", "main..feature"], { encoding: "utf8" }).stdout.trim().split("\n");
    type Scene = { diagram: { title: string; reason: string; nodes: { id: string; diff?: string; label: string }[]; edges: { from: string; to: string; kind: string }[]; stamp?: { commit: string } }; markdown: string; change: { kind: string } | null; drawn: boolean; error?: string };
    const scene = async (query: string): Promise<Scene> => (await (await fetch(`${origin}/api/scene?${query}`)).json()) as Scene;
    const third = await scene(`view=timeline&at=${shas[2]}&overlay=churn,coupling`);
    assert.match(third.diagram.title, /step 3: louder — commit 3 of 4$/);
    assert.equal(third.diagram.stamp?.commit, shas[2]!.slice(0, 7));
    assert.equal(third.change?.kind, "review");
    assert.ok(third.markdown.startsWith(`<!-- archdiff:generated — commit ${shas[2]!.slice(0, 7)} -->`), third.markdown.slice(0, 80));
    assert.deepEqual(third.diagram.nodes.filter((node) => node.diff).map((node) => node.id), ["src/lib/log.ts", "src/lib/step1.ts"]);
    assert.ok(third.diagram.edges.some((edge) => edge.kind === "cochange" && edge.from === "src/lib/log.ts" && edge.to === "src/lib/step1.ts"));
    // A module's page says what the commit did to it, and reads the module as the commit has it.
    const logAt = (await (await fetch(`${origin}/api/shape?view=timeline&at=${shas[2]}&id=${encodeURIComponent("src/lib/log.ts")}`)).json()) as { markdown: string };
    assert.ok(logAt.markdown.includes("## In this change\n\n- changed fn `log` — src/lib/log.ts:3 (body)"), logAt.markdown);
    const storeAt = (await (await fetch(`${origin}/api/shape?view=timeline&at=${shas[2]}&id=${encodeURIComponent("src/db/store.ts")}`)).json()) as { markdown: string };
    assert.ok(!storeAt.markdown.includes("src/lib/log.ts"), storeAt.markdown);
    // The line of the two files changed together has a page of its own.
    const line = (await (await fetch(`${origin}/api/line?view=timeline&at=${shas[2]}&overlay=coupling&from=${encodeURIComponent("src/lib/log.ts")}&to=${encodeURIComponent("src/lib/step1.ts")}&kind=cochange`)).json()) as { markdown: string };
    assert.equal(line.markdown, "# src/lib/log.ts ⇄ src/lib/step1.ts\n\nsrc/lib/log.ts and src/lib/step1.ts changed together in 2 commits of the range the picture reads (the coupling overlay).\n\nAn import joins them: the code says they belong together.\n");
    // A commit git does not know is the request's problem; the whole range is still the bars.
    const unknown = await fetch(`${origin}/api/scene?view=timeline&at=nope`);
    assert.equal(unknown.status, 400);
    assert.ok(((await unknown.json()) as { error: string }).error.includes('no commit "nope"'));
    assert.match((await scene("view=timeline")).diagram.title, /: 4 commits$/);
  }));

test("the guided tours through the API: saved whole, listed, read, removed; what is no tour is refused; the directory archdiff.json names", () =>
  withOwnServer(
    "archdiff-tours-api-",
    (dir) => {
      const config = JSON.parse(readFileSync(join(dir, "archdiff.json"), "utf8")) as Record<string, unknown>;
      writeFileSync(join(dir, "archdiff.json"), JSON.stringify({ ...config, tours: "docs/tours" }));
    },
    async (origin, dir) => {
      const post = (path: string, body: unknown): Promise<Response> => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.deepEqual(await (await fetch(`${origin}/api/tours`)).json(), { directory: "docs/tours", tours: [] });
      // A tour is saved whole: its title and steps; a step's link loses the tour's own parameters and its `#`.
      const steps = [
        { link: "#view=layers&tour=intro&step=1", select: ["lib"], note: "The **layers**." },
        { link: "view=module%3Asrc%2Flib%2Forders.ts&overlay=storages", note: "The orders." },
      ];
      const saved = (await (await post("/api/tour?name=intro", { title: "How an order is placed", steps })).json()) as { saved: string; tour: { name: string; title: string; steps: unknown[] } };
      assert.equal(saved.saved, "docs/tours/intro.json");
      assert.deepEqual(saved.tour.steps, [
        { link: "view=layers", select: ["lib"], note: "The **layers**." },
        { link: "view=module%3Asrc%2Flib%2Forders.ts&overlay=storages", select: [], note: "The orders." },
      ]);
      const onDisk = JSON.parse(readFileSync(join(dir, "docs/tours/intro.json"), "utf8")) as { format: number; name: string; title: string; steps: unknown[] };
      assert.deepEqual([onDisk.format, onDisk.name, onDisk.title, onDisk.steps.length], [1, "intro", "How an order is placed", 2]);
      assert.deepEqual(await (await fetch(`${origin}/api/tours`)).json(), { directory: "docs/tours", tours: [{ name: "intro", title: "How an order is placed", steps: 2 }] });
      assert.equal(((await (await fetch(`${origin}/api/tour?name=intro`)).json()) as { title: string }).title, "How an order is placed");
      // What is no tour is refused, each with its reason, and nothing is written.
      const refused = async (path: string, body: unknown): Promise<string> => {
        const response = await post(path, body);
        assert.equal(response.status, 400, path);

        return ((await response.json()) as { error: string }).error;
      };
      assert.ok((await refused("/api/tour?name=..%2Fescape", { steps: [] })).includes("is no name of a tour"));
      assert.equal(await refused("/api/tour?name=bad", { steps: [{ link: "view=nope" }] }), "tour: the link of step 1 names no view (view=<key>)");
      assert.equal(await refused("/api/tour?name=bad", { steps: [{ link: "view=layers", select: "lib" }] }), 'tour: "select" of step 1 must be a list of shape IDs');
      assert.ok(!existsSync(join(dir, "docs/tours/bad.json")) && !existsSync(join(dir, "docs/escape.json")));
      assert.equal((await fetch(`${origin}/api/tour?name=bad`)).status, 404);
      // A file written by hand that does not read as a tour says what is wrong in it, and is not listed.
      writeFileSync(join(dir, "docs/tours/broken.json"), JSON.stringify({ format: 1, steps: [{ link: "view=layers" }, { note: "no link" }] }));
      const broken = await fetch(`${origin}/api/tour?name=broken`);
      assert.equal(broken.status, 400);
      assert.equal(((await broken.json()) as { error: string }).error, 'docs/tours/broken.json does not read as a tour: step 2 needs a "link" (a view\'s link with its options)');
      assert.equal(((await (await fetch(`${origin}/api/tours`)).json()) as { tours: unknown[] }).tours.length, 1);
      // Removed: its file goes; a second time there is none.
      assert.deepEqual(await (await post("/api/tour/delete?name=intro", {})).json(), { removed: "intro" });
      assert.ok(!existsSync(join(dir, "docs/tours/intro.json")));
      assert.equal((await post("/api/tour/delete?name=intro", {})).status, 404);
    },
  ));

test("chat tags are suggested and expanded into context; mocks come from the types when the agent gives no JSON", async () => {
  const tags = await getJson<{ tags: { tag: string; title: string }[] }>("/api/tags?q=orders");
  assert.ok(tags.tags.some((tag) => tag.tag === "@module:src/lib/orders.ts"), JSON.stringify(tags.tags.slice(0, 5)));
  assert.ok(tags.tags.some((tag) => tag.tag === "@fn:src/lib/orders.ts#placeOrder"));
  assert.ok(tags.tags.some((tag) => tag.tag === "@type:src/lib/orders.ts#Order"));
  const expanded = await fetch(`${base}/api/expand`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Refactor @fn:src/lib/orders.ts#placeOrder and keep @layer:db small (see @layer:db)." }) });
  const context = ((await expanded.json()) as { context: string }).context;
  assert.ok(context.startsWith("## Context from the diagrams"), context.slice(0, 80));
  assert.ok(context.includes("### @fn:src/lib/orders.ts#placeOrder") && context.includes("## Calls"), context);
  // The punctuation after a tag is the sentence's: the heading is the tag, and a tag written twice is one section.
  assert.ok(context.includes("### @layer:db\n") && !context.includes("### @layer:db)") && context.split("### @layer:db").length === 2 && context.includes("src/db/store.ts"), context);
  // The fake agent answers "Done.", no JSON: the mocks fall back to the types of the signature.
  const mocks = await fetch(`${base}/api/flow/mocks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "calls:src/lib/orders.ts#placeOrder", description: "an order of 42" }) });
  const body = (await mocks.json()) as { source: string; input: Record<string, unknown>; storages: Record<string, unknown> };
  assert.equal(body.source, "types");
  assert.deepEqual(body.input, { id: "id-1", total: 1 });
  assert.deepEqual(Object.keys(body.storages), ["src/db/store.ts"]);
  // The prompt went to the agent (whose answer held no JSON): it is kept with the other tasks.
  const { tasks } = await getJson<{ tasks: { file: string; head: string }[] }>("/api/tasks");
  assert.ok(tasks.some((task) => task.file.startsWith(".archdiff/tasks/calls_src_lib_orders.ts_placeOrder-")), JSON.stringify(tasks.map((task) => task.file)));
});

test("the server stops on a signal though a page holds its live-reload stream open", async () => {
  const { server, origin } = startWeb(fixture);
  const stream = await fetch(`${await origin}/api/changes`);
  assert.equal(stream.status, 200);
  // A page left open keeps this stream (and reconnects to whatever server takes the port): it must not keep the server alive.
  const exited = new Promise<number | null>((resolve) => server.once("exit", (code) => resolve(code)));
  server.kill("SIGTERM");
  const code = await Promise.race([exited, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5000))]);
  assert.notEqual(code, "hung", "the server did not stop within 5 s");
  await stream.body?.cancel().catch(() => {});
});

test("web without --port takes the next free port when 7080 is taken, and a named port that is taken is an error", async () => {
  // A blocker on 7080 (or whatever is free from there: the test only needs two servers in a row to pick different ports).
  const first = spawn(process.execPath, [join(import.meta.dirname, "..", "bin", "archdiff.js"), "web", fixture, "--no-watch"], { stdio: ["ignore", "pipe", "pipe"] });
  const firstUrl = await new Promise<string>((resolve, reject) => {
    let text = "";
    first.stderr!.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const match = text.match(/archdiff web: (http:\/\/[^/]+)\//);

      if (match) resolve(match[1]!);
    });
    first.once("exit", (code) => reject(new Error(`exited ${code}: ${text}`)));
  });

  try {
    const second = spawn(process.execPath, [join(import.meta.dirname, "..", "bin", "archdiff.js"), "web", fixture, "--no-watch"], { stdio: ["ignore", "pipe", "pipe"] });
    const secondText = await new Promise<string>((resolve, reject) => {
      let text = "";
      second.stderr!.on("data", (chunk: Buffer) => {
        text += chunk.toString();

        if (/archdiff web: http/.test(text)) resolve(text);
      });
      second.once("exit", (code) => reject(new Error(`exited ${code}: ${text}`)));
    });
    const secondUrl = secondText.match(/archdiff web: (http:\/\/[^/]+)\//)![1]!;
    assert.notEqual(secondUrl, firstUrl);
    assert.ok(secondText.includes("was taken"), secondText);
    second.kill();
    // The named port of the first server is taken: a plain error, exit 2.
    const port = Number(new URL(firstUrl).port);
    const third = spawn(process.execPath, [join(import.meta.dirname, "..", "bin", "archdiff.js"), "web", fixture, "--no-watch", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    const [code, thirdText] = await new Promise<[number | null, string]>((resolve) => {
      let text = "";
      third.stderr!.on("data", (chunk: Buffer) => (text += chunk.toString()));
      third.once("exit", (exitCode) => resolve([exitCode, text]));
    });
    assert.equal(code, 2, thirdText);
    assert.ok(thirdText.includes("EADDRINUSE"), thirdText);
  } finally {
    first.kill();
  }
});

test("code this folds the drawing into the contract and writes the task; the intent and check routes follow", async () => {
  // No contract yet: check says so, the intent view explains.
  const before = await getJson<{ exists: boolean; ok: boolean }>("/api/check");
  assert.equal(before.exists, false);
  // A drawing on layer:lib with a new module and an arrow to it, saved, then "code this".
  const scene = await getJson<{ elements: { id: string; x: number; y: number; width: number; height: number; customData?: Record<string, unknown> }[] }>(`/api/scene?view=${encodeURIComponent("layer:lib")}`);
  const orders = scene.elements.find((element) => element.id === "src/lib/orders.ts")!;
  const lane = scene.elements.find((element) => element.id === "lane:lib")!;
  const drawn = [
    ...scene.elements,
    { id: "drawn-1", type: "rectangle", x: lane.x + 20, y: lane.y + lane.height - 70, width: 170, height: 50, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: [{ id: "drawn-1-text", type: "text" }], updated: 1, link: null, locked: false },
    { id: "drawn-1-text", type: "text", x: lane.x + 30, y: lane.y + lane.height - 55, width: 150, height: 20, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 2, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, text: "src/lib/vouchers.ts", originalText: "src/lib/vouchers.ts", fontSize: 14, fontFamily: 1, textAlign: "left", verticalAlign: "top", containerId: "drawn-1", lineHeight: 1.25, baseline: 14 },
    { id: "drawn-arrow", type: "arrow", x: orders.x + orders.width, y: orders.y + orders.height / 2, width: 10, height: 10, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 3, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, points: [[0, 0], [lane.x + 100 - (orders.x + orders.width), lane.y + lane.height - 45 - (orders.y + orders.height / 2)]], lastCommittedPoint: null, startBinding: { elementId: "src/lib/orders.ts", focus: 0, gap: 1 }, endBinding: { elementId: "drawn-1", focus: 0, gap: 1 }, startArrowhead: null, endArrowhead: "arrow" },
  ];
  const saved = await fetch(`${base}/api/drawing?view=${encodeURIComponent("layer:lib")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: 1, view: "layer:lib", elements: drawn, mocks: [] }) });
  assert.equal(saved.status, 200, await saved.text());
  const coded = await (await fetch(`${base}/api/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "layer:lib" }) })).json() as { markdown: string; intent: string; planned: number };
  assert.ok(coded.markdown.includes("A new module `src/lib/vouchers.ts` in layer **lib**"), coded.markdown);
  assert.ok(coded.intent.includes("src/lib/vouchers.ts") && coded.intent.includes("n_src_lib_orders_ts --> n_src_lib_vouchers_ts"), coded.intent);
  assert.ok(coded.planned >= 2, `${coded.planned}\n${coded.markdown}\n${coded.intent}`);
  const intent = await getJson<{ exists: boolean; markdown: string }>("/api/intent");
  assert.ok(intent.exists && intent.markdown.includes("subgraph n_lib"), intent.markdown);
  const after = await getJson<{ exists: boolean; ok: boolean; markdown: string }>("/api/check");
  assert.ok(after.exists && after.ok && after.markdown.includes("- `src/lib/vouchers.ts`"), after.markdown);
  // The intent view draws the planned module dashed beside the built ones.
  const view = await getJson<{ diagram: { nodes: { id: string; diff?: string }[] } }>("/api/scene?view=intent");
  assert.equal(view.diagram.nodes.find((node) => node.id === "src/lib/vouchers.ts")?.diff, "planned");
  assert.equal(view.diagram.nodes.find((node) => node.id === "src/lib/orders.ts")?.diff, undefined);
  // A document with a flowchart replaces the intent without the agent; the rules say what was read.
  const fromDocument = await (await fetch(`${base}/api/intent/document`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "# Note\n\n```mermaid\nflowchart LR\n  subgraph lib\n    A[src/lib/orders.ts]\n    B[src/lib/tax.ts]\n  end\n  A --> B\n```\n" }) })).json() as { source: string; modules: number };
  assert.equal(fromDocument.source, "document");
  assert.equal(fromDocument.modules, 2);
});

test("a document with a flowchart becomes the contract without an agent; one in prose needs an agent", () =>
  withOwnServer(
    "archdiff-no-agent-",
    () => {},
    async (origin, dir) => {
      const post = (text: string): Promise<Response> => fetch(`${origin}/api/intent/document`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const kept = await post("# Note\n\n```mermaid\nflowchart LR\n  subgraph lib\n    A[src/lib/orders.ts]\n  end\n```\n");
      const body = (await kept.json()) as { source: string; modules: number; error?: string };
      assert.equal(kept.status, 200, body.error);
      assert.equal(body.source, "document");
      assert.equal(body.modules, 1);
      assert.ok(readFileSync(join(dir, "ARCHITECTURE.md"), "utf8").includes("src/lib/orders.ts"));
      const prose = await post("Orders go through the lib layer to the store.");
      assert.equal(prose.status, 400);
      assert.match(((await prose.json()) as { error: string }).error, /^no agent: the document holds no Mermaid flowchart/);
    },
  ));

test("after a run the contract and the configured checks run, their results in the run's events; /api/checks runs them on request", () =>
  // A server of its own on a copy of the fixture with checks: one that passes, one that fails with output.
  withOwnServer(
    "archdiff-checks-",
    (checked) => {
      writeFileSync(join(checked, "archdiff.json"), JSON.stringify({ layers: { routes: ["src/routes/**"], lib: ["src/lib/**"], db: ["src/db/**"], cartridge: ["cartridges/**"] }, agent: { name: "fake", command: [process.execPath, join(root, "tests/fixtures/fake-agent.mjs")], resume: "--resume" }, checks: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`, `${JSON.stringify(process.execPath)} -e "process.stderr.write('boom'); process.exit(3)"`] }));
      writeFileSync(join(checked, "ARCHITECTURE.md"), "# Architecture\n\n```mermaid\nflowchart LR\n  subgraph lib\n    o[src/lib/orders.ts]\n  end\n  subgraph db\n    s[src/db/store.ts]\n  end\n  o --> s\n```\n");
    },
    async (origin) => {
      const started = await fetch(`${origin}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "layers", prompt: "do nothing", resume: null }) });
      const run = JSON.parse(await started.text()) as { id: string };
      const events = (await (await fetch(`${origin}/api/agent/events?id=${run.id}`)).text()).split("\n\n").filter((chunk) => chunk.startsWith("data: ")).map((chunk) => JSON.parse(chunk.slice(6)) as { kind: string; text: string });
      const checks = events.filter((event) => event.kind === "check").map((event) => event.text);
      assert.equal(checks.length, 3, JSON.stringify(events));
      assert.equal(checks[0], "✔ archdiff check: the code follows ARCHITECTURE.md");
      assert.ok(checks[1]!.startsWith("✔ ") && checks[1]!.includes("process.exit(0)"), checks[1]);
      assert.ok(checks[2]!.startsWith("✘ ") && checks[2]!.includes("(exit 3)") && checks[2]!.endsWith("\nboom"), checks[2]);
      assert.equal(events[events.length - 1]?.kind, "exit");
      // On request, without a run.
      const onRequest = (await (await fetch(`${origin}/api/checks`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { results: { command: string; ok: boolean; code?: number | null }[] };
      assert.deepEqual(onRequest.results.map((result) => [result.ok, result.code ?? null]), [[true, null], [true, 0], [false, 3]]);
    },
  ));

test("Claude Code with checks still gets its task: the allowed tools end before the prompt", async () => {
  // A `claude` on the test PATH that is the fake agent — a shell script, or on Windows the shim npm would write —
  // reading its arguments as Claude Code does: `--allowedTools` takes everything up to `--`, and a prompt swallowed
  // by it ends the run with an error and no text.
  const wrapper = fakeCommand(TEST_BIN, "claude", join(root, "tests/fixtures/fake-agent.mjs"));

  try {
    await withOwnServer(
      "archdiff-allowed-tools-",
      (own) => writeFileSync(join(own, "archdiff.json"), JSON.stringify({ checks: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`] })),
      async (origin, own) => {
        const started = await fetch(`${origin}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "layers", prompt: `add a module. write-file: ${join(own, "src/lib/planned.ts")}`, resume: null, agent: "claude" }) });
        const body = await started.text();
        assert.equal(started.status, 200, body);
        const run = JSON.parse(body) as { id: string; agent: string };
        assert.equal(run.agent, "claude");
        const events = await eventsOf(origin, run.id);
        assert.ok(events.some((event) => event.kind === "text" && event.text.startsWith("Reading the task")), JSON.stringify(events));
        assert.ok(existsSync(join(own, "src/lib/planned.ts")), "the agent wrote the file the task names");
        assert.ok(events.some((event) => event.kind === "check" && event.text.startsWith("✔ ")), JSON.stringify(events));
      },
    );
  } finally {
    for (const left of [wrapper, `${wrapper}.cmd`, join(TEST_BIN, "node_modules")]) rmSync(left, { recursive: true, force: true });
  }
});

test("Cursor's stream-json (chat_id, --resume) is read like Claude's: the question protocol and the resumed answer work", () =>
  withOwnServer(
    "archdiff-cursor-",
    (cursored) => writeFileSync(join(cursored, "archdiff.json"), JSON.stringify({ agent: { name: "cursor-fake", command: [process.execPath, join(root, "tests/fixtures/fake-cursor.mjs")], resume: "--resume" } })),
    async (origin) => {
      const started = JSON.parse(await (await fetch(`${origin}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "layers", prompt: "pick a store; ask the user", resume: null }) })).text()) as { id: string; agent: string };
      assert.equal(started.agent, "cursor-fake");
      const events = (await (await fetch(`${origin}/api/agent/events?id=${started.id}`)).text()).split("\n\n").filter((chunk) => chunk.startsWith("data: ")).map((chunk) => JSON.parse(chunk.slice(6)) as { kind: string; text: string; sessionId?: string });
      assert.equal(events[0]?.sessionId, "chat-7");
      assert.ok(events.some((event) => event.kind === "text" && event.text.includes("```archdiff-question")), JSON.stringify(events));
      const answered = JSON.parse(await (await fetch(`${origin}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "layers", prompt: "SQLite", resume: "chat-7" }) })).text()) as { id: string };
      const more = await (await fetch(`${origin}/api/agent/events?id=${answered.id}`)).text();
      assert.ok(more.includes("Cursor resumed: SQLite"), more);
    },
  ));

/** The events of a run, read to its end. */
async function eventsOf(origin: string, id: string): Promise<{ kind: string; text: string; sessionId?: string; files?: string[] }[]> {
  return (await (await fetch(`${origin}/api/agent/events?id=${id}`)).text()).split("\n\n").filter((chunk) => chunk.startsWith("data: ")).map((chunk) => JSON.parse(chunk.slice(6)) as { kind: string; text: string; sessionId?: string; files?: string[] });
}

test("Codex's and OpenCode's events read as Claude's: the session, the text, the files a tool wrote, the answer; a follow-up resumes", async () => {
  for (const [name, script, protocol, resume, session, resumed] of [
    ["codex-fake", "fake-codex.mjs", "codex", "resume", "0199aaaa-fake-thread-0001", "Resumed 0199aaaa-fake-thread-0001."],
    ["opencode-fake", "fake-opencode.mjs", "opencode", "--session", "ses_fake0001", "continued ses_fake0001"],
  ] as const) {
    await withOwnServer(
      `archdiff-${protocol}-`,
      (own) => writeFileSync(join(own, "archdiff.json"), JSON.stringify({ agent: { name, command: [process.execPath, join(root, "tests/fixtures", script)], resume, protocol } })),
      async (origin, own) => {
        // The configured agent is offered beside the built-in ones, installed, and picked first.
        const offered = (await (await fetch(`${origin}/api/agents`)).json()) as { agents: { name: string; label: string; installed: boolean }[]; default: string | null };
        assert.deepEqual(offered.agents.map((agent) => agent.name), ["claude", "cursor", "codex", "opencode", name]);
        assert.equal(offered.default, name);
        assert.ok(offered.agents.find((agent) => agent.name === name)?.installed);
        const run = async (body: Record<string, unknown>): Promise<{ id: string; agent: string }> => (await (await fetch(`${origin}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "layers", ...body }) })).json()) as { id: string; agent: string };
        const first = await run({ agent: name, prompt: "write-file: src/lib/refunds.ts" });
        assert.equal(first.agent, name);
        const events = await eventsOf(origin, first.id);
        assert.equal(events.find((event) => event.kind === "init")?.sessionId, session, protocol);
        assert.ok(events.some((event) => event.kind === "tool" && event.files?.includes(join(own, "src/lib/refunds.ts"))), JSON.stringify(events));
        assert.equal(events.find((event) => event.kind === "result")?.text, "done", JSON.stringify(events));
        assert.ok(existsSync(join(own, "src/lib/refunds.ts")));
        // The follow-up names the session: the agent goes on with it.
        const second = await run({ agent: name, prompt: "and a test", resume: session });
        assert.ok((await eventsOf(origin, second.id)).some((event) => event.text === resumed), protocol);
        // An agent the server does not know is refused by name.
        const unknown = await fetch(`${origin}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "layers", prompt: "x", agent: "nope" }) });
        assert.equal(unknown.status, 400);
        assert.match(((await unknown.json()) as { error: string }).error, /^no agent "nope" \(claude, cursor, codex, opencode, /);
      },
    );
  }
});

test("a POST from a page of another site is refused: its origin is not this server's", async () => {
  const post = (origin: string | null): Promise<Response> => fetch(`${base}/api/drawing?view=layers`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ elements: [], mocks: [] }) });
  const foreign = await post("http://evil.example");
  assert.equal(foreign.status, 403);
  assert.equal(((await foreign.json()) as { error: string }).error, "a request from another site");
  assert.equal((await post("null")).status, 403);
  assert.equal((await post(base)).status, 200);
  // A tool without a browser sends no origin: it is no page of another site.
  assert.equal((await post(null)).status, 200);
});

test("the Flow tab's run: POST /api/flow/run executes the entry with the saved mocks and reports the steps against the prediction", async () => {
  const view = "calls:src/lib/orders.ts#placeOrder";
  await fetch(`${base}/api/drawing?view=${encodeURIComponent(view)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ elements: [], mocks: [{ id: "src/lib/orders.ts#placeOrder", kind: "input", value: '{"id": "web-1", "total": 7}' }] }) });
  const answer = await fetch(`${base}/api/flow/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view }) });
  assert.equal(answer.status, 200);
  const { run, markdown } = (await answer.json()) as { run: { steps: { id: string }[]; result: { id: string; total: number }; missed: string[] }; markdown: string };
  assert.deepEqual(run.steps.map((step) => step.id), ["src/lib/orders.ts#placeOrder", "src/lib/orders.ts#validate", "src/db/store.ts#saveOrder", "src/lib/log.ts#log"]);
  assert.deepEqual(run.result, { id: "web-1", total: 7 });
  assert.deepEqual(run.missed, []);
  assert.ok(markdown.startsWith("<!-- archdiff:generated — run "), markdown);
  assert.equal((await fetch(`${base}/api/flow/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "layers" }) })).status, 400);
  // An entry that cannot run is refused before anything runs: a method, an unknown function.
  const refused = await fetch(`${base}/api/flow/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "calls:src/lib/orders.ts#OrderService.place" }) });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /^a method cannot be run on its own/);
});

test("the project map lists every module with its layer and every import; a tag of a view or of a function's logic expands into context", async () => {
  const map = await getJson<{ layers: string[]; nodes: { id: string; layer: string; lines: number }[]; edges: { from: string; to: string; count: number }[]; directoryDepth: number | null }>("/api/graph");
  assert.equal(map.directoryDepth, null);
  assert.deepEqual(map.layers, ["cartridge", "db", "lib", "routes"]);
  assert.ok(map.nodes.some((node) => node.id === "src/lib/orders.ts" && node.layer === "lib" && node.lines > 0), JSON.stringify(map.nodes));
  assert.ok(map.edges.some((edge) => edge.from === "src/lib/orders.ts" && edge.to === "src/db/store.ts" && edge.count === 1), JSON.stringify(map.edges));
  const expanded = await fetch(`${base}/api/expand`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Why? @view:layer:lib and @logic:src/lib/orders.ts#validate", query: "depth=0" }) });
  const { context } = (await expanded.json()) as { context: string };
  assert.ok(context.includes("### @view:layer:lib") && context.includes("# Layer lib"), context.slice(0, 300));
  assert.ok(context.includes("### @logic:src/lib/orders.ts#validate") && context.includes("Rules: every path from the start to an exit") && context.includes("`order.total < 0: yes`"), context);
  // A shape of a logic view has a page like any other shape.
  const node = await getJson<{ markdown: string }>(`/api/shape?view=${encodeURIComponent("logic:src/lib/orders.ts#validate")}&id=n1`);
  assert.ok(node.markdown.startsWith("# order.total < 0"), node.markdown.slice(0, 80));
});

test("a changed source file of any language the analysis reads reaches the page through /api/changes, and the next picture is drawn anew", async (t) => {
  // A machine whose file watchers are used up cannot follow the code: the server says why, and there is nothing more to see.
  const { watching } = await getJson<{ watching: { on: boolean; problem: string | null } }>("/api/views");

  if (watching.problem) return t.skip(`the server does not follow the code here: ${watching.problem}`);
  assert.equal(watching.on, true);
  const controller = new AbortController();
  const response = await fetch(`${base}/api/changes`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const file = join(dir, "src/lib/tool.py");
  // The picture of the lib layer, drawn (and kept) before the change.
  const shapesOfLib = async (): Promise<string[]> => (await getJson<{ diagram: { nodes: { id: string }[] } }>("/api/scene?view=layer%3Alib")).diagram.nodes.map((node) => node.id);
  assert.ok(!(await shapesOfLib()).includes("src/lib/tool.py"));

  try {
    // A Python file: the watcher once listened to TypeScript and JavaScript only.
    writeFileSync(file, "def helper():\n    return 1\n");
    let text = "";
    const deadline = Date.now() + 15_000;

    while (!text.includes("src/lib/tool.py") && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now()))]);

      if (next === null || next.done) break;
      text += decoder.decode(next.value);
    }

    assert.ok(text.includes(`data: ${JSON.stringify({ path: "src/lib/tool.py" })}`), `no change event for the Python file: ${text}`);
    // The same picture asked again is drawn from the new analysis, not the one kept before the change.
    assert.ok((await shapesOfLib()).includes("src/lib/tool.py"));
  } finally {
    controller.abort();
    rmSync(file, { force: true });
  }
});

test("archdiff web ends when it is told to stop, while it watches the files", async () => {
  // Windows ends a process outright; elsewhere the server's own handler runs, and a watcher left open kept it alive for good.
  const { server: watching, origin } = startWeb(dir, []);
  await origin;
  let timer: NodeJS.Timeout | undefined;
  const ended = await Promise.race([
    new Promise<boolean>((resolve) => {
      watching.once("exit", () => resolve(true));
      watching.kill("SIGTERM");
    }),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 15_000);
    }),
  ]);
  clearTimeout(timer);

  if (!ended) watching.kill("SIGKILL");
  assert.ok(ended, "the server was still running 15 seconds after SIGTERM");
});

test("the server says which repository it serves and what the checkout has of a change, for a host that looks for it", async () => {
  // Outside git: the folder and this archdiff's version, and no remote; a ref cannot be asked about.
  const plain = await getJson<{ name: string; root: string; version: string; remotes: unknown[] }>("/api/repository");
  assert.deepEqual(plain, { name: dir.split(/[\\/]/).pop()!, root: dir, version: (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version, remotes: [] });
  const outside = await fetch(`${base}/api/refs?ref=main`);
  assert.equal(outside.status, 400);
  assert.ok(((await outside.json()) as { error: string }).error.includes("not a git repository"));

  await withOwnServer(
    "archdiff-repository-",
    (own) => {
      const git = (...args: string[]): void => {
        const result = spawnSync("git", ["-C", own, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      };
      git("init", "-q", "-b", "main");
      git("remote", "add", "origin", "https://reader:secret@github.com/acme/shop.git");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      git("checkout", "-q", "-b", "feature");
      writeFileSync(join(own, "src/lib/log.ts"), "export function log(message: string): void {\n  console.error(message);\n}\n");
      git("commit", "-q", "-am", "loud");
      git("checkout", "-q", "main");
      // main goes on after the branch left it.
      writeFileSync(join(own, "README.md"), "# shop\n");
      git("add", ".");
      git("commit", "-q", "-m", "a readme");
    },
    async (origin, own) => {
      const commit = (ref: string): string => spawnSync("git", ["-C", own, "rev-parse", ref], { encoding: "utf8" }).stdout.trim();
      // The remote by its host and its path: the name and the password of its address are told to nobody.
      const repository = await fetch(`${origin}/api/repository`);
      const said = await repository.text();
      assert.deepEqual((JSON.parse(said) as { remotes: unknown }).remotes, [{ name: "origin", host: "github.com", path: "acme/shop" }]);
      assert.ok(!said.includes("secret") && !said.includes("reader"), said);

      // The commit each ref names, null for one git does not know here; and where the head left the base.
      const refs = (await (await fetch(`${origin}/api/refs?ref=main&ref=feature&ref=origin%2Ffeature&ref=${commit("feature").slice(0, 9)}&base=main&head=feature`)).json()) as { refs: { ref: string; commit: string | null }[]; fork: string | null };
      assert.deepEqual(refs.refs, [{ ref: "main", commit: commit("main") }, { ref: "feature", commit: commit("feature") }, { ref: "origin/feature", commit: null }, { ref: commit("feature").slice(0, 9), commit: commit("feature") }]);
      assert.equal(refs.fork, commit("main~1"));
      // Without the two ends nothing is said of where they part; an end git does not know parts nowhere.
      assert.deepEqual(await (await fetch(`${origin}/api/refs?base=main`)).json(), { refs: [], fork: null });
      assert.deepEqual(await (await fetch(`${origin}/api/refs?base=main&head=nope`)).json(), { refs: [], fork: null });
      // A ref git would read as an option is refused, and so are more refs than one request may ask about.
      const option = await fetch(`${origin}/api/refs?ref=--all`);
      assert.equal(option.status, 400);
      assert.equal(((await option.json()) as { error: string }).error, 'not a git ref: "--all"');
      assert.equal((await fetch(`${origin}/api/refs?${Array.from({ length: 25 }, (_unused, index) => `ref=r${index}`).join("&")}`)).status, 400);
    },
  );
});
