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
import { hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, type Analysis } from "./analyze.ts";
import { AgentRunner, installedAgents, type AgentSpec } from "./agent.ts";
import { allowedToolsFor, checkEvents, runChecks } from "./checks.ts";
import type { Config } from "./config.ts";
import { isSourceFile } from "./files.ts";
import { drawPicture, type Picture } from "./picture.ts";
import { ok, wrong, type Result } from "./result.ts";
import { commitOf } from "./git.ts";
import { analysisAt } from "./review.ts";
import { problem, requestOf, send, type RouteContext } from "./routes/context.ts";
import { codeRevision, drawnAtHead, parseView } from "./view-keys.ts";
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

/**
 * The whole body of a request as text, or null when it is over `limit` bytes. A body over the limit is read to its
 * end and dropped, not cut off: the client is still sending, and a closed socket would never get the 413.
 */
function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolveBody, reject) => {
    let chunks: Buffer[] | null = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > limit) chunks = null;
      else chunks?.push(chunk);
    });
    request.on("end", () => resolveBody(chunks ? Buffer.concat(chunks).toString("utf8") : null));
    request.on("error", reject);
  });
}

/** Whether an Origin header names this server (a host it answers to); `null` (a sandboxed frame, a file) is none. */
function ownOrigin(origin: string, hosts: ReadonlySet<string>): boolean {
  try {
    return hosts.has(new URL(origin).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/** Host headers a browser sends to a server on this computer. */
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The names a request to this server may carry in its Host header: this computer's own (and `--host`'s); bound to
 * every address (`--host 0.0.0.0`), also the computer's name and each address of its network interfaces. A page
 * of another site that reaches the server through DNS rebinding sends its own name, which is none of these.
 */
function allowedHosts(host: string): ReadonlySet<string> {
  const names = new Set([...ALLOWED_HOSTS, host]);

  if (host === "0.0.0.0" || host === "::") {
    names.add(hostname());
    names.add(`${hostname()}.local`);

    for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) names.add(address.address);
  }

  return names;
}

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

/** How many revisions' analyses the server keeps (the branches the page switched between), the oldest dropped first. */
const KEPT_REVISIONS = 6;

/**
 * The analysis of the code at a head — a branch, a tag, a commit, read from git without a checkout — kept by commit,
 * a few at a time; the working tree's (per burst) without a head. A head git does not know is refused by name.
 */
function analysesAt(root: string, fresh: () => Promise<Analysis>): (head: string | null) => Promise<Analysis> {
  const byCommit = new Map<string, Promise<Analysis>>();

  return async (head) => {
    if (head === null || head === "WORKTREE") return fresh();
    const commit = commitOf(root, head);

    if (commit === null) throw new Error(`no branch, tag or commit "${head}" (archdiff branches lists the branches)`);
    let analysis = byCommit.get(commit);

    if (!analysis) {
      analysis = analysisAt(root, commit);
      byCommit.set(commit, analysis);
      analysis.catch(() => byCommit.delete(commit));

      if (byCommit.size > KEPT_REVISIONS) byCommit.delete(byCommit.keys().next().value!);
    }

    return analysis;
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

/** Claude Code may run the checks of archdiff.json (and archdiff) on its own; another agent follows its own rules. */
function withAllowedTools(spec: AgentSpec, config: Config): AgentSpec {
  return spec.name === "claude" ? { ...spec, allowedTools: allowedToolsFor(config.checks) } : spec;
}

/** The agent a run names among those offered, or the default (the one given, else the first installed); why not, else. */
function agentFor(offered: readonly { spec: AgentSpec; installed: boolean }[], given: AgentSpec | null, name: string | null): { spec: AgentSpec } | { problem: string } {
  const named = name ?? given?.name ?? offered.find((choice) => choice.installed)?.spec.name ?? null;

  if (named === null) return { problem: `no agent installed here: ${offered.map((choice) => choice.spec.label).join(", ")} (any of them, on the PATH)` };
  const choice = offered.find((candidate) => candidate.spec.name === named);

  if (!choice) return { problem: `no agent "${named}" (${offered.map((candidate) => candidate.spec.name).join(", ")})` };

  return choice.installed ? { spec: choice.spec } : { problem: `${choice.spec.label} is not installed here (\`${choice.spec.command[0]}\` is not on the PATH)` };
}

/** The picture a query names, drawn on the code it is of; git's refusal (outside a repository, a bad ref) is the request's problem. */
async function pictureOf(query: URLSearchParams, defaultBase: string | null, analysisFor: (query: URLSearchParams) => Promise<Analysis>): Promise<Result<Picture>> {
  const request = requestOf(query, defaultBase);

  if (!request.ok) return request;

  try {
    return ok(await drawPicture(await analysisFor(query), request.value));
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

  if (!ctx.hosts.has(hostHeader)) return problem(response, 421, "unexpected Host header");
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  // A page of another site may send a POST here (a form, a fetch in no-cors mode) — to start an agent, to write a
  // drawing — though it cannot read the answer. The browser names the page's origin: it must be this server's own.
  if (request.method === "POST" && request.headers.origin !== undefined && !ownOrigin(request.headers.origin, ctx.hosts)) return problem(response, 403, "a request from another site");

  if (request.method === "POST") {
    const body = await readBody(request, MAX_BODY);

    if (body === null) return problem(response, 413, `the body is over ${MAX_BODY / 1_000_000} MB (a drawing with big images: fewer or smaller ones)`);
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
  let file: string;

  try {
    file = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
  } catch {
    // A broken escape (`%E0%A4%A`) names no file.
    return problem(response, 400, "a malformed path");
  }

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
  const at = analysesAt(root, analyses.fresh);
  // A picture of the code is drawn on the analysis of its head; a change reads its revisions itself (picture.ts).
  const pictureAnalysis = (query: URLSearchParams): Promise<Analysis> => (drawnAtHead(parseView(query.get("view") ?? "layers")?.kind) ? at(query.get("head") || null) : analyses.fresh());
  const analysisFor = (query: URLSearchParams): Promise<Analysis> => at(codeRevision(parseView(query.get("view") ?? "layers"), query.get("head") || null));
  const changes = changeChannel(analyses.invalidate);

  // Whether the page follows the code, and why not when it was asked to (`--no-watch` is no problem).
  const watching = options.watch ? watchSources(root, changes.notify) : null;
  const config = (await analyze(root)).config;
  // The agent given (--agent, archdiff.json): the default of the page, which offers every agent installed here.
  const given = options.agent ?? config.agent;
  const agents = (): { spec: AgentSpec; installed: boolean }[] => installedAgents(given).map(({ spec, installed }) => ({ spec: withAllowedTools(spec, config), installed }));
  // The runner is made once the first run is asked for; every run ends with archdiff running the checks.
  let runner: AgentRunner | null = null;
  const ctx: RouteContext = {
    root,
    options,
    agents,
    agentFor: (name) => agentFor(agents(), given, name),
    fresh: analyses.fresh,
    invalidate: analyses.invalidate,
    runner: () =>
      // After a run: the repository changed, so a fresh analysis, then the contract and the configured checks.
      (runner ??= new AgentRunner(root, async () => {
        analyses.invalidate();

        return checkEvents(await runChecks(await analyses.fresh()));
      })),
    activeRunner: () => runner,
    changeListeners: changes.listeners,
    watching: { on: options.watch && watching === null, problem: watching },
    hosts: allowedHosts(options.host),
    picture: (query) => pictureOf(query, options.base, pictureAnalysis),
    analysisFor,
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
      // A page left open holds its live-reload stream (and keeps reconnecting): `close` alone would wait for it forever.
      server.closeAllConnections();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
