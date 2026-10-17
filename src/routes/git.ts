// The routes that read git: the review against a base, the comparison of
// branches, the branches, the commits of a range and the history.

import { compareBranches, comparisonMarkdown, review, reviewMarkdown } from "../diff.ts";
import { commitsBetween, defaultBase, fileHistory, listBranches, mergeBase } from "../git.ts";
import { toExcalidraw } from "../export/excalidraw.ts";
import { type SceneElement } from "../layouts.ts";
import { json, problem, type RouteContext, type RouteRequest } from "./context.ts";

export async function getCommits(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root, options } = ctx;
  // The commits of the review range, oldest first, for stepping through a branch.
  try {
    const base = url.searchParams.get("base") || options.base || mergeBase(root);
    const head = url.searchParams.get("head") || "HEAD";

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

export async function getCompare(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root, options } = ctx;
  // Several heads against one base: `heads=a,b,c`, `WORKTREE` for the working tree.
  const heads = (url.searchParams.get("heads") ?? "").split(",").filter((head) => head !== "");

  if (heads.length === 0) return problem(response, 400, "heads=a,b,… is required (WORKTREE for the working tree)");

  try {
    const result = await compareBranches(root, url.searchParams.get("base") || options.base, heads);
    const elements = (JSON.parse(toExcalidraw(result.diagram)) as { elements: SceneElement[] }).elements;

    return json(response, { base: result.base, heads: result.heads.map(({ head, diff }) => ({ head, diff })), diagram: result.diagram, elements, markdown: comparisonMarkdown(result) });
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

export async function getReview(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root, options } = ctx;
  const base = url.searchParams.get("base") || options.base;
  const head = url.searchParams.get("head") || null;

  try {
    const result = await review(root, base, head);

    const elements = (JSON.parse(toExcalidraw(result.diagram)) as { elements: SceneElement[] }).elements;

    return json(response, { diff: result.diff, diagram: result.diagram, elements, markdown: reviewMarkdown(result) });
  } catch (error) {
    return problem(response, 400, error instanceof Error ? error.message : String(error));
  }
}

/** The handlers by `METHOD /path`. */
export const routes: Record<string, (ctx: RouteContext, request: RouteRequest) => Promise<void>> = {
  "GET /api/commits": getCommits,
  "GET /api/branches": getBranches,
  "GET /api/compare": getCompare,
  "GET /api/history": getHistory,
  "GET /api/review": getReview,
};
