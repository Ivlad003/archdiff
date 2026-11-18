// Builds the extension into chrome/dist — the folder Chrome loads unpacked —
// and, with --zip, packs that folder as archdiff-chrome-<version>.zip, the
// build people download. The panel's and the worker's scripts are bundled
// with esbuild (the repository's own: this package installs nothing), not
// minified, so that what runs can be read; the panel's page, its texts and
// the icons are copied from static/; the builds page (site/, the one
// GitHub Pages serves) is copied in as builds/, so the extension can say
// whether it is the newest build; the manifest is stamped with the version
// of package.json.
//
// A build between releases is stamped apart: ARCHDIFF_BUILD=<number> makes
// the version <version>.<number>, which Chrome reads as newer than
// <version> and older than the next release, and ARCHDIFF_COMMIT=<sha>
// names the commit in the version people see.
//
// usage: node scripts/build.mjs [--zip] [--outdir <dir>]
//
// Entry points: `buildExtension`, `zip`, `stampOf`, and the script itself
// (`npm run build`, `npm run package`).

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repository = join(root, "..");

/**
 * The version a build carries: the manifest's (one to four numbers, which is all Chrome compares) and the one people
 * see. A release is the version of package.json; a build between releases adds its number as the fourth.
 * @param {string} version
 * @param {{ build?: string | undefined, commit?: string | undefined }} [stamp]
 * @returns {{ version: string, name: string }}
 */
export function stampOf(version, stamp = {}) {
  const build = stamp.build !== undefined && /^\d+$/.test(stamp.build) ? Number(stamp.build) : null;

  if (build === null) return { version, name: version };

  // Chrome takes no number over 65535 in a version: a build number past it wraps around rather than failing the build.
  return { version: `${version}.${build % 65536}`, name: `${version} build ${build}${stamp.commit ? ` (${stamp.commit.slice(0, 7)})` : ""}` };
}

/**
 * Every file under a directory, as paths relative to it with slashes, sorted: the same order on every system.
 * @param {string} directory
 * @returns {string[]}
 */
function filesUnder(directory) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);

      if (statSync(path).isDirectory()) walk(path);
      else found.push(relative(directory, path).split("\\").join("/"));
    }
  };
  walk(directory);

  return found.sort();
}

/** The date every file of the archive carries (2026-01-01, as DOS writes it): the same sources pack to the same bytes. */
const ZIP_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * A zip archive of the entries given, deflated: the format's local headers, central directory and end record, with
 * names in UTF-8. No zip64 — an extension is far under four gigabytes and sixty-five thousand files.
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {Buffer}
 */
export function zip(entries) {
  /** @type {Buffer[]} */
  const files = [];
  /** @type {Buffer[]} */
  const directory = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const named = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    // A file deflate does not make smaller (an image) is stored as it is.
    const [method, stored] = deflated.length < data.length ? [8, deflated] : [0, data];
    const sum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(ZIP_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(named.length, 26);
    files.push(local, named, stored);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(ZIP_DATE, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(stored.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(named.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, named);
    offset += local.length + named.length + stored.length;
  }

  const listed = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(listed.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...files, listed, end]);
}

/**
 * Builds the extension into `outdir` and says the version it carries.
 * @param {string} [outdir]
 * @param {{ build?: string | undefined, commit?: string | undefined }} [stamp]
 * @returns {Promise<{ outdir: string, version: string, name: string }>}
 */
export async function buildExtension(outdir = join(root, "dist"), stamp = { build: process.env["ARCHDIFF_BUILD"], commit: process.env["ARCHDIFF_COMMIT"] }) {
  const { build } = await import("esbuild");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const stamped = stampOf(version, stamp);
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  await build({
    entryPoints: [join(root, "src/panel.ts"), join(root, "src/background.ts")],
    outdir,
    bundle: true,
    format: "esm",
    target: "chrome116",
    minify: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  });
  cpSync(join(root, "static"), outdir, { recursive: true });
  cpSync(join(repository, "site"), join(outdir, "builds"), { recursive: true });
  cpSync(join(root, "LICENSE"), join(outdir, "LICENSE"));
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  writeFileSync(join(outdir, "manifest.json"), `${JSON.stringify({ ...manifest, version: stamped.version, ...(stamped.name === stamped.version ? {} : { version_name: stamped.name }) }, null, 2)}\n`);

  return { outdir, ...stamped };
}

/**
 * The built extension as the archive people download: every file of `outdir`, the manifest at the archive's root.
 * @param {string} outdir
 * @returns {Buffer}
 */
export function zipExtension(outdir) {
  return zip(filesUnder(outdir).map((name) => ({ name, data: readFileSync(join(outdir, name)) })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const named = args.indexOf("--outdir");
  const built = await buildExtension(named >= 0 && args[named + 1] ? resolve(args[named + 1] ?? "") : undefined);
  process.stdout.write(`archdiff for GitHub ${built.name}: ${relative(process.cwd(), built.outdir) || "."}\n`);

  if (args.includes("--zip")) {
    const file = join(root, `archdiff-chrome-${built.version}.zip`);
    writeFileSync(file, zipExtension(built.outdir));
    process.stdout.write(`${relative(process.cwd(), file)}\n`);
  }
}
