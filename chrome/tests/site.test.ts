// The builds page as an app, in a real Chrome on a phone's screen: its
// manifest and icons, a layout that fits the screen, and the page opened with
// no network and no server — from what its service worker and the last list
// of releases kept — coming back to the fresh list when the network does.
// GitHub's API is a stand-in here: nothing is asked of GitHub.
//
// Entry point: run by `npm test` in chrome/. Skipped without Chrome or
// playwright-core (the repository's own, which the page's tests use).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { test } from "node:test";

const repository = join(import.meta.dirname, "..", "..");
const site = join(repository, "site");
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((path) => existsSync(path));

interface Route {
  fulfill(answer: object): Promise<void>;
  abort(code: string): Promise<void>;
}

interface Page {
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
}

interface Context {
  route(pattern: string, handler: (route: Route) => Promise<void>): Promise<void>;
  setOffline(offline: boolean): Promise<void>;
  newPage(): Promise<Page>;
}

interface Browser {
  newContext(options: object): Promise<Context>;
  close(): Promise<void>;
}

function playwright(): { chromium: { launch(options: object): Promise<Browser> } } | null {
  try {
    return createRequire(join(repository, "package.json"))("playwright-core") as { chromium: { launch(options: object): Promise<Browser> } };
  } catch {
    return null;
  }
}

const unavailable = !CHROME ? "no Chrome installed" : playwright() === null ? "playwright-core is not installed (npm install in the repository)" : false;

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

/** The site's files over HTTP, as GitHub Pages serves them. */
function serveSite(): Promise<Server> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = normalize(join(site, path === "/" ? "index.html" : path));

    if (!file.startsWith(site) || !existsSync(file)) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });

  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function release(tag: string, chrome: string): object {
  const name = `archdiff-chrome-${chrome}.zip`;

  return { tag_name: tag, name: `archdiff ${tag}`, published_at: "2026-11-18T10:00:00Z", html_url: `https://github.com/Ivlad003/archdiff/releases/tag/${tag}`, assets: [{ name, size: 30_000, browser_download_url: `https://github.com/Ivlad003/archdiff/releases/download/${tag}/${name}` }] };
}

/** Asked again and again from outside the page: its policy lets no string be evaluated inside it. */
async function until(page: Page, expression: string, what: string): Promise<void> {
  for (let asked = 0; asked < 150; asked++) {
    if (await page.evaluate(expression).catch(() => false)) return;
    await page.waitForTimeout(100);
  }

  assert.fail(`${what}: ${String(await page.evaluate("document.body.innerText").catch(() => "the page cannot be read"))}`);
}

test("the manifest names what a phone needs to install the page, and every icon is there at its size", () => {
  const manifest = JSON.parse(readFileSync(join(site, "manifest.webmanifest"), "utf8")) as { name: string; short_name: string; start_url: string; scope: string; display: string; icons: { src: string; sizes: string; type: string; purpose: string }[] };

  // Relative: the page lives under /archdiff/ on GitHub Pages.
  assert.deepEqual([manifest.start_url, manifest.scope, manifest.display], ["./", "./", "standalone"]);
  assert.ok(manifest.name !== "" && manifest.short_name.length <= 12);
  assert.deepEqual(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`), ["192x192 any", "512x512 any", "512x512 maskable"]);

  for (const { src, sizes } of [...manifest.icons, { src: "icons/180.png", sizes: "180x180" }]) {
    const png = readFileSync(join(site, src));
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, sizes, src);
  }

  // What the service worker keeps is what the page loads.
  const worker = readFileSync(join(site, "sw.js"), "utf8");
  const kept = JSON.parse(/const SHELL = (\[[^\]]+\]);/.exec(worker)![1]!) as string[];

  for (const file of kept.filter((path) => path !== "./")) assert.ok(existsSync(join(site, file)), file);
  assert.deepEqual(["index.html", "builds.css", "builds.js", "icon.svg", "manifest.webmanifest"].filter((file) => !kept.includes(file)), []);
});

test("on a phone the page fits the screen, and with no network it still opens with the versions it knew", { skip: unavailable }, async () => {
  const server = await serveSite();
  const browser = await playwright()!.chromium.launch({ executablePath: CHROME, headless: true });
  let network = true;
  let list = [release("v0.9.0", "0.1.0")];

  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-US" });
    await context.route("https://api.github.com/**", (route) => (network ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(list) }) : route.abort("internetdisconnected")));
    const page = await context.newPage();
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    await page.goto(address);
    await until(page, `document.body.dataset.state === "drawn" && document.querySelectorAll("a.download").length === 1`, "the list of builds");
    await until(page, "navigator.serviceWorker.controller !== null", "the service worker taking the page over");

    // The phone's screen, and the narrowest one in use: nothing runs off its side, and a download is big enough to tap.
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), true, `the page scrolls sideways at ${width} pixels`);
      assert.ok((await page.evaluate(`document.querySelector("a.download").getBoundingClientRect().height`)) as number >= 44);
    }

    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector(".phone-note")).display`), "block", "a phone is told the extensions are for a computer");
    assert.equal(await page.evaluate(`document.querySelector("#saved")`), null, "a fresh list says nothing of its age");

    // No network, and the site itself gone: the page, its styles and the last list are what was kept.
    network = false;
    await context.setOffline(true);
    await new Promise((resolve) => server.close(resolve));
    await page.reload();
    await until(page, `document.body.dataset.state === "drawn" && document.querySelector("#saved") !== null`, "the page without a network");
    assert.match((await page.evaluate(`document.querySelector("#saved").textContent`)) as string, /^GitHub cannot be reached right now\. This list was saved on \w+ \d+, \d{4}\. Downloads need a connection\.$/);
    assert.equal(await page.evaluate(`document.querySelector("a.download strong").textContent`), "Chrome extension");
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector("a.download")).pointerEvents`), "none", "a download cannot start without a network");
    assert.notEqual(await page.evaluate(`getComputedStyle(document.body).backgroundColor`), "rgba(0, 0, 0, 0)", "the page's styles were kept");

    // The network comes back: the fresh list, by itself, and the note gone.
    list = [release("v0.10.0", "0.2.0"), ...list];
    network = true;
    await context.setOffline(false);
    await until(page, `document.querySelector("#saved") === null && document.querySelector("a.download span").textContent.startsWith("0.2.0")`, "the fresh list");
    assert.equal(await page.evaluate(`document.documentElement.classList.contains("offline")`), false);
  } finally {
    await browser.close();
    server.close();
  }
});
