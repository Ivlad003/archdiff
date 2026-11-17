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
// `changedFiles`, `changedSources`, `changedPaths`, `worktreeDiff`, `treeAt`, `mergeBase`, `forkPoint`, `commitOf`,
// `defaultBase`, `listBranches`, `branchGraph`, `commitsBetween`,
// `commitInfo`, `commitFiles`, `fileHistory`, `gitStats`, `fileAt`,
// `fileHunks`, `changedLines`, `revisionStamp`, `commitFirst`.

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

  // A branch that does not exist has no merge-base either: one question per candidate answers both.
  for (const candidate of ["origin/HEAD", "develop", "main", "master", "origin/develop", "origin/main", "origin/master"]) {
    const base = git(root, ["merge-base", head, candidate]);

    if (base.ok && base.out.trim() !== "") return base.out.trim();
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

/** Whether a ref is a commit's full hash: what it names never changes, so what git says of it is asked once. */
function isFullHash(ref: string): boolean {
  return /^[0-9a-f]{40}$/.test(ref);
}

/** What git said of a commit named by its full hash, by repository and question: a slider that comes back to a commit asks nothing again. */
const said = new Map<string, unknown>();

/** How many such answers are kept, the oldest dropped first. */
const SAID = 400;

/** The answer to `key` about the commit `ref`, asked once when `ref` is a full hash (and an answer came); asked every time for a name that can move. */
function once<T>(root: string, key: string, ref: string, ask: () => T): T {
  if (!isFullHash(ref)) return ask();
  const id = `${root}\0${key}\0${ref}`;

  if (said.has(id)) return said.get(id) as T;
  const answer = ask();

  if (answer !== null) {
    said.set(id, answer);

    if (said.size > SAID) said.delete(said.keys().next().value!);
  }

  return answer;
}

/** The commit a ref names, as `CommitInfo`; null when git knows no commit of that name. */
export function commitInfo(root: string, ref: string): CommitInfo | null {
  return once(root, "commit", ref, () => readCommitInfo(root, ref));
}

function readCommitInfo(root: string, ref: string): CommitInfo | null {
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

/** The source files that differ between two revisions, by name alone (`changedFiles` reads their content too). */
export function changedSources(root: string, base: string, head: string): string[] {
  assertRef(base);
  assertRef(head);
  const diff = git(root, ["diff", "--relative", "--name-only", "-z", "--no-renames", base, head, "--"]);

  if (!diff.ok) throw new Error(diff.error);

  return diff.out.split("\0").filter((path) => path !== "" && isSourceFile(path));
}

/**
 * Every path the working tree changes against `base`, source file or not, as git names what happened to it: `A`
 * added, `M` modified, `D` deleted, `R` renamed (the new path), `?` not tracked yet. Relative to `root`.
 */
export function changedPaths(root: string, base: string): { status: string; path: string }[] {
  assertRef(base);
  const diff = git(root, ["diff", "--relative", "--name-status", "-z", "--no-renames", base, "--"]);

  if (!diff.ok) throw new Error(diff.error);
  const parts = diff.out.split("\0").filter((part) => part !== "");
  const paths: { status: string; path: string }[] = [];

  for (let i = 0; i + 1 < parts.length; i += 2) paths.push({ status: parts[i]!.slice(0, 1), path: parts[i + 1]! });
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);

  if (untracked.ok) for (const path of untracked.out.split("\0")) if (path !== "" && !paths.some((known) => known.path === path)) paths.push({ status: "?", path });

  return paths.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** How many lines of one file's diff a reader is given: a rewritten file is read in the Code tab, not as a diff. */
const DIFF_LINES = 400;

/**
 * The text of what the working tree changes in each of `paths` against `base`, as a unified diff per path (git's own
 * for a tracked file; a file not tracked yet as all of its lines added), cut after `DIFF_LINES` lines with a line
 * saying how many more there are. A path that does not differ has no entry.
 */
export function worktreeDiff(root: string, base: string, paths: readonly string[]): Map<string, string> {
  assertRef(base);
  const out = new Map<string, string>();

  if (paths.length === 0) return out;
  const cut = (text: string): string => {
    const lines = text.replace(/\n$/, "").split("\n");

    return lines.length <= DIFF_LINES ? lines.join("\n") : `${lines.slice(0, DIFF_LINES).join("\n")}\n… ${lines.length - DIFF_LINES} more lines`;
  };
  const diff = git(root, ["diff", "--relative", "--no-color", "--no-ext-diff", "--no-renames", base, "--", ...paths]);

  // One section per file, each from its `diff --git` line; the file is the one whose name ends that line.
  if (diff.ok) {
    for (const section of diff.out.split(/^(?=diff --git )/m)) {
      const head = section.slice(0, section.indexOf("\n"));
      const path = paths.find((candidate) => head.endsWith(` b/${candidate}`) || head.endsWith(` b/${candidate}"`));

      if (path !== undefined) out.set(path, cut(section.slice(section.indexOf("\n") + 1)));
    }
  }

  for (const path of paths) {
    if (out.has(path) || !existsSync(join(root, path)) || !git(root, ["ls-files", "--error-unmatch", "--others", "--exclude-standard", "--", path]).ok) continue;
    const lines = readFileSync(join(root, path), "utf8").replace(/\r?\n$/, "").split(/\r?\n/);
    out.set(path, cut([`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n")));
  }

  return out;
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

/** What the commits of a range say of the files, for the overlays read from git (overlays.ts). */
export interface GitStats {
  /** The commits read, as a reader names them: `main..feature`, or the last commits of a head when the range holds none. */
  range: string;
  /** How many commits were read. */
  commits: number;
  /** Churn: how many of those commits changed each file. */
  churn: Map<string, number>;
  /** Change coupling: the pairs of files changed in one commit at least twice, the most often together first. */
  coupling: { a: string; b: string; together: number }[];
  /** Ownership: for each file, the author of most of the commits that changed it, with how many of how many. */
  owners: Map<string, { author: string; commits: number; of: number }>;
  /** How many commits the ownership was read from (the head's history, not the range alone). */
  ownersFrom: number;
}

/** A commit that changes more files than this says nothing of which belong together (a rename of a directory, a formatter's run): it counts as churn only. */
const COUPLING_FILES = 50;

/** The pairs of files a picture is given, at most: the most often changed together. */
const COUPLING_PAIRS = 400;

/** How many commits the range falls back to when it holds none (the main line itself), and how many the ownership reads. */
const STATS_COMMITS = { fallback: 200, owners: 1000 } as const;

/** The commits `git log` lists for the arguments, each with its author and the files it changed (merges left out; paths relative to `root`). */
function commitsWithFiles(root: string, args: string[]): { author: string; files: string[] }[] {
  const log = git(root, ["log", "--no-merges", "--no-renames", "--relative", "--name-only", "--format=%x00%an", ...args]);

  if (!log.ok) throw new Error(log.error);

  return log.out
    .split("\0")
    .slice(1)
    .map((record) => {
      const [author = "", ...files] = record.split("\n");

      return { author, files: files.filter((file) => file !== "") };
    });
}

/**
 * The statistics of the commits from `base` (excluded) to `head`, in one `git log`: the churn of every file, the
 * pairs changed together, and — with `owners`, from the last commits of `head`'s whole history — the main author
 * of every file. A range without a commit (the main line against itself) is read as the last commits of `head`,
 * and `range` says so.
 */
export function gitStats(root: string, base: string, head: string, owners = false): GitStats {
  assertRef(base);
  assertRef(head);

  // Between two commits named by their hashes the statistics never change: the slider reads each range once.
  return isFullHash(base) ? once(root, `stats ${base} ${owners}`, head, () => readGitStats(root, base, head, owners)) : readGitStats(root, base, head, owners);
}

function readGitStats(root: string, base: string, head: string, owners: boolean): GitStats {
  let commits = commitsWithFiles(root, [`${base}..${head}`]);
  let range = `${base.length === 40 ? base.slice(0, 7) : base}..${head.length === 40 ? head.slice(0, 7) : head}`;

  if (commits.length === 0) {
    commits = commitsWithFiles(root, [`-${STATS_COMMITS.fallback}`, head]);
    range = `the last ${commits.length === 1 ? "commit" : `${commits.length} commits`} of ${head.length === 40 ? head.slice(0, 7) : head}`;
  }

  const churn = new Map<string, number>();
  const together = new Map<string, number>();

  for (const commit of commits) {
    for (const file of commit.files) churn.set(file, (churn.get(file) ?? 0) + 1);

    if (commit.files.length < 2 || commit.files.length > COUPLING_FILES) continue;
    const files = [...commit.files].sort();

    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) together.set(`${files[i]}\0${files[j]}`, (together.get(`${files[i]}\0${files[j]}`) ?? 0) + 1);
  }

  const coupling = [...together]
    .filter(([, count]) => count >= 2)
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, COUPLING_PAIRS)
    .map(([pair, count]) => {
      const [a, b] = pair.split("\0") as [string, string];

      return { a, b, together: count };
    });
  const authors = new Map<string, Map<string, number>>();
  const history = owners ? commitsWithFiles(root, [`-${STATS_COMMITS.owners}`, head]) : [];

  for (const commit of history) for (const file of commit.files) authors.set(file, (authors.get(file) ?? new Map<string, number>()).set(commit.author, (authors.get(file)?.get(commit.author) ?? 0) + 1));
  const owned = new Map<string, { author: string; commits: number; of: number }>();

  for (const [file, by] of authors) {
    const [author, most] = [...by].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]!;
    owned.set(file, { author, commits: most, of: [...by.values()].reduce((sum, count) => sum + count, 0) });
  }

  return { range, commits: commits.length, churn, coupling, owners: owned, ownersFrom: history.length };
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
  // One call for all of them: the whole name of a ref says whether it is a local branch, so a repository with a
  // hundred branches is not asked a hundred times (the server answers nothing else while it waits on git).
  const log = git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(committerdate:short)%00%(subject)", "refs/heads", "refs/remotes"]);

  if (!log.ok) throw new Error(log.error);
  const branches: Branch[] = [];

  for (const line of log.out.split("\n")) {
    if (line === "") continue;
    const [ref, name, sha, date, subject] = line.split("\0") as [string, string, string, string, string];

    // A remote's own HEAD names its default branch and is none itself (git shortens it to the remote's name, `origin`).
    if (ref.endsWith("/HEAD")) continue;
    const remote = !ref.startsWith("refs/heads/");
    branches.push({ name, sha, date, subject, remote, current: !remote && name === head });
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

  return once(root, "stamp", ref, () => {
    const result = git(root, ["log", "-1", "--format=%h %cs", ref]);

    if (!result.ok) return null;
    const [commit, date] = result.out.trim().split(" ");

    return commit && date ? { commit, date } : null;
  });
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

/** A stretch of a file a change touched, as the head's file has it: the lines that are new there, and the base's lines that are gone, which stood before the head's line `at`. */
export interface DiffHunk {
  /** The head's line the gone lines stood before (one past the last line, for lines gone from the end). */
  at: number;
  removed: string[];
  /** The head's lines that are new or rewritten; null where lines only went. */
  added: { from: number; to: number } | null;
}

/** Lines gone that one file's hunks carry, at most: a file rewritten whole is read as it is. */
const GONE_LINES = 4000;

/**
 * What a change did to one file, laid on the file as the head has it (`head` null: the working tree): git's own diff
 * without context, read into the lines that came and the lines that went. A file the base had not is all new; one
 * git knows nothing of (not tracked yet) likewise. Throws git's words when it refuses (no such ref, no repository).
 */
export function fileHunks(root: string, base: string, head: string | null, path: string): DiffHunk[] {
  assertRef(base);

  if (head !== null) assertRef(head);
  const diff = git(root, ["diff", "--relative", "--no-color", "--no-ext-diff", "--no-renames", "-U0", base, ...(head === null ? [] : [head]), "--", path]);

  if (!diff.ok) throw new Error(diff.error);
  const hunks: DiffHunk[] = [];
  let gone = 0;

  for (const raw of diff.out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const range = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);

    if (range) {
      const start = Number(range[1]);
      const count = range[2] === undefined ? 1 : Number(range[2]);
      // Lines that only went are named by the head's line before them.
      hunks.push(count === 0 ? { at: start + 1, removed: [], added: null } : { at: start, removed: [], added: { from: start, to: start + count - 1 } });
    } else if (hunks.length > 0 && line.startsWith("-") && gone++ < GONE_LINES) hunks.at(-1)!.removed.push(line.slice(1));
  }

  // Not tracked yet, so git's diff says nothing of it: every line of the working tree's file is new.
  if (hunks.length === 0 && head === null && contentAt(root, base, path) === null && existsSync(join(root, path))) {
    const lines = readFileSync(join(root, path), "utf8").replace(/\n$/, "").split("\n").length;

    return [{ at: 1, removed: [], added: { from: 1, to: lines } }];
  }

  return hunks;
}

/** One line a change added or removed: its file, its place in the head's file (its own number for a line added, the line it stood before for one removed) and what it says. */
export interface ChangedLine {
  file: string;
  line: number;
  sign: "+" | "-";
  text: string;
}

/** Lines of a change read for a search, at most. */
const CHANGED_LINES = 200_000;

/**
 * Every line the change from `base` to `head` (null: the working tree) added and removed, file by file, read from one
 * diff of git without context; of the working tree's files git does not track yet (and does not ignore), every line.
 * Throws git's words when it refuses.
 */
export function changedLines(root: string, base: string, head: string | null): ChangedLine[] {
  assertRef(base);

  if (head !== null) assertRef(head);
  const diff = git(root, ["diff", "--relative", "--no-color", "--no-ext-diff", "--no-renames", "-U0", base, ...(head === null ? [] : [head]), "--"]);

  if (!diff.ok) throw new Error(diff.error);
  const lines: ChangedLine[] = [];
  let file = "";
  let was = 0;
  let now = 0;
  // Inside a hunk a line is its text behind a sign; between hunks the lines are the file's header.
  let left = 0;
  const named = (path: string): string => path.replace(/^"|"$/g, "").replace(/^[ab]\//, "");

  for (const raw of diff.out.split("\n")) {
    const line = raw.replace(/\r$/, "");

    if (left === 0) {
      const range = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

      if (range) {
        const came = range[4] === undefined ? 1 : Number(range[4]);
        now = Number(range[3]);
        // Lines that only went are named by the head's line before them: they stood before the next one.
        was = came === 0 ? now + 1 : now;
        left = (range[2] === undefined ? 1 : Number(range[2])) + came;
      } else if (line.startsWith("--- ") && line !== "--- /dev/null") file = named(line.slice(4));
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file = named(line.slice(4));

      continue;
    }

    // "\ No newline at end of file" is no line of the file.
    if (line.startsWith("\\")) continue;
    left--;

    if (lines.length >= CHANGED_LINES) continue;

    if (line.startsWith("-")) lines.push({ file, line: was, sign: "-", text: line.slice(1) });
    else if (line.startsWith("+")) lines.push({ file, line: now++, sign: "+", text: line.slice(1) });
  }

  // The working tree's new files git does not track yet are part of the change: every line of a text file among them came.
  const untracked = head === null ? git(root, ["ls-files", "--others", "--exclude-standard", "-z"]) : null;

  for (const path of untracked?.ok ? untracked.out.split("\0").filter((name) => name !== "") : []) {
    if (lines.length >= CHANGED_LINES) break;
    let text: string;

    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }

    // A file of bytes, or one too long to be read as a change, is left out.
    if (text.length > 1_500_000 || text.slice(0, 8000).includes("\0")) continue;
    text.replace(/\r?\n$/, "").split(/\r?\n/).forEach((line, index) => lines.push({ file: path, line: index + 1, sign: "+", text: line }));
  }

  return lines;
}
