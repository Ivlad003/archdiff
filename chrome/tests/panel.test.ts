// The panel in a real Chrome: the extension as `npm run build` builds it,
// loaded unpacked over the debugging protocol, its panel opened as a page
// pinned to an address of GitHub (`?url=`), beside the archdiff of this
// checkout serving a repository whose remote is that address's. What Chrome
// allows is what is tested — the extension's page framing a local server and
// reading its API — with the panel's own answers: the picture of a
// comparison from where the head left the base, the place a tapped shape
// goes to on GitHub, and what it says when no server serves the repository
// or the checkout lacks the commits. Nothing is asked of GitHub: a
// comparison, a branch and a commit are read from the address alone.
//
// Entry point: run by `npm test` in chrome/. Skipped without Chrome or
// playwright-core (the repository's own, which the page's tests use).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildExtension } from "../scripts/build.mjs";
import { anchorOf } from "../src/github.ts";
import { startArchdiff } from "./server.ts";

const repository = join(import.meta.dirname, "..", "..");
const fixture = join(repository, "tests", "fixtures", "sample");
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((path) => existsSync(path));

/** What the test uses of playwright-core, which the extension does not depend on. */
interface Frame {
  url(): string;
  evaluate(script: string): Promise<unknown>;
  waitForFunction(script: string, arg?: unknown, options?: object): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
}

interface Page extends Frame {
  goto(url: string): Promise<unknown>;
  frames(): Frame[];
  mouse: { move(x: number, y: number): Promise<void>; down(): Promise<void>; up(): Promise<void> };
  close(): Promise<void>;
}

interface Context {
  browser(): { newBrowserCDPSession(): Promise<{ send(method: string, params: object): Promise<{ id: string }> }> } | null;
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

function playwright(): { chromium: { launchPersistentContext(profile: string, options: object): Promise<Context> } } | null {
  try {
    return createRequire(join(repository, "package.json"))("playwright-core") as { chromium: { launchPersistentContext(profile: string, options: object): Promise<Context> } };
  } catch {
    return null;
  }
}

const unavailable = !CHROME ? "no Chrome installed" : playwright() === null ? "playwright-core is not installed (npm install in the repository)" : false;

let dir = "";
let profile = "";
let extension = "";
let origin = "";
let panel = "";
let fork = "";
let stop: (() => Promise<void>) | null = null;
let context: Context | null = null;

function git(...args: string[]): string {
  const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  return result.stdout.trim();
}

before(async () => {
  if (unavailable) return;
  // A checkout of github.com/acme/shop: main, and a branch `feature/loud` that changes one module — as a fetch leaves
  // them, under the remote too. main has gone on since the branch left it.
  dir = mkdtempSync(join(tmpdir(), "archdiff-chrome-"));
  cpSync(fixture, dir, { recursive: true });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://reader:secret@github.com/acme/shop.git");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  fork = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feature/loud");
  writeFileSync(join(dir, "src/lib/log.ts"), "export function log(message: string): void {\n  console.error(message);\n}\n");
  git("commit", "-q", "-am", "loud");
  git("update-ref", "refs/remotes/origin/feature/loud", "HEAD");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "README.md"), "# shop\n");
  git("add", ".");
  git("commit", "-q", "-m", "a readme");
  git("update-ref", "refs/remotes/origin/main", "HEAD");

  const started = startArchdiff(dir);
  stop = started.stop;
  origin = await started.origin;

  extension = mkdtempSync(join(tmpdir(), "archdiff-chrome-built-"));
  await buildExtension(extension, {});
  profile = mkdtempSync(join(tmpdir(), "archdiff-chrome-profile-"));
  // Chrome's own build takes no extension from its command line any more: it is loaded over the debugging protocol.
  // In English, whatever the language of the computer: the panel's texts are the browser's language's (`--lang` on
  // Windows and macOS, the environment on Linux).
  context = await playwright()!.chromium.launchPersistentContext(profile, { executablePath: CHROME, headless: true, viewport: { width: 1000, height: 900 }, ignoreDefaultArgs: ["--disable-extensions"], args: ["--enable-unsafe-extension-debugging", "--lang=en-US"], env: { ...process.env, LANGUAGE: "en_US", LC_ALL: "en_US.UTF-8" } });
  const browser = context.browser();
  assert.ok(browser, "the browser of the context");
  const loaded = await (await browser.newBrowserCDPSession()).send("Extensions.loadUnpacked", { path: extension });
  panel = `chrome-extension://${loaded.id}/panel.html`;
});

after(async () => {
  await context?.close().catch(() => undefined);
  await stop?.();

  for (const made of [dir, extension, profile]) {
    try {
      if (made !== "") rmSync(made, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Chrome may still hold a file of its profile on Windows: the system's temporary directory is cleared in time.
    }
  }
});

/** The panel pinned to an address of GitHub, asking the test's server too (it listens on a port of its own). */
async function open(address: string): Promise<Page> {
  const page = await context!.newPage();
  await page.goto(`${panel}?url=${encodeURIComponent(address)}&server=${encodeURIComponent(origin)}`);

  return page;
}

/** Waits until an expression of the panel is true — asked, not waited for inside the page, whose policy lets no string be evaluated there — and gives the panel's state when it never is. */
async function until(page: Page, expression: string, what: string): Promise<void> {
  for (let asked = 0; asked < 150; asked++) {
    if (await page.evaluate(expression)) return;
    await page.waitForTimeout(100);
  }

  assert.fail(`${what}: ${JSON.stringify(await page.evaluate(`({ state: document.body.dataset.state, frame: document.body.dataset.frame, title: document.getElementById("card-title").textContent, text: document.getElementById("card-text").textContent })`))}`);
}

function text(page: Page, id: string): Promise<string> {
  return page.evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`) as Promise<string>;
}

test("a comparison is reviewed from where the head left the base, in the frame of the server's page; a tapped shape goes to its file on GitHub", { skip: unavailable }, async () => {
  const page = await open("https://github.com/acme/shop/compare/main...feature/loud");

  try {
    await until(page, `document.body.dataset.state === "showing"`, "the picture");
    // The base is the merge-base, not main as it is now: what main gained since is not the branch's doing.
    const address = `${origin}/?embed=1&host=1#view=review&base=${fork}&head=origin%2Ffeature%2Floud`;
    assert.equal(await page.evaluate(`document.body.dataset.frame`), address);
    assert.equal(await text(page, "repository"), "acme/shop");
    assert.equal(await text(page, "subject"), "main ← feature/loud");
    assert.deepEqual(await page.evaluate(`[...document.getElementById("picture").options].map((option) => option.value)`), ["review", "changes", "impact", "timeline", "code"]);

    // Chrome lets the extension's page frame the local server, and the server's page draws there.
    const frame = page.frames().find((candidate) => candidate.url().startsWith(origin));
    assert.ok(frame, "the frame on the server's page");
    await frame.waitForFunction(`window.archdiff?.drawn() === "review"`, undefined, { timeout: 30_000 });
    await frame.waitForTimeout(1000);

    // A message of the page's type from anywhere but the frame sends the tab nowhere.
    await page.evaluate(`window.postMessage({ type: "archdiff:open", file: "src/forged.ts", line: 1 }, "*")`);
    const at = (await frame.evaluate(`(() => {
      const shape = window.archdiff.canvas().scene().find((element) => element.id === "src/lib/log.ts" && !element.isDeleted);
      const viewport = window.archdiff.canvas().viewport();
      const box = document.querySelector(".excalidraw__canvas.interactive").getBoundingClientRect();
      return { x: box.left + (shape.x + shape.width / 2 + viewport.scrollX) * viewport.zoom, y: box.top + (shape.y + shape.height / 2 + viewport.scrollY) * viewport.zoom };
    })()`)) as { x: number; y: number };
    const framed = (await page.evaluate(`(() => { const box = document.getElementById("page").getBoundingClientRect(); return { x: box.left, y: box.top }; })()`)) as { x: number; y: number };
    await page.mouse.move(framed.x + at.x, framed.y + at.y);
    await page.mouse.down();
    await page.mouse.up();
    await until(page, `document.body.dataset.went !== undefined`, "the place of the tapped shape");
    // The change touched the file: its place is in the comparison's list of files, under the anchor of its path.
    assert.equal(await page.evaluate(`document.body.dataset.went`), `https://github.com/acme/shop/compare/main...feature/loud#${await anchorOf("src/lib/log.ts")}`);

    // Another picture of the same change is another view of the page already there, not loaded again.
    await frame.evaluate(`window.sameWindow = true`);
    await page.evaluate(`(() => { const select = document.getElementById("picture"); select.value = "code"; select.dispatchEvent(new Event("change")); })()`);
    await frame.waitForFunction(`window.archdiff.drawn() === "layers"`, undefined, { timeout: 30_000 });
    assert.equal(await frame.evaluate(`window.sameWindow`), true, "the page was loaded again");
    assert.equal(await page.evaluate(`document.body.dataset.frame`), `${origin}/?embed=1&host=1#view=layers&head=origin%2Ffeature%2Floud`);
  } finally {
    await page.close();
  }
});

test("a branch off the main line is reviewed against it, a file of the main line is its module, a commit is its own change", { skip: unavailable }, async () => {
  const branch = await open("https://github.com/acme/shop/tree/feature/loud/src/lib");
  const file = await open("https://github.com/acme/shop/blob/main/src/lib/orders.ts");
  const commit = await open(`https://github.com/acme/shop/commit/${fork}`);

  try {
    await until(branch, `document.body.dataset.state === "showing"`, "the branch's picture");
    // The branch's name ends where the checkout's branches say, not at the first slash.
    assert.equal(await text(branch, "subject"), "feature/loud");
    assert.equal(await branch.evaluate(`document.body.dataset.frame`), `${origin}/?embed=1&host=1#view=review&head=origin%2Ffeature%2Floud`);

    await until(file, `document.body.dataset.state === "showing"`, "the file's picture");
    assert.equal(await text(file, "subject"), "src/lib/orders.ts @ main");
    assert.equal(await file.evaluate(`document.body.dataset.frame`), `${origin}/?embed=1&host=1#view=module%3Asrc%2Flib%2Forders.ts&head=origin%2Fmain`);
    assert.deepEqual(await file.evaluate(`[...document.getElementById("picture").options].map((option) => option.value)`), ["module", "inside", "code", "modules"]);

    await until(commit, `document.body.dataset.state === "showing"`, "the commit's picture");
    assert.equal(await text(commit, "subject"), `commit ${fork.slice(0, 7)}`);
    assert.equal(await commit.evaluate(`document.body.dataset.frame`), `${origin}/?embed=1&host=1#view=commit%3A${fork}`);
  } finally {
    await Promise.all([branch.close(), file.close(), commit.close()]);
  }
});

test("without a server of the repository the panel says so and names what it found; commits the checkout lacks are named with the command that fetches them", { skip: unavailable }, async () => {
  const other = await open("https://github.com/acme/other/tree/main");
  const missing = await open("https://github.com/acme/shop/compare/main...not-fetched");
  const elsewhere = await open("https://example.com/acme/shop");

  try {
    await until(other, `document.body.dataset.state === "no-server"`, "the card of no server");
    assert.equal(await text(other, "card-title"), "No archdiff serves acme/other on this computer");
    assert.equal(await text(other, "command"), "npx @ivlad003/archdiff web");
    // What was found instead: the server of the test, by its remote — the host and the path, without the name and the password of its address.
    const found = await text(other, "card-found");
    assert.ok(found.includes(origin.replace("http://", "")) && found.includes("(github.com/acme/shop)"), found);
    assert.ok(!found.includes("secret") && !found.includes("reader"), found);

    await until(missing, `document.body.dataset.state === "missing"`, "the card of the missing commits");
    assert.equal(await text(missing, "card-title"), "This checkout has not got main ← not-fetched yet");
    assert.equal(await text(missing, "command"), "git fetch origin");

    await until(elsewhere, `document.body.dataset.state === "idle"`, "the card of another site");
    assert.equal(await text(elsewhere, "card-title"), "Nothing to draw here");
  } finally {
    await Promise.all([other.close(), missing.close(), elsewhere.close()]);
  }
});
