// Git, as archdiff uses it: the plumbing that lists changed files, reads a
// file at a revision, finds the merge-base and the default base branch,
// lists branches and commits, and stamps a revision. Every function runs
// `git` as a child process with an argument list and answers in plain
// words when git refuses (not a repository, no commits yet, no such ref).
//
// Sits at the I/O edge below diff.ts (which compares analyses) and the
// server. Entry points: `changedFiles`, `treeAt`, `mergeBase`,
// `defaultBase`, `listBranches`, `commitsBetween`, `fileHistory`,
// `revisionStamp`.

import { spawnSync } from "node:child_process";
import { isSourceFile } from "./files.ts";
function git(root: string, args: string[]): { ok: true; out: string } | { ok: false; error: string } {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

  if (result.error) return { ok: false, error: `git: ${result.error.message}` };

  if (result.status !== 0) {
    // The first line of what git said, not its usage text; the usual causes named plainly.
    const text = result.stderr.trim();

    if (/not a git repository/i.test(text)) return { ok: false, error: `${root} is not a git repository` };

    if (/bad revision 'HEAD'|ambiguous argument 'HEAD'/.test(text)) return { ok: false, error: `${root} has no commits yet` };

    if (/unknown revision|bad revision|ambiguous argument/.test(text)) return { ok: false, error: text.split("\n")[0] ?? text };

    return { ok: false, error: text.split("\n")[0] || `git ${args[0]} failed` };
  }

  return { ok: true, out: result.stdout };
}

/** A ref that is not an option: git must never read `--x` as one. */
function assertRef(ref: string): void {
  if (ref.startsWith("-") || ref === "") throw new Error(`not a git ref: "${ref}"`);
}

/**
 * The merge-base commit of HEAD with the main branch (origin/HEAD, main,
 * master, origin/main, origin/master): the commit the change started from,
 * so commits that landed on main since are not read as this change. On the
 * main branch itself, or without any such branch, HEAD: the change is then
 * the working tree. Throws with a hint when the repository is shallow and
 * no base can be found.
 */
export function mergeBase(root: string): string {
  for (const candidate of ["origin/HEAD", "main", "master", "origin/main", "origin/master"]) {
    const exists = git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);

    if (!exists.ok) continue;
    const base = git(root, ["merge-base", "HEAD", candidate]);

    if (base.ok) return base.out.trim();
  }

  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]);

  if (shallow.ok && shallow.out.trim() === "true") throw new Error("no merge-base with the main branch in a shallow clone: fetch more history (git fetch --unshallow, or fetch-depth: 0 in CI) or pass --base <ref>");

  return "HEAD";
}

/** A revision's content of a file, as `analyze` overrides: null when the revision lacks it. */
function contentAt(root: string, ref: string, path: string): string | null {
  const content = git(root, ["show", `${ref}:${path}`]);

  return content.ok ? content.out : null;
}

/**
 * The source files that differ between `base` and `head` (a ref, or the
 * working tree when null: tracked changes and untracked files), as the
 * overrides of each side's analysis: the base's content, and the head's
 * when it is a ref. Null drops the file on that side.
 */
export function changedFiles(root: string, base: string, head: string | null = null): { base: Map<string, string | null>; head: Map<string, string | null> } {
  assertRef(base);

  if (head !== null) assertRef(head);
  const diff = git(root, head === null ? ["diff", "--name-status", "-z", "-M", base, "--"] : ["diff", "--name-status", "-z", "-M", base, head, "--"]);

  if (!diff.ok) throw new Error(diff.error);
  const changed = new Map<string, string | null>();
  const parts = diff.out.split("\0").filter((part) => part !== "");

  for (let i = 0; i < parts.length; ) {
    const status = parts[i]!;
    const first = parts[i + 1];

    if (first === undefined) break;

    if (status.startsWith("R") || status.startsWith("C")) {
      const second = parts[i + 2]!;
      changed.set(first, "base");
      changed.set(second, status.startsWith("R") ? null : "base");
      i += 3;
    } else {
      changed.set(first, status === "A" ? null : "base");
      i += 2;
    }
  }

  if (head === null) {
    const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);

    if (untracked.ok) for (const path of untracked.out.split("\0")) if (path !== "" && !changed.has(path)) changed.set(path, null);
  }

  const baseSide = new Map<string, string | null>();
  const headSide = new Map<string, string | null>();

  for (const [path, marker] of changed) {
    if (!isSourceFile(path)) continue;
    // Added since the base: the base does not have it.
    baseSide.set(path, marker === null ? null : contentAt(root, base, path));

    if (head !== null) headSide.set(path, contentAt(root, head, path));
  }

  // A head ref: every source file the working tree has but the head does not (or the reverse) must be read from the head too,
  // else the head analysis would mix the working tree in. The diff lists them already when they differ from the base.
  return { base: baseSide, head: headSide };
}

/** The whole tree of a ref as overrides against the working tree: files that differ get the ref's content, files the ref lacks null, files only the ref has their content. */
export function treeAt(root: string, ref: string): Map<string, string | null> {
  assertRef(ref);
  const diff = git(root, ["diff", "--name-status", "-z", "-M", ref, "--"]);

  if (!diff.ok) throw new Error(diff.error);
  const overrides = new Map<string, string | null>();
  const parts = diff.out.split("\0").filter((part) => part !== "");

  for (let i = 0; i < parts.length; ) {
    const status = parts[i]!;
    const paths = status.startsWith("R") || status.startsWith("C") ? [parts[i + 1]!, parts[i + 2]!] : [parts[i + 1]!];
    i += 1 + paths.length;

    for (const path of paths) if (path && isSourceFile(path)) overrides.set(path, contentAt(root, ref, path));
  }

  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);

  if (untracked.ok) for (const path of untracked.out.split("\0")) if (path !== "" && isSourceFile(path) && !overrides.has(path)) overrides.set(path, null);

  return overrides;
}

/** One commit of a range, as `git log` lists it. */
export interface Commit {
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

/** The commits from `base` (excluded) to `head`, oldest first. */
export function commitsBetween(root: string, base: string, head: string): Commit[] {
  assertRef(base);
  assertRef(head);
  const log = git(root, ["log", "--reverse", "--format=%H%x00%h%x00%an%x00%ad%x00%s", "--date=short", `${base}..${head}`]);

  if (!log.ok) throw new Error(log.error);

  return log.out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha, short, author, date, subject] = line.split("\0") as [string, string, string, string, string];

      return { sha, short, author, date, subject };
    });
}

/** The commits that touched a file, newest first, for the history of a shape. */
export function fileHistory(root: string, path: string, limit = 30): Commit[] {
  const log = git(root, ["log", `-${limit}`, "--format=%H%x00%h%x00%an%x00%ad%x00%s", "--date=short", "--", path]);

  if (!log.ok) return [];

  return log.out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha, short, author, date, subject] = line.split("\0") as [string, string, string, string, string];

      return { sha, short, author, date, subject };
    });
}

/** A branch of the repository, local or remote. */
export interface Branch {
  name: string;
  sha: string;
  date: string;
  subject: string;
  remote: boolean;
  current: boolean;
}

/** Every branch, local then remote (HEAD pointers left out), newest commit first, with the current one marked. */
export function listBranches(root: string): { current: string | null; branches: Branch[] } {
  const current = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = current.ok && current.out.trim() !== "HEAD" ? current.out.trim() : null;
  const log = git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%00%(objectname:short)%00%(committerdate:short)%00%(subject)", "refs/heads", "refs/remotes"]);

  if (!log.ok) throw new Error(log.error);
  const branches: Branch[] = [];

  for (const line of log.out.split("\n")) {
    if (line === "") continue;
    const [name, sha, date, subject] = line.split("\0") as [string, string, string, string];

    if (name.endsWith("/HEAD")) continue;
    branches.push({ name, sha, date, subject, remote: !git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).ok, current: name === head });
  }

  return { current: head, branches };
}

/** The base branch a comparison starts from: develop, main or master, local or on origin, whichever exists first; null when none. */
export function defaultBase(root: string): string | null {
  for (const candidate of ["develop", "main", "master", "origin/develop", "origin/main", "origin/master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]).ok) return candidate;
  }

  return null;
}

/** The short commit and its date, for the stamp of an export; null outside git or before the first commit. */
export function revisionStamp(root: string): { commit: string; date: string } | null {
  const result = git(root, ["log", "-1", "--format=%h %cs"]);

  if (!result.ok) return null;
  const [commit, date] = result.out.trim().split(" ");

  return commit && date ? { commit, date } : null;
}
