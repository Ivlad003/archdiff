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
// /api/flow?view= (the data flow of a calls view with its saved mocks),
// /api/graph (the whole repository for the project map).
// POST /api/layout saves a drawing to .archdiff/layouts/. /api/plan?view=
// reads the task drawn on a view; POST /api/agent/run starts the agent on
// a prompt (saved to .archdiff/tasks/), /api/agent/events?id= streams its
// events, POST /api/agent/stop?id= ends it. Entry point: `serve`.

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, type Analysis } from "./analyze.ts";
import { layout } from "./diagram.ts";
import { review, withTimeline } from "./diff.ts";
import { withLogic } from "./logic.ts";
import { mergeBase, revisionStamp } from "./git.ts";
import { watch as watchFs } from "node:fs";
import { AgentRunner, type AgentSpec } from "./agent.ts";
import { allowedToolsFor, checkEvents, runChecks } from "./checks.ts";
import { readPictureOptions, type PictureOptions } from "./options.ts";
import type { Result } from "./result.ts";
import { problem, send, type RouteContext } from "./routes/context.ts";
import { routes as pictureRoutes } from "./routes/pictures.ts";
import { routes as agentRoutes } from "./routes/agent.ts";
import { routes as gitRoutes } from "./routes/git.ts";
import { routes as specRoutes } from "./routes/spec.ts";
import { positionsOf, readLayout } from "./layouts.ts";
import { parseView, viewOf, viewOptionsOf } from "./views.ts";

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
  // The agent: --agent wins, else archdiff.json; the runner is made once the first run is asked for. Claude Code may run
  // the checks of archdiff.json (and archdiff) on its own; every agent's run ends with archdiff running them.
  const config = (await analyze(root)).config;
  const chosen = options.agent ?? config.agent;
  const agentSpec: AgentSpec | null = chosen && chosen.name === "claude" ? { ...chosen, allowedTools: allowedToolsFor(config.checks) } : chosen;
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

  /** The options of a picture as the query names them (the table of options.ts), or the problem with one of them. */
  const optionsOf = (url: URL): Result<PictureOptions> => {
    const read = readPictureOptions((name) => url.searchParams.get(name), "param");

    return read.ok ? { ok: true, value: read.value.options } : read;
  };

  // Placed pictures by analysis: the same view with the same options and the same saved drawing is laid out once per
  // analysis, so switching pictures back and forth costs a lookup. A new analysis (a changed file) starts a new map.
  const pictures = new WeakMap<Analysis, Map<string, ReturnType<typeof layout>>>();

  /** The placed diagram of a view with the page's options, the saved drawing's positions and the revision stamp; null for an unknown view. */
  const placed = async (analysis: Analysis, key: string, picked: PictureOptions, base: string | null = null, head: string | null = null): Promise<ReturnType<typeof layout> | null> => {
    const view = parseView(key);

    if (!view) return null;
    const saved = readLayout(root, key);
    const memo = pictures.get(analysis) ?? new Map<string, ReturnType<typeof layout>>();
    pictures.set(analysis, memo);
    const memoKey = JSON.stringify([key, picked, base, head, saved?.saved ?? null]);
    const known = memo.get(memoKey);

    if (known) return known;
    const viewOptions = viewOptionsOf(picked);
    let source = analysis;

    // The timeline is built from the commits of a range and the logic of a function from its file; `changes` lays the review's
    // marks over the view: all read git or the disk here, at the edge.
    if (view.kind === "timeline") source = await withTimeline(analysis, base || options.base || mergeBase(root), head || "HEAD");
    else if (view.kind === "logic" && view.scope !== null) source = await withLogic(analysis, view.scope);
    else if (picked.changes) viewOptions.diff = (await review(root, base || options.base, head)).diff;
    const diagram = layout(viewOf(source, view, viewOptions), positionsOf(saved?.elements ?? null));
    const stamp = revisionStamp(root);
    const picture = stamp ? { ...diagram, stamp } : diagram;
    memo.set(memoKey, picture);

    return picture;
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

      // After a run: the repository changed, so a fresh analysis, then the contract and the configured checks.
      return (runner ??= new AgentRunner(root, agentSpec, async () => {
        current = null;

        return checkEvents(await runChecks(await fresh()));
      }));
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
