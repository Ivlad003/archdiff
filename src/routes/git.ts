// The routes that read git for the review's bars: the branches, the commits
// of a range and the history of a file. The review and the comparison
// themselves are pictures (`/api/scene?view=review`, `view=compare`).
//
// Entry point: `routes`, by `METHOD /path` (server.ts dispatches through
// it).

import { commitsBetween, defaultBase, fileHistory, listBranches, mergeBase } from "../git.ts";
import { json, problem, type RouteContext, type RouteRequest } from "./context.ts";

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

/** The handlers by `METHOD /path`. */
export const routes: Record<string, (ctx: RouteContext, request: RouteRequest) => Promise<void>> = {
  "GET /api/commits": getCommits,
  "GET /api/branches": getBranches,
  "GET /api/history": getHistory,
};
