// The web server through HTTP on a temporary copy of the fixture: the API
// of the page, the drawing saved by the editor and read back into the
// layout, and the refusals (foreign Host, a path out of dist/web).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

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
  server = spawn(process.execPath, [join(root, "bin/archdiff.js"), "web", dir, "--port", "0"], { stdio: ["ignore", "ignore", "pipe"] });
  base = await new Promise<string>((resolve, reject) => {
    let text = "";
    server!.stderr!.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const match = text.match(/archdiff web: (http:\/\/[^/]+)\//);

      if (match) resolve(match[1]!);
    });
    server!.on("exit", (code) => reject(new Error(`server exited with ${code}: ${text}`)));
    setTimeout(() => reject(new Error(`server did not start: ${text}`)), 60_000);
  });
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
function rawRequest(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
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
  const node = await getJson<{ markdown: string }>("/api/node?view=module:src/lib/orders.ts&id=src/lib/orders.ts");
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
  const saved = await fetch(`${base}/api/layout?view=${encodeURIComponent(view)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ elements: moved, mocks: [{ id: "src/db/store.ts", kind: "storage", value: '{"rows": []}' }] }) });
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
  const bad = await fetch(`${base}/api/layout?view=${encodeURIComponent(view)}`, { method: "POST", body: JSON.stringify({ elements: "no" }) });
  assert.equal(bad.status, 400);
});

test("a line's page names its ends and the imports and calls behind it", async () => {
  const edge = await getJson<{ markdown: string }>(`/api/edge?view=${encodeURIComponent("layer:lib")}&from=${encodeURIComponent("src/lib/orders.ts")}&to=${encodeURIComponent("src/db/store.ts")}&kind=dependency`);
  assert.ok(edge.markdown.startsWith("# src/lib/orders.ts → src/db/store.ts"), edge.markdown.slice(0, 80));
  assert.ok(edge.markdown.includes("- to: **src/db/store.ts** (module)"), edge.markdown);
  assert.ok(edge.markdown.includes("`src/lib/orders.ts:2` → src/db/store.ts") && edge.markdown.includes("placeOrder → src/db/store.ts#saveOrder"), edge.markdown);
  const layers = await getJson<{ markdown: string }>(`/api/edge?view=layers&from=routes&to=lib`);
  assert.ok(layers.markdown.includes("routes imports lib") && layers.markdown.includes("src/routes/checkout.tsx:1"), layers.markdown);
  assert.equal((await fetch(`${base}/api/edge?view=layers&from=lib&to=nowhere`)).status, 404);
});

test("the scene takes the options of the page: limit, overlays, the Mermaid type", async () => {
  const view = "layer:lib";
  const scene = await getJson<{ diagram: { nodes: { id: string; label: string; kind: string }[]; reason?: string }; markdown: string }>(`/api/scene?view=${encodeURIComponent(view)}&limit=1&overlay=storages&mermaid=mindmap`);
  assert.ok(scene.diagram.nodes.some((node) => node.kind === "more"), JSON.stringify(scene.diagram.nodes.map((node) => node.id)));
  assert.ok(scene.markdown.includes("mindmap"), scene.markdown.slice(0, 300));
  assert.equal((await fetch(`${base}/api/scene?view=${encodeURIComponent(view)}&overlay=nope`)).status, 400);
  const light = await getJson<{ diagram: { edges: unknown[]; reason?: string; stamp?: { commit: string } } }>(`/api/scene?view=layers&weight=9&hubs=0`);
  assert.equal(light.diagram.edges.length, 0);
  // The server runs on a scratch copy outside git here, so the stamp is absent rather than wrong.
  assert.equal(light.diagram.stamp, undefined);
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
  const saved = await fetch(`${base}/api/layout?view=${encodeURIComponent(view)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ elements: drawn, mocks: [] }) });
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
  const compare = await fetch(`${base}/api/compare?heads=a,b`);
  assert.equal(compare.status, 400);
});

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
});
