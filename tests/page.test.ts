// The page in a real browser (Chrome through playwright-core): the views,
// a tap on a shape showing its code, the breadcrumbs, the editor, the Chat
// tab. Skipped when no Chrome is installed (`npm run test:web`); the API
// itself is covered by web.test.ts.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

const root = join(import.meta.dirname, "..");

const fixture = join(root, "tests/fixtures/sample");

const CHROME = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => existsSync(path));

let dir = "";
let server: ChildProcess | null = null;
let base = "";
let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  dir = mkdtempSync(join(tmpdir(), "archdiff-page-"));
  cpSync(fixture, dir, { recursive: true });
  server = spawn(process.execPath, [join(root, "bin/archdiff.js"), "web", dir, "--port", "0", "--no-watch"], { stdio: ["ignore", "ignore", "pipe"] });
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
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  // Wide enough for Excalidraw's desktop layout in the centre column (below ~730 px it switches to its mobile UI).
  page = await browser.newPage({ viewport: { width: 1900, height: 1000 } });
  // A confirm (unsaved changes) would stop the test: answer it, and say so.
  page.on("dialog", (dialog) => {
    process.stderr.write(`dialog: ${dialog.message()}\n`);
    void dialog.accept();
  });
});

after(async () => {
  await browser?.close();
  server?.kill();

  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("the page lists the views, draws the layers and walks to a module and its code", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.goto(`${base}/#view=layers`);
  await page!.waitForSelector("#views li");
  const items = (await page!.evaluate(`[...document.querySelectorAll("#views li")].map((node) => node.textContent ?? "")`)) as string[];
  assert.ok(items.includes("lib"), items.join(", "));
  assert.ok(items.some((item) => item.startsWith("Entry points")), items.join(", "));
  // The canvas is Excalidraw: its own class names say it mounted and drew.
  await page!.waitForSelector(".excalidraw canvas");
  assert.ok((await page!.textContent("#title-text"))?.includes("Layers"));
  // The Markdown panel renders the diagram's page.
  await page!.waitForFunction(`document.querySelector("#markdown h1")?.textContent === "Layers"`);
  // Open a module view from the list and tap its shape: the code tab shows the file.
  await page!.click("#views li[title='module:src/lib/orders.ts']");
  await page!.waitForFunction(`location.hash.includes("module%3Asrc%2Flib%2Forders.ts")`);
  await page!.waitForFunction(`(document.querySelector("#crumbs")?.textContent ?? "").includes("orders.ts")`);
  assert.ok((await page!.textContent("#crumbs"))?.includes("lib"));
  // After "fit" the whole scene is centred in the canvas; the single module of a depth-0 view sits at the centre, so a tap there picks it.
  // A remembered viewport would win over the fit: forget it, as a first visit would.
  await page!.evaluate("localStorage.clear()");
  await page!.goto(`${base}/?fresh=1#view=module%3Asrc%2Flib%2Forders.ts&depth=0`);
  await page!.waitForFunction(`document.querySelector("#title-text")?.textContent === "src/lib/orders.ts"`);
  await page!.waitForTimeout(1000);
  const canvasBox = (await page!.evaluate(`document.querySelector(".excalidraw__canvas.interactive").getBoundingClientRect().toJSON()`)) as { left: number; top: number; width: number; height: number };
  assert.ok(canvasBox.width > 100);
  const centre = { x: canvasBox.left + canvasBox.width / 2, y: canvasBox.top + canvasBox.height / 2 };
  await page!.mouse.move(centre.x, centre.y);
  await page!.mouse.down();
  await page!.mouse.up();
  await page!.waitForFunction(`(document.querySelector("#code")?.textContent ?? "").includes("placeOrder")`, undefined, { timeout: 8000 });
  assert.ok((await page!.textContent("#code"))?.includes("export function placeOrder"));
});

test("the editor opens and closes, and the Chat tab reads the task from the drawing", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.goto(`${base}/#view=module%3Asrc%2Flib%2Forders.ts`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.click("#edit");
  await page!.waitForSelector("body.editing");
  // Excalidraw's full UI is up in edit mode: a tool button of its toolbar (view mode shows none).
  await page!.waitForSelector(".excalidraw [data-testid='toolbar-rectangle'], .excalidraw .ToolIcon_type_radio, .excalidraw button[title^='Rectangle']", { timeout: 10_000 });
  // Nothing was drawn: leaving asks nothing.
  let asked = false;
  page!.once("dialog", () => (asked = true));
  await page!.click("#exit");
  await page!.waitForFunction(`!document.body.classList.contains("editing")`);
  assert.equal(asked, false, "leaving an untouched editor asked to confirm");
  await page!.click("#tabs button[data-tab='chat']");
  await page!.click("#plan");
  await page!.waitForFunction(`(document.querySelector("#task")?.value ?? "").includes("# Task from the drawing")`);
  assert.ok((await page!.inputValue("#task")).includes("adds nothing to the code"));
  assert.ok((await page!.textContent("#agent-name"))?.includes("no agent"));
});

test("the options panel sets the overlays and the fold limit, writes them to the link and remembers them as defaults", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.evaluate("localStorage.clear()");
  await page!.goto(`${base}/?fresh=2#view=layer%3Alib`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.click("#options-menu summary");
  await page!.check("#options .overlay[value='storages']");
  await page!.waitForFunction(`location.hash.includes("overlay=storages")`);
  // The Markdown of the view names the overlay's finding.
  await page!.waitForFunction(`(document.querySelector("#reason")?.textContent ?? "").includes("storages")`);
  await page!.fill("#limit", "1");
  await page!.press("#limit", "Enter");
  await page!.dispatchEvent("#limit", "change");
  await page!.waitForFunction(`location.hash.includes("limit=1")`);
  await page!.waitForFunction(`(document.querySelector("#markdown")?.textContent ?? "").includes("…")`);
  // Remembered: a link without options opens with them, and the hash drops what equals the defaults.
  await page!.click("#options-default");
  await page!.goto(`${base}/?fresh=3#view=layer%3Alib`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.waitForFunction(`document.querySelector("#options .overlay[value='storages']").checked && document.querySelector("#limit").value === "1"`);
  assert.ok(!String(await page!.evaluate("location.hash")).includes("overlay="));
  // Reset: back to the built-in options, nothing remembered.
  await page!.click("#options-menu summary");
  await page!.click("#options-reset");
  await page!.waitForFunction(`document.querySelector("#limit").value === "" && !document.querySelector("#options .overlay[value='storages']").checked`);
  assert.equal(await page!.evaluate("localStorage.getItem('archdiff.defaults.v2')"), null);
});

test("a tap on a line lights it with its ends and shows where it leads", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.evaluate("localStorage.clear()");
  await page!.goto(`${base}/?fresh=4#view=layer%3Alib`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.waitForFunction(`document.querySelector("#title-text")?.textContent?.includes("lib")`);
  await page!.waitForTimeout(1200);
  // Where the page put the scene: the fit centres the bounds of every element at a zoom of at most 1 with a 32 px margin.
  const scene = (await (await fetch(`${base}/api/scene?view=${encodeURIComponent("layer:lib")}`)).json()) as { elements: { x: number; y: number; width: number; height: number; isDeleted?: boolean; points?: [number, number][]; customData?: Record<string, unknown> }[] };
  const all = scene.elements.filter((element) => !element.isDeleted);
  const minX = Math.min(...all.map((element) => element.x));
  const minY = Math.min(...all.map((element) => element.y));
  const maxX = Math.max(...all.map((element) => element.x + element.width));
  const maxY = Math.max(...all.map((element) => element.y + element.height));
  const canvasBox = (await page!.evaluate(`document.querySelector(".excalidraw__canvas.interactive").getBoundingClientRect().toJSON()`)) as { left: number; top: number; width: number; height: number };
  const zoom = Math.max(0.1, Math.min(1, (canvasBox.width - 64) / (maxX - minX), (canvasBox.height - 64) / (maxY - minY)));
  const scrollX = canvasBox.width / zoom / 2 - (minX + (maxX - minX) / 2);
  const scrollY = canvasBox.height / zoom / 2 - (minY + (maxY - minY) / 2);
  // The line orders.ts → store.ts: the middle of its longest segment is in a gap, on no shape.
  const arrow = all.find((element) => element.customData?.["archdiff"] === "edge" && element.customData["from"] === "src/lib/orders.ts" && element.customData["to"] === "src/db/store.ts")!;
  assert.ok(arrow, "no arrow orders → store in the scene");
  let longest: { x: number; y: number; length: number } | null = null;

  for (let i = 1; i < arrow.points!.length; i++) {
    const [ax, ay] = arrow.points![i - 1]!;
    const [bx, by] = arrow.points![i]!;
    const length = Math.hypot(bx - ax, by - ay);

    if (!longest || length > longest.length) longest = { x: arrow.x + (ax + bx) / 2, y: arrow.y + (ay + by) / 2, length };
  }

  const screen = { x: canvasBox.left + (longest!.x + scrollX) * zoom, y: canvasBox.top + (longest!.y + scrollY) * zoom };
  await page!.mouse.move(screen.x, screen.y);
  await page!.mouse.down();
  await page!.mouse.up();
  await page!.waitForFunction(`document.querySelector("#markdown h1")?.textContent === "src/lib/orders.ts → src/db/store.ts"`, undefined, { timeout: 8000 });
  assert.ok((await page!.textContent("#markdown"))?.includes("to: src/db/store.ts (module)"));
  // "follow" lights the chain onward from the line and lists what it reaches; store.ts imports orders.ts back, so the chain is not empty.
  await page!.click(".line-strip button:has-text('follow')");
  await page!.waitForFunction(`[...document.querySelectorAll("#markdown h2")].some((h) => h.textContent?.startsWith("Chain onward"))`, undefined, { timeout: 8000 });
  assert.ok((await page!.textContent("#markdown"))?.includes("src/db/store.ts → src/lib/orders.ts"));
  await page!.click(".line-strip button:has-text('stop following')");
  await page!.waitForFunction(`![...document.querySelectorAll("#markdown h2")].some((h) => h.textContent?.startsWith("Chain onward"))`);
});

/** Where the scene element sits on screen after the page's own fit (bounds centred, zoom at most 1, 32 px margin). */
async function screenPointOf(view: string, elementId: string, extra = ""): Promise<{ x: number; y: number }> {
  const scene = (await (await fetch(`${base}/api/scene?view=${encodeURIComponent(view)}${extra}`)).json()) as { elements: { id: string; x: number; y: number; width: number; height: number; isDeleted?: boolean }[] };
  const all = scene.elements.filter((element) => !element.isDeleted);
  const minX = Math.min(...all.map((element) => element.x));
  const minY = Math.min(...all.map((element) => element.y));
  const maxX = Math.max(...all.map((element) => element.x + element.width));
  const maxY = Math.max(...all.map((element) => element.y + element.height));
  const box = (await page!.evaluate(`document.querySelector(".excalidraw__canvas.interactive").getBoundingClientRect().toJSON()`)) as { left: number; top: number; width: number; height: number };
  const zoom = Math.max(0.1, Math.min(1, (box.width - 64) / (maxX - minX), (box.height - 64) / (maxY - minY)));
  const scrollX = box.width / zoom / 2 - (minX + (maxX - minX) / 2);
  const scrollY = box.height / zoom / 2 - (minY + (maxY - minY) / 2);
  const target = all.find((element) => element.id === elementId)!;
  assert.ok(target, `no element ${elementId}`);

  return { x: box.left + (target.x + target.width / 2 + scrollX) * zoom, y: box.top + (target.y + target.height / 2 + scrollY) * zoom };
}

test("find (/), the views filter (v), lanes, split, the chain between two shapes and the minimap", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.evaluate("localStorage.clear()");
  await page!.goto(`${base}/?fresh=7#view=layer%3Alib`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.waitForFunction(`document.querySelector("#title-text")?.textContent?.includes("lib")`);
  await page!.waitForTimeout(1000);
  // The path: a tap on orders.ts, then Shift+tap on log.ts.
  const orders = await screenPointOf("layer:lib", "src/lib/orders.ts");
  const log = await screenPointOf("layer:lib", "src/lib/log.ts");
  await page!.mouse.click(orders.x, orders.y);
  await page!.waitForFunction(`document.querySelector("#markdown h1")?.textContent === "src/lib/orders.ts"`, undefined, { timeout: 8000 });
  await page!.keyboard.down("Shift");
  await page!.mouse.click(log.x, log.y);
  await page!.keyboard.up("Shift");
  await page!.waitForFunction(`document.querySelector("#markdown h1")?.textContent === "Chain: src/lib/orders.ts → src/lib/log.ts"`, undefined, { timeout: 8000 });
  assert.ok((await page!.textContent("#markdown"))?.includes("src/lib/orders.ts → src/lib/log.ts"));
  // The keys of the fields: `/` focuses find (nothing typed into it), `v` the filter of the views; Escape leaves a field.
  await page!.keyboard.press("/");
  assert.equal(await page!.evaluate("document.activeElement?.id"), "find");
  assert.equal(await page!.inputValue("#find"), "");
  await page!.keyboard.press("Escape");
  await page!.keyboard.press("v");
  assert.equal(await page!.evaluate("document.activeElement?.id"), "search");
  await page!.keyboard.press("Escape");
  assert.notEqual(await page!.evaluate("document.activeElement?.id"), "search");
  // Find: typing counts the matches, Enter centres the first and opens it (the viewport moves: taps by position come before this).
  await page!.fill("#find", "store");
  await page!.waitForFunction(`(document.querySelector("#reason")?.textContent ?? "").includes("1 shape matches")`);
  await page!.press("#find", "Enter");
  await page!.waitForFunction(`document.querySelector("#markdown h1")?.textContent === "src/db/store.ts"`, undefined, { timeout: 8000 });
  await page!.press("#find", "Escape");
  // Lanes: unticking routes hides it through the link.
  await page!.click("#lanes-menu summary");
  const routesBox = page!.locator("#lanes label", { hasText: "routes" }).locator("input");
  await routesBox.uncheck();
  await page!.waitForFunction(`location.hash.includes("hide=routes")`);
  await page!.waitForFunction(`(document.querySelector("#reason")?.textContent ?? "").includes("lanes hidden: routes")`);
  // The minimap is on by default; the button hides it (remembered) and shows it again; then the split pane with the embedded page.
  await page!.waitForFunction(`!document.querySelector("#minimap").hidden`);
  await page!.click("#tool-minimap");
  await page!.waitForFunction(`document.querySelector("#minimap").hidden`);
  assert.equal(await page!.evaluate("localStorage.getItem('archdiff.minimap.off')"), "1");
  await page!.click("#tool-minimap");
  await page!.waitForFunction(`!document.querySelector("#minimap").hidden`);
  await page!.click("#tool-split");
  await page!.waitForFunction(`document.body.classList.contains("split") && document.querySelector("#split-frame").src.includes("embed=1")`);
  const frame = page!.frameLocator("#split-frame");
  await frame.locator(".excalidraw canvas").first().waitFor({ timeout: 15_000 });
  assert.equal(await frame.locator("#top").isVisible(), false, "the embedded page shows its header");
  await page!.click("#tool-split");
  await page!.waitForFunction(`!document.body.classList.contains("split")`);
});

test("a picked shape's neighbours are chips; the arrow keys walk them sideways, Enter goes into the shape", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.evaluate("localStorage.clear()");
  await page!.goto(`${base}/?fresh=8#view=modules`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.waitForFunction(`document.querySelector("#title-text")?.textContent?.startsWith("Modules")`);
  await page!.waitForTimeout(1000);
  const orders = await screenPointOf("modules", "src/lib/orders.ts");
  await page!.mouse.click(orders.x, orders.y);
  await page!.waitForFunction(`document.querySelector("#markdown h1")?.textContent === "src/lib/orders.ts"`, undefined, { timeout: 8000 });
  const chips = (await page!.evaluate(`[...document.querySelectorAll("#neighbours button")].map((b) => b.textContent)`)) as string[];
  assert.ok(chips.includes("→ src/db/store.ts") && chips.includes("← src/routes/checkout.tsx"), chips.join(", "));
  // → walks along an arrow to what orders.ts imports; ← back to what imports it.
  await page!.keyboard.press("ArrowRight");
  await page!.waitForFunction(`["src/db/store.ts", "src/lib/log.ts"].includes(document.querySelector("#markdown h1")?.textContent)`, undefined, { timeout: 8000 });
  await page!.keyboard.press("ArrowLeft");
  await page!.waitForFunction(`document.querySelector("#markdown h1")?.textContent === "src/lib/orders.ts"`, undefined, { timeout: 8000 });
  // A chip picks sideways; Enter goes into the picked shape's own view.
  await page!.click("#neighbours button:has-text('src/routes/checkout.tsx')");
  await page!.waitForFunction(`document.querySelector("#markdown h1")?.textContent === "src/routes/checkout.tsx"`, undefined, { timeout: 8000 });
  await page!.keyboard.press("Enter");
  await page!.waitForFunction(`location.hash.includes("inside%3Asrc%2Froutes%2Fcheckout.tsx")`);
});

test("the canvas toolbar switches the picture, sets the detail and opens a module in place with the mix tool", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.evaluate("localStorage.clear()");
  await page!.goto(`${base}/?fresh=5#view=layer%3Alib`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.waitForFunction(`document.querySelector("#picture option[value='matrix']")`);
  await page!.selectOption("#picture", "matrix");
  await page!.waitForFunction(`location.hash.includes("view=matrix")`);
  // A plain view has no siblings: the select holds the overviews only (cycles:fns among them), never a "module:matrix".
  const options = (await page!.evaluate(`[...document.querySelectorAll("#picture option")].map((o) => o.value)`)) as string[];
  assert.ok(options.every((option) => !option.startsWith("module:") && !option.startsWith("inside:")), options.join(", "));
  assert.ok(options.includes("metrics") && options.includes("cycles:fns"), options.join(", "));
  await page!.selectOption("#picture", "layers");
  await page!.waitForFunction(`location.hash === "#view=layers"`);
  await page!.click("#canvas-tools [data-detail='minimal']");
  await page!.waitForFunction(`location.hash.includes("limit=20") && location.hash.includes("weight=2") && location.hash.includes("depth=1")`);
  await page!.waitForFunction(`document.querySelector("#canvas-tools [data-detail='minimal']").classList.contains("active")`);
  await page!.click("#depth-more");
  await page!.waitForFunction(`location.hash.includes("depth=2")`);
  // The mix tool: a tap on the single module of a depth-0 module view opens it in place.
  await page!.goto(`${base}/?fresh=6#view=module%3Asrc%2Flib%2Forders.ts&depth=0`);
  await page!.waitForFunction(`document.querySelector("#title-text")?.textContent === "src/lib/orders.ts"`);
  await page!.waitForTimeout(1000);
  await page!.click("#tool-mix");
  const canvasBox = (await page!.evaluate(`document.querySelector(".excalidraw__canvas.interactive").getBoundingClientRect().toJSON()`)) as { left: number; top: number; width: number; height: number };
  await page!.mouse.move(canvasBox.left + canvasBox.width / 2, canvasBox.top + canvasBox.height / 2);
  await page!.mouse.down();
  await page!.mouse.up();
  await page!.waitForFunction(`location.hash.includes("expand=src%2Flib%2Forders.ts")`, undefined, { timeout: 8000 });
  await page!.waitForFunction(`(document.querySelector("#reason")?.textContent ?? "").includes("opened in place")`);
  await page!.click("#mix-clear");
  await page!.waitForFunction(`!location.hash.includes("expand=")`);
});

test("the agent's question shows its options; an answer resumes the session", { skip: !CHROME && "no Chrome installed" }, async () => {
  // A server of its own, on a copy with the fake agent configured (the shared one has no agent).
  const agentDir = mkdtempSync(join(tmpdir(), "archdiff-page-agent-"));
  cpSync(fixture, agentDir, { recursive: true });
  writeFileSync(join(agentDir, "archdiff.json"), JSON.stringify({ layers: { routes: ["src/routes/**"], lib: ["src/lib/**"], db: ["src/db/**"] }, agent: { name: "fake", command: [process.execPath, join(root, "tests/fixtures/fake-agent.mjs")], resume: "--resume" } }));
  const agentServer = spawn(process.execPath, [join(root, "bin/archdiff.js"), "web", agentDir, "--port", "0", "--no-watch"], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const agentBase = await new Promise<string>((resolve, reject) => {
      let text = "";
      agentServer.stderr!.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        const match = text.match(/archdiff web: (http:\/\/[^/]+)\//);

        if (match) resolve(match[1]!);
      });
      agentServer.on("exit", (code) => reject(new Error(`server exited with ${code}: ${text}`)));
    });
    await page!.goto(`${agentBase}/#view=layer%3Alib`);
    await page!.waitForSelector(".excalidraw canvas");
    await page!.click("#tabs button[data-tab='chat']");
    await page!.waitForFunction(`(document.querySelector("#agent-name")?.textContent ?? "").includes("fake")`);
    await page!.fill("#task", "Please ask the user which store to use.");
    await page!.click("#run");
    await page!.waitForFunction(`!document.querySelector("#question").hidden`, undefined, { timeout: 15_000 });
    const options = (await page!.evaluate(`[...document.querySelectorAll("#question .options button")].map((b) => b.textContent)`)) as string[];
    assert.deepEqual(options, ["in memory", "SQLite", "Postgres"]);
    await page!.click("#question .options button:has-text('SQLite')");
    await page!.waitForFunction(`document.querySelector("#question").hidden`);
    await page!.waitForFunction(`[...document.querySelectorAll("#transcript .ev")].some((row) => (row.textContent ?? "").includes("Noted: SQLite"))`, undefined, { timeout: 15_000 });
    // The transcript is compact: the steps fold under a summary, the result is the answer, rendered.
    await page!.waitForFunction(`document.querySelector("#transcript .answer")?.textContent?.includes("Done.")`, undefined, { timeout: 15_000 });
    assert.equal(await page!.evaluate("document.querySelector('#transcript details.steps').open"), false);
    assert.ok(((await page!.textContent("#transcript details.steps summary")) ?? "").includes("step"));
    // A question about the picture: a new run (the transcript starts afresh), the picture goes along as a tag, the row shows the question.
    await page!.fill("#ask", "What does this layer do?");
    await page!.press("#ask", "Enter");
    await page!.waitForFunction(`[...document.querySelectorAll("#transcript .ev.you")].some((row) => (row.textContent ?? "").includes("What does this layer do? (with the picture)"))`, undefined, { timeout: 15_000 });
    await page!.waitForFunction(`document.querySelector("#transcript .answer")?.textContent?.includes("Done.")`, undefined, { timeout: 15_000 });
    assert.equal(await page!.evaluate(`document.querySelectorAll("#transcript .ev.you").length`), 1);
  } finally {
    agentServer.kill();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("copy takes the active tab's text; the Spec tab lists the repository's specs", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page!.goto(`${base}/#view=layer%3Alib`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.waitForFunction(`document.querySelector("#markdown h1")?.textContent === "Layer lib"`);
  await page!.click("#copy");
  await page!.waitForFunction(`document.querySelector("#copy").textContent.startsWith("copied")`);
  const copied = (await page!.evaluate("navigator.clipboard.readText()")) as string;
  assert.ok(copied.startsWith("<!-- archdiff:generated — view layer:lib"), copied.slice(0, 80));
  // The Code tab copies the file, without line numbers.
  const orders = await screenPointOf("layer:lib", "src/lib/orders.ts");
  await page!.mouse.click(orders.x, orders.y);
  await page!.waitForFunction(`(document.querySelector("#code")?.textContent ?? "").includes("placeOrder")`, undefined, { timeout: 8000 });
  await page!.click("#copy");
  await page!.waitForFunction(`document.querySelector("#copy").textContent.startsWith("copied")`);
  const code = (await page!.evaluate("navigator.clipboard.readText()")) as string;
  assert.ok(code.includes("export function placeOrder") && !/^\s*1\s/.test(code), code.slice(0, 80));
  // The Spec tab: no specs in the fixture, the buttons are there.
  await page!.click("#tabs button[data-tab='spec']");
  await page!.waitForFunction(`(document.querySelector("#spec-state")?.textContent ?? "").includes("no openspec/ yet")`);
  assert.equal(await page!.isVisible("#spec-generate"), true);
});

test("Shift or Ctrl+tap selects several shapes; a right click opens the menu; the project map opens with p and a dot opens its module", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.evaluate("localStorage.clear()");
  await page!.goto(`${base}/?fresh=9#view=layer%3Alib`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.waitForFunction(`document.querySelector("#title-text")?.textContent?.includes("lib")`);
  await page!.waitForTimeout(1000);
  // The minimap is on by default.
  assert.equal(await page!.evaluate("document.querySelector('#minimap').hidden"), false);
  const orders = await screenPointOf("layer:lib", "src/lib/orders.ts");
  const log = await screenPointOf("layer:lib", "src/lib/log.ts");
  const store = await screenPointOf("layer:lib", "src/db/store.ts");
  await page!.mouse.click(orders.x, orders.y);
  await page!.waitForFunction(`document.querySelector("#markdown h1")?.textContent === "src/lib/orders.ts"`, undefined, { timeout: 8000 });
  await page!.keyboard.down("Control");
  await page!.mouse.click(log.x, log.y);
  await page!.mouse.click(store.x, store.y);
  await page!.keyboard.up("Control");
  await page!.waitForFunction(`document.querySelector("#markdown h1")?.textContent === "3 shapes selected"`, undefined, { timeout: 8000 });
  assert.deepEqual(await page!.evaluate("window.archdiff.selected()"), ["src/lib/orders.ts", "src/lib/log.ts", "src/db/store.ts"]);
  assert.ok(((await page!.textContent("#selection")) ?? "").includes("3 selected"));
  // The menu of a right click on a shape: its focus view is one line of it.
  await page!.mouse.click(orders.x, orders.y, { button: "right" });
  await page!.waitForSelector("#context-menu:not([hidden])");
  const items = (await page!.evaluate(`[...document.querySelectorAll("#context-menu li")].map((li) => li.textContent)`)) as string[];
  assert.ok(items.some((item) => item.startsWith("Focus: everything joined to it")) && items.some((item) => item.startsWith("Ask the agent about it")), items.join(" | "));
  await page!.click("#context-menu li:has-text('Focus: everything joined to it')");
  await page!.waitForFunction(`location.hash.includes("focus%3Asrc%2Flib%2Forders.ts")`);
  await page!.waitForFunction(`document.querySelector("#title-text")?.textContent?.startsWith("Everything joined to")`);
  // The project map: a dot per module; a click on one opens its view and closes the map.
  await page!.keyboard.press("p");
  await page!.waitForFunction(`!document.querySelector("#project-map").hidden`);
  await page!.waitForFunction(`window.archdiff.mapSettled()`, undefined, { timeout: 20_000 });
  const dots = (await page!.evaluate("window.archdiff.mapDots()")) as { id: string; x: number; y: number }[];
  assert.ok(dots.length >= 5, `${dots.length} dots`);
  const storeDot = dots.find((dot) => dot.id === "src/db/store.ts")!;
  await page!.mouse.click(storeDot.x, storeDot.y);
  await page!.waitForFunction(`location.hash.includes("module%3Asrc%2Fdb%2Fstore.ts")`);
  await page!.waitForFunction(`document.querySelector("#project-map").hidden`);
});
