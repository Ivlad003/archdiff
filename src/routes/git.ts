// The routes that read git: for the review's bars, the branches, the commits
// of a range and the history of a file; and for a host that looks for the
// archdiff of a repository (the browser extension), which repository this
// server serves and the commits its refs name. The review and the comparison
// themselves are pictures (`/api/scene?view=review`, `view=compare`).
//
// Entry point: `routes`, by `METHOD /path` (server.ts dispatches through
// it).

import { createRequire } from "node:module";
import { basename } from "node:path";
import { commitOf, commitsBetween, defaultBase, fileHistory, forkPoint, listBranches, mergeBase, remotes } from "../git.ts";
import { json, problem, type RouteContext, type RouteRequest } from "./context.ts";

/** The version of this archdiff: a host tells by it what the server can answer. */
const VERSION = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

/** How many refs one request may ask about: each is a question to git. */
const MAX_REFS = 24;

export async function getCommits(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root, options } = ctx;
  // The commits of the review range, oldest first, for stepping through a branch.
  try {
    const head = url.searchParams.get("head") || "HEAD";
    const base = url.searchParams.get("base") || options.base || mergeBase(root, head);

    return json(response, { base, head, commits: commitsBetween(root, base, head) });
  } catch (error) {
    return problem(response, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function getBranches(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  const { root, options } = ctx;
  // Local and remote branches for the pickers, with the base to start from and the current branch.
  try {
    return json(response, { ...listBranches(root), base: options.base || defaultBase(root) });
  } catch (error) {
    return problem(response, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function getHistory(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  const file = url.searchParams.get("path") ?? "";
  const analysis = await ctx.fresh();

  if (!analysis.facts.has(file)) return problem(response, 404, "not an analysed file");

  return json(response, { path: file, commits: fileHistory(root, file) });
}

export async function getRepository(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  const { root } = ctx;

  // Which repository this is, for a host that has the address of one on a forge and looks for its checkout here: the
  // folder, this archdiff's version, and the remotes — the host and the path of each, never the name or the password
  // its address may carry. Outside git there is no remote, and the answer says so by an empty list.
  return json(response, { name: basename(root), root, version: VERSION, remotes: remotes(root) });
}

export async function getRefs(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  // What this checkout has of a change on a forge: the commit each `ref=` names (a branch, a tag, a commit; null for
  // one git does not know here), and with `base=` and `head=` where the head left the base — their merge-base, the
  // commit a pull request of the head into the base starts from (null when they share none).
  try {
    const refs = url.searchParams.getAll("ref");

    if (refs.length > MAX_REFS) return problem(response, 400, `at most ${MAX_REFS} refs at once`);
    const base = url.searchParams.get("base");
    const head = url.searchParams.get("head");

    return json(response, { refs: refs.map((ref) => ({ ref, commit: commitOf(root, ref) })), fork: base && head ? forkPoint(root, base, head) : null });
  } catch (error) {
    return problem(response, 400, error instanceof Error ? error.message : String(error));
  }
}

/** The handlers by `METHOD /path`. */
export const routes: Record<string, (ctx: RouteContext, request: RouteRequest) => Promise<void>> = {
  "GET /api/commits": getCommits,
  "GET /api/branches": getBranches,
  "GET /api/history": getHistory,
  "GET /api/repository": getRepository,
  "GET /api/refs": getRefs,
};
