// The page in a real browser (Chrome through playwright-core): the views,
// a tap on a shape showing its code, the breadcrumbs, the editor, the Chat
// tab. Skipped when no Chrome is installed (`npm run test:web`); the API
// itself is covered by web.test.ts.
//
// Entry point: run by `npm run test:web` (after `npm run web:build`).

import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { startWeb, withOwnServer } from "./web-server.ts";

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
  const started = startWeb(dir);
  server = started.server;
  base = await started.origin;
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

test("Alt held with the button on a shape shows its lines alone, lit, until either is released", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.goto(`${base}/#view=modules`);
  await page!.waitForFunction(`window.archdiff.drawn() === "modules"`);
  await page!.waitForTimeout(600);
  const lines = (): Promise<Record<string, { opacity: number; stroke: string }>> => page!.evaluate(`Object.fromEntries(window.archdiff.canvas().scene().filter((e) => !e.isDeleted && e.customData?.archdiff === "edge").map((e) => [e.customData.from + " -> " + e.customData.to, { opacity: e.opacity, stroke: e.strokeColor }]))`) as Promise<Record<string, { opacity: number; stroke: string }>>;
  const before = await lines();
  const title = await page!.textContent("#markdown h1");
  assert.ok(Object.keys(before).length >= 3 && Object.values(before).every((line) => line.opacity === 100), JSON.stringify(before));
  assert.ok(Object.keys(before).some((key) => !key.includes("src/db/store.ts")), "a line not touching store.ts, to go");
  const store = await screenPointOf("src/db/store.ts");
  await page!.keyboard.down("Alt");
  await page!.mouse.move(store.x, store.y);
  await page!.mouse.down();
  await page!.waitForFunction(`window.archdiff.peeked() === "src/db/store.ts"`, undefined, { timeout: 5000 });
  const during = await lines();

  // Its lines lit and whole, every other line gone.
  for (const [key, line] of Object.entries(during)) {
    if (key.includes("src/db/store.ts")) assert.deepEqual(line, { opacity: 100, stroke: "#ff6f00" }, key);
    else assert.equal(line.opacity, 0, key);
  }

  await page!.mouse.up();
  await page!.keyboard.up("Alt");
  await page!.waitForFunction(`window.archdiff.peeked() === null`, undefined, { timeout: 5000 });
  assert.deepEqual(await lines(), before);
  // A peek, not a tap: the panel still shows the picture's page, and nothing is selected.
  assert.equal(await page!.textContent("#markdown h1"), title);
  assert.deepEqual(await page!.evaluate("window.archdiff.selected()"), []);
});

test("the page lists the views, draws the layers and walks to a module and its code", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.goto(`${base}/#view=layers`);
  await page!.waitForSelector("#views li");
  const items = (await page!.evaluate(`[...document.querySelectorAll("#views li")].map((node) => node.textContent ?? "")`)) as string[];
  assert.ok(items.includes("lib"), items.join(", "));
  assert.ok(items.some((item) => item.startsWith("Entry points")), items.join(", "));
  // The canvas is Excalidraw: its own class names say it mounted and drew.
  await page!.waitForSelector(".excalidraw canvas");
  // The title comes with the picture, after the canvas mounted: waited for, not read at once.
  await page!.waitForFunction(`(document.querySelector("#title-text")?.textContent ?? "").includes("Layers")`);
  // The Markdown panel renders the diagram's page.
  await page!.waitForFunction(`document.querySelector("#markdown h1")?.textContent === "Layers"`);
  // Open a module view from the list and tap its shape: the code tab shows the file.
  await page!.click("#views li[title='module:src/lib/orders.ts']");
  await page!.waitForFunction(`location.hash.includes("module%3Asrc%2Flib%2Forders.ts")`);
  await page!.waitForFunction(`(document.querySelector("#crumbs")?.textContent ?? "").includes("orders.ts")`);
  assert.ok((await page!.textContent("#crumbs"))?.includes("lib"));
  // A first visit (nothing remembered): the single module of a depth-0 view, fitted, picked by a tap on it.
  await page!.evaluate("localStorage.clear()");
  await page!.goto(`${base}/?fresh=1#view=module%3Asrc%2Flib%2Forders.ts&depth=0`);
  await page!.waitForFunction(`window.archdiff.drawn() === "module:src/lib/orders.ts"`);
  await page!.waitForTimeout(1000);
  const module = await screenPointOf("src/lib/orders.ts");
  await page!.mouse.move(module.x, module.y);
  await page!.mouse.down();
  await page!.mouse.up();
  await page!.waitForFunction(`(document.querySelector("#code")?.textContent ?? "").includes("placeOrder")`, undefined, { timeout: 8000 });
  assert.ok((await page!.textContent("#code"))?.includes("export function placeOrder"));
});

/** Every generated line of the canvas: its look now, and the middle of its longest segment on screen (where a tap reaches it alone). */
async function linesOnScreen(): Promise<{ id: string; look: string; x: number; y: number; length: number }[]> {
  return (await page!.evaluate(`(() => {
    const canvas = window.archdiff.canvas();
    const viewport = canvas.viewport();
    const box = document.querySelector(".excalidraw__canvas.interactive").getBoundingClientRect();
    return canvas.scene().filter((element) => !element.isDeleted && element.customData?.archdiff === "edge").map((element) => {
      let best = null;
      for (let i = 1; i < element.points.length; i++) {
        const [ax, ay] = element.points[i - 1], [bx, by] = element.points[i];
        const length = Math.hypot(bx - ax, by - ay);
        if (!best || length > best.length) best = { length, x: element.x + (ax + bx) / 2, y: element.y + (ay + by) / 2 };
      }
      return { id: element.id, look: element.strokeColor + "/" + element.strokeWidth + "/" + element.opacity, x: box.left + (best.x + viewport.scrollX) * viewport.zoom, y: box.top + (best.y + viewport.scrollY) * viewport.zoom, length: best.length * viewport.zoom };
    });
  })()`)) as { id: string; look: string; x: number; y: number; length: number }[];
}

/** Where a scene point sits on screen now: through the canvas's own scroll and zoom, wherever the page placed the scene. */
async function onScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  return (await page!.evaluate(`(() => {
    const viewport = window.archdiff.canvas().viewport();
    const box = document.querySelector(".excalidraw__canvas.interactive").getBoundingClientRect();
    return { x: box.left + (${x} + viewport.scrollX) * viewport.zoom, y: box.top + (${y} + viewport.scrollY) * viewport.zoom };
  })()`)) as { x: number; y: number };
}

/** Where the middle of a shape of the picture on the canvas sits on screen now. */
async function screenPointOf(elementId: string): Promise<{ x: number; y: number }> {
  const shape = (await page!.evaluate(`window.archdiff.canvas().scene().find((element) => element.id === ${JSON.stringify(elementId)} && !element.isDeleted)`)) as { x: number; y: number; width: number; height: number } | undefined;
  assert.ok(shape, `no element ${elementId} on the canvas`);

  return onScreen(shape.x + shape.width / 2, shape.y + shape.height / 2);
}

/** The canvas against the page's own picture: how many Excalidraws are mounted, and whether the canvas shows the shapes of the picture the page holds. */
async function canvasState(): Promise<{ canvases: number; drawn: string | null; same: boolean; shapes: number }> {
  return (await page!.evaluate(`(() => {
    const handle = window.archdiff;
    const shapes = new Set((handle.canvas()?.scene() ?? []).filter((element) => element.customData?.archdiff === "node" && !element.isDeleted).map((element) => element.id));
    const nodes = [...handle.nodes().keys()];
    return { canvases: document.querySelectorAll("#canvas .excalidraw").length, drawn: handle.drawn(), same: nodes.length === shapes.size && nodes.every((id) => shapes.has(id)), shapes: shapes.size };
  })()`)) as { canvases: number; drawn: string | null; same: boolean; shapes: number };
}

test("a link that changes while the canvas mounts, and links faster than the pictures, end on the newest picture on one canvas", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.goto(`${base}/?fresh=race0#view=layers`);
  await page!.evaluate("localStorage.clear()");
  // A slow machine: mounting Excalidraw takes longer than the server takes to answer, as on a big page.
  const cdp = await page!.context().newCDPSession(page!);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 10 });
  await page!.goto(`${base}/?fresh=race#view=layers`);
  // The first picture came and is mounting the canvas (its title is up, the canvas's handle not yet): the link changes twice.
  await page!.waitForFunction(`document.querySelector("#title-text")?.textContent === "Layers" && window.archdiff.canvas() === null`, undefined, { polling: 5 });
  await page!.evaluate(`location.hash = "view=modules"; setTimeout(() => (location.hash = "view=layer%3Alib"), 30)`);
  await page!.waitForFunction(`window.archdiff.drawn() === "layer:lib"`, undefined, { timeout: 20_000 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp.detach();
  let state = await canvasState();
  assert.equal(state.canvases, 1, "a second Excalidraw was mounted into the canvas");
  assert.ok(state.same && state.shapes > 0, JSON.stringify(state));
  // A slow picture overtaken by a quick one: the quick one is drawn, and the slow one, when it comes, is dropped.
  await page!.route("**/api/scene?view=modules*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await page!.evaluate(`location.hash = "view=modules"; setTimeout(() => (location.hash = "view=module%3Asrc%2Fdb%2Fstore.ts"), 50)`);
  await page!.waitForFunction(`window.archdiff.drawn() === "module:src/db/store.ts"`, undefined, { timeout: 10_000 });
  // The slow answer comes now.
  await page!.waitForTimeout(1500);
  await page!.unroute("**/api/scene?view=modules*");
  state = await canvasState();
  assert.ok(state.same && state.canvases === 1 && state.drawn === "module:src/db/store.ts", JSON.stringify(state));
  assert.equal(await page!.textContent("#title-text"), "src/db/store.ts");
});

/** Where the picture sits on screen against the canvas and what the page lays over it: the toolbar and the minimap. */
async function pictureBoxes(): Promise<Record<"picture" | "canvas" | "tools" | "minimap", { left: number; top: number; right: number; bottom: number }> & { zoom: number }> {
  return (await page!.evaluate(`(() => {
    const canvas = window.archdiff.canvas();
    const viewport = canvas.viewport();
    const box = document.querySelector(".excalidraw__canvas.interactive").getBoundingClientRect();
    const elements = canvas.scene().filter((element) => !element.isDeleted && element.customData?.archdiff);
    const sx = (x) => box.left + (x + viewport.scrollX) * viewport.zoom;
    const sy = (y) => box.top + (y + viewport.scrollY) * viewport.zoom;
    const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    return {
      zoom: viewport.zoom,
      picture: { left: sx(Math.min(...elements.map((e) => e.x))), top: sy(Math.min(...elements.map((e) => e.y))), right: sx(Math.max(...elements.map((e) => e.x + e.width))), bottom: sy(Math.max(...elements.map((e) => e.y + e.height))) },
      canvas: rect(".excalidraw__canvas.interactive"),
      tools: rect("#canvas-tools"),
      minimap: rect("#minimap"),
    };
  })()`)) as Record<"picture" | "canvas" | "tools" | "minimap", { left: number; top: number; right: number; bottom: number }> & { zoom: number };
}

/** The picture is all on the canvas, below the toolbar and clear of the minimap. */
async function assertPictureClear(when: string): Promise<number> {
  const boxes = await pictureBoxes();
  const { picture, canvas, tools, minimap } = boxes;
  const facts = JSON.stringify(boxes);
  assert.ok(picture.left >= canvas.left && picture.right <= canvas.right && picture.top >= canvas.top && picture.bottom <= canvas.bottom, `${when}: off the canvas ${facts}`);
  assert.ok(picture.top >= tools.bottom, `${when}: under the toolbar ${facts}`);
  assert.ok(picture.right <= minimap.left || picture.bottom <= minimap.top, `${when}: under the minimap ${facts}`);

  return boxes.zoom;
}

test("a picture is fitted clear of the toolbar and the minimap, again when the canvas resizes, and a view comes back where the reader left it", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.goto(`${base}/?fresh=fit0#view=layers`);
  await page!.evaluate("localStorage.clear()");
  // A short window: the whole map fills the canvas's height, where the toolbar and the minimap sit.
  await page!.setViewportSize({ width: 1900, height: 620 });
  await page!.goto(`${base}/?fresh=fit#view=modules`);
  await page!.waitForFunction(`window.archdiff.drawn() === "modules"`);
  await page!.waitForTimeout(800);
  const short = await assertPictureClear("a short window");
  // The window grows: the picture the reader did not move is fitted again, larger.
  await page!.setViewportSize({ width: 1900, height: 1000 });
  await page!.waitForTimeout(800);
  assert.ok((await assertPictureClear("a tall window")) > short);
  // The reader zooms in; another view is fitted; back on this one, the picture is where the reader left it.
  const centre = await screenPointOf("src/lib/orders.ts");
  await page!.mouse.move(centre.x, centre.y);
  await page!.keyboard.down("Control");

  for (let i = 0; i < 4; i++) {
    await page!.mouse.wheel(0, -100);
    await page!.waitForTimeout(40);
  }

  await page!.keyboard.up("Control");
  await page!.waitForTimeout(300);
  const left = (await page!.evaluate("window.archdiff.canvas().viewport()")) as { zoom: number };
  await page!.evaluate(`location.hash = "view=layers"`);
  await page!.waitForFunction(`window.archdiff.drawn() === "layers"`);
  await page!.waitForTimeout(500);
  await assertPictureClear("a view shown the first time");
  await page!.goBack();
  await page!.waitForFunction(`window.archdiff.drawn() === "modules"`);
  await page!.waitForTimeout(500);
  assert.deepEqual(await page!.evaluate("window.archdiff.canvas().viewport()"), left);
  // 0 fits it again and forgets the place: the next visit is fitted.
  await page!.keyboard.press("0");
  await page!.evaluate(`location.hash = "view=layers"`);
  await page!.waitForFunction(`window.archdiff.drawn() === "layers"`);
  await page!.goBack();
  await page!.waitForFunction(`window.archdiff.drawn() === "modules"`);
  await page!.waitForTimeout(500);
  await assertPictureClear("after 0");
  // A remembered place that shows none of the picture (the picture changed since) gives way to the fit.
  await page!.evaluate(`localStorage.setItem("archdiff.viewport.v2.layer:lib", JSON.stringify({ scrollX: 90000, scrollY: 90000, zoom: 1 }))`);
  await page!.evaluate(`location.hash = "view=layer%3Alib"`);
  await page!.waitForFunction(`window.archdiff.drawn() === "layer:lib"`);
  await page!.waitForTimeout(500);
  await assertPictureClear("a stale place");
});

test("a picture bigger than the canvas even at the smallest zoom starts from its beginning and says so", { skip: !CHROME && "no Chrome installed" }, () =>
  withOwnServer(
    "archdiff-page-long-",
    (dir) => {
      // Sixty early returns in a row: a flowchart some sixteen thousand units wide, ten times the canvas at the smallest zoom.
      writeFileSync(join(dir, "src/lib/long.ts"), `export function long(x: number): number {\n${Array.from({ length: 60 }, (_, i) => `  if (x === ${i}) return ${i * 2};`).join("\n")}\n  return -1;\n}\n`);
    },
    async (origin) => {
      await page!.goto(`${origin}/#view=${encodeURIComponent("logic:src/lib/long.ts#long")}`);
      await page!.waitForFunction(`window.archdiff.drawn() === "logic:src/lib/long.ts#long"`, undefined, { timeout: 20_000 });
      await page!.waitForTimeout(800);
      const { picture, canvas, zoom } = await pictureBoxes();
      // The flow starts at the canvas's left edge (its margin), and the rest runs off to the right.
      assert.ok(zoom < 0.11 && Math.abs(picture.left - (canvas.left + 32)) < 2 && picture.right > canvas.right, JSON.stringify({ picture, canvas, zoom }));
      assert.match((await page!.textContent("#reason")) ?? "", /bigger than the canvas even at the smallest zoom/);
    },
  ));

test("an empty picture and one that cannot be drawn say why on the canvas; a second tap opens deeper or says nothing opens", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.goto(`${base}/?fresh=empty#view=machines`);
  await page!.waitForFunction(`window.archdiff.drawn() === "machines"`);
  // No machine in the sample: the canvas says so in its middle, and the minimap of nothing is gone.
  await page!.waitForFunction(`!document.querySelector("#empty").hidden`);
  assert.match((await page!.textContent("#empty")) ?? "", /Nothing to draw here.*no state machine/);
  assert.equal(await page!.evaluate("document.querySelector('#minimap').hidden"), true);
  // The timeline outside git cannot be drawn: the canvas is cleared and says why, rather than keeping the last picture.
  await page!.evaluate(`location.hash = "view=timeline"`);
  await page!.waitForFunction(`window.archdiff.drawn() === "timeline"`);
  assert.match((await page!.textContent("#empty")) ?? "", /could not be drawn.*not a git repository/);
  assert.equal(await page!.evaluate("window.archdiff.canvas().scene().filter((element) => !element.isDeleted).length"), 0);
  // A picture with shapes takes the note away.
  await page!.evaluate(`location.hash = "view=${encodeURIComponent("calls:src/routes/checkout.tsx#Checkout")}"`);
  await page!.waitForFunction(`window.archdiff.drawn() === "calls:src/routes/checkout.tsx#Checkout"`);
  await page!.waitForTimeout(500);
  assert.equal(await page!.evaluate("document.querySelector('#empty').hidden"), true);
  // A second tap on the function the call tree starts from (its own view is this picture) opens its logic.
  const root = await screenPointOf("src/routes/checkout.tsx#Checkout");
  await page!.mouse.dblclick(root.x, root.y);
  await page!.waitForFunction(`window.archdiff.drawn() === "logic:src/routes/checkout.tsx#Checkout"`);
  // A second tap on a shape that opens nothing (a cell of the metrics) says so instead of doing nothing.
  await page!.evaluate(`location.hash = "view=metrics"`);
  await page!.waitForFunction(`window.archdiff.drawn() === "metrics"`);
  await page!.waitForTimeout(500);
  const cell = (await page!.evaluate(`[...window.archdiff.nodes().values()].find((node) => node.kind === "cell" && node.opens === undefined)?.id`)) as string;
  const point = await screenPointOf(cell);
  await page!.mouse.dblclick(point.x, point.y);
  await page!.waitForFunction(`(document.querySelector("#reason")?.textContent ?? "").includes("nothing opens from this shape")`);
  assert.ok((await page!.evaluate("location.hash")) === "#view=metrics");
});

test("a line's light stays while the pointer moves on, moves to the next line tapped and goes out on a tap on nothing", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.goto(`${base}/?fresh=lights#view=layer%3Alib`);
  await page!.waitForFunction(`window.archdiff.drawn() === "layer:lib"`);
  await page!.waitForTimeout(800);
  const drawn = await linesOnScreen();
  const looks = new Map(drawn.map((line) => [line.id, line.look]));
  /** The lines whose look is not the one the picture drew them with. */
  const lit = async (): Promise<string[]> => (await linesOnScreen()).filter((line) => looks.get(line.id) !== line.look).map((line) => line.id);
  const [first, second] = drawn.filter((line) => line.length > 30);
  assert.ok(first && second, JSON.stringify(drawn));
  // The pointer comes over the line (the hover lights it), the tap lights it; leaving it keeps the tap's light.
  await page!.mouse.move(first.x, first.y);
  await page!.waitForTimeout(200);
  await page!.mouse.down();
  await page!.mouse.up();
  await page!.waitForTimeout(300);
  assert.ok((await lit()).includes(first.id));
  await page!.mouse.move(first.x + 40, first.y + 40);
  await page!.waitForTimeout(200);
  assert.ok((await lit()).includes(first.id), "the hover leaving the line put the tap's light out");
  // Another line tapped: the first is drawn as before (not in the hover's colour), the second lit.
  await page!.mouse.move(second.x, second.y);
  await page!.waitForTimeout(200);
  await page!.mouse.down();
  await page!.mouse.up();
  await page!.waitForTimeout(300);
  const now = await lit();
  assert.ok(now.includes(second.id) && (now.includes(first.id) === false || first.id === second.id), JSON.stringify(now));
  // A tap on nothing: every line as the picture drew it.
  const box = (await page!.evaluate(`document.querySelector(".excalidraw__canvas.interactive").getBoundingClientRect().toJSON()`)) as { left: number; bottom: number };
  await page!.mouse.move(box.left + 16, box.bottom - 80);
  await page!.waitForTimeout(200);
  await page!.mouse.down();
  await page!.mouse.up();
  await page!.waitForTimeout(300);
  assert.deepEqual(await lit(), []);
});

test("the counts under a shape say what lies beyond the picture; a tap on one lists it, and a chip opens a neighbour's picture", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.goto(`${base}/?fresh=beyond#view=${encodeURIComponent("module:src/lib/log.ts")}`);
  await page!.waitForFunction(`window.archdiff.drawn() === "module:src/lib/log.ts"`);
  await page!.waitForTimeout(800);
  // orders.ts is imported from beyond the picture (checkout.tsx) and imports beyond it (store.ts).
  const counts = (await page!.evaluate(`window.archdiff.canvas().scene().filter((element) => element.customData?.archdiff === "beyond").map((element) => element.text)`)) as string[];
  assert.deepEqual(counts, ["◂ 1", "1 ▸"]);
  // A tap on the count picks its shape: the strip lists the neighbours beyond, dashed.
  const before = await screenPointOf("beyond:src/lib/orders.ts:before");
  await page!.mouse.click(before.x, before.y);
  await page!.waitForFunction(`window.archdiff.selected()[0] === "src/lib/orders.ts"`);
  await page!.waitForFunction(`(document.querySelector("#neighbours")?.textContent ?? "").includes("beyond ◂ 1:")`);
  assert.deepEqual(await page!.evaluate(`[...document.querySelectorAll("#neighbours button.beyond")].map((button) => button.textContent)`), ["◂ src/routes/checkout.tsx", "src/db/store.ts ▸"]);
  // Shift+click on one beyond: everything joined to it; a click: its own picture.
  await page!.click("#neighbours button.beyond:has-text('store.ts')", { modifiers: ["Shift"] });
  await page!.waitForFunction(`window.archdiff.drawn() === "focus:src/db/store.ts"`);
  await page!.goBack();
  await page!.waitForFunction(`window.archdiff.drawn() === "module:src/lib/log.ts"`);
  await page!.waitForTimeout(500);
  const again = await screenPointOf("src/lib/orders.ts");
  await page!.mouse.click(again.x, again.y);
  await page!.waitForFunction(`document.querySelectorAll("#neighbours button.beyond").length === 2`);
  await page!.click("#neighbours button.beyond:has-text('checkout.tsx')");
  await page!.waitForFunction(`window.archdiff.drawn() === "module:src/routes/checkout.tsx"`);
});

test("the branch bar compares two heads: the title, the table from where each left main, a module's page per head; one head is its review", { skip: !CHROME && "no Chrome installed" }, () =>
  withOwnServer(
    "archdiff-page-compare-",
    (dir) => {
      // One date for every commit: the branch bar lists the heads by their commit date, then by name, so `a` comes
      // before `b` whichever second each commit lands in.
      const dated = { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
      const git = (...args: string[]): void => {
        const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8", env: dated });
        assert.equal(result.status, 0, result.stderr);
      };
      git("init", "-q", "-b", "main");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      // a: the store reads a route (db → routes); b: the store counts its rows.
      git("checkout", "-q", "-b", "a");
      writeFileSync(join(dir, "src/db/report.ts"), 'import { action } from "../routes/checkout.tsx";\n\nexport function report(): unknown {\n  return action({ total: 1 });\n}\n');
      git("add", ".");
      git("commit", "-q", "-m", "a: a report");
      git("checkout", "-q", "main");
      git("checkout", "-q", "-b", "b");
      writeFileSync(join(dir, "src/db/store.ts"), "export function countOrders(): number {\n  return 0;\n}\n");
      git("add", ".");
      git("commit", "-q", "-m", "b: count");
      git("checkout", "-q", "main");
    },
    async (origin) => {
      await page!.goto(`${origin}/#view=review`);
      await page!.waitForFunction(`window.archdiff.drawn() === "review"`, undefined, { timeout: 20_000 });
      await page!.waitForFunction(`document.querySelectorAll("#head-list input").length >= 3`);
      // Tick the two heads, not the working tree, and compare.
      await page!.evaluate(`for (const box of document.querySelectorAll("#head-list input")) box.checked = box.value === "a" || box.value === "b"`);
      await page!.click("#compare");
      await page!.waitForFunction(`window.archdiff.drawn() === "compare"`, undefined, { timeout: 20_000 });
      assert.equal(await page!.textContent("#title-text"), "2 heads against main — ⚠ 1 head adds a layer dependency");
      assert.deepEqual(await page!.evaluate(`[...document.querySelectorAll("#head-list input:checked")].map((box) => box.value)`), ["a", "b"]);
      // The table names where each head left main.
      const markdown = (await page!.textContent("#markdown")) ?? "";
      assert.ok(markdown.includes("since") && markdown.includes("Each head from where it left main"), markdown.slice(0, 400));
      // A module's page: what each head did to it.
      await page!.waitForTimeout(600);
      const store = await screenPointOf("src/db/store.ts");
      await page!.mouse.click(store.x, store.y);
      await page!.click("#tabs button[data-tab='markdown']");
      await page!.waitForFunction(`(document.querySelector("#markdown")?.textContent ?? "").includes("In this comparison")`, undefined, { timeout: 8000 });
      assert.ok(((await page!.textContent("#markdown")) ?? "").includes("added fn countOrders"));
      // One head ticked is that head's review, and the bar keeps it ticked.
      await page!.evaluate(`for (const box of document.querySelectorAll("#head-list input")) box.checked = box.value === "b"`);
      await page!.click("#compare");
      await page!.waitForFunction(`window.archdiff.drawn() === "review" && location.hash.includes("head=b")`, undefined, { timeout: 20_000 });
      assert.deepEqual(await page!.evaluate(`[...document.querySelectorAll("#head-list input:checked")].map((box) => box.value)`), ["b"]);
      assert.match((await page!.textContent("#title-text")) ?? "", /^Changes since [0-9a-f]{7}\.\.b — 1 source file changed$/);
      // The head field is the code of every picture: the layers of a, then ] steps to the next branch.
      await page!.evaluate(`location.hash = "view=modules"`);
      await page!.waitForFunction(`window.archdiff.drawn() === "modules"`, undefined, { timeout: 20_000 });
      await page!.fill("#head", "a");
      await page!.dispatchEvent("#head", "change");
      await page!.waitForFunction(`location.hash.includes("head=a") && document.querySelector("#title-text")?.textContent?.endsWith("@ a")`, undefined, { timeout: 20_000 });
      assert.ok((await page!.evaluate(`[...document.querySelectorAll("#views li")].map((li) => li.title)`) as string[]).includes("module:src/db/report.ts"));
      assert.ok(((await page!.textContent("#stats")) ?? "").startsWith("at a · "));
      const before = (await page!.evaluate("location.hash")) as string;
      await page!.mouse.click(10, 300);
      await page!.keyboard.press("]");
      await page!.waitForFunction(`location.hash !== ${JSON.stringify(before)}`, undefined, { timeout: 10_000 });
      assert.ok(!(((await page!.evaluate("location.hash")) as string).includes("head=a&") || ((await page!.evaluate("location.hash")) as string).endsWith("head=a")));
      // b: the branches, a lane each from where it left main; a tap on a commit is its page, a double tap its change.
      await page!.evaluate(`location.hash = "view=layers"`);
      await page!.waitForFunction(`window.archdiff.drawn() === "layers"`, undefined, { timeout: 20_000 });
      await page!.mouse.click(10, 300);
      await page!.keyboard.press("b");
      await page!.waitForFunction(`window.archdiff.drawn() === "branches"`, undefined, { timeout: 20_000 });
      assert.equal(await page!.textContent("#title-text"), "Branches against main");
      const commitOfA = (await page!.evaluate(`[...window.archdiff.nodes().values()].find((node) => node.label.includes("a: a report"))?.id ?? ""`)) as string;
      assert.ok(commitOfA.startsWith("commit:"), commitOfA);
      const spot = await screenPointOf(commitOfA);
      await page!.mouse.click(spot.x, spot.y);
      await page!.waitForFunction(`(document.querySelector("#markdown")?.textContent ?? "").includes("Files (1)")`, undefined, { timeout: 8000 });
      assert.ok(((await page!.textContent("#markdown")) ?? "").includes("added src/db/report.ts"));
      await page!.mouse.dblclick(spot.x, spot.y);
      await page!.waitForFunction(`window.archdiff.drawn()?.startsWith("commit:")`, undefined, { timeout: 20_000 });
      assert.match((await page!.textContent("#title-text")) ?? "", /^Commit [0-9a-f]{7}: a: a report — 1 source file changed — ⚠ 1 new layer dependency$/);
    },
  ));

test("the review's commit bar steps through its range and keeps it; a link without a base is reviewed from the default", { skip: !CHROME && "no Chrome installed" }, () =>
  withOwnServer(
    "archdiff-page-commits-",
    (dir) => {
      const git = (...args: string[]): void => {
        const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      };
      git("init", "-q", "-b", "main");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      git("checkout", "-q", "-b", "feature");

      for (const n of [1, 2, 3]) {
        writeFileSync(join(dir, `src/lib/step${n}.ts`), `export function step${n}(): number {\n  return ${n};\n}\n`);
        git("add", ".");
        git("commit", "-q", "-m", `step ${n}`);
      }
    },
    async (origin) => {
      await page!.goto(`${origin}/#view=review`);
      await page!.waitForFunction(`window.archdiff.drawn() === "review" && document.querySelectorAll("#commit-list option").length === 4`, undefined, { timeout: 20_000 });
      const listed = (): Promise<string[]> => page!.evaluate(`[...document.querySelectorAll("#commit-list option")].map((option) => option.textContent.replace(/^\\S+ \\S+ /, ""))`) as Promise<string[]>;
      assert.equal((await listed()).length, 4);
      // Each › moves to the next commit of the range; the list keeps the whole range.
      for (const n of [1, 2, 3]) {
        const before = (await page!.evaluate("location.hash")) as string;
        await page!.click("#commit-next");
        await page!.waitForFunction(`location.hash !== ${JSON.stringify(before)} && window.archdiff.drawn() === "review"`, undefined, { timeout: 20_000 });
        await page!.waitForFunction(`document.querySelector("#commit-list").selectedOptions[0]?.textContent.endsWith("step ${n}")`, undefined, { timeout: 10_000 });
        assert.equal((await listed()).length, 4, `after › ${n}`);
        assert.match((await page!.textContent("#title-text")) ?? "", /— 1 source file changed$/);
      }

      // ‹ goes back one, still one commit's change.
      await page!.click("#commit-prev");
      await page!.waitForFunction(`document.querySelector("#commit-list").selectedOptions[0]?.textContent.endsWith("step 2")`, undefined, { timeout: 10_000 });
      await page!.waitForFunction(`/— 1 source file changed$/.test(document.querySelector("#title-text")?.textContent ?? "")`, undefined, { timeout: 20_000 });
      // A link without a base: the base field follows it, empty, whatever it held for the last commit.
      await page!.evaluate(`location.hash = "view=review"`);
      await page!.waitForFunction(`!location.hash.includes("base=") && document.querySelector("#base").value === ""`, undefined, { timeout: 10_000 });
      await page!.waitForFunction(`/— 3 source files changed$/.test(document.querySelector("#title-text")?.textContent ?? "")`, undefined, { timeout: 20_000 });
    },
  ));

test("a repository the server cannot read says why on the page; the Flow tab is the picture's own", { skip: !CHROME && "no Chrome installed" }, async () => {
  // The config broken while the server runs (it refuses to start with one).
  await withOwnServer(
    "archdiff-page-broken-",
    () => {},
    async (origin, dir) => {
      writeFileSync(join(dir, "archdiff.json"), '{ "layers": { "lib": 5 } }');
      await page!.goto(`${origin}/`);
      await page!.waitForFunction(`!document.querySelector("#empty").hidden`, undefined, { timeout: 20_000 });
      assert.ok(((await page!.textContent("#empty")) ?? "").includes('archdiff.json: "layers.lib" must be a list of strings'));
    },
  );
  // A calls view has its Flow tab; a module's picture has none, and its panel goes with it.
  await page!.goto(`${base}/#view=${encodeURIComponent("calls:src/routes/checkout.tsx#action")}`);
  await page!.waitForFunction(`window.archdiff.drawn()?.startsWith("calls:") && !document.querySelector("#flow-tab").hidden`, undefined, { timeout: 20_000 });
  await page!.click("#flow-tab");
  await page!.waitForFunction(`document.querySelector("#flow").classList.contains("active") && document.querySelectorAll("#flow-steps .step").length > 0`, undefined, { timeout: 10_000 });
  await page!.evaluate(`location.hash = "view=${encodeURIComponent("module:src/lib/log.ts")}"`);
  await page!.waitForFunction(`window.archdiff.drawn() === "module:src/lib/log.ts"`, undefined, { timeout: 20_000 });
  assert.ok(await page!.evaluate(`document.querySelector("#flow-tab").hidden && !document.querySelector("#flow").classList.contains("active") && document.querySelector("#markdown").classList.contains("active")`));
  assert.equal(await page!.evaluate(`document.querySelectorAll("#flow-steps .step").length`), 0);
});

test("a double tap goes in though the page is still busy with its first tap", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.goto(`${base}/?fresh=busy#view=layer%3Alib`);
  await page!.waitForFunction(`window.archdiff.drawn() === "layer:lib"`);
  await page!.waitForTimeout(800);
  const orders = await screenPointOf("src/lib/orders.ts");
  await page!.mouse.move(orders.x, orders.y);
  await page!.mouse.down();
  await page!.mouse.up();
  // The first tap's work keeps the page busy for most of a second (a big file's code, a big scene lit): the second
  // tap, pressed a quarter of a second after the first, is handled only after it.
  await page!.evaluate("setTimeout(() => { const start = performance.now(); while (performance.now() - start < 700); }, 0)");
  await page!.waitForTimeout(250);
  await page!.mouse.down();
  await page!.mouse.up();
  await page!.waitForFunction(`location.hash === "#view=inside%3Asrc%2Flib%2Forders.ts"`, undefined, { timeout: 5000 });
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
  // "none" picked (the tests' server finds no agent installed either): the task is only written, and the run button is off.
  await page!.selectOption("#agent-select", "");
  assert.match((await page!.textContent("#agent-name")) ?? "", /^no agent (picked|installed)/);
  assert.ok(await page!.evaluate(`document.querySelector("#run").disabled`));
});

test("a reader who stays in the editor keeps the link of the picture drawn on; leaving drops the strokes not saved", { skip: !CHROME && "no Chrome installed" }, () =>
  withOwnServer(
    "archdiff-page-editor-",
    () => {},
    async (origin, dir) => {
      await page!.goto(`${origin}/#view=layer%3Alib`);
      await page!.waitForFunction(`window.archdiff.drawn() === "layer:lib"`, undefined, { timeout: 20_000 });
      await page!.click("#edit");
      await page!.waitForSelector("body.editing");
      // A rectangle drawn with the editor's own tool, below the picture.
      const strokes = `window.archdiff.canvas().scene().filter((element) => !element.isDeleted && !element.customData?.archdiff).length`;
      const box = (await page!.locator(".excalidraw__canvas.interactive").boundingBox())!;
      const rectangle = (): Promise<void> => page!.click(".excalidraw [data-testid='toolbar-rectangle']", { force: true });
      await rectangle();
      await page!.mouse.move(box.x + 120, box.y + box.height - 160);
      await page!.mouse.down();
      await page!.mouse.move(box.x + 220, box.y + box.height - 90, { steps: 5 });
      await page!.mouse.up();
      await page!.waitForFunction(`${strokes} > 0 && document.querySelector("#save")?.classList.contains("dirty")`);
      // Another view asked for, and the reader stays: the link goes back to the picture drawn on, and a save writes its drawing.
      await page!.evaluate(`window.confirm = () => false`);
      await page!.evaluate(`location.hash = "view=module%3Asrc%2Flib%2Flog.ts"`);
      await page!.waitForFunction(`location.hash === "#view=layer%3Alib"`);
      assert.ok(await page!.evaluate(`document.body.classList.contains("editing")`));
      await page!.keyboard.press("Control+s");
      await page!.waitForFunction(`!document.querySelector("#save")?.classList.contains("dirty")`);
      assert.ok(existsSync(join(dir, ".archdiff/layouts/layer_lib.json")));
      assert.ok(!existsSync(join(dir, ".archdiff/layouts/module_src_lib_log.ts.json")));
      // One more stroke, given up on leaving: it goes, the saved one stays.
      await rectangle();
      await page!.mouse.move(box.x + 260, box.y + box.height - 160);
      await page!.mouse.down();
      await page!.mouse.move(box.x + 330, box.y + box.height - 90, { steps: 5 });
      await page!.mouse.up();
      await page!.waitForFunction(`${strokes} > 1`);
      await page!.evaluate(`window.confirm = () => true`);
      await page!.click("#exit");
      await page!.waitForFunction(`!document.body.classList.contains("editing") && ${strokes} === 1`, undefined, { timeout: 10_000 });
    },
  ));

test("the options panel sets the overlays and the fold limit, writes them to the link and remembers them as defaults", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.evaluate("localStorage.clear()");
  await page!.goto(`${base}/?fresh=2#view=layer%3Alib`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.click("#options-menu summary");
  await page!.check("#options .overlay[value='storages']");
  await page!.waitForFunction(`location.hash.includes("overlay=storages")`);
  // The Markdown of the view names the overlay's finding.
  await page!.waitForFunction(`(document.querySelector("#reason")?.textContent ?? "").includes("storage")`);
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

test("the options keep every good value of a link, round what the fields need, step the depth from the view's own, warn past 12, reset everything and say so", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.evaluate("localStorage.clear()");
  const reason = async (): Promise<string> => (await page!.textContent("#reason")) ?? "";
  const open = async (hash: string): Promise<void> => {
    await page!.goto(`${base}/?fresh=${Math.random()}#${hash}`);
    await page!.waitForSelector(".excalidraw canvas");
    await page!.waitForFunction(`document.querySelector("#title-text")?.textContent !== ""`);
  };
  const options = async (): Promise<void> => {
    if (!(await page!.evaluate(`document.querySelector("#options-menu").open`))) await page!.click("#options-menu summary");
  };
  // A wrong value of a link is left out alone and named; the good ones stay.
  await open("view=modules&depth=2&overlay=tests&limit=1.5&mermaid=xyz");
  await page!.waitForFunction(`(document.querySelector("#reason")?.textContent ?? "").startsWith("⚠ ignored in the link: limit=1.5")`);
  assert.ok((await reason()).includes("⚠ ignored in the link: mermaid=xyz"), await reason());
  assert.equal(await page!.inputValue("#depth"), "2");
  assert.ok(await page!.evaluate(`document.querySelector("#options .overlay[value='tests']").checked`));
  // A fold of 1.5 is a fold of 1; a fold of 0 shows 1 in the field, the value in force.
  await options();
  await page!.fill("#limit", "1.5");
  await page!.press("#limit", "Enter");
  await page!.waitForFunction(`location.hash.includes("limit=1&") || location.hash.endsWith("limit=1")`);
  assert.ok(String(await page!.evaluate("location.hash")).includes("depth=2"));
  await page!.fill("#limit", "0");
  await page!.press("#limit", "Enter");
  await page!.waitForFunction(`document.querySelector("#limit").value === "1"`);
  // depth − and + start from the view's own depth (3 for a call tree), with no ceiling; past 12 the picture warns.
  await open("view=calls%3Asrc%2Froutes%2Fcheckout.tsx%23action");
  assert.equal(await page!.getAttribute("#depth", "placeholder"), "auto (3)");
  await page!.click("#depth-more");
  await page!.waitForFunction(`location.hash.includes("depth=4")`);
  await open("view=calls%3Asrc%2Froutes%2Fcheckout.tsx%23action");
  await page!.click("#depth-less");
  await page!.waitForFunction(`location.hash.includes("depth=2")`);
  await options();
  await page!.fill("#depth", "20");
  await page!.press("#depth", "Enter");
  await page!.waitForFunction(`location.hash.includes("depth=20")`);
  await page!.waitForFunction(`(document.querySelector("#reason")?.textContent ?? "").startsWith("⚠ depth 20 is deeper than 12")`);
  assert.ok(await page!.evaluate(`document.querySelector("#depth").classList.contains("warn")`));
  // full goes one step deeper than the view by itself.
  await open("view=calls%3Asrc%2Froutes%2Fcheckout.tsx%23action");
  await page!.click("#canvas-tools [data-detail='full']");
  await page!.waitForFunction(`location.hash.includes("depth=4") && document.querySelector("#canvas-tools [data-detail='full']").classList.contains("active")`);
  // The Mermaid types of one kind of view: a machine's state diagram is listed and kept; a gitGraph is greyed out off the timeline.
  await open("view=module%3Asrc%2Flib%2Forders.ts&mermaid=state");
  assert.equal(await page!.inputValue("#mermaid"), "state");
  assert.ok(await page!.evaluate(`document.querySelector("#mermaid option[value='gitgraph']").disabled`));
  // Remember says so after the reload it starts; reset sets every option back, the toolbar's and the lanes menu's too.
  await options();
  await page!.click("#options-default");
  await page!.waitForTimeout(800);
  assert.equal(await reason(), "options remembered as the defaults of this browser");
  await open("view=modules&changes=1&only=changes&hide=db&types=1&expand=src%2Flib%2Forders.ts");
  await options();
  await page!.click("#options-reset");
  await page!.waitForFunction(`location.hash === "#view=modules"`);
  await page!.waitForFunction(`(document.querySelector("#reason")?.textContent ?? "") === "every option back to the built-in one; the remembered defaults are forgotten"`);
  assert.equal(await page!.evaluate("localStorage.getItem('archdiff.defaults.v2')"), null);
});

test("a tap on a line lights it with its ends and shows where it leads", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.evaluate("localStorage.clear()");
  await page!.goto(`${base}/?fresh=4#view=layer%3Alib`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.waitForFunction(`document.querySelector("#title-text")?.textContent?.includes("lib")`);
  await page!.waitForTimeout(1200);
  // The line orders.ts → store.ts as the canvas shows it: the middle of its longest segment is in a gap, on no shape.
  const arrow = (await page!.evaluate(`window.archdiff.canvas().scene().find((element) => !element.isDeleted && element.customData?.archdiff === "edge" && element.customData.from === "src/lib/orders.ts" && element.customData.to === "src/db/store.ts")`)) as { x: number; y: number; points?: [number, number][] } | undefined;
  assert.ok(arrow, "no arrow orders → store in the scene");
  let longest: { x: number; y: number; length: number } | null = null;

  for (let i = 1; i < arrow.points!.length; i++) {
    const [ax, ay] = arrow.points![i - 1]!;
    const [bx, by] = arrow.points![i]!;
    const length = Math.hypot(bx - ax, by - ay);

    if (!longest || length > longest.length) longest = { x: arrow.x + (ax + bx) / 2, y: arrow.y + (ay + by) / 2, length };
  }

  const screen = await onScreen(longest!.x, longest!.y);
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

test("find (/), the views filter (v), dim (d), lanes, split, the chain between two shapes and the minimap", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.evaluate("localStorage.clear()");
  await page!.goto(`${base}/?fresh=7#view=layer%3Alib`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.waitForFunction(`document.querySelector("#title-text")?.textContent?.includes("lib")`);
  await page!.waitForTimeout(1000);
  // The path: a tap on orders.ts, then Shift+tap on log.ts.
  const orders = await screenPointOf("src/lib/orders.ts");
  const log = await screenPointOf("src/lib/log.ts");
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
  // The dim tool (d): a tap on log.ts fades all but it and its neighbour orders.ts — never a lane's title; d again turns it off and clears the dimming.
  await page!.keyboard.press("d");
  await page!.waitForFunction(`document.querySelector("#tool-dim").classList.contains("active")`);
  // Past the double tap's half second: log.ts was tapped (with Shift) just before.
  await page!.waitForTimeout(700);
  await page!.mouse.click(log.x, log.y);
  const opacity = (id: string): Promise<number> => page!.evaluate(`window.archdiff.canvas().scene().find((element) => element.id === ${JSON.stringify(id)}).opacity`) as Promise<number>;
  await page!.waitForFunction(`window.archdiff.canvas().scene().find((element) => element.id === "src/db/store.ts")?.opacity === 18`, undefined, { timeout: 8000 });
  assert.deepEqual([await opacity("src/lib/log.ts"), await opacity("src/lib/orders.ts"), await opacity("lane:db:text")], [100, 100, 100]);
  await page!.keyboard.press("d");
  await page!.waitForFunction(`!window.archdiff.canvas().scene().some((element) => element.opacity === 18)`);
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
  const orders = await screenPointOf("src/lib/orders.ts");
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
  // The layers do not go a depth from a subject: minimal sets the fold and the weight alone, and the depth steps are off.
  await page!.click("#canvas-tools [data-detail='minimal']");
  await page!.waitForFunction(`location.hash.includes("limit=20") && location.hash.includes("weight=2") && !location.hash.includes("depth=")`);
  await page!.waitForFunction(`document.querySelector("#canvas-tools [data-detail='minimal']").classList.contains("active")`);
  assert.ok(await page!.evaluate(`document.querySelector("#depth-more").disabled && document.querySelector("#depth-less").disabled`));
  // A layer goes one step from its modules; minimal keeps it there, and depth + goes a step further.
  await page!.goto(`${base}/?fresh=5b#view=layer%3Alib`);
  await page!.waitForSelector(".excalidraw canvas");
  await page!.click("#canvas-tools [data-detail='minimal']");
  await page!.waitForFunction(`location.hash.includes("depth=1") && location.hash.includes("limit=20")`);
  await page!.click("#depth-more");
  await page!.waitForFunction(`location.hash.includes("depth=2")`);
  // The mix tool: a tap on the single module of a depth-0 module view opens it in place.
  await page!.goto(`${base}/?fresh=6#view=module%3Asrc%2Flib%2Forders.ts&depth=0`);
  await page!.waitForFunction(`document.querySelector("#title-text")?.textContent === "src/lib/orders.ts"`);
  await page!.waitForTimeout(1000);
  await page!.click("#tool-mix");
  const module = await screenPointOf("src/lib/orders.ts");
  await page!.mouse.move(module.x, module.y);
  await page!.mouse.down();
  await page!.mouse.up();
  await page!.waitForFunction(`location.hash.includes("expand=src%2Flib%2Forders.ts")`, undefined, { timeout: 8000 });
  await page!.waitForFunction(`(document.querySelector("#reason")?.textContent ?? "").includes("opened in place")`);
  await page!.click("#mix-clear");
  await page!.waitForFunction(`!location.hash.includes("expand=")`);
});

test("the agent's question shows its options; an answer resumes the session", { skip: !CHROME && "no Chrome installed" }, () =>
  // A server of its own, on a copy with the fake agent configured (the shared one has no agent).
  withOwnServer(
    "archdiff-page-agent-",
    (agentDir) => writeFileSync(join(agentDir, "archdiff.json"), JSON.stringify({ layers: { routes: ["src/routes/**"], lib: ["src/lib/**"], db: ["src/db/**"] }, agent: { name: "fake", command: [process.execPath, join(root, "tests/fixtures/fake-agent.mjs")], resume: "--resume" } })),
    async (agentBase) => {
      await page!.goto(`${agentBase}/#view=layer%3Alib`);
      await page!.waitForSelector(".excalidraw canvas");
      await page!.click("#tabs button[data-tab='chat']");
      // The configured agent is picked first, beside the built-in ones.
      await page!.waitForFunction(`document.querySelector("#agent-select")?.value === "fake" && [...document.querySelectorAll("#agent-select option")].map((option) => option.value).join(",") === "claude,cursor,codex,opencode,fake,"`);
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
    },
  ));

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
  const orders = await screenPointOf("src/lib/orders.ts");
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
  const orders = await screenPointOf("src/lib/orders.ts");
  const log = await screenPointOf("src/lib/log.ts");
  const store = await screenPointOf("src/db/store.ts");
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
  // The key that opened the map is not typed into its search box, and every dot is on the map's canvas.
  assert.equal(await page!.inputValue("#map-search"), "");
  const mapBox = (await page!.evaluate(`document.querySelector("#project-map-canvas").getBoundingClientRect().toJSON()`)) as { left: number; top: number; right: number; bottom: number };
  assert.ok(dots.every((dot) => dot.x >= mapBox.left && dot.x <= mapBox.right && dot.y >= mapBox.top && dot.y <= mapBox.bottom), JSON.stringify({ mapBox, dots }));
  const storeDot = dots.find((dot) => dot.id === "src/db/store.ts")!;
  await page!.mouse.click(storeDot.x, storeDot.y);
  await page!.waitForFunction(`location.hash.includes("module%3Asrc%2Fdb%2Fstore.ts")`);
  await page!.waitForFunction(`document.querySelector("#project-map").hidden`);
  // A double click on a dot goes inside its module: the first click waits for the second instead of closing the map.
  await page!.keyboard.press("p");
  await page!.waitForFunction(`!document.querySelector("#project-map").hidden && window.archdiff.mapSettled()`, undefined, { timeout: 20_000 });
  const ordersDot = ((await page!.evaluate("window.archdiff.mapDots()")) as { id: string; x: number; y: number }[]).find((dot) => dot.id === "src/lib/orders.ts")!;
  await page!.mouse.dblclick(ordersDot.x, ordersDot.y);
  await page!.waitForFunction(`location.hash.includes("inside%3Asrc%2Flib%2Forders.ts")`);
  await page!.waitForFunction(`document.querySelector("#project-map").hidden`);
});

test("the centre shows the view as the link says: in 3D, as its Markdown page, as the code of its subject, and as the canvas again", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.goto(`${base}/#view=module:src/lib/orders.ts&as=3d`);
  await page!.waitForFunction(`window.archdiff.drawn() === "module:src/lib/orders.ts"`);
  // The 3D module is a chunk of its own: the scene is there once it loaded and drew this view (or said it has no WebGL).
  await page!.waitForFunction(`window.archdiff.presentation().as === "3d" && (window.archdiff.presentation().three?.view === "module:src/lib/orders.ts" || window.archdiff.presentation().three?.webgl === false)`, undefined, { timeout: 15000 });
  const three = (await page!.evaluate("window.archdiff.presentation().three")) as { webgl: boolean; shapes: number; lines: number; lanes: number };
  const shapes = (await page!.evaluate("window.archdiff.nodes().size")) as number;
  assert.equal(await page!.inputValue("#show-as"), "3d");
  assert.equal(await page!.getAttribute("body", "data-as"), "3d");
  assert.ok(await page!.isVisible("#three"), "the 3D box is shown over the canvas");
  assert.ok(await page!.isDisabled("#edit"), "drawing needs the canvas");

  // A block per shape of the picture, a tube per line, a terrace per lane; a browser without WebGL says so instead.
  if (three.webgl) {
    assert.equal(three.shapes, shapes, JSON.stringify(three));
    assert.ok(three.lines >= 1 && three.lanes >= 1, JSON.stringify(three));
  } else assert.ok((await page!.textContent("#three"))?.includes("WebGL"));

  // The Markdown page in the centre: the same page the right panel shows.
  await page!.selectOption("#show-as", "markdown");
  await page!.waitForFunction(`window.archdiff.presentation().as === "markdown" && (document.querySelector("#reader-body h1")?.textContent ?? "").includes("orders")`);
  assert.equal(await page!.textContent("#reader-body h1"), await page!.textContent("#markdown h1"));
  assert.ok(await page!.isHidden("#three"));

  // The code of the subject: the module's file, line by line.
  await page!.selectOption("#show-as", "code");
  await page!.waitForFunction(`window.archdiff.presentation().as === "code" && (document.querySelector("#reader-code")?.textContent ?? "").includes("export")`);
  assert.ok((await page!.textContent("#reader-code"))?.startsWith("src/lib/orders.ts"));

  // The canvas again: the overlays gone, the editor allowed.
  await page!.selectOption("#show-as", "canvas");
  await page!.waitForFunction(`window.archdiff.presentation().as === "canvas" && document.querySelector("#reader").hidden`);
  assert.ok((await page!.isHidden("#three")) && (await page!.isHidden("#reader")));
  assert.equal(await page!.isDisabled("#edit"), false);
});

test("the left panel shows the repository as a folder tree: layers, folders, modules and their functions, opened and remembered, filtered, navigating", { skip: !CHROME && "no Chrome installed" }, async () => {
  await page!.goto(`${base}/#view=layers`);
  await page!.waitForFunction(`window.archdiff.drawn() === "layers"`);
  await page!.evaluate(`localStorage.removeItem("archdiff.tree.v1")`);
  await page!.click("#left-mode [data-left='tree']");
  const rows = (): Promise<string[]> => page!.evaluate(`[...document.querySelectorAll("#views .tree-row .label")].map((label) => label.textContent)`) as Promise<string[]>;
  // The layers alone at first, folded.
  assert.deepEqual(await rows(), ["cartridge", "db", "lib", "routes"]);
  const caretOf = async (label: string): Promise<void> => {
    await page!.click(`#views .tree-row:has(.label:text-is("${label}")) .caret`);
  };
  await caretOf("lib");
  assert.ok((await rows()).includes("src/"), (await rows()).join(", "));
  await caretOf("src/");
  await caretOf("lib/");
  assert.deepEqual((await rows()).slice(0, 6), ["cartridge", "db", "lib", "src/", "lib/", "log.ts"]);
  // A tap on a module opens its view, with the centre as it is; the row lights.
  await page!.click(`#views .tree-row:has(.label:text-is("orders.ts"))`);
  await page!.waitForFunction(`window.archdiff.drawn() === "module:src/lib/orders.ts"`);
  assert.equal(await page!.textContent("#views .tree-row.active .label"), "orders.ts");
  // The module's caret lists its functions, read from its inside picture; a tap on one opens the function's view.
  await caretOf("orders.ts");
  await page!.waitForFunction(`[...document.querySelectorAll("#views .tree-row .label")].some((label) => label.textContent === "placeOrder")`);
  await page!.click(`#views .tree-row:has(.label:text-is("placeOrder"))`);
  await page!.waitForFunction(`/^(calls|logic|focus):src\\/lib\\/orders\\.ts#placeOrder$/.test(window.archdiff.drawn() ?? "")`);
  assert.equal(await page!.textContent("#views .tree-row.active .label"), "placeOrder");
  // The filter finds a module with its folders open; the open folders are remembered across a reload, and so is the tree.
  await page!.fill("#search", "store");
  assert.deepEqual(await rows(), ["db", "src/", "db/", "store.ts"]);
  await page!.fill("#search", "");
  await page!.reload();
  await page!.waitForFunction(`document.querySelectorAll("#views .tree-row").length > 0`);
  assert.ok((await rows()).includes("orders.ts"), (await rows()).join(", "));
  assert.equal(await page!.getAttribute("#left-mode [data-left='tree']", "class"), "active");
  // Back to the lists.
  await page!.click("#left-mode [data-left='views']");
  await page!.waitForSelector("#views li.group");
  assert.equal(await page!.getAttribute("#left-mode [data-left='views']", "class"), "active");
});
