// The command line: parses the arguments and calls the modules. `main`
// returns the exit code (0 success, 1 findings or differences, 2 a wrong
// invocation or an I/O error); bin/archdiff.js sets process.exitCode.
// Machine output (`--json`) goes to stdout alone; notes go to stderr.

import { resolve } from "node:path";
import { analyze } from "./analyze.ts";
import { coverageReport } from "./coverage.ts";
import { diagramMarkdown } from "./markdown.ts";
import { exportDiagram, EXPORT_FORMATS, type ExportFormat } from "./export/index.ts";
import { reviewMarkdown, review } from "./diff.ts";
import { serve } from "./server.ts";
import { layout } from "./diagram.ts";
import { parseView, viewOf, viewList } from "./views.ts";

const HELP = `archdiff: live diagrams of a TypeScript/JavaScript repository, and the architectural diff of a change

Usage: archdiff <command> [options] [dir]

Commands:
  analyze [dir] [--json] [--no-cache]
                     Parse the repository and print its size: files, functions, imports,
                     resolved calls and gaps. --json: the stats as JSON
  views [dir]        List the views that can be drawn: layers, every module, every entry point
  diagram <view> [dir] [--format F] [--depth N] [--out FILE]
                     Draw one view. F: md (Markdown with Mermaid, default), mermaid, json,
                     drawio, excalidraw, archimate. Views: layers | layer:<name> |
                     module:<path> | calls:<path>#<fn> | coverage
  coverage [dir] [--json]
                     The map of what the diagrams cannot cover: unresolved imports, calls
                     archdiff could not follow, files with syntax errors, by module
  review [dir] [--base REF] [--format F] [--out FILE]
                     The architectural diff of the working tree against REF (default: the
                     merge-base with the main branch): modules, imports and calls added,
                     removed or changed, as Markdown with a Mermaid diagram (md, default),
                     json, or any diagram format. Exit 1 when a layer dependency appeared
  web [dir] [--port N] [--base REF]
                     Serve the diagrams in a browser: views, the canvas, the code and the
                     Markdown of a shape, the review against REF

Exit codes: 0 ok, 1 differences found (review), 2 wrong invocation or I/O error.
`;

interface Parsed {
  command: string | null;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg.startsWith("--")) {
      const at = arg.indexOf("=");

      if (at !== -1) {
        flags.set(arg.slice(2, at), arg.slice(at + 1));
      } else if (["format", "depth", "out", "base", "port", "host"].includes(arg.slice(2)) && i + 1 < argv.length) {
        flags.set(arg.slice(2), argv[++i]!);
      } else {
        flags.set(arg.slice(2), true);
      }
    } else {
      positional.push(arg);
    }
  }

  return { command: positional[0] ?? null, positional: positional.slice(1), flags };
}

function fail(message: string): number {
  process.stderr.write(`archdiff: ${message}\n`);

  return 2;
}

function writeOut(text: string, out: string | true | undefined): void {
  if (typeof out === "string") {
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(out, text);
    process.stderr.write(`${out}: written\n`);
  } else {
    process.stdout.write(text);
  }
}

const require = (await import("node:module")).createRequire(import.meta.url);

export async function main(argv: readonly string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);

  if (command === null || flags.has("help") || command === "help") {
    process.stdout.write(HELP);

    return command === null && !flags.has("help") ? 2 : 0;
  }

  const dirArg = (index: number): string => resolve(positional[index] ?? ".");

  try {
    switch (command) {
      case "analyze": {
        const analysis = await analyze(dirArg(0), { cache: !flags.has("no-cache") });

        if (flags.has("json")) {
          process.stdout.write(`${JSON.stringify(analysis.stats, null, 2)}\n`);
        } else {
          const s = analysis.stats;
          process.stdout.write(`${s.files} files, ${s.modules} modules in ${analysis.graph.layers.length} layers, ${s.fns} functions, ${s.classes} classes, ${s.types} types\n${s.deps} imports (${s.unresolvedImports} unresolved), ${s.calls} calls followed, ${s.gaps} gaps\n${s.ms.total} ms (list ${s.ms.list}, extract ${s.ms.extract}, graph ${s.ms.graph}; cache ${s.cacheHits} hits, ${s.cacheMisses} misses)\n`);
        }

        return 0;
      }

      case "views": {
        const analysis = await analyze(dirArg(0));

        for (const view of viewList(analysis)) process.stdout.write(`${view.key}\t${view.title}\n`);

        return 0;
      }

      case "diagram": {
        const key = positional[0];

        if (!key) return fail("diagram: a view is required (archdiff views lists them)");
        const view = parseView(key);

        if (!view) return fail(`diagram: unknown view "${key}"`);
        const format = (flags.get("format") ?? "md") as string;

        if (!EXPORT_FORMATS.includes(format as ExportFormat)) return fail(`diagram: unknown format "${format}" (${EXPORT_FORMATS.join(", ")})`);
        const depth = flags.has("depth") ? Number(flags.get("depth")) : undefined;

        if (depth !== undefined && !(Number.isInteger(depth) && depth >= 0)) return fail("diagram: --depth must be a whole number");
        const analysis = await analyze(dirArg(1));
        const diagram = layout(viewOf(analysis, view, depth === undefined ? {} : { depth }));
        writeOut(format === "md" ? diagramMarkdown(diagram, analysis) : exportDiagram(diagram, format as Exclude<ExportFormat, "md">), flags.get("out"));

        return 0;
      }

      case "coverage": {
        const analysis = await analyze(dirArg(0));
        const report = coverageReport(analysis);
        writeOut(flags.has("json") ? `${JSON.stringify(report, null, 2)}\n` : report.markdown, flags.get("out"));

        return 0;
      }

      case "review": {
        const format = (flags.get("format") ?? "md") as string;

        if (format !== "md" && format !== "json" && !EXPORT_FORMATS.includes(format as ExportFormat)) return fail(`review: unknown format "${format}"`);
        const result = await review(dirArg(0), typeof flags.get("base") === "string" ? (flags.get("base") as string) : null);

        if (format === "md") writeOut(reviewMarkdown(result), flags.get("out"));
        else if (format === "json") writeOut(`${JSON.stringify(result.diff, null, 2)}\n`, flags.get("out"));
        else writeOut(exportDiagram(result.diagram, format as Exclude<ExportFormat, "md">), flags.get("out"));

        return result.diff.layerEdgesAdded.length > 0 ? 1 : 0;
      }

      case "web": {
        const port = flags.has("port") ? Number(flags.get("port")) : 7080;

        if (!Number.isInteger(port) || port < 0 || port > 65535) return fail("web: --port must be a port number");
        await serve(dirArg(0), { port, host: typeof flags.get("host") === "string" ? (flags.get("host") as string) : "127.0.0.1", base: typeof flags.get("base") === "string" ? (flags.get("base") as string) : null });

        return 0;
      }

      default:
        return fail(`unknown command "${command}" (archdiff --help)`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
