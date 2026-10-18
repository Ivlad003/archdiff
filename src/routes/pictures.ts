// The routes of the pictures: the views, a diagram and its scene, a shape's
// and a line's page, a file, the exports, the coverage, the plan of a
// drawing, the saved layouts, the chat tags, the expansion of a tag, and
// the live-reload stream. Each handler takes the server's context and the
// request; the table at the end names them by method and path.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { coverageReport } from "../coverage.ts";
import type { Shape } from "../diagram.ts";
import { compareBranches, review } from "../diff.ts";
import { EXPORT_EXTENSION, EXPORT_FORMATS, EXPORT_MEDIA_TYPE, exportDiagram, MERMAID_STYLES, type ExportFormat, type MermaidStyle } from "../export/index.ts";
import { toExcalidraw } from "../export/excalidraw.ts";
import { planFromScene, planMarkdown } from "../plan.ts";
import { mergeScene, parseLayout, readLayout, writeLayout, type SceneElement } from "../layouts.ts";
import { diagramMarkdown, edgeMarkdown, nodeMarkdown } from "../markdown.ts";
import { isJsonObject, isJsonString, parseJson } from "../json.ts";
import { parseView, viewList, viewOf, viewOptionsOf, type View } from "../views.ts";
import { withLogic } from "../logic.ts";
import { projectMap } from "../project-map.ts";
import { readPictureOptions } from "../options.ts";
import { failed, json, problem, send, type RouteContext, type RouteRequest } from "./context.ts";

export async function postLayout(ctx: RouteContext, { url, body, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  const key = url.searchParams.get("view") ?? "";

  if (!parseView(key) && !key.startsWith("review")) return problem(response, 400, "unknown view");

  try {
    const file = writeLayout(root, parseLayout(parseJson(body), key));

    return json(response, { saved: file });
  } catch (error) {
    return problem(response, 400, error instanceof Error ? error.message : String(error));
  }
}

/** The analysis with what a view needs read at the edge: the logic of a function from its file. */
async function sourceFor(analysis: Awaited<ReturnType<RouteContext["fresh"]>>, view: View): Promise<typeof analysis> {
  return view.kind === "logic" && view.scope !== null ? withLogic(analysis, view.scope) : analysis;
}

export async function postExpand(ctx: RouteContext, { body, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  // The tags of a text (@module:path, @fn:path#name, @layer:name, @dir:path, @flow:path#fn, @type:path#Name, @logic:path#fn,
  // @view:<key>) as context for an agent; `query` carries the picture's options for @view: (the picture as the page shows it).
  let parsed;

  try {
    parsed = parseJson(body);
  } catch {
    return problem(response, 400, "the body must be JSON");
  }

  const text = isJsonObject(parsed) && isJsonString(parsed["text"]) ? parsed["text"] : "";
  const query = new URLSearchParams(isJsonObject(parsed) && isJsonString(parsed["query"]) ? parsed["query"] : "");
  const picked = readPictureOptions((name) => query.get(name), "param");
  const pictureOptions = picked.ok ? viewOptionsOf(picked.value.options) : {};
  const analysis = await ctx.fresh();
  const readSource = (file: string): string | null => (analysis.facts.has(file) ? readFileSync(join(root, file), "utf8") : null);
  const sections: string[] = [];
  const seenTags = new Set<string>();

  for (const match of text.matchAll(/@(module|fn|layer|dir|flow|type|logic|view):(\S+)/g)) {
    const tag = match[0];

    if (seenTags.has(tag)) continue;
    seenTags.add(tag);
    const kind = match[1]!;
    const subject = match[2]!.replace(/[.,;:)]+$/, "");
    const key = kind === "fn" ? `calls:${subject}` : kind === "flow" ? `calls:${subject}` : kind === "type" ? `type:${subject}` : kind === "view" ? subject : `${kind}:${subject}`;
    const view = parseView(key);

    if (!view) continue;
    const source = await sourceFor(analysis, view);
    const diagram = viewOf(source, view, kind === "view" ? pictureOptions : {});

    if (kind === "module" || kind === "fn" || kind === "type") {
      const node = diagram.nodes.find((candidate) => (candidate.ref?.id ?? candidate.id) === subject);
      sections.push(`### ${tag}\n\n${node ? nodeMarkdown(node, analysis, readSource) : diagramMarkdown(diagram, analysis)}`);
    } else sections.push(`### ${tag}\n\n${diagramMarkdown(diagram, analysis)}`);
  }

  return json(response, { context: sections.length > 0 ? `## Context from the diagrams\n\n${sections.join("\n\n")}` : "" });
}

export async function getGraph(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  // The whole repository for the project map: every module (or directory, folded) with its layer, every import between them.
  const analysis = await ctx.fresh();

  return json(response, projectMap(analysis.graph));
}

export async function getLayout(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  const key = url.searchParams.get("view") ?? "";
  const saved = readLayout(root, key);

  return json(response, saved ? { saved: saved.saved, mocks: saved.mocks, elements: saved.elements.length } : null);
}

export async function getScene(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  const key = url.searchParams.get("view") ?? "";
  const analysis = await ctx.fresh();
  const picked = ctx.optionsOf(url);

  if (!picked.ok) return failed(response, picked);
  const diagram = await ctx.placed(analysis, key, picked.value, url.searchParams.get("base"), url.searchParams.get("head"));

  if (!diagram) return problem(response, 400, "unknown view");
  // The code's picture at the saved places, then the saved drawing's own elements (pencil, notes) on top.
  const generated = (JSON.parse(toExcalidraw(diagram)) as { elements: SceneElement[] }).elements;
  const saved = readLayout(root, key);
  const mermaid = (url.searchParams.get("mermaid") ?? "auto") as MermaidStyle;

  return json(response, { elements: saved ? mergeScene(saved.elements, generated) : generated, mocks: saved?.mocks ?? [], diagram, markdown: diagramMarkdown(diagram, analysis, MERMAID_STYLES.includes(mermaid) ? mermaid : "auto"), drawn: saved !== null });
}

export async function getViews(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  const { root, agentSpec } = ctx;
  const analysis = await ctx.fresh();

  return json(response, { root, stats: analysis.stats, layers: analysis.graph.layers, views: viewList(analysis), agent: agentSpec?.name ?? null });
}

export async function getPlan(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  // The task drawn on the saved scene of a view.
  const key = url.searchParams.get("view") ?? "";

  if (!parseView(key)) return problem(response, 400, "unknown view");
  const analysis = await ctx.fresh();
  const saved = readLayout(root, key);
  const plan = planFromScene(analysis, key, saved?.elements ?? []);

  return json(response, { plan, markdown: planMarkdown(plan, analysis), drawn: saved !== null });
}

export async function getDiagram(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  const view = parseView(url.searchParams.get("view") ?? "");

  if (!view) return problem(response, 400, "unknown view");
  const analysis = await ctx.fresh();
  const picked = ctx.optionsOf(url);

  if (!picked.ok) return failed(response, picked);
  const diagram = (await ctx.placed(analysis, url.searchParams.get("view") ?? "", picked.value, url.searchParams.get("base"), url.searchParams.get("head")))!;
  const mermaid = (url.searchParams.get("mermaid") ?? "auto") as MermaidStyle;

  return json(response, { diagram, markdown: diagramMarkdown(diagram, analysis, MERMAID_STYLES.includes(mermaid) ? mermaid : "auto"), drawn: readLayout(root, url.searchParams.get("view") ?? "") !== null });
}

export async function getNode(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  const view = parseView(url.searchParams.get("view") ?? "");
  const id = url.searchParams.get("id") ?? "";

  if (!view) return problem(response, 400, "unknown view");
  const analysis = await ctx.fresh();
  const picked = ctx.optionsOf(url);

  if (!picked.ok) return failed(response, picked);
  // The same picture the page shows: with its expansions, hidden lanes, fold limit and weight, a shape is where the page has it.
  const diagram = view.kind === "timeline" ? { nodes: [] as Shape[] } : viewOf(await sourceFor(analysis, view), view, viewOptionsOf(picked.value));
  const node = diagram.nodes.find((candidate) => candidate.id === id);

  if (!node) return problem(response, 404, "no such shape in the view");

  const readSource = (file: string): string | null => (analysis.facts.has(file) ? readFileSync(join(root, file), "utf8") : null);

  return json(response, { markdown: nodeMarkdown(node, analysis, readSource) });
}

export async function getEdge(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const view = parseView(url.searchParams.get("view") ?? "");
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const kind = url.searchParams.get("kind");

  if (!view) return problem(response, 400, "unknown view");
  const analysis = await ctx.fresh();
  const picked = ctx.optionsOf(url);

  if (!picked.ok) return failed(response, picked);
  const diagram = view.kind === "timeline" ? { view: "timeline", title: "", nodes: [], edges: [], groups: [] } : viewOf(await sourceFor(analysis, view), view, viewOptionsOf(picked.value));
  const edge = diagram.edges.find((candidate) => candidate.from === from && candidate.to === to && (kind === null || candidate.kind === kind));

  if (!edge) return problem(response, 404, "no such line in the view");

  return json(response, { markdown: edgeMarkdown(edge, diagram, analysis) });
}

export async function getFile(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  const file = url.searchParams.get("path") ?? "";
  const analysis = await ctx.fresh();

  // An analysed file, or any other text file of the repository (a package.json a package shape points to); never a path out of it.
  const full = join(root, ...file.split("/"));

  if (file === "" || file.split("/").some((segment) => segment === "" || segment === "." || segment === "..") || file.startsWith(".git/") || file.includes("node_modules/")) return problem(response, 404, "not a file of the repository");

  if (!analysis.facts.has(file) && !(existsSync(full) && statSync(full).isFile() && statSync(full).size <= 1_500_000)) return problem(response, 404, "not a file of the repository");

  return send(response, 200, "text/plain; charset=utf-8", readFileSync(full, "utf8"));
}

export async function getCoverage(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  const analysis = await ctx.fresh();

  return json(response, coverageReport(analysis));
}

export async function getChanges(ctx: RouteContext, { response, request }: RouteRequest): Promise<void> {
  const { options } = ctx;
  // Server-sent events: one per change of a source file, debounced; the page reloads its view.
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  response.write(`data: ${JSON.stringify({ watching: options.watch })}\n\n`);
  ctx.changeListeners.add(response);
  request.on("close", () => ctx.changeListeners.delete(response));

  return;
}

export async function getTags(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  // What `@` can name in the chat: layers, directories, modules, functions, flows (entry points), types; filtered by `q`.
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const analysis = await ctx.fresh();
  const tags: { tag: string; title: string }[] = [];

  for (const entry of viewList(analysis)) {
    if (entry.kind === "layer") tags.push({ tag: `@layer:${entry.key.slice(6)}`, title: entry.title });
    else if (entry.kind === "dir") tags.push({ tag: `@dir:${entry.key.slice(4)}`, title: entry.title });
    else if (entry.kind === "module") tags.push({ tag: `@module:${entry.key.slice(7)}`, title: entry.title });
    else if (entry.kind === "calls") tags.push({ tag: `@flow:${entry.key.slice(6)}`, title: entry.title });
    else if (entry.kind === "type") tags.push({ tag: `@type:${entry.key.slice(5)}`, title: entry.title });
    else if (entry.kind === "logic" && entry.key !== "logic") tags.push({ tag: `@logic:${entry.key.slice(6)}`, title: `${entry.title} — the flowchart and its rules` });
  }

  for (const node of analysis.graph.nodes.values()) if (node.kind === "fn") tags.push({ tag: `@fn:${node.id}`, title: `${node.parent ? `${node.parent}.` : ""}${node.name} (${node.module})` });
  const hits = tags.filter((candidate) => q === "" || candidate.tag.toLowerCase().includes(q) || candidate.title.toLowerCase().includes(q)).slice(0, 40);

  return json(response, { tags: hits });
}

export async function getExport(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root, options } = ctx;
  const format = url.searchParams.get("format") ?? "";

  if (!EXPORT_FORMATS.includes(format as ExportFormat) || format === "md") return problem(response, 400, "unknown format");
  const key = url.searchParams.get("view") ?? "";
  const analysis = await ctx.fresh();
  let diagram;

  if (key.startsWith("review")) {
    const result = await review(root, url.searchParams.get("base") || options.base, url.searchParams.get("head") || null);
    diagram = result.diagram;
  } else if (key.startsWith("compare")) {
    const result = await compareBranches(root, url.searchParams.get("base") || null, (url.searchParams.get("heads") ?? "WORKTREE").split(",").filter((head) => head !== ""));
    diagram = result.diagram;
  } else {
    const picked = ctx.optionsOf(url);

    if (!picked.ok) return failed(response, picked);
    diagram = await ctx.placed(analysis, key, picked.value, url.searchParams.get("base"), url.searchParams.get("head"));

    if (!diagram) return problem(response, 400, "unknown view");
  }

  const name = `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}${EXPORT_EXTENSION[format as ExportFormat]}`;
  const mermaid = (url.searchParams.get("mermaid") ?? "auto") as MermaidStyle;
  response.writeHead(200, { "content-type": EXPORT_MEDIA_TYPE[format as ExportFormat], "content-disposition": `attachment; filename="${name}"` });

  return void response.end(exportDiagram(diagram, format as Exclude<ExportFormat, "md">, MERMAID_STYLES.includes(mermaid) ? mermaid : "auto"));
}

/** The handlers by `METHOD /path`. */
export const routes: Record<string, (ctx: RouteContext, request: RouteRequest) => Promise<void>> = {
  "POST /api/layout": postLayout,
  "POST /api/expand": postExpand,
  "GET /api/layout": getLayout,
  "GET /api/scene": getScene,
  "GET /api/views": getViews,
  "GET /api/plan": getPlan,
  "GET /api/diagram": getDiagram,
  "GET /api/node": getNode,
  "GET /api/edge": getEdge,
  "GET /api/file": getFile,
  "GET /api/coverage": getCoverage,
  "GET /api/changes": getChanges,
  "GET /api/tags": getTags,
  "GET /api/export": getExport,
  "GET /api/graph": getGraph,
};
