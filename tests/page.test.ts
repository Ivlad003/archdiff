// The page in a real browser (Chrome through playwright-core): the views,
// a tap on a shape showing its code, the breadcrumbs, the editor, the Chat
// tab. Skipped when no Chrome is installed (`npm run test:web`); the API
// itself is covered by web.test.ts.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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
  assert.equal(await page!.evaluate("localStorage.getItem('archdiff.defaults')"), null);
});
