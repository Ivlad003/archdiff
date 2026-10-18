// The routes of the pictures: the views, a picture (its scene for the
// canvas, or its diagram and Markdown), a shape's and a line's page, a
// file, the exports, the coverage, the plan of a drawing, saving a
// drawing, the chat tags and the expansion of a tag, the project map, and
// the live-reload stream. Every picture is the one picture.ts draws for
// the query (`view`, the options, the refs), so a shape's page is asked
// of the picture the page shows. Each handler takes the server's context
// and the request; the table at the end names them by method and path.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { coverageReport } from "../coverage.ts";
import { EXPORT_EXTENSION, EXPORT_FORMATS, EXPORT_MEDIA_TYPE, exportDiagram, type ExportFormat } from "../export/index.ts";
import { toExcalidraw } from "../export/excalidraw.ts";
import { planFromScene, planMarkdown } from "../plan.ts";
import { mergeScene, parseLayout, readLayout, writeLayout, type SceneElement } from "../layouts.ts";
import { edgeMarkdown, nodeMarkdown } from "../markdown.ts";
import { isJsonObject, isJsonString, parseJson } from "../json.ts";
import { parseView, viewList } from "../views.ts";
import { projectMap } from "../project-map.ts";
import { standsFor } from "../shape-keys.ts";
import { failed, json, optionsOf, problem, send, type RouteContext, type RouteRequest } from "./context.ts";

export async function postLayout(ctx: RouteContext, { url, body, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  const key = url.searchParams.get("view") ?? "";

  if (!parseView(key)) return problem(response, 400, "unknown view");

  try {
    const file = writeLayout(root, parseLayout(parseJson(body), key));

    return json(response, { saved: file });
  } catch (error) {
    return problem(response, 400, error instanceof Error ? error.message : String(error));
  }
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
  // The picture's options (and refs) for @view: — the picture as the page shows it; the other tags take the defaults.
  const shown = new URLSearchParams(isJsonObject(parsed) && isJsonString(parsed["query"]) ? parsed["query"] : "");
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
    const query = kind === "view" ? new URLSearchParams(shown) : new URLSearchParams();
    query.set("view", key);
    const picture = await ctx.picture(query);

    if (!picture.ok) continue;
    const { diagram, markdown } = picture.value;

    if (kind === "module" || kind === "fn" || kind === "type") {
      const node = diagram.nodes.find((candidate) => standsFor(candidate) === subject);
      sections.push(`### ${tag}\n\n${node ? nodeMarkdown(node, analysis, readSource) : markdown}`);
    } else sections.push(`### ${tag}\n\n${markdown}`);
  }

  return json(response, { context: sections.length > 0 ? `## Context from the diagrams\n\n${sections.join("\n\n")}` : "" });
}

export async function getGraph(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  // The whole repository for the project map: every module (or directory, folded) with its layer, every import between them.
  const analysis = await ctx.fresh();

  return json(response, projectMap(analysis.graph));
}

export async function getScene(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const picture = await ctx.picture(url.searchParams);

  if (!picture.ok) return failed(response, picture);
  const { diagram, markdown, drawing, change } = picture.value;
  // The code's picture at the saved places, then the saved drawing's own elements (pencil, notes) on top.
  const generated = (JSON.parse(toExcalidraw(diagram)) as { elements: SceneElement[] }).elements;

  return json(response, { elements: drawing ? mergeScene(drawing.elements, generated) : generated, mocks: drawing?.mocks ?? [], diagram, markdown, drawn: drawing !== null, change: change ?? null });
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
  // The placed diagram of a picture with its Markdown, as JSON: what a script reads of a view.
  const picture = await ctx.picture(url.searchParams);

  if (!picture.ok) return failed(response, picture);
  const { diagram, markdown, drawing, change } = picture.value;

  return json(response, { diagram, markdown, drawn: drawing !== null, change: change ?? null });
}

export async function getShape(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  const id = url.searchParams.get("id") ?? "";
  // The same picture the page shows — its expansions, hidden lanes, fold limit, weight, the review's marks — so a shape is where the page has it.
  const picture = await ctx.picture(url.searchParams);

  if (!picture.ok) return failed(response, picture);
  const node = picture.value.diagram.nodes.find((candidate) => candidate.id === id);

  if (!node) return problem(response, 404, "no such shape in the picture");
  const analysis = await ctx.fresh();
  const readSource = (file: string): string | null => (analysis.facts.has(file) ? readFileSync(join(root, file), "utf8") : null);

  return json(response, { markdown: nodeMarkdown(node, analysis, readSource) });
}

export async function getLine(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const kind = url.searchParams.get("kind");
  const picture = await ctx.picture(url.searchParams);

  if (!picture.ok) return failed(response, picture);
  const { diagram } = picture.value;
  const edge = diagram.edges.find((candidate) => candidate.from === from && candidate.to === to && (kind === null || candidate.kind === kind));

  if (!edge) return problem(response, 404, "no such line in the picture");

  return json(response, { markdown: edgeMarkdown(edge, diagram, await ctx.fresh()) });
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
  const format = EXPORT_FORMATS.find((candidate): candidate is Exclude<ExportFormat, "md"> => candidate !== "md" && candidate === url.searchParams.get("format"));

  if (!format) return problem(response, 400, "unknown format");
  const picture = await ctx.picture(url.searchParams);

  if (!picture.ok) return failed(response, picture);
  const { diagram } = picture.value;
  const name = `${diagram.view.replace(/[^A-Za-z0-9._-]+/g, "_")}${EXPORT_EXTENSION[format]}`;
  const options = optionsOf(url.searchParams);
  const mermaid = options.ok ? options.value.mermaid : "auto";
  response.writeHead(200, { "content-type": EXPORT_MEDIA_TYPE[format], "content-disposition": `attachment; filename="${name}"` });

  return void response.end(exportDiagram(diagram, format, mermaid));
}

/** The handlers by `METHOD /path`. */
export const routes: Record<string, (ctx: RouteContext, request: RouteRequest) => Promise<void>> = {
  "POST /api/layout": postLayout,
  "POST /api/expand": postExpand,
  "GET /api/scene": getScene,
  "GET /api/views": getViews,
  "GET /api/plan": getPlan,
  "GET /api/diagram": getDiagram,
  "GET /api/shape": getShape,
  "GET /api/line": getLine,
  "GET /api/file": getFile,
  "GET /api/coverage": getCoverage,
  "GET /api/changes": getChanges,
  "GET /api/tags": getTags,
  "GET /api/export": getExport,
  "GET /api/graph": getGraph,
};
