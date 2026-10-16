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
import { layout } from "./diagram.ts";
import { review, reviewMarkdown } from "./diff.ts";
import { EXPORT_EXTENSION, EXPORT_FORMATS, EXPORT_MEDIA_TYPE, exportDiagram, type ExportFormat } from "./export/index.ts";
import { toExcalidraw } from "./export/excalidraw.ts";
import { AgentRunner, agentFromConfig, type AgentSpec } from "./agent.ts";
import { dataFlow, flowMarkdown } from "./flow.ts";
import { planFromScene, planMarkdown } from "./plan.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { CACHE_DIRECTORY } from "./cache.ts";
import { layoutSlug } from "./layouts.ts";
import { mergeScene, parseLayout, positionsOf, readLayout, writeLayout, type SceneElement } from "./layouts.ts";
import { diagramMarkdown, nodeMarkdown } from "./markdown.ts";
import { isJsonObject, isJsonString, parseJson } from "./json.ts";
import { parseView, viewList, viewOf } from "./views.ts";

export interface ServeOptions {
  port: number;
  host: string;
  /** The base ref of the review panel; null: the merge-base with the main branch. */
  base: string | null;
  /** The agent of `--agent`, over the config's; null: the config decides. */
  agent: AgentSpec | null;
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

export async function serve(root: string, options: ServeOptions): Promise<void> {
  const web = await webDirectory();
  let current: Promise<Analysis> | null = null;
  // The agent: --agent wins, else archdiff.json; the runner is made once the first run is asked for.
  const agentSpec = options.agent ?? (await analyze(root)).config.agent;
  let runner: AgentRunner | null = null;

  // One analysis per burst of requests: the page asks for several things at once after a reload.
  const fresh = (): Promise<Analysis> => {
    if (!current) {
      current = analyze(root);
      setTimeout(() => (current = null), 300);
    }

    return current;
  };

  // The placed diagram of a view, at the saved places when the view was drawn by hand.
  const placed = (analysis: Analysis, key: string, depth?: number, packages = false): ReturnType<typeof layout> | null => {
    const view = parseView(key);

    if (!view) return null;
    const options = depth === undefined ? { packages } : { depth, packages };

    return layout(viewOf(analysis, view, options), positionsOf(readLayout(root, key)?.elements ?? null));
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
          const depthText = url.searchParams.get("depth");
          const diagram = placed(analysis, key, depthText === null || depthText === "" ? undefined : Number(depthText), url.searchParams.get("packages") === "1");

          if (!diagram) return problem(response, 400, "unknown view");
          // The code's picture at the saved places, then the saved drawing's own elements (pencil, notes) on top.
          const generated = (JSON.parse(toExcalidraw(diagram)) as { elements: SceneElement[] }).elements;
          const saved = readLayout(root, key);

          return json(response, { elements: saved ? mergeScene(saved.elements, generated) : generated, mocks: saved?.mocks ?? [], diagram, markdown: diagramMarkdown(diagram, analysis), drawn: saved !== null });
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
          const depth = depthText === null ? undefined : Number(depthText);

          if (depth !== undefined && !(Number.isInteger(depth) && depth >= 0)) return problem(response, 400, "depth must be a whole number");
          const analysis = await fresh();
          const diagram = placed(analysis, url.searchParams.get("view") ?? "", depth)!;

          return json(response, { diagram, markdown: diagramMarkdown(diagram, analysis), drawn: readLayout(root, url.searchParams.get("view") ?? "") !== null });
        }

        case "/api/node": {
          const view = parseView(url.searchParams.get("view") ?? "");
          const id = url.searchParams.get("id") ?? "";

          if (!view) return problem(response, 400, "unknown view");
          const analysis = await fresh();
          const diagram = viewOf(analysis, view);
          const node = diagram.nodes.find((candidate) => candidate.id === id);

          if (!node) return problem(response, 404, "no such shape in the view");

          return json(response, { markdown: nodeMarkdown(node, analysis) });
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

        case "/api/review": {
          const base = url.searchParams.get("base") || options.base;

          try {
            const result = await review(root, base);

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
            const result = await review(root, url.searchParams.get("base") || options.base);
            diagram = result.diagram;
          } else {
            diagram = placed(analysis, key);

            if (!diagram) return problem(response, 400, "unknown view");
          }

          const name = `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}${EXPORT_EXTENSION[format as ExportFormat]}`;
          response.writeHead(200, { "content-type": EXPORT_MEDIA_TYPE[format as ExportFormat], "content-disposition": `attachment; filename="${name}"` });

          return void response.end(exportDiagram(diagram, format as Exclude<ExportFormat, "md">));
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

  await new Promise<void>((resolveStarted, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolveStarted());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  process.stderr.write(`archdiff web: http://${options.host}:${port}/  (${root})\n`);

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
