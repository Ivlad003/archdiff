// Draws the extension's icons from static/icons/icon.svg: the PNG files of
// 16, 32, 48 and 128 pixels the manifest names, which are committed. Run
// again only when the mark changes. Chrome draws them (playwright-core of
// the repository drives it, as in the page's tests), so the PNG is the SVG
// as a browser shows it, on no background.
//
// usage: node scripts/icons.mjs   (CHROME=<path> names another browser)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const icons = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "icons");
const CHROME = [process.env["CHROME"] ?? "", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe"].find((path) => path !== "" && existsSync(path));

if (!CHROME) throw new Error("no Chrome found: CHROME=<path> names one");
const { chromium } = createRequire(import.meta.url)("playwright-core");
const svg = readFileSync(join(icons, "icon.svg"), "utf8");
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html, body { margin: 0; background: transparent; } svg { display: block; width: ${size}px; height: ${size}px; }</style>${svg}`);
    writeFileSync(join(icons, `${size}.png`), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    await page.close();
  }
} finally {
  await browser.close();
}
