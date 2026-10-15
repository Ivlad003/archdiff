// Bundles the page (web/src/app.ts) with esbuild into dist/web/app.js and
// copies index.html and app.css beside it, with the license of every
// package that ends up in the bundle (@maxgraph/core) as <package>.LICENSE.
// esbuild and maxGraph are dev dependencies: the published package carries
// the built files, not the packages. The server builds the same way in a
// checkout when dist/web is missing (`buildWeb`).
//
// usage: node scripts/build-web.mjs [--outdir <dir>]

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const require = createRequire(import.meta.url);

function writeAtomic(file, contents) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, file);
}

/** Builds the page into `outdir`. */
export async function buildWeb(outdir = join(root, "dist/web")) {
  const { build } = await import("esbuild");
  mkdirSync(outdir, { recursive: true });
  const result = await build({
    entryPoints: [join(root, "web/src/app.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    sourcemap: false,
    write: false,
    metafile: true,
    legalComments: "none",
    logLevel: "silent",
  });

  for (const file of result.outputFiles) writeAtomic(join(outdir, "app.js"), file.contents);

  for (const name of ["index.html", "app.css"]) copyFileSync(join(root, "web", name), join(outdir, name));

  // The license of every bundled package, once.
  const packages = new Set();

  for (const input of Object.keys(result.metafile.inputs)) {
    const at = input.lastIndexOf("node_modules/");

    if (at === -1) continue;
    const parts = input.slice(at + "node_modules/".length).split("/");
    packages.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
  }

  for (const name of packages) {
    const directory = dirname(require.resolve(`${name}/package.json`));

    for (const candidate of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"]) {
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
