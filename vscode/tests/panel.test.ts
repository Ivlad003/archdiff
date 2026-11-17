// The panel's document (src/panel.ts): what its policy allows, how the
// address is written into it, and which messages count as a place to open.
// With Chrome and the archdiff of this checkout around — the tests run in
// the repository — the document is loaded for real, as the editor's webview
// loads it: the page in its frame tells the script the place of a tapped
// shape, the script hands it on, and an address shown changes the view
// without loading the page again.
//
// Entry point: run by `npm test` in vscode/.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isOpenMessage, panelHtml } from "../src/panel.ts";
import { originOf } from "../src/runner.ts";
import { pageUrl } from "../src/views.ts";

const ORIGIN = "http://127.0.0.1:7123";

test("the document frames the page on the server's origin, and its policy allows that frame, one script and one style", () => {
  const html = panelHtml(pageUrl(ORIGIN, "calls:src/a.ts#f", true), ORIGIN, "Tm9uY2U=");

  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:7123; style-src 'nonce-Tm9uY2U='; script-src 'nonce-Tm9uY2U='">`), html);
  // The address in an attribute: its ampersand written as one.
  assert.ok(html.includes(`<iframe id="page" src="http://127.0.0.1:7123/?host=1&amp;embed=1#view=calls%3Asrc%2Fa.ts%23f" allow="clipboard-read; clipboard-write"></iframe>`), html);
  assert.ok(html.includes(`<script nonce="Tm9uY2U=">`) && html.includes(`<style nonce="Tm9uY2U=">`), html);
  assert.ok(html.includes(`const origin = "http://127.0.0.1:7123";`), html);
  // A quote in an address cannot close the attribute.
  assert.ok(panelHtml(`${ORIGIN}/?host=1#view="><script>`, ORIGIN, "n").includes(`src="http://127.0.0.1:7123/?host=1#view=&quot;>&lt;script>"`));
});

test("a place to open is a file and a whole line from 1, of the page's type; anything else is not", () => {
  assert.equal(isOpenMessage({ type: "archdiff:open", file: "src/a.ts", line: 3 }), true);
  assert.equal(isOpenMessage({ type: "archdiff:open", file: "src/a.ts", line: 3, endLine: 9, head: "main" }), true);

  for (const other of [null, undefined, "archdiff:open", [], {}, { type: "archdiff:show", url: "x" }, { type: "archdiff:open", file: "src/a.ts" }, { type: "archdiff:open", file: "", line: 1 }, { type: "archdiff:open", file: "src/a.ts", line: 0 }, { type: "archdiff:open", file: "src/a.ts", line: 1.5 }, { type: "archdiff:open", file: 7, line: 1 }, { type: "archdiff:open", file: "src/a.ts", line: "3" }]) {
    assert.equal(isOpenMessage(other), false, JSON.stringify(other));
  }
});

// ── The document in a browser, on the archdiff of this checkout ──────────────

const repository = join(import.meta.dirname, "..", "..");
const bin = join(repository, "bin", "archdiff.js");
const fixture = join(repository, "tests", "fixtures", "sample");
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((path) => existsSync(path));

/** playwright-core, which the repository's own page tests drive Chrome with; null where it is not installed. */
function playwright(): { chromium: { launch(options: object): Promise<Browser> } } | null {
  try {
    return createRequire(join(repository, "package.json"))("playwright-core") as { chromium: { launch(options: object): Promise<Browser> } };
  } catch {
    return null;
  }
}

/** What the test uses of playwright-core, which the extension itself does not depend on. */
interface Frame {
  waitForFunction(script: string, arg?: unknown, options?: object): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(script: string): Promise<unknown>;
}

interface Page extends Frame {
  addInitScript(script: string): Promise<void>;
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string): Promise<{ contentFrame(): Promise<Frame | null> }>;
  mouse: { move(x: number, y: number): Promise<void>; down(): Promise<void>; up(): Promise<void> };
}

interface Browser {
  newPage(options: object): Promise<Page>;
  close(): Promise<void>;
}

const unavailable = !existsSync(bin) ? "not in the archdiff repository" : !CHROME ? "no Chrome installed" : playwright() === null ? "playwright-core is not installed (npm install in the repository)" : false;

test("in a browser: the page in the panel's frame tells of a tapped shape and the script hands it to the editor; an address shown changes the view in place", { skip: unavailable }, async () => {
  // A home of the test's own: the server reads no settings of the person who runs the tests.
  const home = mkdtempSync(join(tmpdir(), "archdiff-vscode-home-"));
  const server = spawn(process.execPath, [bin, "web", fixture, "--port", "0", "--no-watch"], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ARCHDIFF_HOME: home } });
  const browser = await playwright()!.chromium.launch({ executablePath: CHROME, headless: true });
  const closing: (() => void)[] = [];

  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let written = "";
      server.stderr.on("data", (chunk: Buffer) => {
        written += chunk.toString();
        const found = originOf(written);

        if (found) resolve(found);
      });
      server.once("exit", (code) => reject(new Error(`archdiff web ended with ${code}: ${written}`)));
    });
    const page = await browser.newPage({ viewport: { width: 1900, height: 1000 } });
    // The editor's side of the webview: what the script is handed, and what it hands on.
    await page.addInitScript(`window.handed = []; window.acquireVsCodeApi = () => ({ postMessage: (message) => window.handed.push(message) });`);
    // The document is served as the webview serves it: from an origin of its own, not the server's (on this computer
    // too: a browser lets no page of the network frame a local one).
    const html = panelHtml(pageUrl(origin, "module:src/lib/orders.ts", false).replace("#", "#depth=0&"), origin, "bm9uY2U=");
    const editor = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html));
    await new Promise<void>((resolve) => editor.listen(0, "127.0.0.1", resolve));
    closing.push(() => editor.close());
    await page.goto(`http://127.0.0.1:${(editor.address() as AddressInfo).port}/`);
    const frame = await (await page.waitForSelector("iframe#page")).contentFrame();
    assert.ok(frame, "the panel's frame");
    await frame.waitForFunction(`window.archdiff?.drawn() === "module:src/lib/orders.ts"`);
    await frame.waitForTimeout(1000);

    // A message of the same type from anywhere but the frame is not handed on.
    await page.evaluate(`window.postMessage({ type: "archdiff:open", file: "src/forged.ts", line: 1 }, "*")`);
    // The frame fills the document: a point of the frame is the same point of the document.
    const at = (await frame.evaluate(`(() => {
      const shape = window.archdiff.canvas().scene().find((element) => element.id === "src/lib/orders.ts" && !element.isDeleted);
      const viewport = window.archdiff.canvas().viewport();
      const box = document.querySelector(".excalidraw__canvas.interactive").getBoundingClientRect();
      return { x: box.left + (shape.x + shape.width / 2 + viewport.scrollX) * viewport.zoom, y: box.top + (shape.y + shape.height / 2 + viewport.scrollY) * viewport.zoom };
    })()`)) as { x: number; y: number };
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up();
    // Asked, not waited for inside the document: its policy lets no string be evaluated there.
    for (let asked = 0; asked < 80 && ((await page.evaluate(`window.handed`)) as unknown[]).length === 0; asked++) await frame.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(`window.handed`), [{ type: "archdiff:open", file: "src/lib/orders.ts", line: 1 }]);

    // The extension shows another view: the page draws it where it is, not loaded again (its window is the same one).
    await frame.evaluate(`window.sameWindow = true`);
    await page.evaluate(`window.postMessage({ type: "archdiff:show", url: ${JSON.stringify(pageUrl(origin, "layers", false))} }, "*")`);
    await frame.waitForFunction(`window.archdiff.drawn() === "layers"`, undefined, { timeout: 15_000 });
    assert.equal(await frame.evaluate(`window.sameWindow`), true, "the page was loaded again");
    // An address of another site is not shown.
    await page.evaluate(`window.postMessage({ type: "archdiff:show", url: "http://elsewhere.test/?host=1" }, "*")`);
    await frame.waitForTimeout(300);
    assert.equal(await page.evaluate(`document.getElementById("page").src`), pageUrl(origin, "layers", false));
  } finally {
    await browser.close();
    closing.forEach((close) => close());
    server.kill();
    await new Promise((resolve) => (server.exitCode === null && server.signalCode === null ? server.once("exit", resolve) : resolve(null)));
    rmSync(home, { recursive: true, force: true });
  }
});
