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
import { compareBranches, comparisonMarkdown, history, onlyChanged, overlayDiff, review, reviewMarkdown } from "./diff.ts";
import { commitsBetween, defaultBase, fileHistory, listBranches, mergeBase, revisionStamp } from "./git.ts";
import { timelineDiagram } from "./views-more.ts";
import { watch as watchFs } from "node:fs";
import { EXPORT_EXTENSION, EXPORT_FORMATS, EXPORT_MEDIA_TYPE, exportDiagram, MERMAID_STYLES, type ExportFormat, type MermaidStyle } from "./export/index.ts";
import { toExcalidraw } from "./export/excalidraw.ts";
import { AgentRunner, agentFromConfig, type AgentSpec } from "./agent.ts";
import { dataFlow, flowMarkdown, jsonInAnswer, mockPrompt, mocksFromTypes } from "./flow.ts";
import { applyOverlays, parseOverlays, type Overlay } from "./overlays.ts";
import { planFromScene, planMarkdown } from "./plan.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { layoutSlug } from "./layouts.ts";
import { problem, send, type PictureOptions, type RouteContext } from "./routes/context.ts";
import { routes as pictureRoutes } from "./routes/pictures.ts";
import { routes as agentRoutes } from "./routes/agent.ts";
import { routes as gitRoutes } from "./routes/git.ts";
import { routes as specRoutes } from "./routes/spec.ts";
import { AGENT_PROTOCOL, checkIntent, checkMarkdown, documentPrompt, INTENT_FILE, intentMarkdown, mergePlan, parseIntent, writeIntent } from "./intent.ts";
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
  const optionsOf = (url: URL): PictureOptions => {
    const depthText = url.searchParams.get("depth");
    const limitText = url.searchParams.get("limit");
    const weightText = url.searchParams.get("weight");
    const list = (name: string): string[] => (url.searchParams.get(name) ?? "").split(",").filter((item) => item !== "");
    const out: PictureOptions = { hubs: url.searchParams.get("hubs") !== "0", packages: url.searchParams.get("packages") === "1", changes: url.searchParams.get("changes") === "1", onlyChanges: url.searchParams.get("only") === "changes", overlays: parseOverlays(url.searchParams.get("overlay")), expand: list("expand"), hide: list("hide") };

    if (depthText !== null && depthText !== "" && Number.isInteger(Number(depthText)) && Number(depthText) >= 0) out.depth = Number(depthText);

    if (limitText !== null && limitText !== "" && Number.isInteger(Number(limitText)) && Number(limitText) >= 1) out.limit = Number(limitText);

    if (weightText !== null && weightText !== "" && Number.isInteger(Number(weightText)) && Number(weightText) >= 1) out.weight = Number(weightText);

    return out;
  };

  /** The placed diagram of a view with the page's options, the saved drawing's positions and the revision stamp; null for an unknown view. */
  const placed = async (analysis: Analysis, key: string, picked: PictureOptions, base: string | null = null, head: string | null = null): Promise<ReturnType<typeof layout> | null> => {
    const view = parseView(key);

    if (!view) return null;
    const viewOptions: ViewOptions = { packages: picked.packages, hubs: picked.hubs, expand: picked.expand, hideLanes: picked.hide };

    if (picked.depth !== undefined) viewOptions.depth = picked.depth;

    if (picked.limit !== undefined) viewOptions.limit = picked.limit;

    if (picked.weight !== undefined) viewOptions.weight = picked.weight;
    const positions = positionsOf(readLayout(root, key)?.elements ?? null);
    let diagram: ReturnType<typeof layout>;

    if (picked.changes && view.kind !== "timeline") {
      // `changes`: the review's marks laid over the view, so the structure and what the change did to it are one picture.
      const result = await review(root, base || options.base, head);
      const marked = overlayDiff(viewOf(analysis, view, viewOptions), result.diff);
      diagram = layout(applyOverlays(picked.onlyChanges ? onlyChanged(marked) : marked, analysis, picked.overlays), positions);
    } else if (view.kind === "timeline") {
      // The timeline is built from the commits of a range, not from one analysis.
      const from = base || options.base || mergeBase(root);
      const to = head || "HEAD";
      diagram = layout(timelineDiagram(await history(root, from, to), from, to), positions);
    } else diagram = layout(applyOverlays(viewOf(analysis, view, viewOptions), analysis, picked.overlays), positions);

    const stamp = revisionStamp(root);

    return stamp ? { ...diagram, stamp } : diagram;
  };

  const routes = { ...pictureRoutes, ...agentRoutes, ...gitRoutes, ...specRoutes };
  const ctx: RouteContext = {
    root,
    options,
    agentSpec,
    fresh,
    invalidate: () => {
      current = null;
    },
    runner: () => {
      if (!agentSpec) throw new Error("no agent");

      return (runner ??= new AgentRunner(root, agentSpec));
    },
    activeRunner: () => runner,
    changeListeners,
    placed,
    optionsOf,
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

      const handler = routes[`POST ${path}`];

      if (handler) return handler(ctx, { url, body, response, request });

      return problem(response, 404, "no such API");
    }

    if (path.startsWith("/api/")) {
      const handler = routes[`GET ${path}`];

      if (handler) return handler(ctx, { url, body: "", response, request });

      return problem(response, 404, "no such API");
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
