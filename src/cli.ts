// The command line: parses the arguments and calls the modules. `main`
// returns the exit code (0 success, 1 findings or differences, 2 a wrong
// invocation or an I/O error); bin/archdiff.js sets process.exitCode.
// Machine output (`--json`) goes to stdout alone; notes go to stderr.

import { resolve } from "node:path";
import { analyze } from "./analyze.ts";
import { coverageReport } from "./coverage.ts";
import { dataFlow, flowMarkdown } from "./flow.ts";
import { LAYOUTS_DIRECTORY, readLayout, readLayoutFile } from "./layouts.ts";
import { planFromScene, planMarkdown } from "./plan.ts";
import { agentFromConfig } from "./agent.ts";
import { diagramMarkdown } from "./markdown.ts";
import { exportDiagram, EXPORT_FORMATS, MERMAID_STYLES, type ExportFormat, type MermaidStyle } from "./export/index.ts";
import { compareBranches, comparisonMarkdown, defaultBase, history, historyMarkdown, listBranches, mergeBase, overlayDiff, reviewMarkdown, review } from "./diff.ts";
import { timelineDiagram } from "./views-more.ts";
import { applyOverlays, parseOverlays } from "./overlays.ts";
import { serve } from "./server.ts";
import { layout } from "./diagram.ts";
import { parseView, viewOf, viewList, type ViewOptions } from "./views.ts";

const HELP = `archdiff: live diagrams of a TypeScript/JavaScript repository, and the architectural diff of a change

Usage: archdiff <command> [options] [dir]

Commands:
  analyze [dir] [--json] [--no-cache]
                     Parse the repository and print its size: files, functions, imports,
                     resolved calls and gaps. --json: the stats as JSON
  views [dir]        List the views that can be drawn: layers, every module, every entry point
  diagram <view> [dir] [--format F] [--depth N] [--packages] [--limit N] [--out FILE]
                     Draw one view. F: md (Markdown with Mermaid, default), mermaid, json,
                     drawio, excalidraw, archimate. Views: layers | layer:<name> | dir:<path> |
                     module:<path> | inside:<path> | contract:<path> | calls:<path>#<fn> |
                     sequence:<path>#<fn> | path:<path>#<fn> | type:<path>#<Type> | cycles |
                     cycle:<path> | classes | classes:<path|dir> | matrix | events | tests |
                     hotspots | packages |
                     timeline [--base --head] | coverage. --mermaid auto|flowchart|c4|quadrant|
                     pie|gitgraph|mindmap picks the Mermaid type (auto: a sequence, class or
                     gitGraph where the view has one, else a flowchart). --overlay tests,storages,heat
                     marks untested modules, labels the storages, shades by calls in, on any view.
                     --changes lays the review's marks
                     (--base, --head) over the view: structure and change in one picture. --packages draws the
                     packages a module imports; --limit folds a bigger picture into
                     "… N more" (default 80)
  layouts [dir] [--prune]
                     List the saved drawings (.archdiff/layouts/); --prune deletes those
                     whose view the code no longer has (a renamed module, a removed function)
  flow <calls:view> [dir] [--depth N] [--json]
                     The data flow from an entry point without running it: the steps in call
                     order with their parameters and return types, the storages on the way,
                     and the mock values saved on the page carried by name
  coverage [dir] [--json]
                     The map of what the diagrams cannot cover: unresolved imports, calls
                     archdiff could not follow, files with syntax errors, by module
  review [dir] [--base REF] [--head REF] [--format F] [--out FILE]
                     The architectural diff of the working tree (or --head REF) against
                     --base REF (default: the merge-base with the main branch): modules,
                     imports and calls added, removed or changed, as Markdown with a Mermaid
                     diagram (md, default), json, or any diagram format. Exit 1 when a layer
                     dependency appeared
  branches [dir]     List the branches (local, then remote) with the base the comparisons start from
  compare [dir] [--base REF] [--heads A,B,C] [--format F] [--out FILE]
                     The architectural diff of several heads (branches, tags, commits; WORKTREE
                     for the working tree) against one base (default: develop, main or master):
                     a table per head, one picture of what every head touched, marked by head
  history [dir] [--base REF] [--head REF] [--json] [--out FILE]
                     The architecture drift commit by commit from --base (default: the
                     merge-base) to --head (default: HEAD): modules, functions, imports,
                     layer couplings and packages each commit added or removed
  plan <view> [dir] [--json] [--out FILE]
                     The task drawn on the saved drawing of a view (the page's ✎ edit): new
                     shapes as modules or functions to add, arrows as imports or calls,
                     deleted shapes as removals, notes — as a Markdown task for an agent
  web [dir] [--port N] [--base REF] [--agent claude|cursor] [--no-watch]
                     Serve the diagrams in a browser: views, the canvas, the code and the
                     Markdown of a shape, the review against REF. --agent (or "agent" in
                     archdiff.json) lets the Chat tab hand a drawn task to Claude Code or
                     Cursor's CLI, run in this repository; every run starts from a button.
                     The page reloads when a source file changes (--no-watch: it does not)
  --version          Print the version

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
      } else if (["format", "depth", "out", "base", "head", "heads", "port", "host", "limit", "agent", "mermaid", "overlay"].includes(arg.slice(2)) && i + 1 < argv.length) {
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

/** Every output archdiff writes carries its name, so `--out` can tell its own file from someone else's. */
function isGenerated(text: string): boolean {
  return text.slice(0, 2000).includes("archdiff");
}

/** Prints to stdout, or writes `--out`: a new file, or one archdiff wrote before; any other file is refused (exit 2) and left as it is. */
function writeOut(text: string, out: string | true | undefined): number {
  if (typeof out !== "string") {
    process.stdout.write(text);

    return 0;
  }

  const { existsSync, readFileSync, statSync, writeFileSync } = require("node:fs") as typeof import("node:fs");

  if (existsSync(out) && statSync(out).isDirectory()) return fail(`--out ${out}: a directory; name a file`);

  if (existsSync(out) && !isGenerated(readFileSync(out, "utf8"))) return fail(`--out ${out}: the file exists and was not written by archdiff; nothing written`);
  writeFileSync(out, text);
  process.stderr.write(`${out}: written\n`);

  return 0;
}

const require = (await import("node:module")).createRequire(import.meta.url);

export async function main(argv: readonly string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);

  if (flags.has("version") || command === "version") {
    process.stdout.write(`${(require("../package.json") as { version: string }).version}\n`);

    return 0;
  }

  if (command === null || flags.has("help") || command === "help") {
    process.stdout.write(HELP);

    return command === null && !flags.has("help") ? 2 : 0;
  }

  const dirArg = (index: number): string => resolve(positional[index] ?? ".");
  // How many positional arguments each command takes; one more is a typo, not a silent extra.
  const arity: Record<string, number> = { analyze: 1, views: 1, diagram: 2, coverage: 1, review: 1, history: 1, layouts: 1, flow: 2, plan: 2, web: 1 };

  if (command in arity && positional.length > arity[command]!) return fail(`${command}: unexpected argument "${positional[arity[command]!]}" (archdiff --help)`);

  try {
    switch (command) {
      case "analyze": {
        const analysis = await analyze(dirArg(0), { cache: !flags.has("no-cache") });
        const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
        const ignore = resolve(dirArg(0), ".gitignore");

        // The cache and the drawings live in .archdiff/; a repository that does not ignore it will see them in git status.
        if (!flags.has("no-cache") && existsSync(resolve(dirArg(0), ".git")) && !(existsSync(ignore) && /^\.archdiff\/?\s*$/m.test(readFileSync(ignore, "utf8")))) process.stderr.write("archdiff: .archdiff/ (the cache) is not in .gitignore; add it, or commit .archdiff/layouts/ on purpose\n");

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
        const limit = flags.has("limit") ? Number(flags.get("limit")) : undefined;

        if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) return fail("diagram: --limit must be a whole number above 0");
        const analysis = await analyze(dirArg(1));
        const options: ViewOptions = { packages: flags.has("packages") };

        if (depth !== undefined) options.depth = depth;

        if (limit !== undefined) options.limit = limit;
        let diagram;

        if (view.kind === "timeline") {
          // From the commits: --base (default the merge-base) to --head (default HEAD).
          const from = typeof flags.get("base") === "string" ? (flags.get("base") as string) : mergeBase(analysis.root);
          const to = typeof flags.get("head") === "string" ? (flags.get("head") as string) : "HEAD";
          diagram = layout(timelineDiagram(await history(analysis.root, from, to), from, to));
        } else if (flags.has("changes")) {
          const result = await review(analysis.root, typeof flags.get("base") === "string" ? (flags.get("base") as string) : null, typeof flags.get("head") === "string" ? (flags.get("head") as string) : null);
          diagram = layout(applyOverlays(overlayDiff(viewOf(analysis, view, options), result.diff), analysis, parseOverlays(flags.get("overlay") as string | undefined)));
        } else diagram = layout(applyOverlays(viewOf(analysis, view, options), analysis, parseOverlays(flags.get("overlay") as string | undefined)));

        if (diagram.missing) return fail(`diagram: ${diagram.reason} (archdiff views lists them)`);
        const mermaid = (flags.get("mermaid") ?? "auto") as string;

        if (!MERMAID_STYLES.includes(mermaid as MermaidStyle)) return fail(`diagram: --mermaid must be one of ${MERMAID_STYLES.join(", ")}`);

        return writeOut(format === "md" ? diagramMarkdown(diagram, analysis, mermaid as MermaidStyle) : exportDiagram(diagram, format as Exclude<ExportFormat, "md">, mermaid as MermaidStyle), flags.get("out"));
      }

      case "layouts": {
        const root = dirArg(0);
        const analysis = await analyze(root);
        const { existsSync, readdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
        const directory = resolve(root, LAYOUTS_DIRECTORY);
        const keys = new Set(viewList(analysis).map((view) => view.key));
        const files = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".json")).sort() : [];

        for (const name of files) {
          const saved = readLayoutFile(resolve(directory, name));
          const alive = saved !== null && (keys.has(saved.view) || saved.view.startsWith("review"));
          const line = `${LAYOUTS_DIRECTORY}/${name}\t${saved ? saved.view : "(unreadable)"}\t${alive ? "ok" : "orphan"}`;

          if (!alive && flags.has("prune")) {
            rmSync(resolve(directory, name));
            process.stdout.write(`${line}\tdeleted\n`);
          } else {
            process.stdout.write(`${line}\n`);
          }
        }

        return 0;
      }

      case "flow": {
        const key = positional[0];
        const view = key ? parseView(key) : null;

        if (!view || view.kind !== "calls") return fail("flow: a calls:<path>#<fn> view is required");
        const analysis = await analyze(dirArg(1));
        const depth = flags.has("depth") ? Number(flags.get("depth")) : 4;

        if (!(Number.isInteger(depth) && depth >= 0)) return fail("flow: --depth must be a whole number");
        const flow = dataFlow(analysis, view.id, readLayout(analysis.root, key!)?.mocks ?? [], depth);

        return writeOut(flags.has("json") ? `${JSON.stringify(flow, null, 2)}\n` : flowMarkdown(flow), flags.get("out"));
      }

      case "plan": {
        const key = positional[0];

        if (!key || !parseView(key)) return fail("plan: a view is required (archdiff views lists them)");
        const analysis = await analyze(dirArg(1));
        const saved = readLayout(analysis.root, key);

        if (!saved) return fail(`plan: ${key} has no saved drawing (draw and save it on the page first)`);
        const plan = planFromScene(analysis, key, saved.elements);

        return writeOut(flags.has("json") ? `${JSON.stringify(plan, null, 2)}\n` : planMarkdown(plan, analysis), flags.get("out"));
      }

      case "coverage": {
        const analysis = await analyze(dirArg(0));
        const report = coverageReport(analysis);
        return writeOut(flags.has("json") ? `${JSON.stringify(report, null, 2)}\n` : report.markdown, flags.get("out"));
      }

      case "review": {
        const format = (flags.get("format") ?? "md") as string;

        if (format !== "md" && format !== "json" && !EXPORT_FORMATS.includes(format as ExportFormat)) return fail(`review: unknown format "${format}"`);
        const result = await review(dirArg(0), typeof flags.get("base") === "string" ? (flags.get("base") as string) : null, typeof flags.get("head") === "string" ? (flags.get("head") as string) : null);

        const text = format === "md" ? reviewMarkdown(result) : format === "json" ? `${JSON.stringify(result.diff, null, 2)}\n` : exportDiagram(result.diagram, format as Exclude<ExportFormat, "md">);
        const written = writeOut(text, flags.get("out"));

        if (written !== 0) return written;

        return result.diff.layerEdgesAdded.length > 0 ? 1 : 0;
      }

      case "branches": {
        const root = dirArg(0);
        const { current, branches } = listBranches(root);
        const base = defaultBase(root);
        process.stdout.write(`base: ${base ?? "(none of develop, main, master)"}\ncurrent: ${current ?? "(detached)"}\n`);

        for (const branch of branches) process.stdout.write(`${branch.current ? "* " : "  "}${branch.name}\t${branch.sha}\t${branch.date}\t${branch.subject}${branch.remote ? "\t(remote)" : ""}\n`);

        return 0;
      }

      case "compare": {
        const format = (flags.get("format") ?? "md") as string;

        if (format !== "md" && format !== "json" && !EXPORT_FORMATS.includes(format as ExportFormat)) return fail(`compare: unknown format "${format}"`);
        const heads = typeof flags.get("heads") === "string" ? (flags.get("heads") as string).split(",").filter((head) => head !== "") : ["WORKTREE"];
        const result = await compareBranches(dirArg(0), typeof flags.get("base") === "string" ? (flags.get("base") as string) : null, heads);
        const text = format === "md" ? comparisonMarkdown(result) : format === "json" ? `${JSON.stringify({ base: result.base, heads: result.heads }, null, 2)}\n` : exportDiagram(result.diagram, format as Exclude<ExportFormat, "md">);
        const written = writeOut(text, flags.get("out"));

        if (written !== 0) return written;

        return result.heads.some((head) => head.diff.layerEdgesAdded.length > 0) ? 1 : 0;
      }

      case "history": {
        const root = dirArg(0);
        const base = typeof flags.get("base") === "string" ? (flags.get("base") as string) : mergeBase(root);
        const head = typeof flags.get("head") === "string" ? (flags.get("head") as string) : "HEAD";
        const rows = await history(root, base, head);

        return writeOut(flags.has("json") ? `${JSON.stringify(rows, null, 2)}\n` : historyMarkdown(rows, base, head), flags.get("out"));
      }

      case "web": {
        const port = flags.has("port") ? Number(flags.get("port")) : 7080;

        if (!Number.isInteger(port) || port < 0 || port > 65535) return fail("web: --port must be a port number");
        const agentFlag = flags.get("agent");

        if (agentFlag === true) return fail("web: --agent needs claude or cursor");
        const agent = typeof agentFlag === "string" ? agentFromConfig(agentFlag) : null;
        await serve(dirArg(0), { port, host: typeof flags.get("host") === "string" ? (flags.get("host") as string) : "127.0.0.1", base: typeof flags.get("base") === "string" ? (flags.get("base") as string) : null, agent, watch: !flags.has("no-watch") });

        return 0;
      }

      default:
        return fail(`unknown command "${command}" (archdiff --help)`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
