// What the panel shows for a page of GitHub (src/target.ts): the pictures
// and their links, the refs chosen among what the checkout has, where the
// code is on GitHub, and what is said when the checkout lacks the commits —
// over a stand-in for the checkout.
//
// Entry point: run by `npm test` in chrome/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { pageOf } from "../src/hosts.ts";
import type { PullEnds } from "../src/pull.ts";
import type { Served } from "../src/servers.ts";
import { resolve, type Checkout, type Resolution, type Target } from "../src/target.ts";

const SERVED: Served = { origin: "http://127.0.0.1:7080", name: "shop", root: "/home/me/shop", version: "0.9.0", remotes: [{ name: "origin", host: "github.com", path: "acme/shop" }, { name: "someone", host: "github.com", path: "someone/shop" }] };
const HEAD = "b".repeat(40);
const OLD = "c".repeat(40);
const FORK = "f".repeat(40);

/** A checkout that has the refs given, each at its commit; every head left every base at FORK. */
function checkout(refs: Record<string, string>, options: { branches?: string[]; mainLine?: string | null; modules?: string[]; unrelated?: boolean } = {}): Checkout & { asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    branches: async () => ({ names: options.branches ?? Object.keys(refs), mainLine: options.mainLine === undefined ? "main" : options.mainLine }),
    refs: async (names, range) => {
      asked.push(range ? `${range.base}..${range.head}` : names.join(","));

      return { commits: new Map(names.map((name) => [name, refs[name] ?? null])), fork: range && !options.unrelated ? FORK : null };
    },
    modules: async () => new Set(options.modules ?? []),
  };
}

function ends(given: Partial<PullEnds> = {}): (number: number) => Promise<PullEnds | null> {
  return async () => ({ base: "main", head: "fix/it", headSha: HEAD, headRepository: "acme/shop", ...given });
}

async function shown(address: string, has: Checkout, pull: (number: number) => Promise<PullEnds | null> = ends()): Promise<Resolution> {
  return resolve(pageOf(address)!, SERVED, "origin", has, pull);
}

function target(resolution: Resolution): Target {
  assert.equal(resolution.kind, "show", JSON.stringify(resolution));

  return (resolution as { target: Target }).target;
}

test("a pull request is reviewed from where its head left its base, at the commit GitHub has it at", async () => {
  const has = checkout({ "origin/main": "a".repeat(40), main: "a".repeat(40), "origin/fix/it": HEAD, [HEAD]: HEAD });
  const result = target(await shown("https://github.com/acme/shop/pull/7/files", has));

  assert.deepEqual(result.subject, { kind: "pull", number: 7, base: "main", head: "fix/it" });
  // A name that is at the pull request's commit reads better than the commit; the base is their merge-base.
  assert.deepEqual(result.pictures, [
    { name: "review", hash: `view=review&base=${FORK}&head=origin%2Ffix%2Fit` },
    { name: "changes", hash: `view=layers&base=${FORK}&head=origin%2Ffix%2Fit&changes=1` },
    { name: "impact", hash: `view=impact&base=${FORK}&head=origin%2Ffix%2Fit` },
    { name: "timeline", hash: `view=timeline&base=${FORK}&head=origin%2Ffix%2Fit` },
    { name: "code", hash: "view=layers&head=origin%2Ffix%2Fit" },
  ]);
  assert.deepEqual(result.range, { base: FORK, head: "origin/fix/it" });
  assert.equal(result.stale, null);
  assert.deepEqual(result.where, { changes: "https://github.com/acme/shop/pull/7/files", blob: `https://github.com/acme/shop/blob/${HEAD}` });
  // Asked of the checkout: every candidate at once, then where the head left the base.
  assert.deepEqual(has.asked, [`${HEAD},origin/pr/7,origin/fix/it,fix/it,origin/main,main`, "origin/main..origin/fix/it"]);
});

test("the pull request's commit under no name is shown by itself; a branch that is not at it is shown with the command that fetches", async () => {
  // Fetched by its ref without a name of its own: the objects are there.
  const unnamed = target(await shown("https://github.com/acme/shop/pull/7", checkout({ "origin/main": "a", [HEAD]: HEAD, "origin/fix/it": OLD })));
  assert.equal(unnamed.range?.head, HEAD);
  assert.equal(unnamed.stale, null);

  // Only an older commit of the branch: shown, and said.
  const stale = target(await shown("https://github.com/acme/shop/pull/7", checkout({ "origin/main": "a", "origin/fix/it": OLD })));
  assert.equal(stale.range?.head, "origin/fix/it");
  assert.equal(stale.stale, "git fetch origin pull/7/head:refs/remotes/origin/pr/7");

  // A page that did not say the commit: whatever the checkout has of the branch, and no claim that it is behind.
  const unsaid = target(await shown("https://github.com/acme/shop/pull/7", checkout({ main: "a", "fix/it": OLD }), ends({ headSha: null })));
  assert.deepEqual(unsaid.range, { base: FORK, head: "fix/it" });
  assert.equal(unsaid.stale, null);
  assert.equal(unsaid.where.blob, "https://github.com/acme/shop/blob/fix/it");

  // Two histories that share no commit: the base as it is.
  assert.equal(target(await shown("https://github.com/acme/shop/pull/7", checkout({ main: "a", [HEAD]: HEAD }, { unrelated: true }))).range?.base, "main");
});

test("a pull request from a fork is its own ref, never a branch of the same name here; one not fetched is named with its command", async () => {
  const fork = ends({ headRepository: "someone/shop", head: "main" });
  // The checkout's own `main` is not the fork's `main`.
  const missing = await shown("https://github.com/acme/shop/pull/7", checkout({ "origin/main": "a", main: "a" }), fork);
  assert.deepEqual(missing, { kind: "missing", subject: { kind: "pull", number: 7, base: "main", head: "main" }, command: "git fetch origin pull/7/head:refs/remotes/origin/pr/7" });

  const fetched = target(await shown("https://github.com/acme/shop/pull/7", checkout({ "origin/main": "a", main: "a", "origin/pr/7": HEAD, [HEAD]: HEAD }), fork));
  assert.equal(fetched.range?.head, "origin/pr/7");
  // A file the change did not touch is read in the fork, at the pull request's commit.
  assert.equal(fetched.where.blob, `https://github.com/someone/shop/blob/${HEAD}`);

  // The base not here either: everything of the remote is to fetch.
  assert.deepEqual(await shown("https://github.com/acme/shop/pull/7", checkout({ [HEAD]: HEAD })), { kind: "missing", subject: { kind: "pull", number: 7, base: "main", head: "fix/it" }, command: "git fetch origin" });
  // Nobody said the branches.
  assert.deepEqual(await shown("https://github.com/acme/shop/pull/7", checkout({}), async () => null), { kind: "unread", number: 7 });
});

test("a comparison takes its ends from its address: the remote's branches, a tag, a fork's branch under the fork's remote", async () => {
  const same = target(await shown("https://github.com/acme/shop/compare/v1.0...feature/x", checkout({ "v1.0": "a", "origin/feature/x": HEAD, "feature/x": OLD })));
  assert.deepEqual(same.subject, { kind: "compare", base: "v1.0", head: "feature/x" });
  assert.deepEqual(same.range, { base: FORK, head: "origin/feature/x" });
  assert.deepEqual(same.where, { changes: "https://github.com/acme/shop/compare/v1.0...feature/x", blob: "https://github.com/acme/shop/blob/feature/x" });

  // Without a base in the address the review starts where the head left the main line: no base in the link.
  const bare = target(await shown("https://github.com/acme/shop/compare/feature/x", checkout({ "feature/x": HEAD })));
  assert.deepEqual(bare.range, { base: null, head: "feature/x" });
  assert.equal(bare.pictures[0]?.hash, "view=review&head=feature%2Fx");

  // A fork's branch: under the remote whose address is the fork's.
  const forked = target(await shown("https://github.com/acme/shop/compare/main...someone:fix", checkout({ "origin/main": "a", "someone/fix": HEAD, fix: OLD })));
  assert.equal(forked.range?.head, "someone/fix");
  assert.equal(forked.where.blob, "https://github.com/someone/shop/blob/fix");
  // A fork with no remote here: the command fetches the branch under the owner's name.
  assert.deepEqual(await shown("https://github.com/acme/shop/compare/main...stranger:fix", checkout({ "origin/main": "a", fix: OLD })), { kind: "missing", subject: { kind: "compare", base: "main", head: "fix" }, command: "git fetch https://github.com/stranger/shop.git fix:refs/remotes/stranger/fix" });
  // A base the checkout has not got is not swapped for another.
  assert.deepEqual(await shown("https://github.com/acme/shop/compare/v9...feature/x", checkout({ "feature/x": HEAD })), { kind: "missing", subject: { kind: "compare", base: "v9", head: "feature/x" }, command: "git fetch origin" });
});

test("a branch off the main line is a change against it; the main line and a file of it are code", async () => {
  const has = { "origin/main": "a", main: "a", "origin/feature/x": HEAD };
  const branch = target(await shown("https://github.com/acme/shop/tree/feature/x/src/lib", checkout(has)));

  assert.deepEqual(branch.subject, { kind: "branch", ref: "feature/x" });
  assert.deepEqual(branch.pictures.map((picture) => picture.name), ["review", "changes", "impact", "timeline", "code"]);
  assert.equal(branch.pictures[0]?.hash, "view=review&head=origin%2Ffeature%2Fx");
  // GitHub lists the branch's change too: its comparison with the default branch.
  assert.deepEqual(branch.where, { changes: "https://github.com/acme/shop/compare/feature/x", blob: "https://github.com/acme/shop/blob/feature/x" });
  assert.deepEqual(branch.range, { base: null, head: "origin/feature/x" });

  // The main line, named with its remote by the server or not: the code, and nothing changed to list.
  for (const mainLine of ["main", "origin/main"]) {
    const main = target(await shown("https://github.com/acme/shop/tree/main", checkout(has, { mainLine })));
    assert.deepEqual(main.pictures, [{ name: "code", hash: "view=layers&head=origin%2Fmain" }, { name: "modules", hash: "view=modules&head=origin%2Fmain" }]);
    assert.deepEqual([main.where.changes, main.range], [null, null]);
  }

  // A file that is a module of the code has its own pictures first; one that is not (a README) has the branch's.
  const file = target(await shown("https://github.com/acme/shop/blob/main/src/lib/orders.ts", checkout(has, { modules: ["src/lib/orders.ts"] })));
  assert.deepEqual(file.subject, { kind: "file", ref: "main", path: "src/lib/orders.ts" });
  assert.deepEqual(file.pictures.map((picture) => picture.hash), ["view=module%3Asrc%2Flib%2Forders.ts&head=origin%2Fmain", "view=inside%3Asrc%2Flib%2Forders.ts&head=origin%2Fmain", "view=layers&head=origin%2Fmain", "view=modules&head=origin%2Fmain"]);
  assert.deepEqual(target(await shown("https://github.com/acme/shop/blob/main/README.md", checkout(has))).pictures.map((picture) => picture.name), ["code", "modules"]);
  assert.deepEqual(target(await shown("https://github.com/acme/shop/blob/feature/x/src/a.ts", checkout(has, { modules: ["src/a.ts"] }))).pictures.map((picture) => picture.name), ["module", "inside", "review", "changes", "impact", "timeline", "code"]);

  // A branch the checkout has not got.
  assert.deepEqual(await shown("https://github.com/acme/shop/tree/gone", checkout(has)), { kind: "missing", subject: { kind: "branch", ref: "gone" }, command: "git fetch origin" });
});

test("a commit is its own change; the repository itself is the checkout as it is", async () => {
  const commit = target(await shown("https://github.com/acme/shop/commit/bbbbbbb", checkout({ bbbbbbb: HEAD })));

  assert.deepEqual(commit.subject, { kind: "commit", sha: "bbbbbbb" });
  assert.deepEqual(commit.pictures, [{ name: "commit", hash: `view=commit%3A${HEAD}` }, { name: "code", hash: `view=layers&head=${HEAD}` }]);
  assert.deepEqual(commit.where, { changes: "https://github.com/acme/shop/commit/bbbbbbb", blob: `https://github.com/acme/shop/blob/${HEAD}` });
  assert.deepEqual(commit.range, { base: `${HEAD}~1`, head: HEAD });
  assert.deepEqual(await shown("https://github.com/acme/shop/commit/abcdef1", checkout({})), { kind: "missing", subject: { kind: "commit", sha: "abcdef1" }, command: "git fetch origin" });

  const has = checkout({});
  const repository = target(await shown("https://github.com/acme/shop/issues", has));
  assert.deepEqual(repository.subject, { kind: "checkout" });
  assert.deepEqual(repository.pictures.map((picture) => picture.hash), ["view=layers", "view=modules", "view=changes", "view=branches"]);
  assert.equal(repository.where.blob, "https://github.com/acme/shop/blob/HEAD");
  // Nothing is asked of the checkout for it.
  assert.deepEqual(has.asked, []);
});
