// `archdiff web`: a local HTTP server that serves the page (dist/web, built
// by scripts/build-web.mjs; built on the fly in a checkout) and a JSON API
// over the analysis. Every request reads a fresh analysis (one per burst of
// requests; the fact cache keeps it fast), so the pictures are live: edit a
// file and the page reloads. GET and POST only; it binds to localhost unless
// --host says otherwise, refuses a Host header that is not its own, and
// returns no file outside the repository.
//
// The routes live in routes/*.ts by `METHOD /path` — the pictures, the
// agent and the contract, git's bars, the specs — over one context; every
// picture is the one picture.ts draws for the query. Entry points:
// `serve`, `ServeOptions`, `DEFAULT_PORT`.

import { existsSync, readFileSync, watch as watchFs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, type Analysis } from "./analyze.ts";
import { AgentRunner, type AgentSpec } from "./agent.ts";
import { allowedToolsFor, checkEvents, runChecks } from "./checks.ts";
import type { Config } from "./config.ts";
import { isSourceFile } from "./files.ts";
import { drawPicture, type Picture } from "./picture.ts";
import { ok, wrong, type Result } from "./result.ts";
import { problem, requestOf, send, type RouteContext } from "./routes/context.ts";
import { routes as pictureRoutes } from "./routes/pictures.ts";
import { routes as agentRoutes } from "./routes/agent.ts";
import { routes as gitRoutes } from "./routes/git.ts";
import { routes as specRoutes } from "./routes/spec.ts";

export interface ServeOptions {
  /** The port to bind; null: the first free port from DEFAULT_PORT up. */
  port: number | null;
  host: string;
  /** The base ref of the review panel; null: the merge-base with develop, main or master. */
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

/** The analysis a burst of requests shares (the page asks for several things at once after a reload), and the way to drop it after a change. */
function analysisPerBurst(root: string): { fresh(): Promise<Analysis>; invalidate(): void } {
  let current: Promise<Analysis> | null = null;

  return {
    fresh: () => {
      if (!current) {
        current = analyze(root);
        setTimeout(() => (current = null), 300);
      }

      return current;
    },
    invalidate: () => {
      current = null;
    },
  };
}

/** The responses waiting on `/api/changes`, and how they hear of a changed file: once per burst of changes, the analysis dropped first. */
function changeChannel(invalidate: () => void): { listeners: Set<ServerResponse>; notify(path: string): void } {
  const listeners = new Set<ServerResponse>();
  let timer: NodeJS.Timeout | null = null;

  return {
    listeners,
    notify: (path) => {
      invalidate();

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        for (const listener of listeners) listener.write(`data: ${JSON.stringify({ path })}\n\n`);
      }, 300);
    },
  };
}

/**
 * Watches the repository for a changed source file of any language archdiff reads (the cache, the drawings, git and
 * node_modules change for other reasons); the problem when it cannot, else null. A plain watch of the root goes
 * first, as a probe: Node's recursive watch on Linux gives neither events nor an error once the system's file
 * watchers are used up (ENOSPC), where a plain one throws.
 */
function watchSources(root: string, onChange: (path: string) => void): string | null {
  try {
    watchFs(root).close();
    watchFs(root, { recursive: true }, (_event, name) => {
      const path = typeof name === "string" ? name.split("\\").join("/") : "";

      if (path === "" || path.startsWith(".archdiff/") || path.startsWith(".git/") || path.includes("node_modules/") || !isSourceFile(path)) return;
      onChange(path);
    });

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const problem = message.includes("ENOSPC") ? "the system's file watchers are used up (raise fs.inotify.max_user_watches)" : message;
    process.stderr.write(`archdiff web: not watching the files: ${problem}\n`);

    return problem;
  }
}

/** The agent of the page: --agent wins, else archdiff.json; Claude Code may run the checks of archdiff.json (and archdiff) on its own. */
function agentSpecOf(config: Config, given: AgentSpec | null): AgentSpec | null {
  const chosen = given ?? config.agent;

  return chosen && chosen.name === "claude" ? { ...chosen, allowedTools: allowedToolsFor(config.checks) } : chosen;
}

/** The picture a query names, drawn on the current analysis; git's refusal (outside a repository, a bad ref) is the request's problem. */
async function pictureOf(query: URLSearchParams, defaultBase: string | null, fresh: () => Promise<Analysis>): Promise<Result<Picture>> {
  const request = requestOf(query, defaultBase);

  if (!request.ok) return request;

  try {
    return ok(await drawPicture(await fresh(), request.value));
  } catch (error) {
    return wrong(error instanceof Error ? error.message : String(error));
  }
}

/** Every route of the API by `METHOD /path`. */
const ROUTES = { ...pictureRoutes, ...agentRoutes, ...gitRoutes, ...specRoutes };

/** Answers one request: an API route by its method and path, else a static file of the page. */
async function handle(ctx: RouteContext, web: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET" && request.method !== "POST") return problem(response, 405, "GET or POST only");
  // A page on another site cannot read the sources through DNS rebinding: the Host header must be this server's own name.
  const hostHeader = (request.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");

  if (!ALLOWED_HOSTS.has(hostHeader) && hostHeader !== ctx.options.host) return problem(response, 421, "unexpected Host header");
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (request.method === "POST") {
    const body = await readBody(request, MAX_BODY);

    if (body === null) return problem(response, 413, `the body is over ${MAX_BODY / 1_000_000} MB`);
    const handler = ROUTES[`POST ${path}`];

    return handler ? handler(ctx, { url, body, response, request }) : problem(response, 404, "no such API");
  }

  if (path.startsWith("/api/")) {
    const handler = ROUTES[`GET ${path}`];

    return handler ? handler(ctx, { url, body: "", response, request }) : problem(response, 404, "no such API");
  }

  return sendStatic(web, path, response);
}

/** A static file of the page, from dist/web only: the page, its chunks and the editor's fonts; never a path that climbs out. */
function sendStatic(web: string, path: string, response: ServerResponse): void {
  const file = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));

  if (file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return problem(response, 404, "not found");
  const full = join(web, ...file.split("/"));
  const extension = file.slice(file.lastIndexOf("."));

  if (!full.startsWith(web) || !existsSync(full) || !(extension in STATIC_TYPES)) return problem(response, 404, "not found");

  return send(response, 200, STATIC_TYPES[extension]!, readFileSync(full));
}

/**
 * Binds the server and says on which port: a named port is binding (taken is an error); without one, the default
 * port or the next free one above it, so a second archdiff (or a page left running) does not stop this one.
 */
async function listen(server: Server, options: ServeOptions): Promise<number | null> {
  const on = (port: number): Promise<void> =>
    new Promise<void>((resolveStarted, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(port, options.host, () => {
        server.off("error", onError);
        resolveStarted();
      });
    });

  if (options.port !== null) await on(options.port);
  else {
    let bound = false;

    for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_TRIES && !bound; port++) {
      try {
        await on(port);
        bound = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
      }
    }

    if (!bound) throw new Error(`no free port between ${DEFAULT_PORT} and ${DEFAULT_PORT + PORT_TRIES - 1}; --port names one`);
  }

  const address = server.address();

  return typeof address === "object" && address ? address.port : options.port;
}

/** Serves the page and the API on the repository at `root` until the process is stopped (Ctrl+C or a signal). */
export async function serve(root: string, options: ServeOptions): Promise<void> {
  const web = await webDirectory();
  const analyses = analysisPerBurst(root);
  const changes = changeChannel(analyses.invalidate);

  // Whether the page follows the code, and why not when it was asked to (`--no-watch` is no problem).
  const watching = options.watch ? watchSources(root, changes.notify) : null;
  const agentSpec = agentSpecOf((await analyze(root)).config, options.agent);
  // The agent's runner is made once the first run is asked for; every run ends with archdiff running the checks.
  let runner: AgentRunner | null = null;
  const ctx: RouteContext = {
    root,
    options,
    agentSpec,
    fresh: analyses.fresh,
    invalidate: analyses.invalidate,
    runner: () => {
      if (!agentSpec) throw new Error("no agent");

      // After a run: the repository changed, so a fresh analysis, then the contract and the configured checks.
      return (runner ??= new AgentRunner(root, agentSpec, async () => {
        analyses.invalidate();

        return checkEvents(await runChecks(await analyses.fresh()));
      }));
    },
    activeRunner: () => runner,
    changeListeners: changes.listeners,
    watching: { on: options.watch && watching === null, problem: watching },
    picture: (query) => pictureOf(query, options.base, analyses.fresh),
  };

  const server = createServer((request, response) => {
    handle(ctx, web, request, response).catch((error: unknown) => {
      process.stderr.write(`archdiff web: ${error instanceof Error ? error.message : String(error)}\n`);

      if (!response.headersSent) problem(response, 500, error instanceof Error ? error.message : String(error));
    });
  });
  const port = await listen(server, options);
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
