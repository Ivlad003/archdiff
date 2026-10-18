// Git, as archdiff uses it: the plumbing that lists the files of the
// working tree and the changed ones, reads a file at a revision, finds the
// merge-base and the default base branch, lists branches and commits,
// stamps a revision, and makes a new project's first commit. Every
// function runs `git` as a child process with an argument list and answers
// in plain words when git refuses (not a repository, no commits yet, no
// such ref); no other module of archdiff runs git.
//
// Sits at the I/O edge below review.ts (which reads a change), files.ts
// (which lists the sources) and the server. Entry points: `listedFiles`,
// `changedFiles`, `treeAt`, `mergeBase`, `forkPoint`, `commitOf`,
// `defaultBase`, `listBranches`, `branchGraph`, `commitsBetween`,
// `commitInfo`, `commitFiles`, `fileHistory`, `fileAt`, `revisionStamp`,
// `commitFirst`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isSourceFile } from "./languages.ts";
/** How long one git command may take. */
const GIT_TIMEOUT = 300_000;

function git(root: string, args: string[]): { ok: true; out: string } | { ok: false; error: string } {
  // A git that never answers (a lock held by a hung process, a filesystem gone away) would hang the command and the
  // server with it: five minutes, then a plain error.
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT });

  if (result.error) return { ok: false, error: "code" in result.error && result.error.code === "ETIMEDOUT" ? `git ${args[0]} did not finish in ${GIT_TIMEOUT / 60_000} minutes` : `git: ${result.error.message}` };

  if (result.status !== 0) {
    // The first line of what git said, not its usage text; the usual causes named plainly.
    const text = result.stderr.trim();

    if (/not a git repository/i.test(text)) return { ok: false, error: `${root} is not a git repository` };

    // `HEAD`, `HEAD..HEAD`, `HEAD~1`: a repository with no commit has no HEAD to read.
    if (/bad revision 'HEAD|ambiguous argument 'HEAD|unknown revision or path not in the working tree.*HEAD/.test(text) && !git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok) return { ok: false, error: `${root} has no commits yet` };

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
 * The merge-base commit of a head (HEAD by default: the checkout) with the
 * main line (origin/HEAD, develop, main, master, then their remote
 * branches): the commit the change started from, so commits that landed on
 * the main line since are not read as this change — for a review of
 * another branch, that branch's own start, not the checkout's. On the main
 * line itself, or without any such branch, the head: the change is then
 * the working tree. Throws with a hint when the repository is shallow and
 * no base can be found.
 */
export function mergeBase(root: string, head = "HEAD"): string {
  assertRef(head);

  for (const candidate of ["origin/HEAD", "develop", "main", "master", "origin/develop", "origin/main", "origin/master"]) {
    const exists = git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);

    if (!exists.ok) continue;
    const base = git(root, ["merge-base", head, candidate]);

    if (base.ok) return base.out.trim();
  }

  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]);

  if (shallow.ok && shallow.out.trim() === "true") throw new Error("no merge-base with develop, main or master in a shallow clone: fetch more history (git fetch --unshallow, or fetch-depth: 0 in CI) or pass --base <ref>");

  return head;
}

/**
 * Where `head` left `base`: their merge-base, the commit a pull request of `head` into `base` starts from, so what
 * landed on `base` since is not read as `head`'s doing; null when the two share no commit (unrelated histories, a
 * shallow clone that lacks it).
 */
export function forkPoint(root: string, base: string, head: string): string | null {
  assertRef(base);
  assertRef(head);
  const result = git(root, ["merge-base", base, head]);

  return result.ok ? result.out.trim() || null : null;
}

/** The tree of no files: what a first commit is compared against, as it has no parent. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** One commit as a reader names it, with its first parent (the empty tree for a first commit) and the rest of its message. */
export interface CommitInfo extends Commit {
  parent: string;
  body: string;
}

/** The commit a ref names, as `CommitInfo`; null when git knows no commit of that name. */
export function commitInfo(root: string, ref: string): CommitInfo | null {
  if (commitOf(root, ref) === null) return null;
  const result = git(root, ["log", "-1", "--format=%H%x00%h%x00%P%x00%an%x00%ad%x00%s%x00%b", "--date=short", ref]);

  if (!result.ok) return null;
  const [sha = "", short = "", parents = "", author = "", date = "", subject = "", body = ""] = result.out.split("\0");

  return { sha, short, parent: parents.split(" ")[0] || EMPTY_TREE, author, date, subject, body: body.trim() };
}

/** The files a commit touched, as `git show` names them: A added, M modified, D deleted, R renamed (the new path). */
export function commitFiles(root: string, sha: string): { status: string; path: string }[] {
  assertRef(sha);
  const result = git(root, ["show", "--format=", "--name-status", "--no-renames", sha]);

  if (!result.ok) return [];

  return result.out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [status = "", path = ""] = line.split("\t");

      return { status: status.slice(0, 1), path };
    });
}

/** The commit a ref names (a branch, a tag, a commit), as its full hash; null when git knows none of that name. */
export function commitOf(root: string, ref: string): string | null {
  assertRef(ref);
  const result = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);

  // Outside git, or before the first commit, no ref is known: said as such, not as an unknown ref.
  if (!result.ok && /is not a git repository|has no commits yet/.test(result.error)) throw new Error(result.error);

  return result.ok ? result.out.trim() : null;
}

/** A file as a revision has it (a branch's, a commit's code for the page); null when the revision lacks it. */
export function fileAt(root: string, ref: string, path: string): string | null {
  assertRef(ref);

  return contentAt(root, ref, path);
}

/**
 * A revision's content of a file, as `analyze` overrides: null when the revision lacks it. The path is the
 * analysis's, relative to `root` — which may be a directory inside the repository (`./`: from there, not the top).
 */
function contentAt(root: string, ref: string, path: string): string | null {
  const content = git(root, ["show", `${ref}:./${path}`]);

  return content.ok ? content.out : null;
}

/**
 * The contents of several files at `ref` in one git process (`git cat-file --batch`), by path; null for a file the
 * ref does not have. A path a batch line cannot carry (a line break in it) is read alone, and so is every path when
 * the batch fails.
 */
function contentsAt(root: string, ref: string, paths: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const batched = paths.filter((path) => !/[\n\r]/.test(path));

  for (const path of paths) if (/[\n\r]/.test(path)) out.set(path, contentAt(root, ref, path));

  if (batched.length === 0) return out;
  const result = spawnSync("git", ["-C", root, "cat-file", "--batch"], { input: batched.map((path) => `${ref}:./${path}\n`).join(""), maxBuffer: 1024 * 1024 * 1024, timeout: GIT_TIMEOUT });

  if (result.error || result.status !== 0) {
    for (const path of batched) out.set(path, contentAt(root, ref, path));

    return out;
  }

  // Per file: a header `<sha> <type> <size>`, the content, a line break; or `<name> missing` for a file the ref lacks.
  const data = result.stdout;
  let at = 0;

  for (const path of batched) {
    const end = data.indexOf(0x0a, at);

    if (end < 0) {
      out.set(path, contentAt(root, ref, path));
      continue;
    }

    const header = /^[0-9a-f]+ (\w+) (\d+)$/.exec(data.subarray(at, end).toString("utf8"));
    at = end + 1;

    if (!header) {
      out.set(path, null);
      continue;
    }

    const size = Number(header[2]);
    out.set(path, header[1] === "blob" ? data.subarray(at, at + size).toString("utf8") : null);
    at += size + 1;
  }

  return out;
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
  // `--relative`: the paths of the analysis, from `root` down, when it is a directory of the repository.
  const diff = git(root, head === null ? ["diff", "--relative", "--name-status", "-z", "-M", base, "--"] : ["diff", "--relative", "--name-status", "-z", "-M", base, head, "--"]);

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
  const sources = [...changed].filter(([path]) => isSourceFile(path));
  // Each side's files read in one git process.
  const baseContents = contentsAt(root, base, sources.filter(([, marker]) => marker !== null).map(([path]) => path));
  const headContents = head !== null ? contentsAt(root, head, sources.map(([path]) => path)) : null;

  for (const [path, marker] of sources) {
    // Added since the base: the base does not have it.
    baseSide.set(path, marker === null ? null : (baseContents.get(path) ?? null));

    if (headContents) headSide.set(path, headContents.get(path) ?? null);
  }

  // A head ref: every source file the working tree has but the head does not (or the reverse) must be read from the head too,
  // else the head analysis would mix the working tree in. The diff lists them already when they differ from the base.
  return { base: baseSide, head: headSide };
}

/**
 * The whole tree of a ref as overrides against the working tree: the source files that differ get the ref's content,
 * files the ref lacks null, files only the ref has their content; and so do the files of `also` (the contract), when
 * they differ.
 */
export function treeAt(root: string, ref: string, also: readonly string[] = []): Map<string, string | null> {
  assertRef(ref);
  const diff = git(root, ["diff", "--relative", "--name-status", "-z", "-M", ref, "--"]);

  if (!diff.ok) throw new Error(diff.error);
  const changed: string[] = [];
  const parts = diff.out.split("\0").filter((part) => part !== "");

  for (let i = 0; i < parts.length; ) {
    const status = parts[i]!;
    const paths = status.startsWith("R") || status.startsWith("C") ? [parts[i + 1]!, parts[i + 2]!] : [parts[i + 1]!];
    i += 1 + paths.length;

    for (const path of paths) if (path && (isSourceFile(path) || also.includes(path)) && !changed.includes(path)) changed.push(path);
  }

  // A file of `also` git does not compare (one the working tree has untracked, or the ref has and the tree not): as the ref has it.
  const unlisted = also.filter((path) => !changed.includes(path));
  // Every file read from the ref in one git process: a history reads a tree per commit.
  const contents = contentsAt(root, ref, [...changed, ...unlisted]);
  const overrides = new Map<string, string | null>();

  for (const path of changed) overrides.set(path, contents.get(path) ?? null);

  for (const path of unlisted) {
    const here = existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
    const there = contents.get(path) ?? null;

    if (here !== there) overrides.set(path, there);
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
  const log = git(root, ["log", "--reverse", LOG_FORMAT, "--date=short", `${base}..${head}`]);

  if (!log.ok) throw new Error(log.error);

  return commitsOf(log.out);
}

/** The commits that touched a file, newest first, for the history of a shape. */
export function fileHistory(root: string, path: string, limit = 30): Commit[] {
  return logOf(root, [`-${limit}`, "--", path]);
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
  // The branch HEAD names, even before its first commit; none on a detached HEAD.
  const current = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const head = current.ok && current.out.trim() !== "" ? current.out.trim() : null;
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

/** A branch of the branches' picture: where it left the base, its own commits, how far it is ahead and behind. */
export interface BranchLane {
  name: string;
  remote: boolean;
  /** The branch checked out. */
  current: boolean;
  /** Where the branch left the base (their merge-base); null when they share no commit. */
  fork: string | null;
  /** Its own commits (on it, not on the base) along its first parents, newest first, at most the limit. */
  commits: Commit[];
  /** How many commits of its own it has. */
  ahead: number;
  /** How many commits of the base it does not have. */
  behind: number;
}

/** The branches as their picture reads them: the base's last commits, and every branch with commits of its own. */
export interface BranchGraph {
  base: string;
  /** The branch checked out; null on a detached head. */
  current: string | null;
  /** The base's last commits along its first parents, newest first. */
  baseCommits: Commit[];
  /** The base's commits older than those read. */
  baseEarlier: number;
  /** The branches with commits of their own, the checked-out one first, then the newest tip first. */
  lanes: BranchLane[];
  /** The branches with no commit of their own (merged into the base, or level with it), with the commit they point at. */
  level: { name: string; tip: string }[];
  /** The branches with commits of their own left out past the limit. */
  more: number;
}

/** How many of each the picture of the branches reads: the base's commits, a branch's commits, the branches. */
export const BRANCH_LIMITS = { base: 12, branch: 8, branches: 12 } as const;

/**
 * The branches against a base, for their picture: the base's last commits, and for every other branch (local, or
 * remote with no local branch of its name) the commits of its own since it left the base, with how far it is ahead
 * and behind. A branch with nothing of its own (merged, or level with the base) is only named. Throws when the base
 * is no commit git knows.
 */
export function branchGraph(root: string, base: string, limits: { base: number; branch: number; branches: number } = BRANCH_LIMITS): BranchGraph {
  assertRef(base);

  if (commitOf(root, base) === null) throw new Error(`no branch, tag or commit "${base}" (archdiff branches lists the branches)`);
  const { current, branches } = listBranches(root);
  // HEAD as the base (no develop, main or master): the branch checked out is the base, named.
  const named = base === "HEAD" && current ? current : base;
  const baseCommits = logOf(root, [`-${limits.base}`, "--first-parent", named]);
  const total = git(root, ["rev-list", "--count", "--first-parent", named]);
  const local = new Set(branches.filter((branch) => !branch.remote).map((branch) => branch.name));
  const lanes: BranchLane[] = [];
  const level: { name: string; tip: string }[] = [];
  let more = 0;

  // The checked-out branch first, then the newest tip first (listBranches' order); a remote twin of a local branch is the same line.
  for (const branch of [...branches].sort((a, b) => Number(b.current) - Number(a.current))) {
    if (branch.name === named || (branch.remote && local.has(branch.name.slice(branch.name.indexOf("/") + 1)))) continue;
    const counts = git(root, ["rev-list", "--left-right", "--count", `${named}...${branch.name}`]);
    const [behind = 0, ahead = 0] = counts.ok ? counts.out.trim().split(/\s+/).map(Number) : [];

    if (ahead === 0) {
      level.push({ name: branch.name, tip: commitOf(root, branch.name) ?? "" });
      continue;
    }

    if (lanes.length >= limits.branches) {
      more++;
      continue;
    }

    lanes.push({ name: branch.name, remote: branch.remote, current: branch.current, fork: forkPoint(root, named, branch.name), commits: logOf(root, [`-${limits.branch}`, "--first-parent", `${named}..${branch.name}`]), ahead, behind });
  }

  return { base: named, current, baseCommits, baseEarlier: total.ok ? Math.max(0, Number(total.out.trim()) - baseCommits.length) : 0, lanes, level, more };
}

/** The commits `git log` lists for the arguments (newest first unless they say otherwise); none when git refuses. */
function logOf(root: string, args: string[]): Commit[] {
  const log = git(root, ["log", LOG_FORMAT, "--date=short", ...args]);

  return log.ok ? commitsOf(log.out) : [];
}

/** One line per commit: hash, short hash, author, date, subject. */
const LOG_FORMAT = "--format=%H%x00%h%x00%an%x00%ad%x00%s";

function commitsOf(out: string): Commit[] {
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha, short, author, date, subject] = line.split("\0") as [string, string, string, string, string];

      return { sha, short, author, date, subject };
    });
}

/** Whether git ignores a path of the repository (by any .gitignore, the global one too); null outside git. */
export function isIgnored(root: string, path: string): boolean | null {
  const result = git(root, ["check-ignore", "-q", "--", path]);

  if (result.ok) return true;

  return /not a git repository/.test(result.error) ? null : false;
}

/** The base branch a comparison starts from: develop, main or master, local or on origin, whichever exists first; null when none. */
export function defaultBase(root: string): string | null {
  for (const candidate of ["develop", "main", "master", "origin/develop", "origin/main", "origin/master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]).ok) return candidate;
  }

  return null;
}

/** The short commit and its date of a revision (the checkout's by default), for the stamp of an export; null outside git or before the first commit. */
export function revisionStamp(root: string, ref = "HEAD"): { commit: string; date: string } | null {
  assertRef(ref);
  const result = git(root, ["log", "-1", "--format=%h %cs", ref]);

  if (!result.ok) return null;
  const [commit, date] = result.out.trim().split(" ");

  return commit && date ? { commit, date } : null;
}

/** Tracked and untracked-but-not-ignored files as git lists them, or null outside a repository (or without git). */
export function listedFiles(root: string): string[] | null {
  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);

  return listed.ok ? listed.out.split("\0").filter((path) => path !== "") : null;
}

/** A new repository at `dir` on the branch main, everything in it the first commit, by archdiff; throws with git's words when it refuses. */
export function commitFirst(dir: string, message: string): void {
  const steps: [name: string, args: string[]][] = [
    ["init", ["init", "-q", "-b", "main"]],
    ["add", ["add", "."]],
    ["commit", ["-c", "user.email=archdiff@localhost", "-c", "user.name=archdiff", "commit", "-q", "-m", message]],
  ];

  for (const [name, args] of steps) {
    const result = git(dir, args);

    if (!result.ok) throw new Error(`git ${name}: ${result.error}`);
  }
}
