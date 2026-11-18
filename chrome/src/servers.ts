// The archdiff of a repository, on this computer: `archdiff web` listens on
// port 7080 or the next free one above it, and says which repository it
// serves (`GET /api/repository`: its remotes by host and path). Every port
// it may have taken is asked at once — and every address the reader added,
// for a server on a port of its own — and the one whose remote is the
// repository of the GitHub page is the one to show. Only this computer is
// asked: an address is a port of `127.0.0.1` or `localhost`.
//
// Entry points: `serving`, `ask`, `candidates`, `localOrigin`, `remoteFor`,
// `Served`, `Answer`, `Fetcher`.

import type { RepositoryPage } from "./hosts.ts";

/** A remote of a served repository, as the server names it. */
export interface Remote {
  name: string;
  host: string;
  path: string;
}

/** An archdiff found on this computer, and the repository it serves. */
export interface Served {
  /** Where it listens: `http://127.0.0.1:7080`. */
  origin: string;
  /** The folder's name. */
  name: string;
  /** The folder's path on this computer. */
  root: string;
  version: string;
  remotes: Remote[];
}

/** What an address answered: an archdiff that says what it serves, one too old to say, or nothing of archdiff's. */
export type Answer = { kind: "served"; served: Served } | { kind: "old"; origin: string } | { kind: "none" };

/** What the servers are asked with: `fetch`, or a stand-in for it. */
export type Fetcher = (address: string, init?: { signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** The first port `archdiff web` takes, and how many above it are asked: it tries fifty, and few computers run more than a handful. */
const FIRST_PORT = 7080;
const PORTS = 20;

/** How long one address may take to answer: a port nobody listens on refuses at once, a busy server is not waited for. */
const TIMEOUT = 1500;

/** An address of this computer as an origin (`http://127.0.0.1:7080`), from what the reader typed (`7080`, `localhost:7123`, a whole address); null for anything else. */
export function localOrigin(typed: string): string | null {
  const text = typed.trim();
  const address = /^\d+$/.test(text) ? `http://127.0.0.1:${text}` : /^https?:\/\//i.test(text) ? text : `http://${text}`;

  try {
    const url = new URL(address);

    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port !== "" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The addresses to ask: the reader's own first, then the ports `archdiff web` takes by itself. */
export function candidates(added: readonly string[]): string[] {
  const own = added.map(localOrigin).filter((origin): origin is string => origin !== null);

  return [...new Set([...own, ...Array.from({ length: PORTS }, (_unused, index) => `http://127.0.0.1:${FIRST_PORT + index}`)])];
}

function isRemote(value: unknown): value is Remote {
  if (typeof value !== "object" || value === null) return false;
  const { name, host, path } = value as Record<string, unknown>;

  return typeof name === "string" && typeof host === "string" && typeof path === "string";
}

/** What listens on an address: asked which repository it serves. */
export async function ask(origin: string, fetcher: Fetcher, timeout = TIMEOUT): Promise<Answer> {
  const waited = new AbortController();
  const timer = setTimeout(() => waited.abort(), timeout);

  try {
    const response = await fetcher(`${origin}/api/repository`, { signal: waited.signal });
    const answer = (await response.json()) as { name?: unknown; root?: unknown; version?: unknown; remotes?: unknown; error?: unknown } | null;

    if (typeof answer !== "object" || answer === null) return { kind: "none" };

    // An archdiff from before this question was one of its API's: it answers as it does to any unknown route.
    if (response.status === 404 && answer.error === "no such API") return { kind: "old", origin };

    if (response.status !== 200 || typeof answer.name !== "string" || typeof answer.version !== "string" || !Array.isArray(answer.remotes)) return { kind: "none" };

    return { kind: "served", served: { origin, name: answer.name, root: typeof answer.root === "string" ? answer.root : answer.name, version: answer.version, remotes: answer.remotes.filter(isRemote) } };
  } catch {
    // Nobody listens there, or something that is no archdiff.
    return { kind: "none" };
  } finally {
    clearTimeout(timer);
  }
}

/** The remote of a served repository that is the page's repository, by its name; null when none is. */
export function remoteFor(served: Served, page: Pick<RepositoryPage, "host" | "owner" | "repo">): string | null {
  const wanted = `${page.owner}/${page.repo}`.toLowerCase();

  // GitHub reads the owner and the name in any case.
  return served.remotes.find((remote) => remote.host === page.host && remote.path.toLowerCase() === wanted)?.name ?? null;
}

/** What the search for a repository's archdiff came to. */
export interface Search {
  /** The archdiff of the repository and the remote that names it there; null when none serves it. */
  match: { served: Served; remote: string } | null;
  /** Every archdiff that answered, for the note that says what was found instead. */
  found: Served[];
  /** The addresses where an archdiff too old to say what it serves listens. */
  old: string[];
}

/** The archdiff that serves the repository of a page, among the addresses given — the first of them in the order asked, when two serve it — with everything else that answered. */
export async function serving(page: Pick<RepositoryPage, "host" | "owner" | "repo">, origins: readonly string[], fetcher: Fetcher): Promise<Search> {
  const answers = await Promise.all(origins.map((origin) => ask(origin, fetcher)));
  const found = answers.flatMap((answer) => (answer.kind === "served" ? [answer.served] : []));
  const old = answers.flatMap((answer) => (answer.kind === "old" ? [answer.origin] : []));

  for (const served of found) {
    const remote = remoteFor(served, page);

    if (remote !== null) return { match: { served, remote }, found, old };
  }

  return { match: null, found, old };
}
