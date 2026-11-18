// What the panel shows for a page of GitHub: the pictures of archdiff that
// fit it, each as the link of the page that draws it. A pull request and a
// comparison are a change — the review from where the head left the base
// (their merge-base: what the base gained since is not the head's doing),
// the layers with the change marked, the impact, the commits, the code of
// the head; a branch off the main line is a change against it; the main
// line, a file and the repository itself are code; a commit is its own
// change. The refs are the checkout's own: a branch of GitHub is
// `<remote>/<branch>` there, and a pull request whose commits the checkout
// has not got is said as such, with the command that fetches them.
//
// Nothing here asks GitHub or the server itself: what the checkout has is
// asked through `Checkout`, the pull request's ends through `pull`.
//
// Entry points: `resolve`, `Resolution`, `Target`, `Subject`, `Picture`,
// `PictureName`, `Checkout`.

import { blobAddress, type Where } from "./github.ts";
import { splitRef, type RepositoryPage } from "./hosts.ts";
import type { PullEnds } from "./pull.ts";
import type { Served } from "./servers.ts";

/** The pictures the panel offers, by the name its select knows each by. */
export type PictureName = "review" | "changes" | "impact" | "timeline" | "code" | "modules" | "module" | "inside" | "commit" | "board" | "branches";

/** A picture: its name, and the link (the hash) of the page that draws it. */
export interface Picture {
  name: PictureName;
  hash: string;
}

/** What the pictures are of, as GitHub names it: the panel's title. */
export type Subject =
  | { kind: "pull"; number: number; base: string; head: string }
  | { kind: "compare"; base: string | null; head: string }
  | { kind: "branch"; ref: string }
  | { kind: "file"; ref: string; path: string }
  | { kind: "commit"; sha: string }
  | { kind: "checkout" };

export interface Target {
  subject: Subject;
  /** The pictures to choose from; the first is the one shown unless the reader chose another. */
  pictures: Picture[];
  /** Where a place of the code is on GitHub. */
  where: Where;
  /** The change whose files are listed on GitHub (`where.changes`): its two ends in the checkout, the base null for the main line's. */
  range: { base: string | null; head: string } | null;
  /** The command that brings the checkout to the pull request's commit, when what is shown is older or another. */
  stale: string | null;
}

/** What a page comes to: pictures to show, commits the checkout has not got, or a pull request whose branches nobody said. */
export type Resolution = { kind: "show"; target: Target } | { kind: "missing"; subject: Subject; command: string } | { kind: "unread"; number: number };

/** What is asked of the checkout, through the server that serves it. */
export interface Checkout {
  /** The branches, local and remote (`origin/main`), and the main line a review starts from by itself. */
  branches(): Promise<{ names: string[]; mainLine: string | null }>;
  /** The commit each ref names (null: git does not know it here), and where `range.head` left `range.base`. */
  refs(refs: readonly string[], range?: { base: string; head: string }): Promise<{ commits: ReadonlyMap<string, string | null>; fork: string | null }>;
  /** The files that are modules of the code at a head (null: the working tree). */
  modules(head: string | null): Promise<ReadonlySet<string>>;
}

function link(view: string, refs: { base?: string | null; head?: string | null }, options: Record<string, string> = {}): string {
  const params = new URLSearchParams({ view });

  if (refs.base) params.set("base", refs.base);

  if (refs.head) params.set("head", refs.head);

  for (const [name, value] of Object.entries(options)) params.set(name, value);

  return params.toString();
}

/** The pictures of a change from `base` (null: where the head left the main line) to `head`. */
function changePictures(base: string | null, head: string): Picture[] {
  return [
    { name: "review", hash: link("review", { base, head }) },
    { name: "changes", hash: link("layers", { base, head }, { changes: "1" }) },
    { name: "impact", hash: link("impact", { base, head }) },
    { name: "timeline", hash: link("timeline", { base, head }) },
    { name: "code", hash: link("layers", { head }) },
  ];
}

function same(one: string, other: string): boolean {
  return one.toLowerCase() === other.toLowerCase();
}

function first(candidates: readonly string[], commits: ReadonlyMap<string, string | null>): string | null {
  return candidates.find((ref) => (commits.get(ref) ?? null) !== null) ?? null;
}

/** Where the head left the base, to review from: their merge-base, or the base itself when they share no commit. */
async function startOf(base: string, head: string, checkout: Checkout): Promise<string> {
  return (await checkout.refs([], { base, head })).fork ?? base;
}

/**
 * What to show for `page`, a page of the repository `served` serves under its remote `remote`. `pull` says the ends
 * of a pull request by its number (null when they cannot be read).
 */
export async function resolve(page: RepositoryPage, served: Served, remote: string, checkout: Checkout, pull: (number: number) => Promise<PullEnds | null>): Promise<Resolution> {
  const { shown } = page;
  const repository = `https://${page.host}/${page.owner}/${page.repo}`;
  const fetchAll = `git fetch ${remote}`;

  if (shown.kind === "pull") {
    const ends = await pull(shown.number);

    if (!ends) return { kind: "unread", number: shown.number };
    const subject: Subject = { kind: "pull", number: shown.number, base: ends.base, head: ends.head };
    // GitHub keeps every pull request under a ref of the repository it is opened in, a fork's too: one command fetches either.
    const tracked = `${remote}/pr/${shown.number}`;
    const command = `git fetch ${remote} pull/${shown.number}/head:refs/remotes/${tracked}`;
    const own = ends.headRepository === null || same(ends.headRepository, `${page.owner}/${page.repo}`);
    const named = [tracked, ...(own ? [`${remote}/${ends.head}`, ends.head] : [])];
    const bases = [`${remote}/${ends.base}`, ends.base];
    const { commits } = await checkout.refs([...(ends.headSha === null ? [] : [ends.headSha]), ...named, ...bases]);
    // A name that is at the pull request's commit reads best; then the commit itself, when the checkout has it under no name; then whatever it has of the branch.
    const head = (ends.headSha === null ? undefined : named.find((ref) => commits.get(ref) === ends.headSha)) ?? (ends.headSha !== null && commits.get(ends.headSha) ? ends.headSha : first(named, commits));
    const base = first(bases, commits);

    if (head === null) return { kind: "missing", subject, command };

    if (base === null) return { kind: "missing", subject, command: fetchAll };
    const start = await startOf(base, head, checkout);
    const where: Where = { changes: `${repository}/pull/${shown.number}/files`, blob: blobAddress(ends.headRepository === null ? repository : `https://${page.host}/${ends.headRepository}`, ends.headSha ?? ends.head) };

    return { kind: "show", target: { subject, pictures: changePictures(start, head), where, range: { base: start, head }, stale: ends.headSha !== null && commits.get(head) !== ends.headSha ? command : null } };
  }

  if (shown.kind === "compare") {
    const subject: Subject = { kind: "compare", base: shown.base, head: shown.head };
    const owner = shown.headOwner !== null && !same(shown.headOwner, page.owner) ? shown.headOwner : null;
    // A fork's branch is under the remote of the fork: the one whose address is the fork's, else one named for its owner.
    const headRemote = owner === null ? remote : (served.remotes.find((candidate) => candidate.host === page.host && candidate.path.toLowerCase().startsWith(`${owner.toLowerCase()}/`))?.name ?? owner);
    const heads = owner === null ? [`${remote}/${shown.head}`, shown.head] : [`${headRemote}/${shown.head}`];
    const bases = shown.base === null ? [] : [`${remote}/${shown.base}`, shown.base];
    const { commits } = await checkout.refs([...heads, ...bases]);
    const head = first(heads, commits);
    const base = first(bases, commits);

    if (head === null) return { kind: "missing", subject, command: owner === null ? fetchAll : `git fetch https://${page.host}/${owner}/${page.repo}.git ${shown.head}:refs/remotes/${headRemote}/${shown.head}` };

    if (shown.base !== null && base === null) return { kind: "missing", subject, command: fetchAll };
    const start = base === null ? null : await startOf(base, head, checkout);

    return { kind: "show", target: { subject, pictures: changePictures(start, head), where: { changes: page.address, blob: blobAddress(owner === null ? repository : `https://${page.host}/${owner}/${page.repo}`, shown.head) }, range: { base: start, head }, stale: null } };
  }

  if (shown.kind === "commit") {
    const subject: Subject = { kind: "commit", sha: shown.sha };
    const commit = (await checkout.refs([shown.sha])).commits.get(shown.sha) ?? null;

    if (commit === null) return { kind: "missing", subject, command: fetchAll };
    const pictures: Picture[] = [{ name: "commit", hash: link(`commit:${commit}`, {}) }, { name: "code", hash: link("layers", { head: commit }) }];

    return { kind: "show", target: { subject, pictures, where: { changes: page.address, blob: blobAddress(repository, commit) }, range: { base: `${commit}~1`, head: commit }, stale: null } };
  }

  if (shown.kind === "tree" || shown.kind === "blob") {
    const { names, mainLine } = await checkout.branches();
    // The branches as GitHub names them: a remote one without its remote.
    const remoteLength = (name: string): number => served.remotes.map((candidate) => `${candidate.name}/`).find((start) => name.startsWith(start))?.length ?? 0;
    const { ref, path } = splitRef(shown.rest, names.map((name) => name.slice(remoteLength(name))));
    const subject: Subject = shown.kind === "blob" ? { kind: "file", ref, path } : { kind: "branch", ref };
    const candidates = [`${remote}/${ref}`, ref];
    const head = first(candidates, (await checkout.refs(candidates)).commits);

    if (head === null) return { kind: "missing", subject, command: fetchAll };
    // The main line has no change of its own to review: its pictures are of the code.
    const main = mainLine !== null && mainLine.slice(remoteLength(mainLine)) === ref;
    const file = shown.kind === "blob" && (await checkout.modules(head)).has(path) ? path : null;
    const ofFile: Picture[] = file === null ? [] : [{ name: "module", hash: link(`module:${file}`, { head }) }, { name: "inside", hash: link(`inside:${file}`, { head }) }];
    const pictures: Picture[] = main ? [...ofFile, { name: "code", hash: link("layers", { head }) }, { name: "modules", hash: link("modules", { head }) }] : [...ofFile, ...changePictures(null, head)];

    // A branch off the main line is a change GitHub lists too: its comparison with the default branch.
    return { kind: "show", target: { subject, pictures, where: { changes: main ? null : `${repository}/compare/${ref.split("/").map(encodeURIComponent).join("/")}`, blob: blobAddress(repository, ref) }, range: main ? null : { base: null, head }, stale: null } };
  }

  // The repository itself: the checkout as it is, with what is not committed yet.
  const pictures: Picture[] = [{ name: "code", hash: link("layers", {}) }, { name: "modules", hash: link("modules", {}) }, { name: "board", hash: link("changes", {}) }, { name: "branches", hash: link("branches", {}) }];

  return { kind: "show", target: { subject: { kind: "checkout" }, pictures, where: { changes: null, blob: blobAddress(repository, "HEAD") }, range: null, stale: null } };
}
