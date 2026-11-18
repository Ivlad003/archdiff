// The builds page (site/builds.js): which files of a release are builds,
// how the releases are laid out, when a reader's build is not the newest,
// and that every text of the page has its Ukrainian.
//
// Entry point: run by `npm test` in chrome/ — the page is copied into the
// extension, which is why its test lives here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { arranged, buildOf, compareVersions, newerBuild, recalled, releasesOf, remember, sizeText } from "../../site/builds.js";

const site = join(import.meta.dirname, "..", "..", "site");

function asset(name: string, size = 1000): { name: string; size: number; browser_download_url: string } {
  return { name, size, browser_download_url: `https://github.com/Ivlad003/archdiff/releases/download/x/${name}` };
}

test("a file of a release is a build by its name, which carries its version", () => {
  assert.deepEqual(buildOf(asset("archdiff-chrome-0.1.0.zip", 29_973)), { kind: "chrome", version: "0.1.0", name: "archdiff-chrome-0.1.0.zip", size: 29_973, url: "https://github.com/Ivlad003/archdiff/releases/download/x/archdiff-chrome-0.1.0.zip" });
  assert.equal(buildOf(asset("archdiff-chrome-0.1.0.57.zip"))?.version, "0.1.0.57");
  assert.deepEqual([buildOf(asset("archdiff-vscode-0.1.0.vsix"))?.kind, buildOf(asset("archdiff-vscode-0.1.0.vsix"))?.version], ["vscode", "0.1.0"]);

  for (const other of [asset("ivlad003-archdiff-0.9.0.tgz"), asset("archdiff-chrome-latest.zip"), asset("archdiff-chrome-0.1.0.zip.sha256"), asset("source.zip"), { name: "archdiff-chrome-0.1.0.zip" }, null, "text"]) assert.equal(buildOf(other), null, JSON.stringify(other));
});

test("versions are compared number by number", () => {
  assert.ok(compareVersions("0.1.0.57", "0.1.0") > 0);
  assert.ok(compareVersions("0.1.1", "0.1.0.57") > 0);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareVersions("0.1.0", "0.1.0.0"), 0);
  assert.ok(compareVersions("0.1", "0.1.1") < 0);
});

const ANSWER = [
  { tag_name: "v0.9.0", name: "archdiff 0.9.0", draft: false, prerelease: false, published_at: "2026-11-20T10:00:00Z", html_url: "https://github.com/Ivlad003/archdiff/releases/tag/v0.9.0", assets: [asset("archdiff-vscode-0.1.0.vsix"), asset("archdiff-chrome-0.1.0.zip"), asset("notes.txt")] },
  { tag_name: "dev", name: "Development build", draft: false, prerelease: true, published_at: "2026-11-22T08:00:00Z", html_url: "https://github.com/Ivlad003/archdiff/releases/tag/dev", assets: [asset("archdiff-chrome-0.1.0.61.zip"), asset("archdiff-vscode-0.1.0.vsix")] },
  { tag_name: "v0.10.0", name: "", draft: false, published_at: "2026-12-01T10:00:00Z", html_url: "https://github.com/Ivlad003/archdiff/releases/tag/v0.10.0", assets: [asset("archdiff-chrome-0.2.0.zip")] },
  // A draft is nobody's to download; a release with no build has nothing for the page.
  { tag_name: "v0.11.0", name: "archdiff 0.11.0", draft: true, published_at: "2026-12-09T10:00:00Z", assets: [asset("archdiff-chrome-0.3.0.zip")] },
  { tag_name: "v0.8.0", name: "archdiff 0.8.0", draft: false, published_at: "2026-11-17T10:00:00Z", assets: [] },
];

test("the releases that hold a build are laid out: the newest version, the build of the last commit, the versions before", () => {
  const releases = releasesOf(ANSWER);

  assert.deepEqual(releases.map((release) => release.tag), ["v0.10.0", "dev", "v0.9.0"]);
  // A release without a name is named by its tag; the Chrome build is listed first, whatever the order of the files.
  assert.equal(releases[0]?.title, "v0.10.0");
  assert.deepEqual(releases[2]?.builds.map((build) => build.kind), ["chrome", "vscode"]);
  const laid = arranged(releases);
  assert.deepEqual([laid.latest?.tag, laid.development?.tag, laid.earlier.map((release) => release.tag)], ["v0.10.0", "dev", ["v0.9.0"]]);
  assert.equal(laid.development?.development, true);
  // The build of the last commit is one release whose files are replaced: its day is its newest file's.
  const moved = releasesOf([{ tag_name: "dev", published_at: "2026-11-22T08:00:00Z", assets: [{ ...asset("archdiff-chrome-0.1.0.70.zip"), updated_at: "2026-12-24T09:00:00Z" }, { ...asset("archdiff-vscode-0.1.0.vsix"), updated_at: "2026-12-24T09:00:05Z" }] }, ANSWER[2]]);
  assert.deepEqual(moved.map((release) => [release.tag, release.date]), [["dev", "2026-12-24T09:00:05Z"], ["v0.10.0", "2026-12-01T10:00:00Z"]]);

  // An answer that is no list of releases (an error of the API) holds none.
  for (const other of [null, { message: "API rate limit exceeded" }, "text", [null, "x", { name: "no tag" }]]) assert.deepEqual(releasesOf(other), []);
  assert.deepEqual(arranged([]), { latest: null, development: null, earlier: [] });
});

test("a reader's build is set against the newest version, then against the build of the last commit", () => {
  const before = arranged(releasesOf(ANSWER.slice(0, 2)));

  // An older release: the newest version is newer.
  assert.equal(newerBuild("0.0.9", "chrome", before)?.name, "archdiff-chrome-0.1.0.zip");
  // The newest version itself, or an older build of master: the build of the last commit is newer.
  assert.equal(newerBuild("0.1.0", "chrome", before)?.name, "archdiff-chrome-0.1.0.61.zip");
  assert.equal(newerBuild("0.1.0.57", "chrome", before)?.name, "archdiff-chrome-0.1.0.61.zip");
  // The build of the last commit, or one after it: the newest there is.
  assert.equal(newerBuild("0.1.0.61", "chrome", before), null);
  assert.equal(newerBuild("0.1.0.70", "chrome", before), null);
  // A version released after that build is newer than it.
  assert.equal(newerBuild("0.1.0.61", "chrome", arranged(releasesOf(ANSWER)))?.name, "archdiff-chrome-0.2.0.zip");
  assert.equal(newerBuild("0.1.0", "chrome", { latest: null, development: null }), null);
});

test("the last list read is kept with its time; what cannot be kept or read back is no list", () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) };

  assert.equal(recalled(storage), null);
  remember(storage, ANSWER, 1_795_000_000_000);
  assert.deepEqual(recalled(storage), { at: 1_795_000_000_000, answer: JSON.parse(JSON.stringify(ANSWER)) });
  // An error of the API is no list, and does not take the place of the one kept.
  remember(storage, { message: "API rate limit exceeded" }, 1_795_000_000_001);
  assert.equal(recalled(storage)?.at, 1_795_000_000_000);

  // Storage that is refused or full, and what another program left under the name.
  assert.equal(recalled(null), null);
  remember(null, ANSWER, 1);
  remember({ setItem: () => { throw new Error("QuotaExceededError"); } }, ANSWER, 1);
  assert.equal(recalled({ getItem: () => { throw new Error("SecurityError"); } }), null);

  for (const other of ["not json", "null", "[]", `{"at":"today","answer":[]}`, `{"at":1,"answer":{}}`]) assert.equal(recalled({ getItem: () => other }), null, other);
});

test("a size reads as people say it", () => {
  assert.deepEqual([sizeText(29_973), sizeText(400), sizeText(1_449_000), sizeText(0)], ["30 kB", "1 kB", "1.4 MB", "1 kB"]);
});

test("every text of the page has its Ukrainian, and the page loads nothing but its own files", () => {
  // The app's manifest and the icon iOS takes are among those files.
  const script = readFileSync(join(site, "builds.js"), "utf8");
  const page = readFileSync(join(site, "index.html"), "utf8");
  const table = /const UK = [^{]*\{([\s\S]*?)\n\}\);/.exec(script)?.[1];
  assert.ok(table, "the table of the Ukrainian texts");
  const translated = new Set([...table.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)].map((found) => JSON.parse(`"${found[1]!}"`) as string));
  const said = new Set<string>();

  for (const found of script.replace(table, "").matchAll(/\bsay\("((?:[^"\\]|\\.)*)"\)/g)) said.add(JSON.parse(`"${found[1]!}"`) as string);

  for (const found of page.matchAll(/<[a-z0-9]+\b[^>]*\bdata-say[^>]*>([^<]+)</g)) said.add(found[1]!.replace(/&amp;/g, "&"));
  said.add(/<title>([^<]+)<\/title>/.exec(page)![1]!);
  assert.ok(said.size > 20, `${said.size} texts found`);
  assert.deepEqual([...said].filter((text) => !translated.has(text)).sort(), [], "said and not translated");
  assert.deepEqual([...translated].filter((text) => !said.has(text)).sort(), [], "translated and never said");

  // The page is its own files: a stylesheet, a script and an icon beside it, and GitHub's API by its policy.
  assert.deepEqual([...page.matchAll(/(?:src|href)="([^"]+)"/g)].map((found) => found[1]!).filter((address) => !address.startsWith("https://github.com/Ivlad003/archdiff")), ["manifest.webmanifest", "icon.svg", "icons/180.png", "builds.css", "icon.svg", "builds.js"]);
  assert.ok(page.includes(`content="default-src 'self'; connect-src https://api.github.com; img-src 'self' data:"`));
});
