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
import { startWeb, TEST_PATH, withOwnServer } from "./web-server.ts";

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
    symlinkSync(join(outside, "secret.txt"), join(dir, "notes-link.txt"));
    symlinkSync(outside, join(dir, "up"));
    assert.equal((await fetch(`${base}/api/file?path=notes-link.txt`)).status, 404);
    assert.equal((await fetch(`${base}/api/file?path=${encodeURIComponent("up/secret.txt")}`)).status, 404);
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

test("chat tags are suggested and expanded into context; mocks come from the types when the agent gives no JSON", async () => {
  const tags = await getJson<{ tags: { tag: string; title: string }[] }>("/api/tags?q=orders");
  assert.ok(tags.tags.some((tag) => tag.tag === "@module:src/lib/orders.ts"), JSON.stringify(tags.tags.slice(0, 5)));
  assert.ok(tags.tags.some((tag) => tag.tag === "@fn:src/lib/orders.ts#placeOrder"));
  assert.ok(tags.tags.some((tag) => tag.tag === "@type:src/lib/orders.ts#Order"));
  const expanded = await fetch(`${base}/api/expand`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Refactor @fn:src/lib/orders.ts#placeOrder and keep @layer:db small." }) });
  const context = ((await expanded.json()) as { context: string }).context;
  assert.ok(context.startsWith("## Context from the diagrams"), context.slice(0, 80));
  assert.ok(context.includes("### @fn:src/lib/orders.ts#placeOrder") && context.includes("## Calls"), context);
  assert.ok(context.includes("### @layer:db") && context.includes("src/db/store.ts"), context);
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
  // A `claude` on the test PATH that is the fake agent, reading its arguments as Claude Code does: `--allowedTools`
  // takes everything up to `--`, and a prompt swallowed by it ends the run with an error and no text.
  const wrapper = join(TEST_PATH, "claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "tests/fixtures/fake-agent.mjs"))} "$@"\n`, { mode: 0o755 });

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
    rmSync(wrapper, { force: true });
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
