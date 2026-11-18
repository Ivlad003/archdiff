// What an address of GitHub shows: which repository, and what of it — its
// front page, a branch or a file at a revision, one commit, a pull request,
// a comparison of two branches. The address alone is read: a pull request's
// branches are in its page (pull.ts), and where a branch's name ends and a
// path begins (`/tree/feature/x/src`) only the repository's own branches
// say (`splitRef`). Pure.
//
// Entry points: `pageOf`, `splitRef`, `RepositoryPage`, `Shown`.

/** What a page of a repository shows. */
export type Shown =
  /** The repository itself: its front page, its issues, its settings. */
  | { kind: "repository" }
  /** A branch, a tag or a commit, with the directory under it when one is open: `rest` is `<ref>[/<directory>]`. */
  | { kind: "tree"; rest: string }
  /** A file at a revision: `rest` is `<ref>/<path>`. */
  | { kind: "blob"; rest: string }
  | { kind: "commit"; sha: string }
  /** A pull request, on any of its tabs; `files` on the tab that lists its changed files. */
  | { kind: "pull"; number: number; files: boolean }
  /** Two revisions set against each other; no base is the repository's default branch, an owner the fork the head is in. */
  | { kind: "compare"; base: string | null; head: string; headOwner: string | null };

export interface RepositoryPage {
  /** The host of the forge, in lower case (`github.com`). */
  host: string;
  owner: string;
  repo: string;
  /** The address of the page itself, without its query and its hash. */
  address: string;
  shown: Shown;
}

/** The hosts whose addresses are read: GitHub's own. */
const HOSTS: ReadonlySet<string> = new Set(["github.com"]);

/** First segments of a GitHub address that are pages of the site, not the owner of a repository. */
const NOT_OWNERS: ReadonlySet<string> = new Set([
  "about", "account", "apps", "codespaces", "collections", "contact", "copilot", "customer-stories", "dashboard", "enterprise", "events", "explore",
  "features", "gist", "issues", "join", "login", "logout", "marketplace", "new", "notifications", "organizations", "orgs", "pricing", "pulls",
  "search", "security", "sessions", "settings", "signup", "site", "sponsors", "stars", "team", "topics", "trending", "users", "watching",
]);

/** A segment of an address as it was typed: `%2F` and the like read back; a broken escape is left as it is. */
function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The two ends of a comparison as its address writes them: `base...head`, `base..head`, or the head alone. */
function compareOf(range: string): Shown {
  const dots = range.includes("...") ? "..." : range.includes("..") ? ".." : null;
  const base = dots === null ? null : range.slice(0, range.indexOf(dots));
  const end = dots === null ? range : range.slice(range.indexOf(dots) + dots.length);
  // The head of another fork: `owner:branch`, or `owner:repository:branch`.
  const parts = end.split(":");
  const head = parts[parts.length - 1]!;

  return { kind: "compare", base: base === null || base === "" ? null : base.includes(":") ? base.slice(base.lastIndexOf(":") + 1) : base, head, headOwner: parts.length > 1 ? parts[0]! : null };
}

/** The repository page an address is of, and what it shows; null for any other address. */
export function pageOf(address: string): RepositoryPage | null {
  let url: URL;

  try {
    url = new URL(address);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();

  if (url.protocol !== "https:" || !HOSTS.has(host)) return null;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const [owner, repo, section, ...rest] = segments.map(decoded);

  if (owner === undefined || repo === undefined || NOT_OWNERS.has(owner.toLowerCase())) return null;
  const page = (shown: Shown): RepositoryPage => ({ host, owner, repo: repo.replace(/\.git$/, ""), address: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, shown });
  const first = rest[0];

  if (section === "pull" && first !== undefined && /^\d+$/.test(first)) {
    // One commit of the pull request is that commit's own change.
    if (rest[1] === "commits" && rest[2] !== undefined && /^[0-9a-f]{7,40}$/i.test(rest[2])) return page({ kind: "commit", sha: rest[2].toLowerCase() });

    return page({ kind: "pull", number: Number(first), files: rest[1] === "files" || rest[1] === "changes" });
  }

  if (section === "commit" && first !== undefined && /^[0-9a-f]{7,40}$/i.test(first)) return page({ kind: "commit", sha: first.toLowerCase() });

  if (section === "compare" && rest.length > 0) return page(compareOf(rest.join("/")));

  if ((section === "tree" || section === "commits") && rest.length > 0) return page({ kind: "tree", rest: rest.join("/") });

  if ((section === "blob" || section === "blame") && rest.length > 1) return page({ kind: "blob", rest: rest.join("/") });

  return page({ kind: "repository" });
}

/**
 * Where the ref ends in `<ref>/<path>`, which an address does not say (`feature/x/src/a.ts`): the longest of the
 * repository's branches the text starts with, whole segments only; else a commit's hash or a name of one segment
 * (a tag, a branch this checkout has not got).
 */
export function splitRef(rest: string, branches: readonly string[]): { ref: string; path: string } {
  let ref = "";

  for (const branch of branches) if (branch.length > ref.length && (rest === branch || rest.startsWith(`${branch}/`))) ref = branch;

  if (ref === "") ref = rest.split("/")[0]!;

  return { ref, path: rest.slice(ref.length + 1) };
}
