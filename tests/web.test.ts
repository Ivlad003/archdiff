// The web server through HTTP on a temporary copy of the fixture: the API
// of the page, the drawing saved by the editor and read back into the
// layout, and the refusals (foreign Host, a path out of dist/web).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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
