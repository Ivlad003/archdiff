// The build of the extension (scripts/build.mjs): the version a build
// carries, the archive people download — read back here file by file — what
// the built folder holds and asks of Chrome, and the panel's texts: every
// text the panel says is in both languages.
//
// Entry point: run by `npm test` in chrome/.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { buildExtension, stampOf, zip, zipExtension } from "../scripts/build.mjs";

const root = join(import.meta.dirname, "..");

test("a release carries the version of package.json; a build between releases is newer than it and older than the next", () => {
  assert.deepEqual(stampOf("0.1.0"), { version: "0.1.0", name: "0.1.0" });
  assert.deepEqual(stampOf("0.1.0", { build: undefined, commit: "1a2b3c4d5e6f" }), { version: "0.1.0", name: "0.1.0" });
  assert.deepEqual(stampOf("0.1.0", { build: "57", commit: "1a2b3c4d5e6f" }), { version: "0.1.0.57", name: "0.1.0 build 57 (1a2b3c4)" });
  assert.deepEqual(stampOf("0.1.0", { build: "57" }), { version: "0.1.0.57", name: "0.1.0 build 57" });
  // What is no number is no build number; one past what Chrome takes in a version wraps around.
  assert.equal(stampOf("0.1.0", { build: "abc" }).version, "0.1.0");
  assert.equal(stampOf("0.1.0", { build: "65537" }).version, "0.1.0.1");
});

/** The files of a zip archive, read from its central directory as an unzipper reads it. */
function unzip(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "the end record");
  const files = new Map<string, Buffer>();
  let at = archive.readUInt32LE(end + 16);

  for (let index = 0; index < archive.readUInt16LE(end + 10); index++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50, "an entry of the directory");
    const method = archive.readUInt16LE(at + 10);
    const packed = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const named = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + named).toString("utf8");
    assert.equal(archive.readUInt32LE(local), 0x04034b50, `the local header of ${name}`);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const stored = archive.subarray(start, start + packed);
    const data = method === 8 ? inflateRawSync(stored) : Buffer.from(stored);
    assert.equal(data.length, size, name);
    files.set(name, data);
    at += 46 + named + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }

  return files;
}

test("the archive holds every file as it was, and the same files pack to the same bytes", () => {
  const text = Buffer.from("the same line, again and again\n".repeat(200));
  // Bytes deflate cannot shorten are stored as they are.
  const noise = Buffer.from(Array.from({ length: 300 }, (_unused, index) => (index * 151 + 7) % 256));
  const entries = [{ name: "manifest.json", data: Buffer.from("{}") }, { name: "_locales/uk/текст.json", data: text }, { name: "icons/16.png", data: noise }, { name: "empty", data: Buffer.alloc(0) }];
  const archive = zip(entries);
  const files = unzip(archive);

  assert.deepEqual([...files.keys()], entries.map((entry) => entry.name));

  for (const entry of entries) assert.ok(files.get(entry.name)!.equals(entry.data), entry.name);
  assert.ok(archive.length < text.length, "the text is deflated");
  assert.ok(zip(entries).equals(archive));
});

test("the built folder is the extension Chrome loads: its manifest stamped, its scripts bundled, the builds page inside", async () => {
  const outdir = mkdtempSync(join(tmpdir(), "archdiff-chrome-build-"));

  try {
    const built = await buildExtension(outdir, { build: "12", commit: "1a2b3c4d5e" });
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
    assert.deepEqual(built, { outdir, version: `${version}.12`, name: `${version} build 12 (1a2b3c4)` });

    const manifest = JSON.parse(readFileSync(join(outdir, "manifest.json"), "utf8")) as { version: string; version_name: string; permissions: string[]; host_permissions: string[]; background: { service_worker: string }; side_panel: { default_path: string }; icons: Record<string, string>; content_security_policy: { extension_pages: string } };
    assert.equal(manifest.version, `${version}.12`);
    assert.equal(manifest.version_name, `${version} build 12 (1a2b3c4)`);
    // What the extension asks of Chrome, and no more: the side panel, its own storage, GitHub's pages and this computer's ports.
    assert.deepEqual(manifest.permissions, ["sidePanel", "storage"]);
    assert.deepEqual(manifest.host_permissions, ["https://github.com/*", "http://127.0.0.1/*", "http://localhost/*"]);
    // Its pages frame this computer's servers only, and run no script but their own.
    assert.ok(manifest.content_security_policy.extension_pages.includes("script-src 'self'") && manifest.content_security_policy.extension_pages.includes("frame-src http://127.0.0.1:* http://localhost:*"), manifest.content_security_policy.extension_pages);

    for (const file of [manifest.background.service_worker, manifest.side_panel.default_path, ...Object.values(manifest.icons), "panel.js", "panel.css", "_locales/en/messages.json", "_locales/uk/messages.json", "builds/index.html", "builds/builds.js", "builds/builds.css", "builds/icon.svg", "LICENSE"]) assert.ok(existsSync(join(outdir, file)), file);

    // A bundle: nothing left to import, and no part of Node in it.
    for (const script of ["panel.js", "background.js"]) assert.ok(!/^\s*import\s/m.test(readFileSync(join(outdir, script), "utf8")), script);

    // A release has no name apart from its version.
    assert.ok(!("version_name" in (JSON.parse(readFileSync(join((await buildExtension(outdir, {})).outdir, "manifest.json"), "utf8")) as object)));
    // The archive has the manifest at its root, where Chrome looks for it.
    const packed = unzip(zipExtension(outdir));
    assert.equal((JSON.parse(packed.get("manifest.json")!.toString("utf8")) as { version: string }).version, version);
    assert.ok(packed.has("panel.html") && packed.has("_locales/uk/messages.json") && packed.has("icons/128.png"));
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});

test("every text the panel says is in both languages", () => {
  const messages = (language: string): Record<string, { message: string }> => JSON.parse(readFileSync(join(root, "static", "_locales", language, "messages.json"), "utf8")) as Record<string, { message: string }>;
  const english = messages("en");
  const ukrainian = messages("uk");
  const said = new Set<string>();
  const panel = readFileSync(join(root, "src", "panel.ts"), "utf8");
  const page = readFileSync(join(root, "static", "panel.html"), "utf8");

  // The texts said by name in the panel's script, the ones its page marks, the manifest's own, and a picture's name for every picture there is.
  for (const found of panel.matchAll(/\bsay\("([a-z_]+)"/g)) said.add(found[1]!);

  for (const found of page.matchAll(/data-say(?:-title)?="([a-z_]+)"/g)) said.add(found[1]!);

  for (const found of readFileSync(join(root, "manifest.json"), "utf8").matchAll(/__MSG_([a-z_]+)__/g)) said.add(found[1]!);
  const names = /export type PictureName = ([^;]+);/.exec(readFileSync(join(root, "src", "target.ts"), "utf8"))![1]!;

  for (const found of names.matchAll(/"([a-z]+)"/g)) said.add(`picture_${found[1]!}`);
  assert.ok(said.size > 30, `${said.size} texts found`);

  assert.deepEqual([...said].filter((name) => !(name in english)).sort(), [], "said and not written in English");
  assert.deepEqual(Object.keys(ukrainian).sort(), Object.keys(english).sort());
  // Nothing written that nobody says.
  assert.deepEqual(Object.keys(english).filter((name) => !said.has(name)).sort(), []);

  // A text takes the same things in both languages: `$1`, `$2`…
  for (const [name, { message }] of Object.entries(english)) assert.deepEqual((ukrainian[name]!.message.match(/\$\d/g) ?? []).sort(), (message.match(/\$\d/g) ?? []).sort(), name);
  // Chrome takes no name of an extension over 75 characters and no description over 132.
  for (const table of [english, ukrainian]) assert.ok(table["name"]!.message.length <= 75 && table["description"]!.message.length <= 132, table["description"]!.message);
});
