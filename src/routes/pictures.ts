// The routes of the pictures: the views, a picture (its scene for the
// canvas, or its diagram and Markdown), a shape's and a line's page, a
// file, the exports, the coverage, the plan of a drawing, saving a
// drawing, the chat tags and the expansion of a tag, the project map, and
// the live-reload stream. Every picture is the one picture.ts draws for
// the query (`view`, the options, the refs), so a shape's page is asked
// of the picture the page shows. Each handler takes the server's context
// and the request; the table at the end names them by method and path.
//
// Entry point: `routes`, by `METHOD /path` (server.ts dispatches through
// it).

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { Analysis } from "../analyze.ts";
import { coverageReport } from "../coverage.ts";
import { dataFlow, flowMarkdown } from "../flow.ts";
import { EXPORT_EXTENSION, EXPORT_FORMATS, EXPORT_MEDIA_TYPE, exportDiagram, type ExportFormat } from "../export/index.ts";
import { toExcalidraw } from "../export/excalidraw.ts";
import { planFromScene, taskMarkdown } from "../plan.ts";
import { mergeScene, parseDrawing, readDrawing, writeDrawing, type SceneElement } from "../drawings.ts";
import { commitFiles, commitInfo, fileAt } from "../git.ts";
import { moduleChangeMarkdown } from "../diff.ts";
import { commitMarkdown, edgeMarkdown, nodeMarkdown } from "../markdown.ts";
import { isJsonObject, isJsonString, parseJson } from "../json.ts";
import { parseView, viewList } from "../views.ts";
import { codeRevision, type ViewKind } from "../view-keys.ts";
import { projectMap } from "../project-map.ts";
import { standsFor } from "../shape-keys.ts";
import { failed, json, optionsOf, problem, send, type RouteContext, type RouteRequest } from "./context.ts";

export async function postDrawing(ctx: RouteContext, { url, body, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  const key = url.searchParams.get("view") ?? "";

  if (!parseView(key)) return problem(response, 400, "unknown view");

  try {
    const file = writeDrawing(root, parseDrawing(parseJson(body), key));

    return json(response, { saved: file });
  } catch (error) {
    return problem(response, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function postExpand(ctx: RouteContext, { body, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  // The tags of a text (@module:path, @fn:path#name, @layer:name, @dir:path, @flow:path#fn, @type:path#Name, @logic:path#fn,
  // @view:<key>) as context for an agent; `query` carries the picture's options for @view: (the picture as the page shows it).
  // @flow: is the data flow of an entry with its saved mocks; the call tree of one is @view:calls:<entry>.
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
    const kind = match[1]!;
    // The punctuation after a tag (`(@module:x).`) is the sentence's, not the subject's.
    const subject = match[2]!.replace(/[.,;:)]+$/, "");
    const tag = `@${kind}:${subject}`;

    if (seenTags.has(tag)) continue;
    seenTags.add(tag);

    if (kind === "flow") {
      sections.push(`### ${tag}\n\n${flowMarkdown(dataFlow(analysis, subject, readDrawing(root, `calls:${subject}`)?.mocks ?? [], 4))}`);
      continue;
    }

    const key = kind === "fn" ? `calls:${subject}` : kind === "type" ? `type:${subject}` : kind === "view" ? subject : `${kind}:${subject}`;
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

/** The analysis a query's page reads (the code at its head), or the problem: an unknown head is the request's. */
async function codeOf(ctx: RouteContext, query: URLSearchParams, response: RouteRequest["response"]): Promise<Analysis | null> {
  try {
    return await ctx.analysisFor(query);
  } catch (error) {
    problem(response, 400, error instanceof Error ? error.message : String(error));

    return null;
  }
}

export async function getGraph(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  // The whole repository for the project map, at the page's head: every module (or directory, folded) with its layer, every import between them.
  const analysis = await codeOf(ctx, url.searchParams, response);

  if (analysis) json(response, projectMap(analysis.graph));
}

export async function getScene(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const picture = await ctx.picture(url.searchParams);

  if (!picture.ok) return failed(response, picture);
  const { diagram, markdown, drawing, change } = picture.value;
  // The code's picture at the saved places, then the saved drawing's own elements (pencil, notes) on top.
  const generated = (JSON.parse(toExcalidraw(diagram)) as { elements: SceneElement[] }).elements;

  return json(response, { elements: drawing ? mergeScene(drawing.elements, generated) : generated, mocks: drawing?.mocks ?? [], diagram, markdown, drawn: drawing !== null, change: change ?? null });
}

export async function getViews(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  // The agent a run takes by default (the page offers every installed one: GET /api/agents).
  const agent = ctx.agentFor(null);
  // The views of the code at the page's head (a branch has its own modules and entry points).
  const analysis = await codeOf(ctx, url.searchParams, response);

  if (analysis) json(response, { root, stats: analysis.stats, layers: analysis.graph.layers, views: viewList(analysis), agent: "spec" in agent ? agent.spec.name : null, watching: ctx.watching });
}

export async function getPlan(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  // The task drawn on the saved scene of a view.
  const key = url.searchParams.get("view") ?? "";

  if (!parseView(key)) return problem(response, 400, "unknown view");
  const analysis = await ctx.fresh();
  const saved = readDrawing(root, key);
  const plan = planFromScene(analysis, key, saved?.elements ?? []);

  return json(response, { plan, markdown: taskMarkdown(plan, analysis), drawn: saved !== null });
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

  // A commit (of the branches, of the timeline): its own page, read from git.
  if (node.opens?.startsWith("commit:")) {
    const commit = commitInfo(root, node.opens.slice("commit:".length));

    return commit ? json(response, { markdown: commitMarkdown(commit, commitFiles(root, commit.sha)) }) : problem(response, 404, `no commit ${node.opens.slice("commit:".length)}`);
  }

  const analysis = await codeOf(ctx, url.searchParams, response);

  if (!analysis) return;
  // The code as the picture's head has it: a branch's file from git, the working tree's from the disk.
  const head = codeRevision(parseView(url.searchParams.get("view") ?? ""), url.searchParams.get("head") || null);
  const readSource = (file: string): string | null => (!analysis.facts.has(file) ? null : head ? fileAt(root, head, file) : readFileSync(join(root, file), "utf8"));
  // In a review or a comparison, a module's page says what the change, or each head, did to it.
  const { change } = picture.value;
  const changed = node.kind !== "module" || !change ? "" : change.kind === "review" ? moduleChangeMarkdown(node.id, [{ head: "", diff: change.diff }], false) : moduleChangeMarkdown(node.id, change.heads, true);

  return json(response, { markdown: changed ? `${nodeMarkdown(node, analysis, readSource)}\n${changed}` : nodeMarkdown(node, analysis, readSource) });
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
  const analysis = await codeOf(ctx, url.searchParams, response);

  if (analysis) json(response, { markdown: edgeMarkdown(edge, diagram, analysis) });
}

export async function getFile(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  const file = url.searchParams.get("path") ?? "";
  const head = url.searchParams.get("head") || null;
  const analysis = await codeOf(ctx, url.searchParams, response);

  if (!analysis) return;
  // An analysed file, or any other text file of the repository (a package.json a package shape points to); never a path out of it.
  const full = join(root, ...file.split("/"));

  if (file === "" || file.split("/").some((segment) => segment === "" || segment === "." || segment === "..") || file.startsWith(".git/") || file.includes("node_modules/")) return problem(response, 404, "not a file of the repository");

  // At a head, the file as that revision has it.
  if (head) {
    const content = fileAt(root, head, file);

    return content === null || content.length > 1_500_000 ? problem(response, 404, `not a file of ${head}`) : send(response, 200, "text/plain; charset=utf-8", content);
  }

  if (!analysis.facts.has(file) && !(existsSync(full) && statSync(full).isFile() && statSync(full).size <= 1_500_000)) return problem(response, 404, "not a file of the repository");

  // A symbolic link that leads out of the repository (a file, or a directory on the way) is not its file.
  if (!insideRoot(root, full)) return problem(response, 404, "not a file of the repository");

  return send(response, 200, "text/plain; charset=utf-8", readFileSync(full, "utf8"));
}

/** Whether a path, its symbolic links followed, is the root or under it. */
function insideRoot(root: string, path: string): boolean {
  try {
    const real = realpathSync(path);
    const top = realpathSync(root);

    return real === top || real.startsWith(`${top}${sep}`);
  } catch {
    return false;
  }
}

export async function getCoverage(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const analysis = await codeOf(ctx, url.searchParams, response);

  if (analysis) json(response, coverageReport(analysis));
}

export async function getChanges(ctx: RouteContext, { response, request }: RouteRequest): Promise<void> {
  // Server-sent events: one per change of a source file, debounced; the page reloads its view. The first says whether any will come.
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  response.write(`data: ${JSON.stringify({ watching: ctx.watching.on, ...(ctx.watching.problem ? { problem: ctx.watching.problem } : {}) })}\n\n`);
  ctx.changeListeners.add(response);
  request.on("close", () => ctx.changeListeners.delete(response));

  return;
}

/** The tag a view of the list gives, by its kind: `@layer:`, `@dir:`, `@module:`, `@flow:` (an entry point's data flow), `@type:`, `@logic:`. */
const TAG_OF_KIND: Partial<Record<ViewKind, string>> = { layer: "layer", dir: "dir", module: "module", calls: "flow", type: "type", logic: "logic" };

export async function getTags(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  // What `@` can name in the chat: layers, directories, modules, functions, flows (entry points), types; filtered by `q`.
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const analysis = await ctx.fresh();
  const tags: { tag: string; title: string }[] = [];

  // A view of the list with a subject gives the tag of its kind: a layer, a directory, a module, an entry's flow, a type, a function's logic.
  for (const entry of viewList(analysis)) {
    const view = parseView(entry.key);
    const prefix = view ? TAG_OF_KIND[view.kind] : undefined;

    if (!view || prefix === undefined || view.subject === null) continue;
    tags.push({ tag: `@${prefix}:${view.subject}`, title: prefix === "flow" ? `${entry.title} — its data flow` : prefix === "logic" ? `${entry.title} — the flowchart and its rules` : entry.title });
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
  "POST /api/drawing": postDrawing,
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
