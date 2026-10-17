// The routes that read git: the review against a base, the comparison of
// branches, the branches, the commits of a range and the history.

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, type Analysis } from "../analyze.ts";
import { coverageReport } from "../coverage.ts";
import { layout, type DiagramNode } from "../diagram.ts";
import { compareBranches, comparisonMarkdown, history, onlyChanged, overlayDiff, review, reviewMarkdown } from "../diff.ts";
import { commitsBetween, defaultBase, fileHistory, listBranches, mergeBase, revisionStamp } from "../git.ts";
import { timelineDiagram } from "../views-more.ts";
import { watch as watchFs } from "node:fs";
import { EXPORT_EXTENSION, EXPORT_FORMATS, EXPORT_MEDIA_TYPE, exportDiagram, MERMAID_STYLES, type ExportFormat, type MermaidStyle } from "../export/index.ts";
import { toExcalidraw } from "../export/excalidraw.ts";
import { AgentRunner, agentFromConfig, type AgentSpec } from "../agent.ts";
import { dataFlow, flowMarkdown, jsonInAnswer, mockPrompt, mocksFromTypes } from "../flow.ts";
import { applyOverlays, parseOverlays, type Overlay } from "../overlays.ts";
import { planFromScene, planMarkdown } from "../plan.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { CACHE_DIRECTORY } from "../cache.ts";
import { layoutSlug } from "../layouts.ts";
import { AGENT_PROTOCOL, checkIntent, checkMarkdown, documentPrompt, INTENT_FILE, intentMarkdown, mergePlan, parseIntent, writeIntent } from "../intent.ts";
import { mergeScene, parseLayout, positionsOf, readLayout, writeLayout, type SceneElement } from "../layouts.ts";
import { diagramMarkdown, edgeMarkdown, nodeMarkdown } from "../markdown.ts";
import { isJsonObject, isJsonString, parseJson } from "../json.ts";
import { parseView, viewList, viewOf, type ViewOptions } from "../views.ts";
import { json, problem, send, type RouteContext, type RouteRequest } from "./context.ts";

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
