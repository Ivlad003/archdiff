// `archdiff web`: a local HTTP server that serves the page (dist/web, built
// by scripts/build-web.mjs; built on the fly in a checkout) and a JSON API
// over the analysis. Every request re-analyses the repository, which the
// fact cache keeps fast, so the diagrams are live: edit a file, reload.
// GET only; binds to localhost unless --host says otherwise; the files it
// returns are only the analysed sources of the repository.
//
// API: /api/views, /api/diagram?view=&depth=, /api/node?view=&id=,
// /api/file?path=, /api/coverage, /api/review?base=,
// /api/export?view=&format=. Entry point: `serve`.

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, type Analysis } from "./analyze.ts";
import { coverageReport } from "./coverage.ts";
import { layout } from "./diagram.ts";
import { review, reviewMarkdown } from "./diff.ts";
import { EXPORT_EXTENSION, EXPORT_FORMATS, EXPORT_MEDIA_TYPE, exportDiagram, type ExportFormat } from "./export/index.ts";
import { diagramMarkdown, nodeMarkdown } from "./markdown.ts";
import { parseView, viewList, viewOf } from "./views.ts";

export interface ServeOptions {
  port: number;
  host: string;
  /** The base ref of the review panel; null: the merge-base with the main branch. */
  base: string | null;
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

/** Host headers a browser sends to a server on this computer. */
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const STATIC_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

export async function serve(root: string, options: ServeOptions): Promise<void> {
  const web = await webDirectory();
  let current: Promise<Analysis> | null = null;

  // One analysis per burst of requests: the page asks for several things at once after a reload.
  const fresh = (): Promise<Analysis> => {
    if (!current) {
      current = analyze(root);
      setTimeout(() => (current = null), 300);
    }

    return current;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "GET") return problem(response, 405, "GET only");
    // A page on another site cannot read the sources through DNS rebinding: the Host header must be this server's own name.
    const hostHeader = (request.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");

    if (!ALLOWED_HOSTS.has(hostHeader) && hostHeader !== options.host) return problem(response, 421, "unexpected Host header");
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      switch (path) {
        case "/api/views": {
          const analysis = await fresh();

          return json(response, { root, stats: analysis.stats, layers: analysis.graph.layers, views: viewList(analysis) });
        }

        case "/api/diagram": {
          const view = parseView(url.searchParams.get("view") ?? "");

          if (!view) return problem(response, 400, "unknown view");
          const depthText = url.searchParams.get("depth");
          const depth = depthText === null ? undefined : Number(depthText);

          if (depth !== undefined && !(Number.isInteger(depth) && depth >= 0)) return problem(response, 400, "depth must be a whole number");
          const analysis = await fresh();
          const diagram = layout(viewOf(analysis, view, depth === undefined ? {} : { depth }));

          return json(response, { diagram, markdown: diagramMarkdown(diagram, analysis) });
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

            return json(response, { diff: result.diff, diagram: result.diagram, markdown: reviewMarkdown(result) });
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
            const view = parseView(key);

            if (!view) return problem(response, 400, "unknown view");
            diagram = layout(viewOf(analysis, view));
          }

          const name = `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}${EXPORT_EXTENSION[format as ExportFormat]}`;
          response.writeHead(200, { "content-type": EXPORT_MEDIA_TYPE[format as ExportFormat], "content-disposition": `attachment; filename="${name}"` });

          return void response.end(exportDiagram(diagram, format as Exclude<ExportFormat, "md">));
        }

        default:
          return problem(response, 404, "no such API");
      }
    }

    // Static files of the page, from dist/web only.
    const file = path === "/" ? "index.html" : path.slice(1);

    if (file.includes("..") || file.includes("/")) return problem(response, 404, "not found");
    const full = join(web, file);
    const extension = file.slice(file.lastIndexOf("."));

    if (!existsSync(full) || !(extension in STATIC_TYPES)) return problem(response, 404, "not found");

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
      server.close(() => resolveStopped());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
