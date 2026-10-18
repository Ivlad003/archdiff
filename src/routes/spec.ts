// The routes of the specification: the specs and features of the
// repository, one of them, the prompt that has the agent write or review
// them, and the OpenSpec validation.
//
// Entry point: `routes`, by `METHOD /path` (server.ts dispatches through
// it).

import { listSpecs, readSpec, specPrompt, specSubject, validateSpecs } from "../spec.ts";
import { parseView } from "../views.ts";
import { json, problem, type RouteContext, type RouteRequest } from "./context.ts";

export async function getSpecs(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  return json(response, listSpecs(ctx.root));
}

export async function getSpec(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const path = url.searchParams.get("path") ?? "";
  const text = readSpec(ctx.root, path);

  if (text === null) return problem(response, 404, "no such spec");

  return json(response, { path, text });
}

export async function getSpecPrompt(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  // `mode=update` reviews every spec; `generate` writes the spec of the view's subject (or of every layer without a view).
  const mode = url.searchParams.get("mode") === "update" ? "update" : "generate";
  const key = url.searchParams.get("view");
  const view = key ? parseView(key) : null;

  if (key && !view) return problem(response, 400, "unknown view");
  const analysis = await ctx.fresh();

  return json(response, { markdown: specPrompt(analysis, mode, specSubject(view)) });
}

export async function postSpecValidate(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  return json(response, await validateSpecs(ctx.root));
}

/** The handlers by `METHOD /path`. */
export const routes: Record<string, (ctx: RouteContext, request: RouteRequest) => Promise<void>> = {
  "GET /api/specs": getSpecs,
  "GET /api/spec": getSpec,
  "GET /api/spec/prompt": getSpecPrompt,
  "POST /api/spec/validate": postSpecValidate,
};
