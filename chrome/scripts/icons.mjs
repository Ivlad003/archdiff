// Draws the icons from static/icons/icon.svg: the PNG files of 16, 32, 48 and
// 128 pixels the extension's manifest names, and those of the builds page
// when it is installed as an app (site/icons: 192 and 512 pixels, one on a
// white ground for iOS, and one a phone may cut to any shape, the mark inside
// its safe zone). They are committed: run this again only when the mark
// changes. Chrome draws them (playwright-core of the repository drives it,
// as in the page's tests), so the PNG is the SVG as a browser shows it.
//
// usage: node scripts/icons.mjs   (CHROME=<path> names another browser)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const chrome = join(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(chrome, "static", "icons");
const site = join(chrome, "..", "site", "icons");
const CHROME = [process.env["CHROME"] ?? "", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe"].find((path) => path !== "" && existsSync(path));

if (!CHROME) throw new Error("no Chrome found: CHROME=<path> names one");
const { chromium } = createRequire(import.meta.url)("playwright-core");
const svg = readFileSync(join(icons, "icon.svg"), "utf8");

/** What to draw: the file, its size, the ground under the mark (none: transparent) and the share of the icon the mark takes. */
const DRAWN = [
  ...[16, 32, 48, 128].map((size) => ({ file: join(icons, `${size}.png`), size, ground: null, mark: 1 })),
  { file: join(site, "192.png"), size: 192, ground: null, mark: 1 },
  { file: join(site, "512.png"), size: 512, ground: null, mark: 1 },
  { file: join(site, "180.png"), size: 180, ground: "#ffffff", mark: 0.72 },
  { file: join(site, "maskable-512.png"), size: 512, ground: "#ffffff", mark: 0.6 },
];

mkdirSync(site, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

try {
  for (const { file, size, ground, mark } of DRAWN) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const side = Math.round(size * mark);
    await page.setContent(`<style>html, body { margin: 0; background: ${ground ?? "transparent"}; } body { display: grid; place-items: center; width: ${size}px; height: ${size}px; } svg { display: block; width: ${side}px; height: ${side}px; }</style>${svg}`);
    writeFileSync(file, await page.screenshot({ omitBackground: ground === null, clip: { x: 0, y: 0, width: size, height: size } }));
    await page.close();
  }
} finally {
  await browser.close();
}
