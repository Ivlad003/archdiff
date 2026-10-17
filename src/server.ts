// `archdiff web`: a local HTTP server that serves the page (dist/web, built
// by scripts/build-web.mjs; built on the fly in a checkout) and a JSON API
// over the analysis. Every request re-analyses the repository, which the
// fact cache keeps fast, so the diagrams are live: edit a file, reload.
// GET only; binds to localhost unless --host says otherwise; the files it
// returns are only the analysed sources of the repository.
//
// API (GET): /api/views, /api/diagram?view=&depth=, /api/node?view=&id=,
// /api/file?path=, /api/coverage, /api/review?base=,
// /api/export?view=&format=, /api/scene?view= (the editor's scene: the
// code's picture merged into the saved drawing), /api/layout?view=,
// /api/flow?view= (the data flow of a calls view with its saved mocks).
// POST /api/layout saves a drawing to .archdiff/layouts/. /api/plan?view=
// reads the task drawn on a view; POST /api/agent/run starts the agent on
// a prompt (saved to .archdiff/tasks/), /api/agent/events?id= streams its
// events, POST /api/agent/stop?id= ends it. Entry point: `serve`.

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, type Analysis } from "./analyze.ts";
import { coverageReport } from "./coverage.ts";
import { layout, type DiagramNode } from "./diagram.ts";
import { commitsBetween, compareBranches, comparisonMarkdown, defaultBase, fileHistory, history, listBranches, mergeBase, overlayDiff, review, reviewMarkdown, revisionStamp } from "./diff.ts";
import { timelineDiagram } from "./views-more.ts";
import { watch as watchFs } from "node:fs";
import { EXPORT_EXTENSION, EXPORT_FORMATS, EXPORT_MEDIA_TYPE, exportDiagram, MERMAID_STYLES, type ExportFormat, type MermaidStyle } from "./export/index.ts";
import { toExcalidraw } from "./export/excalidraw.ts";
import { AgentRunner, agentFromConfig, type AgentSpec } from "./agent.ts";
import { dataFlow, flowMarkdown, jsonInAnswer, mockPrompt, mocksFromTypes } from "./flow.ts";
import { applyOverlays, parseOverlays, type Overlay } from "./overlays.ts";
import { planFromScene, planMarkdown } from "./plan.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { CACHE_DIRECTORY } from "./cache.ts";
import { layoutSlug } from "./layouts.ts";
import { mergeScene, parseLayout, positionsOf, readLayout, writeLayout, type SceneElement } from "./layouts.ts";
import { diagramMarkdown, edgeMarkdown, nodeMarkdown } from "./markdown.ts";
import { isJsonObject, isJsonString, parseJson } from "./json.ts";
import { parseView, viewList, viewOf, type ViewOptions } from "./views.ts";

export interface ServeOptions {
  /** The port to bind; null: the first free port from DEFAULT_PORT up. */
  port: number | null;
  host: string;
  /** The base ref of the review panel; null: the merge-base with the main branch. */
  base: string | null;
  /** The agent of `--agent`, over the config's; null: the config decides. */
  agent: AgentSpec | null;
  /** Reload the page when a source file changes. */
  watch: boolean;
}

export const TASKS_DIRECTORY = `${CACHE_DIRECTORY}/tasks`;

/** The built page: dist/web beside dist/, or built now into it from a checkout. */
async function webDirectory(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = join(here, "..");
  const built = join(packageRoot, "dist", "web");

  if (existsSync(join(built, "app.js"))) return built;
  const script = join(packageRoot, "scripts", "build-web.mjs");

  if (!existsSync(script)) throw new Error("the web page is not built (dist/web/app.js is missing)");
  const { buildWeb } = (await import(script)) as { buildWeb: (outdir: string) => Promise<void> };
  await buildWeb(built);

  return built;
}

function send(response: ServerResponse, status: number, type: string, body: string | Buffer): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

function json(response: ServerResponse, value: unknown): void {
  send(response, 200, "application/json", JSON.stringify(value));
}

function problem(response: ServerResponse, status: number, message: string): void {
  send(response, status, "application/json", JSON.stringify({ error: message }));
}

/** The largest drawing the page may save. */
const MAX_BODY = 8_000_000;

/** The whole body of a request as text, or null when it is over `limit` bytes. */
function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > limit) {
        request.destroy();
        resolveBody(null);

        return;
      }

      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** Host headers a browser sends to a server on this computer. */
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const STATIC_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".map": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png" };

/** Where `web` listens when no --port is given: this port, or the next free one above it when it is taken. */
export const DEFAULT_PORT = 7080;

/** How many ports above DEFAULT_PORT are tried before giving up. */
const PORT_TRIES = 50;

export async function serve(root: string, options: ServeOptions): Promise<void> {
  const web = await webDirectory();
  let current: Promise<Analysis> | null = null;
  // The agent: --agent wins, else archdiff.json; the runner is made once the first run is asked for.
  const agentSpec = options.agent ?? (await analyze(root)).config.agent;
  let runner: AgentRunner | null = null;
  // Who waits for a change of the sources (`/api/changes`), and the watcher that tells them.
  const changeListeners = new Set<ServerResponse>();
  let changeTimer: NodeJS.Timeout | null = null;

  const notifyChange = (path: string): void => {
    current = null;

    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      for (const listener of changeListeners) listener.write(`data: ${JSON.stringify({ path })}\n\n`);
    }, 300);
  };

  if (options.watch) {
    try {
      watchFs(root, { recursive: true }, (_event, name) => {
        const path = typeof name === "string" ? name.split("\\").join("/") : "";

        // Only a source file counts; the cache, the drawings, git and node_modules change for other reasons.
        if (path === "" || path.startsWith(".archdiff/") || path.startsWith(".git/") || path.includes("node_modules/") || !/\.[cm]?[jt]sx?$/.test(path)) return;
        notifyChange(path);
      });
    } catch (error) {
      process.stderr.write(`archdiff web: not watching the files (${error instanceof Error ? error.message : String(error)})\n`);
    }
  }

  // One analysis per burst of requests: the page asks for several things at once after a reload.
  const fresh = (): Promise<Analysis> => {
    if (!current) {
      current = analyze(root);
      setTimeout(() => (current = null), 300);
    }

    return current;
  };

  // The placed diagram of a view, at the saved places when the view was drawn by hand.
  /** The options of a picture as the query names them: depth, limit, packages, changes, overlays. */
  const optionsOf = (url: URL): { depth?: number; limit?: number; weight?: number; hubs: boolean; packages: boolean; changes: boolean; overlays: Overlay[]; expand: string[] } => {
    const depthText = url.searchParams.get("depth");
    const limitText = url.searchParams.get("limit");
    const weightText = url.searchParams.get("weight");
    const out: { depth?: number; limit?: number; weight?: number; hubs: boolean; packages: boolean; changes: boolean; overlays: Overlay[]; expand: string[] } = { hubs: url.searchParams.get("hubs") !== "0", packages: url.searchParams.get("packages") === "1", changes: url.searchParams.get("changes") === "1", overlays: parseOverlays(url.searchParams.get("overlay")), expand: (url.searchParams.get("expand") ?? "").split(",").filter((id) => id !== "") };

    if (depthText !== null && depthText !== "" && Number.isInteger(Number(depthText)) && Number(depthText) >= 0) out.depth = Number(depthText);

    if (limitText !== null && limitText !== "" && Number.isInteger(Number(limitText)) && Number(limitText) >= 1) out.limit = Number(limitText);

    if (weightText !== null && weightText !== "" && Number.isInteger(Number(weightText)) && Number(weightText) >= 1) out.weight = Number(weightText);

    return out;
  };

  /** The placed diagram of a view with the page's options, the saved drawing's positions and the revision stamp; null for an unknown view. */
  const placed = async (analysis: Analysis, key: string, picked: ReturnType<typeof optionsOf>, base: string | null = null, head: string | null = null): Promise<ReturnType<typeof layout> | null> => {
    const view = parseView(key);

    if (!view) return null;
    const viewOptions: ViewOptions = { packages: picked.packages, hubs: picked.hubs, expand: picked.expand };

    if (picked.depth !== undefined) viewOptions.depth = picked.depth;

    if (picked.limit !== undefined) viewOptions.limit = picked.limit;

    if (picked.weight !== undefined) viewOptions.weight = picked.weight;
    const positions = positionsOf(readLayout(root, key)?.elements ?? null);
    let diagram: ReturnType<typeof layout>;

    if (picked.changes && view.kind !== "timeline") {
      // `changes`: the review's marks laid over the view, so the structure and what the change did to it are one picture.
      const result = await review(root, base || options.base, head);
      diagram = layout(applyOverlays(overlayDiff(viewOf(analysis, view, viewOptions), result.diff), analysis, picked.overlays), positions);
    } else if (view.kind === "timeline") {
      // The timeline is built from the commits of a range, not from one analysis.
      const from = base || options.base || mergeBase(root);
      const to = head || "HEAD";
      diagram = layout(timelineDiagram(await history(root, from, to), from, to), positions);
    } else diagram = layout(applyOverlays(viewOf(analysis, view, viewOptions), analysis, picked.overlays), positions);

    const stamp = revisionStamp(root);

    return stamp ? { ...diagram, stamp } : diagram;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "GET" && request.method !== "POST") return problem(response, 405, "GET or POST only");
    // A page on another site cannot read the sources through DNS rebinding: the Host header must be this server's own name.
    const hostHeader = (request.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");

    if (!ALLOWED_HOSTS.has(hostHeader) && hostHeader !== options.host) return problem(response, 421, "unexpected Host header");
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (request.method === "POST") {
      const body = await readBody(request, MAX_BODY);

      if (body === null) return problem(response, 413, `the body is over ${MAX_BODY / 1_000_000} MB`);

      switch (path) {
        case "/api/layout": {
          const key = url.searchParams.get("view") ?? "";

          if (!parseView(key) && !key.startsWith("review")) return problem(response, 400, "unknown view");

          try {
            const file = writeLayout(root, parseLayout(parseJson(body), key));

            return json(response, { saved: file });
          } catch (error) {
            return problem(response, 400, error instanceof Error ? error.message : String(error));
          }
        }

        case "/api/agent/run": {
          // An explicit request from the page: the prompt as the user saw it; `resume` continues the agent's session.
          if (!agentSpec) return problem(response, 400, "no agent: start with --agent claude|cursor or set \"agent\" in archdiff.json");
          let parsed;

          try {
            parsed = parseJson(body);
          } catch {
            return problem(response, 400, "the body must be JSON");
          }

          if (!isJsonObject(parsed) || !isJsonString(parsed["prompt"]) || parsed["prompt"].trim() === "") return problem(response, 400, '"prompt" is required');
          const resume = isJsonString(parsed["resume"]) ? parsed["resume"] : null;
          runner ??= new AgentRunner(root, agentSpec);
          const run = runner.start(parsed["prompt"], resume);
          // The agent edits the repository: the next request analyses afresh, however soon it comes.
          run.subscribe(0, (event) => {
            if (event.kind === "exit") current = null;
          });
          // The task as sent, kept beside the drawings so it can be read or resent without the page.
          const view = isJsonString(parsed["view"]) ? parsed["view"] : "chat";
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const file = `${TASKS_DIRECTORY}/${layoutSlug(view)}-${stamp}.md`;
          mkdirSync(join(root, TASKS_DIRECTORY), { recursive: true });
          writeFileSync(join(root, file), `<!-- archdiff:generated — task for ${agentSpec.name}, run ${run.id} -->\n${parsed["prompt"]}\n`);

          return json(response, { id: run.id, agent: agentSpec.name, task: file });
        }

        case "/api/flow/mocks": {
          // Mocks for a calls view: from the agent (with the user's description) when there is one and it answers JSON, else from the types.
          let parsed;

          try {
            parsed = parseJson(body);
          } catch {
            return problem(response, 400, "the body must be JSON");
          }

          const key = isJsonObject(parsed) && isJsonString(parsed["view"]) ? parsed["view"] : "";
          const view = parseView(key);

          if (!view || view.kind !== "calls") return problem(response, 400, "the mocks need a calls: view");
          const description = isJsonObject(parsed) && isJsonString(parsed["description"]) ? parsed["description"] : "";
          const analysis = await fresh();
          const flow = dataFlow(analysis, view.id, [], 4);
          const typed = mocksFromTypes(flow);

          if (!agentSpec) return json(response, { source: "types", ...typed });
          runner ??= new AgentRunner(root, agentSpec);
          const answer = jsonInAnswer(await runner.runToResult(mockPrompt(flow, description)));

          if (!answer) return json(response, { source: "types", note: "the agent gave no JSON; the types did", ...typed });

          return json(response, { source: agentSpec.name, input: answer.input ?? typed.input, storages: answer.storages ?? typed.storages });
        }

        case "/api/expand": {
          // The tags of a text (@module:path, @fn:path#name, @layer:name, @dir:path, @flow:path#fn, @type:path#Name) as context for an agent.
          let parsed;

          try {
            parsed = parseJson(body);
          } catch {
            return problem(response, 400, "the body must be JSON");
          }

          const text = isJsonObject(parsed) && isJsonString(parsed["text"]) ? parsed["text"] : "";
          const analysis = await fresh();
          const readSource = (file: string): string | null => (analysis.facts.has(file) ? readFileSync(join(root, file), "utf8") : null);
          const sections: string[] = [];
          const seenTags = new Set<string>();

          for (const match of text.matchAll(/@(module|fn|layer|dir|flow|type):(\S+)/g)) {
            const tag = match[0];

            if (seenTags.has(tag)) continue;
            seenTags.add(tag);
            const kind = match[1]!;
            const subject = match[2]!.replace(/[.,;:)]+$/, "");
            const key = kind === "fn" ? `calls:${subject}` : kind === "flow" ? `calls:${subject}` : kind === "type" ? `type:${subject}` : `${kind}:${subject}`;
            const view = parseView(key);

            if (!view) continue;
            const diagram = viewOf(analysis, view);

            if (kind === "module" || kind === "fn" || kind === "type") {
              const node = diagram.nodes.find((candidate) => (candidate.ref?.id ?? candidate.id) === subject);
              sections.push(`### ${tag}\n\n${node ? nodeMarkdown(node, analysis, readSource) : diagramMarkdown(diagram, analysis)}`);
            } else sections.push(`### ${tag}\n\n${diagramMarkdown(diagram, analysis)}`);
          }

          return json(response, { context: sections.length > 0 ? `## Context from the diagrams\n\n${sections.join("\n\n")}` : "" });
        }

        case "/api/agent/stop": {
          const id = url.searchParams.get("id") ?? "";
          const run = runner?.runs.get(id);

          if (!run) return problem(response, 404, "no such run");
          run.stop();

          return json(response, { stopped: id });
        }

        default:
          return problem(response, 404, "no such API");
      }
    }

    if (path.startsWith("/api/")) {
      switch (path) {
        case "/api/layout": {
          const key = url.searchParams.get("view") ?? "";
          const saved = readLayout(root, key);

          return json(response, saved ? { saved: saved.saved, mocks: saved.mocks, elements: saved.elements.length } : null);
        }

        case "/api/flow": {
          // The data-flow of a calls view: the saved mocks of the view carried through the call tree.
          const key = url.searchParams.get("view") ?? "";
          const view = parseView(key);

          if (!view || view.kind !== "calls") return problem(response, 400, "the flow needs a calls: view");
          const analysis = await fresh();
          const depthText = url.searchParams.get("depth");
          const flow = dataFlow(analysis, view.id, readLayout(root, key)?.mocks ?? [], depthText === null || depthText === "" ? 4 : Number(depthText));

          return json(response, { flow, markdown: flowMarkdown(flow) });
        }

        case "/api/scene": {
          const key = url.searchParams.get("view") ?? "";
          const analysis = await fresh();
          let picked;

          try {
            picked = optionsOf(url);
          } catch (error) {
            return problem(response, 400, error instanceof Error ? error.message : String(error));
          }

          const diagram = await placed(analysis, key, picked, url.searchParams.get("base"), url.searchParams.get("head"));

          if (!diagram) return problem(response, 400, "unknown view");
          // The code's picture at the saved places, then the saved drawing's own elements (pencil, notes) on top.
          const generated = (JSON.parse(toExcalidraw(diagram)) as { elements: SceneElement[] }).elements;
          const saved = readLayout(root, key);
          const mermaid = (url.searchParams.get("mermaid") ?? "auto") as MermaidStyle;

          return json(response, { elements: saved ? mergeScene(saved.elements, generated) : generated, mocks: saved?.mocks ?? [], diagram, markdown: diagramMarkdown(diagram, analysis, MERMAID_STYLES.includes(mermaid) ? mermaid : "auto"), drawn: saved !== null });
        }

        case "/api/views": {
          const analysis = await fresh();

          return json(response, { root, stats: analysis.stats, layers: analysis.graph.layers, views: viewList(analysis), agent: agentSpec?.name ?? null });
        }

        case "/api/plan": {
          // The task drawn on the saved scene of a view.
          const key = url.searchParams.get("view") ?? "";

          if (!parseView(key)) return problem(response, 400, "unknown view");
          const analysis = await fresh();
          const saved = readLayout(root, key);
          const plan = planFromScene(analysis, key, saved?.elements ?? []);

          return json(response, { plan, markdown: planMarkdown(plan, analysis), drawn: saved !== null });
        }

        case "/api/agent/events": {
          // Server-sent events of a run from `after`, until it ends.
          const id = url.searchParams.get("id") ?? "";
          const run = runner?.runs.get(id);

          if (!run) return problem(response, 404, "no such run");
          const after = Number(url.searchParams.get("after") ?? "0");
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          const unsubscribe = run.subscribe(Number.isInteger(after) && after >= 0 ? after : 0, (event) => {
            response.write(`data: ${JSON.stringify(event)}\n\n`);

            if (event.kind === "exit") response.end();
          });
          request.on("close", unsubscribe);

          if (run.done) response.end();

          return;
        }

        case "/api/diagram": {
          const view = parseView(url.searchParams.get("view") ?? "");

          if (!view) return problem(response, 400, "unknown view");
          const depthText = url.searchParams.get("depth");

          if (depthText !== null && depthText !== "" && !(Number.isInteger(Number(depthText)) && Number(depthText) >= 0)) return problem(response, 400, "depth must be a whole number");
          const analysis = await fresh();
          const picked = optionsOf(url);
          const diagram = (await placed(analysis, url.searchParams.get("view") ?? "", picked, url.searchParams.get("base"), url.searchParams.get("head")))!;
          const mermaid = (url.searchParams.get("mermaid") ?? "auto") as MermaidStyle;

          return json(response, { diagram, markdown: diagramMarkdown(diagram, analysis, MERMAID_STYLES.includes(mermaid) ? mermaid : "auto"), drawn: readLayout(root, url.searchParams.get("view") ?? "") !== null });
        }

        case "/api/node": {
          const view = parseView(url.searchParams.get("view") ?? "");
          const id = url.searchParams.get("id") ?? "";

          if (!view) return problem(response, 400, "unknown view");
          const analysis = await fresh();
          const diagram = view.kind === "timeline" ? { nodes: [] as DiagramNode[] } : viewOf(analysis, view);
          const node = diagram.nodes.find((candidate) => candidate.id === id);

          if (!node) return problem(response, 404, "no such shape in the view");

          const readSource = (file: string): string | null => (analysis.facts.has(file) ? readFileSync(join(root, file), "utf8") : null);

          return json(response, { markdown: nodeMarkdown(node, analysis, readSource) });
        }

        case "/api/edge": {
          const view = parseView(url.searchParams.get("view") ?? "");
          const from = url.searchParams.get("from") ?? "";
          const to = url.searchParams.get("to") ?? "";
          const kind = url.searchParams.get("kind");

          if (!view) return problem(response, 400, "unknown view");
          const analysis = await fresh();
          const diagram = view.kind === "timeline" ? { view: "timeline", title: "", nodes: [], edges: [], groups: [] } : viewOf(analysis, view);
          const edge = diagram.edges.find((candidate) => candidate.from === from && candidate.to === to && (kind === null || candidate.kind === kind));

          if (!edge) return problem(response, 404, "no such line in the view");

          return json(response, { markdown: edgeMarkdown(edge, diagram, analysis) });
        }

        case "/api/file": {
          const file = url.searchParams.get("path") ?? "";
          const analysis = await fresh();

          if (!analysis.facts.has(file)) return problem(response, 404, "not an analysed file");

          return send(response, 200, "text/plain; charset=utf-8", readFileSync(join(root, file), "utf8"));
        }

        case "/api/coverage": {
          const analysis = await fresh();

          return json(response, coverageReport(analysis));
        }

        case "/api/changes": {
          // Server-sent events: one per change of a source file, debounced; the page reloads its view.
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          response.write(`data: ${JSON.stringify({ watching: options.watch })}\n\n`);
          changeListeners.add(response);
          request.on("close", () => changeListeners.delete(response));

          return;
        }

        case "/api/commits": {
          // The commits of the review range, oldest first, for stepping through a branch.
          try {
            const base = url.searchParams.get("base") || options.base || mergeBase(root);
            const head = url.searchParams.get("head") || "HEAD";

            return json(response, { base, head, commits: commitsBetween(root, base, head) });
          } catch (error) {
            return problem(response, 400, error instanceof Error ? error.message : String(error));
          }
        }

        case "/api/tags": {
          // What `@` can name in the chat: layers, directories, modules, functions, flows (entry points), types; filtered by `q`.
          const q = (url.searchParams.get("q") ?? "").toLowerCase();
          const analysis = await fresh();
          const tags: { tag: string; title: string }[] = [];

          for (const entry of viewList(analysis)) {
            if (entry.kind === "layer") tags.push({ tag: `@layer:${entry.key.slice(6)}`, title: entry.title });
            else if (entry.kind === "dir") tags.push({ tag: `@dir:${entry.key.slice(4)}`, title: entry.title });
            else if (entry.kind === "module") tags.push({ tag: `@module:${entry.key.slice(7)}`, title: entry.title });
            else if (entry.kind === "calls") tags.push({ tag: `@flow:${entry.key.slice(6)}`, title: entry.title });
            else if (entry.kind === "type") tags.push({ tag: `@type:${entry.key.slice(5)}`, title: entry.title });
          }

          for (const node of analysis.graph.nodes.values()) if (node.kind === "fn") tags.push({ tag: `@fn:${node.id}`, title: `${node.parent ? `${node.parent}.` : ""}${node.name} (${node.module})` });
          const hits = tags.filter((candidate) => q === "" || candidate.tag.toLowerCase().includes(q) || candidate.title.toLowerCase().includes(q)).slice(0, 40);

          return json(response, { tags: hits });
        }

        case "/api/tasks": {
          // The tasks sent to the agent so far, newest first, with their first lines.
          const directory = join(root, TASKS_DIRECTORY);
          const { readdirSync } = await import("node:fs");
          const files = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".md")).sort().reverse() : [];

          return json(response, { tasks: files.map((name) => ({ file: `${TASKS_DIRECTORY}/${name}`, head: readFileSync(join(directory, name), "utf8").split("\n").slice(1, 4).join(" ").slice(0, 200) })) });
        }

        case "/api/branches": {
          // Local and remote branches for the pickers, with the base to start from and the current branch.
          try {
            return json(response, { ...listBranches(root), base: options.base || defaultBase(root) });
          } catch (error) {
            return problem(response, 400, error instanceof Error ? error.message : String(error));
          }
        }

        case "/api/compare": {
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

        case "/api/history": {
          const file = url.searchParams.get("path") ?? "";
          const analysis = await fresh();

          if (!analysis.facts.has(file)) return problem(response, 404, "not an analysed file");

          return json(response, { path: file, commits: fileHistory(root, file) });
        }

        case "/api/review": {
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

        case "/api/export": {
          const format = url.searchParams.get("format") ?? "";

          if (!EXPORT_FORMATS.includes(format as ExportFormat) || format === "md") return problem(response, 400, "unknown format");
          const key = url.searchParams.get("view") ?? "";
          const analysis = await fresh();
          let diagram;

          if (key.startsWith("review")) {
            const result = await review(root, url.searchParams.get("base") || options.base, url.searchParams.get("head") || null);
            diagram = result.diagram;
          } else if (key.startsWith("compare")) {
            const result = await compareBranches(root, url.searchParams.get("base") || null, (url.searchParams.get("heads") ?? "WORKTREE").split(",").filter((head) => head !== ""));
            diagram = result.diagram;
          } else {
            const picked = optionsOf(url);
            diagram = await placed(analysis, key, picked, url.searchParams.get("base"), url.searchParams.get("head"));

            if (!diagram) return problem(response, 400, "unknown view");
          }

          const name = `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}${EXPORT_EXTENSION[format as ExportFormat]}`;
          const mermaid = (url.searchParams.get("mermaid") ?? "auto") as MermaidStyle;
          response.writeHead(200, { "content-type": EXPORT_MEDIA_TYPE[format as ExportFormat], "content-disposition": `attachment; filename="${name}"` });

          return void response.end(exportDiagram(diagram, format as Exclude<ExportFormat, "md">, MERMAID_STYLES.includes(mermaid) ? mermaid : "auto"));
        }

        default:
          return problem(response, 404, "no such API");
      }
    }

    // Static files of the page, from dist/web only: the page, its chunks and the editor's fonts; never a path that climbs out.
    const file = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));

    if (file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return problem(response, 404, "not found");
    const full = join(web, ...file.split("/"));
    const extension = file.slice(file.lastIndexOf("."));

    if (!full.startsWith(web) || !existsSync(full) || !(extension in STATIC_TYPES)) return problem(response, 404, "not found");

    return send(response, 200, STATIC_TYPES[extension]!, readFileSync(full));
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      process.stderr.write(`archdiff web: ${error instanceof Error ? error.message : String(error)}\n`);

      if (!response.headersSent) problem(response, 500, error instanceof Error ? error.message : String(error));
    });
  });

  // A named port is binding: taken means an error. Without one, the default port or the next free one above it, so
  // a second archdiff (or a page left running) does not stop this one.
  const listen = (port: number): Promise<void> =>
    new Promise<void>((resolveStarted, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(port, options.host, () => {
        server.off("error", onError);
        resolveStarted();
      });
    });

  if (options.port !== null) await listen(options.port);
  else {
    let bound = false;

    for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_TRIES && !bound; port++) {
      try {
        await listen(port);
        bound = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
      }
    }

    if (!bound) throw new Error(`no free port between ${DEFAULT_PORT} and ${DEFAULT_PORT + PORT_TRIES - 1}; --port names one`);
  }

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  process.stderr.write(`archdiff web: http://${options.host}:${port}/  (${root})${options.port === null && port !== DEFAULT_PORT ? `  (port ${DEFAULT_PORT} was taken)` : ""}\n`);

  // Runs until the process is stopped.
  await new Promise<void>((resolveStopped) => {
    const stop = (): void => {
      runner?.stopAll();
      server.close(() => resolveStopped());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
