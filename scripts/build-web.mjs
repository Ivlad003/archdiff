// Bundles the page (web/src/app.ts) with esbuild into dist/web, with code
// splitting so the editor (web/src/editor.tsx, Excalidraw on React) and its
// locales load only when the user opens it; copies index.html and app.css, the fonts Excalidraw draws
// with (the hand-drawn one, the plain one and the monospace one; the
// rest fall back to system fonts), and the license of every package that
// ends up in a bundle as <package>.LICENSE. esbuild, maxGraph, React and
// Excalidraw are dev dependencies: the published package carries the
// built files, not the packages. The server builds the same way in a
// checkout when dist/web is missing (`buildWeb`).
//
// usage: node scripts/build-web.mjs [--outdir <dir>]
//
// Entry points: `buildWeb` (the server, in a checkout), and the script
// itself (`npm run web:build`, prepack).

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const require = createRequire(import.meta.url);

/** The font families the editor ships; Excalidraw fetches each file on demand from EXCALIDRAW_ASSET_PATH. */
const FONT_FAMILIES = ["Excalifont", "Nunito", "ComicShanns", "Cascadia", "Virgil", "Liberation", "Lilita", "Assistant"];

/** Builds the page into `outdir`. */
export async function buildWeb(outdir = join(root, "dist/web")) {
  const { build } = await import("esbuild");
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const result = await build({
    entryPoints: [join(root, "web/src/app.ts")],
    outdir,
    entryNames: "[name]",
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    target: "es2022",
    minify: true,
    sourcemap: false,
    metafile: true,
    legalComments: "none",
    logLevel: "silent",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"' },
    conditions: ["production"],
    // Mermaid import is a feature of Excalidraw's own UI that archdiff does not expose; left out of the bundle.
    external: ["@excalidraw/mermaid-to-excalidraw"],
    loader: { ".woff2": "file", ".ttf": "file", ".svg": "dataurl", ".png": "dataurl" },
    assetNames: "assets/[name]-[hash]",
  });

  // page.css is the page's own stylesheet; app.css is what esbuild extracts from the bundle (Excalidraw's).
  for (const name of ["index.html", "page.css"]) copyFileSync(join(root, "web", name), join(outdir, name));
  const fonts = join(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");

  for (const family of FONT_FAMILIES) {
    if (existsSync(join(fonts, family))) cpSync(join(fonts, family), join(outdir, "excalidraw/fonts", family), { recursive: true });
  }

  // The license of every bundled package, once.
  const packages = new Set();

  for (const input of Object.keys(result.metafile.inputs)) {
    const at = input.lastIndexOf("node_modules/");

    if (at === -1) continue;
    const parts = input.slice(at + "node_modules/".length).split("/");
    packages.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
  }

  for (const name of packages) {
    let directory;

    try {
      directory = dirname(require.resolve(`${name}/package.json`, { paths: [root] }));
    } catch {
      // A package whose exports hide package.json: look for it in node_modules directly.
      directory = join(root, "node_modules", name);
    }

    for (const candidate of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENSE.MIT"]) {
      const file = join(directory, candidate);

      if (existsSync(file)) {
        writeFileSync(join(outdir, `${name.replace("/", "__")}.LICENSE`), readFileSync(file));
        break;
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--outdir");
  await buildWeb(at === -1 ? undefined : resolve(process.argv[at + 1]));
}
