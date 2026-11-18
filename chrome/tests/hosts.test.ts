// What an address of GitHub shows (src/hosts.ts): the repository and the
// page of it, read from the address alone, and where a branch's name ends in
// an address that does not say.
//
// Entry point: run by `npm test` in chrome/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { pageOf, splitRef } from "../src/hosts.ts";

test("an address of a repository says what its page shows", () => {
  const shown = (address: string): unknown => pageOf(address)?.shown ?? null;

  assert.deepEqual(pageOf("https://github.com/Ivlad003/archdiff"), { host: "github.com", owner: "Ivlad003", repo: "archdiff", address: "https://github.com/Ivlad003/archdiff", shown: { kind: "repository" } });
  // The page's own address: without the query, the hash and a slash at its end.
  assert.equal(pageOf("https://github.com/acme/shop/pull/12/files/?w=1#diff-abc")?.address, "https://github.com/acme/shop/pull/12/files");
  // A pull request is one on every tab of it; its files are listed on two of them.
  assert.deepEqual(shown("https://github.com/acme/shop/pull/12"), { kind: "pull", number: 12, files: false });
  assert.deepEqual(shown("https://github.com/acme/shop/pull/12/commits"), { kind: "pull", number: 12, files: false });
  assert.deepEqual(shown("https://github.com/acme/shop/pull/12/files"), { kind: "pull", number: 12, files: true });
  assert.deepEqual(shown("https://github.com/acme/shop/pull/12/changes"), { kind: "pull", number: 12, files: true });
  // One commit of a pull request is that commit.
  assert.deepEqual(shown("https://github.com/acme/shop/pull/12/commits/1A2B3C4D5E"), { kind: "commit", sha: "1a2b3c4d5e" });
  assert.deepEqual(shown("https://github.com/acme/shop/commit/1a2b3c4"), { kind: "commit", sha: "1a2b3c4" });
  assert.deepEqual(shown("https://github.com/acme/shop/tree/feature/x/src/lib"), { kind: "tree", rest: "feature/x/src/lib" });
  assert.deepEqual(shown("https://github.com/acme/shop/commits/main"), { kind: "tree", rest: "main" });
  assert.deepEqual(shown("https://github.com/acme/shop/blob/main/src/a%20b.ts"), { kind: "blob", rest: "main/src/a b.ts" });
  assert.deepEqual(shown("https://github.com/acme/shop/blame/main/src/a.ts"), { kind: "blob", rest: "main/src/a.ts" });
  // Any other page of a repository is the repository.
  assert.deepEqual(shown("https://github.com/acme/shop/issues/3"), { kind: "repository" });
  assert.deepEqual(shown("https://github.com/acme/shop.git"), { kind: "repository" });
  assert.equal(pageOf("https://github.com/acme/shop.git")?.repo, "shop");
});

test("a comparison names its two ends, the head's fork when it has one, and no base when the address has none", () => {
  const shown = (range: string): unknown => pageOf(`https://github.com/acme/shop/compare/${range}`)?.shown;

  assert.deepEqual(shown("main...feature/x"), { kind: "compare", base: "main", head: "feature/x", headOwner: null });
  assert.deepEqual(shown("v1.0..v1.1"), { kind: "compare", base: "v1.0", head: "v1.1", headOwner: null });
  assert.deepEqual(shown("feature"), { kind: "compare", base: null, head: "feature", headOwner: null });
  assert.deepEqual(shown("main...someone:fix"), { kind: "compare", base: "main", head: "fix", headOwner: "someone" });
  assert.deepEqual(shown("acme:main...someone:shop:fix/it"), { kind: "compare", base: "main", head: "fix/it", headOwner: "someone" });
});

test("an address that is no repository's is none: another site, GitHub's own pages, half an address", () => {
  for (const address of ["", "not an address", "http://github.com/acme/shop", "https://example.com/acme/shop", "https://gist.github.com/acme/1", "https://github.com", "https://github.com/acme", "https://github.com/settings/profile", "https://github.com/orgs/acme/people", "https://github.com/Notifications/x"]) {
    assert.equal(pageOf(address), null, address);
  }
});

test("a branch's name ends where the repository's branches say, else at the first slash", () => {
  const branches = ["main", "feature", "feature/x", "feature/x/deep", "release/1.0"];

  assert.deepEqual(splitRef("main", branches), { ref: "main", path: "" });
  assert.deepEqual(splitRef("main/src/a.ts", branches), { ref: "main", path: "src/a.ts" });
  // The longest branch the text starts with, by whole segments: `feature/xy` is not under `feature/x`.
  assert.deepEqual(splitRef("feature/x/deep/src/a.ts", branches), { ref: "feature/x/deep", path: "src/a.ts" });
  assert.deepEqual(splitRef("feature/xy/src", branches), { ref: "feature", path: "xy/src" });
  // No branch of the checkout: a tag, a commit, a branch not fetched — one segment.
  assert.deepEqual(splitRef("v1.2.3/src/a.ts", branches), { ref: "v1.2.3", path: "src/a.ts" });
  assert.deepEqual(splitRef("1a2b3c4", []), { ref: "1a2b3c4", path: "" });
});
