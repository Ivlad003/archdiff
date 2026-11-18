// Where a place of the code is on GitHub (src/github.ts): the anchor of a
// changed file as GitHub itself writes it, the file at a revision for any
// other, and which messages of the framed page count as a place.
//
// Entry point: run by `npm test` in chrome/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorOf, blobAddress, isPlace, placeOnGitHub, type Where } from "../src/github.ts";

test("the anchor of a changed file is the one GitHub gives it", async () => {
  // Read from the list of files of github.com/cli/cli/pull/15094 on 2026-11-18: the id of this file's diff there.
  assert.equal(await anchorOf("pkg/cmd/event/listen/listen.go"), "diff-a68cc76170dc1513d92020d3254901e9f0d49a673ba54d6c4321016a92badc8d");
  // The path's bytes: a name outside ASCII is hashed as UTF-8.
  assert.equal(await anchorOf("src/été.ts"), await anchorOf("src/été.ts"));
  assert.notEqual(await anchorOf("src/a.ts"), await anchorOf("src/b.ts"));
});

test("a file the change touched is in the list of the change's files; any other is read at the head's revision, at its lines", async () => {
  const where: Where = { changes: "https://github.com/acme/shop/pull/7/files", blob: "https://github.com/acme/shop/blob/feature/x" };
  const changed = new Set(["src/lib/log.ts"]);

  assert.equal(await placeOnGitHub(where, { file: "src/lib/log.ts", line: 12 }, changed), `https://github.com/acme/shop/pull/7/files#${await anchorOf("src/lib/log.ts")}`);
  assert.equal(await placeOnGitHub(where, { file: "src/db/store.ts", line: 12 }, changed), "https://github.com/acme/shop/blob/feature/x/src/db/store.ts#L12");
  assert.equal(await placeOnGitHub(where, { file: "src/db/store.ts", line: 12, endLine: 30 }, changed), "https://github.com/acme/shop/blob/feature/x/src/db/store.ts#L12-L30");
  // A declaration of one line is that line.
  assert.equal(await placeOnGitHub(where, { file: "src/db/store.ts", line: 12, endLine: 12 }, changed), "https://github.com/acme/shop/blob/feature/x/src/db/store.ts#L12");
  // A picture of code has no list of changed files, whatever the files are.
  assert.equal(await placeOnGitHub({ ...where, changes: null }, { file: "src/lib/log.ts", line: 1 }, changed), "https://github.com/acme/shop/blob/feature/x/src/lib/log.ts#L1");
  // A name that an address would read otherwise is escaped, its slashes kept.
  assert.equal(await placeOnGitHub(where, { file: "docs/what is #1?.ts", line: 2 }, changed), "https://github.com/acme/shop/blob/feature/x/docs/what%20is%20%231%3F.ts#L2");
});

test("a revision in an address keeps its slashes and escapes the rest", () => {
  assert.equal(blobAddress("https://github.com/acme/shop", "feature/x"), "https://github.com/acme/shop/blob/feature/x");
  assert.equal(blobAddress("https://github.com/acme/shop", "fix/#12"), "https://github.com/acme/shop/blob/fix/%2312");
});

test("a place is a file and a whole line from 1, of the page's type; anything else is not", () => {
  assert.equal(isPlace({ type: "archdiff:open", file: "src/a.ts", line: 3 }), true);
  assert.equal(isPlace({ type: "archdiff:open", file: "src/a.ts", line: 3, endLine: 9, head: "main" }), true);

  for (const other of [null, undefined, "archdiff:open", [], {}, { type: "archdiff:show", url: "x" }, { type: "archdiff:open", file: "src/a.ts" }, { type: "archdiff:open", file: "", line: 1 }, { type: "archdiff:open", file: "src/a.ts", line: 0 }, { type: "archdiff:open", file: "src/a.ts", line: 1.5 }, { type: "archdiff:open", file: 7, line: 1 }, { type: "archdiff:open", file: "src/a.ts", line: "3" }, { type: "archdiff:open", file: "src/a.ts", line: 3, endLine: "9" }]) {
    assert.equal(isPlace(other), false, JSON.stringify(other));
  }
});
