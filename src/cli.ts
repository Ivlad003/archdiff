// The command line: a table of commands — each with its usage, its help,
// how many positional arguments it takes, the flags it knows and the
// function that runs it — from which `--help` is printed, the arguments
// are parsed (a flag the command does not know is an error, as is one
// argument too many) and the command is run. `main` returns the exit code
// (0 success, 1 findings or differences, 2 a wrong invocation or an I/O
// error); bin/archdiff.js sets process.exitCode. Machine output (`--json`)
// goes to stdout alone; notes go to stderr.

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyze } from "./analyze.ts";
import { coverageReport } from "./coverage.ts";
import { dataFlow, flowMarkdown } from "./flow.ts";
import { LAYOUTS_DIRECTORY, readLayout, readLayoutFile } from "./layouts.ts";
import { planFromScene, planMarkdown } from "./plan.ts";
import { agentFromConfig } from "./agent.ts";
import { diagramMarkdown } from "./markdown.ts";
import { exportDiagram, EXPORT_FORMATS, type ExportFormat } from "./export/index.ts";
import { compareBranches, comparisonMarkdown, history, historyMarkdown, reviewMarkdown, review, withTimeline } from "./diff.ts";
import { defaultBase, listBranches, mergeBase, revisionStamp } from "./git.ts";
import { serve } from "./server.ts";
import { layout } from "./diagram.ts";
import { parseView, viewOf, viewList, viewOptionsOf } from "./views.ts";
import { checkIntent, checkMarkdown, INTENT_FILE, intentFromCode, intentMarkdown, mergePlan, parseIntent, writeIntent } from "./intent.ts";
import { scaffold, TEMPLATES, type Template } from "./scaffold.ts";
import { listSpecs, specPrompt, validateSpecs } from "./spec.ts";
import { pictureFlags, pictureOptionsHelp, readPictureOptions } from "./options.ts";

/** A flag a command knows: its name after `--`, and whether a value follows it. */
interface FlagSpec {
  name: string;
  value: boolean;
}

/** One parsed invocation of a command. */
interface Call {
  positional: string[];
  flags: Map<string, string | true>;
  /** The directory argument at `index`, resolved; the current directory without one. */
  dir(index: number): string;
  /** The value of a flag given with a value; null when absent or given bare. */
  text(name: string): string | null;
  has(name: string): boolean;
}

/** One command of the table. */
interface Command {
  name: string;
  /** The usage line after the name: `[dir] [--json]`. */
  usage: string;
  /** The help, one line per element, already wrapped. */
  help: string[];
  /** How many positional arguments the command takes; one more is a typo, not a silent extra. */
  arity: number;
  flags: FlagSpec[];
  run(call: Call): Promise<number>;
}

const flag = (name: string, value = false): FlagSpec => ({ name, value });

/** A flag of a ref (--base, --head): a value. */
const REF_FLAGS = [flag("base", true), flag("head", true)];

/** The formats a picture is written in: `--format F` and `--out FILE`. */
const OUTPUT_FLAGS = [flag("format", true), flag("out", true)];

function fail(message: string): number {
  process.stderr.write(`archdiff: ${message}\n`);

  return 2;
}

/** Every output archdiff writes carries its name, so `--out` can tell its own file from someone else's. */
function isGenerated(text: string): boolean {
  return text.slice(0, 2000).includes("archdiff");
}

/** Prints to stdout, or writes `--out`: a new file, or one archdiff wrote before; any other file is refused (exit 2) and left as it is. */
function writeOut(text: string, out: string | null): number {
  if (out === null) {
    process.stdout.write(text);

    return 0;
  }

  if (existsSync(out) && statSync(out).isDirectory()) return fail(`--out ${out}: a directory; name a file`);

  if (existsSync(out) && !isGenerated(readFileSync(out, "utf8"))) return fail(`--out ${out}: the file exists and was not written by archdiff; nothing written`);
  writeFileSync(out, text);
  process.stderr.write(`${out}: written\n`);

  return 0;
}

/** `--format F` checked against the formats a command writes; `md` is the Markdown page. */
function formatOf(call: Call, command: string, extra: readonly string[] = []): ExportFormat | "md" | "json" | null {
  const format = call.text("format") ?? "md";

  if (format === "md" || extra.includes(format) || EXPORT_FORMATS.includes(format as ExportFormat)) return format as ExportFormat | "md" | "json";
  fail(`${command}: unknown format "${format}" (${[...new Set(["md", ...extra, ...EXPORT_FORMATS])].join(", ")})`);

  return null;
}

const COMMANDS: readonly Command[] = [
  {
    name: "analyze",
    usage: "[dir] [--json] [--no-cache]",
    help: ["Parse the repository and print its size: files, functions, imports,", "resolved calls and gaps. --json: the stats as JSON"],
    arity: 1,
    flags: [flag("json"), flag("no-cache")],
    async run(call) {
      const root = call.dir(0);
      const analysis = await analyze(root, { cache: !call.has("no-cache") });
      const ignore = resolve(root, ".gitignore");

      // The cache and the drawings live in .archdiff/; a repository that does not ignore it will see them in git status.
      if (!call.has("no-cache") && existsSync(resolve(root, ".git")) && !(existsSync(ignore) && /^\.archdiff\/?\s*$/m.test(readFileSync(ignore, "utf8")))) process.stderr.write("archdiff: .archdiff/ (the cache) is not in .gitignore; add it, or commit .archdiff/layouts/ on purpose\n");

      if (call.has("json")) {
        process.stdout.write(`${JSON.stringify(analysis.stats, null, 2)}\n`);
      } else {
        const s = analysis.stats;
        process.stdout.write(`${s.files} files, ${s.modules} modules in ${analysis.graph.layers.length} layers, ${s.fns} functions, ${s.classes} classes, ${s.types} types\n${s.deps} imports (${s.unresolvedImports} unresolved), ${s.calls} calls followed, ${s.gaps} gaps\n${s.ms.total} ms (list ${s.ms.list}, extract ${s.ms.extract}, graph ${s.ms.graph}; cache ${s.cacheHits} hits, ${s.cacheMisses} misses)\n`);
      }

      return 0;
    },
  },
  {
    name: "views",
    usage: "[dir]",
    help: ["List the views that can be drawn: layers, every module, every entry point"],
    arity: 1,
    flags: [],
    async run(call) {
      const analysis = await analyze(call.dir(0));

      for (const view of viewList(analysis)) process.stdout.write(`${view.key}\t${view.title}\n`);

      return 0;
    },
  },
  {
    name: "diagram",
    usage: "<view> [dir] [--format F] [--out FILE] [--base REF --head REF] [picture options]",
    help: [
      "Draw one view. F: md (Markdown with Mermaid, default), mermaid, json,",
      "drawio, excalidraw, archimate. Views: layers | layer:<name> | dir:<path> |",
      "module:<path> | inside:<path> | contract:<path> | calls:<path>#<fn> |",
      "sequence:<path>#<fn> | path:<path>#<fn> | type:<path>#<Type> | cycles |",
      "cycle:<path> | classes | classes:<path|dir> | matrix | matrix:<dir> | events | tests |",
      "hotspots | packages | timeline [--base --head] | coverage | intent | modules.",
      "Every export names the commit it was drawn from. The picture options:",
      ...pictureOptionsHelp().map((line) => `  ${line}`),
    ],
    arity: 2,
    flags: [...OUTPUT_FLAGS, ...REF_FLAGS, ...pictureFlags().map((item) => flag(item.name, item.value))],
    async run(call) {
      const key = call.positional[0];

      if (!key) return fail("diagram: a view is required (archdiff views lists them)");
      const view = parseView(key);

      if (!view) return fail(`diagram: unknown view "${key}"`);
      const format = formatOf(call, "diagram");

      if (format === null) return 2;
      const picture = readPictureOptions((name) => call.flags.get(name), "flag");

      if (!picture.ok) return fail(`diagram: ${picture.problem.message}`);
      const options = viewOptionsOf(picture.value.options);
      let analysis = await analyze(call.dir(1));

      // The timeline reads the commits from --base (default the merge-base) to --head (default HEAD); --changes lays the review's marks over the view.
      if (view.kind === "timeline") analysis = await withTimeline(analysis, call.text("base") ?? mergeBase(analysis.root), call.text("head") ?? "HEAD");
      else if (picture.value.options.changes) options.diff = (await review(analysis.root, call.text("base"), call.text("head"))).diff;
      let diagram = layout(viewOf(analysis, view, options));

      if (diagram.missing) return fail(`diagram: ${diagram.reason} (archdiff views lists them)`);
      const stamp = revisionStamp(analysis.root);

      if (stamp) diagram = { ...diagram, stamp };
      const mermaid = picture.value.options.mermaid;

      return writeOut(format === "md" ? diagramMarkdown(diagram, analysis, mermaid) : exportDiagram(diagram, format as Exclude<ExportFormat, "md">, mermaid), call.text("out"));
    },
  },
  {
    name: "layouts",
    usage: "[dir] [--prune]",
    help: ["List the saved drawings (.archdiff/layouts/); --prune deletes those", "whose view the code no longer has (a renamed module, a removed function)"],
    arity: 1,
    flags: [flag("prune")],
    async run(call) {
      const root = call.dir(0);
      const analysis = await analyze(root);
      const directory = resolve(root, LAYOUTS_DIRECTORY);
      const keys = new Set(viewList(analysis).map((view) => view.key));
      const files = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".json")).sort() : [];

      for (const name of files) {
        const saved = readLayoutFile(resolve(directory, name));
        const alive = saved !== null && (keys.has(saved.view) || saved.view.startsWith("review"));
        const line = `${LAYOUTS_DIRECTORY}/${name}\t${saved ? saved.view : "(unreadable)"}\t${alive ? "ok" : "orphan"}`;

        if (!alive && call.has("prune")) {
          rmSync(resolve(directory, name));
          process.stdout.write(`${line}\tdeleted\n`);
        } else {
          process.stdout.write(`${line}\n`);
        }
      }

      return 0;
    },
  },
  {
    name: "flow",
    usage: "<calls:view> [dir] [--depth N] [--json] [--out FILE]",
    help: ["The data flow from an entry point without running it: the steps in call", "order with their parameters and return types, the storages on the way,", "and the mock values saved on the page carried by name"],
    arity: 2,
    flags: [flag("depth", true), flag("json"), flag("out", true)],
    async run(call) {
      const key = call.positional[0];
      const view = key ? parseView(key) : null;

      if (!view || view.kind !== "calls") return fail("flow: a calls:<path>#<fn> view is required");
      const analysis = await analyze(call.dir(1));
      const depth = call.has("depth") ? Number(call.text("depth")) : 4;

      if (!(Number.isInteger(depth) && depth >= 0)) return fail("flow: --depth must be a whole number");
      const flow = dataFlow(analysis, view.id, readLayout(analysis.root, key!)?.mocks ?? [], depth);

      return writeOut(call.has("json") ? `${JSON.stringify(flow, null, 2)}\n` : flowMarkdown(flow), call.text("out"));
    },
  },
  {
    name: "coverage",
    usage: "[dir] [--json] [--out FILE]",
    help: ["The map of what the diagrams cannot cover: unresolved imports, calls", "archdiff could not follow, files with syntax errors, by module"],
    arity: 1,
    flags: [flag("json"), flag("out", true)],
    async run(call) {
      const analysis = await analyze(call.dir(0));
      const report = coverageReport(analysis);

      return writeOut(call.has("json") ? `${JSON.stringify(report, null, 2)}\n` : report.markdown, call.text("out"));
    },
  },
  {
    name: "review",
    usage: "[dir] [--base REF] [--head REF] [--format F] [--out FILE]",
    help: ["The architectural diff of the working tree (or --head REF) against", "--base REF (default: the merge-base with the main branch): modules,", "imports and calls added, removed or changed, as Markdown with a Mermaid", "diagram (md, default), json, or any diagram format. Exit 1 when a layer", "dependency appeared"],
    arity: 1,
    flags: [...REF_FLAGS, ...OUTPUT_FLAGS],
    async run(call) {
      const format = formatOf(call, "review", ["json"]);

      if (format === null) return 2;
      const result = await review(call.dir(0), call.text("base"), call.text("head"));
      const text = format === "md" ? reviewMarkdown(result) : format === "json" ? `${JSON.stringify(result.diff, null, 2)}\n` : exportDiagram(result.diagram, format as Exclude<ExportFormat, "md">);
      const written = writeOut(text, call.text("out"));

      if (written !== 0) return written;

      return result.diff.layerEdgesAdded.length > 0 ? 1 : 0;
    },
  },
  {
    name: "branches",
    usage: "[dir]",
    help: ["List the branches (local, then remote) with the base the comparisons start from"],
    arity: 1,
    flags: [],
    async run(call) {
      const root = call.dir(0);
      const { current, branches } = listBranches(root);
      const base = defaultBase(root);
      process.stdout.write(`base: ${base ?? "(none of develop, main, master)"}\ncurrent: ${current ?? "(detached)"}\n`);

      for (const branch of branches) process.stdout.write(`${branch.current ? "* " : "  "}${branch.name}\t${branch.sha}\t${branch.date}\t${branch.subject}${branch.remote ? "\t(remote)" : ""}\n`);

      return 0;
    },
  },
  {
    name: "compare",
    usage: "[dir] [--base REF] [--heads A,B,C] [--format F] [--out FILE]",
    help: ["The architectural diff of several heads (branches, tags, commits; WORKTREE", "for the working tree) against one base (default: develop, main or master):", "a table per head, one picture of what every head touched, marked by head"],
    arity: 1,
    flags: [flag("base", true), flag("heads", true), ...OUTPUT_FLAGS],
    async run(call) {
      const format = formatOf(call, "compare", ["json"]);

      if (format === null) return 2;
      const heads = (call.text("heads") ?? "WORKTREE").split(",").filter((head) => head !== "");
      const result = await compareBranches(call.dir(0), call.text("base"), heads);
      const text = format === "md" ? comparisonMarkdown(result) : format === "json" ? `${JSON.stringify({ base: result.base, heads: result.heads }, null, 2)}\n` : exportDiagram(result.diagram, format as Exclude<ExportFormat, "md">);
      const written = writeOut(text, call.text("out"));

      if (written !== 0) return written;

      return result.heads.some((head) => head.diff.layerEdgesAdded.length > 0) ? 1 : 0;
    },
  },
  {
    name: "history",
    usage: "[dir] [--base REF] [--head REF] [--json] [--out FILE]",
    help: ["The architecture drift commit by commit from --base (default: the", "merge-base) to --head (default: HEAD): modules, functions, imports,", "layer couplings and packages each commit added or removed"],
    arity: 1,
    flags: [...REF_FLAGS, flag("json"), flag("out", true)],
    async run(call) {
      const root = call.dir(0);
      const base = call.text("base") ?? mergeBase(root);
      const head = call.text("head") ?? "HEAD";
      const rows = await history(root, base, head);

      return writeOut(call.has("json") ? `${JSON.stringify(rows, null, 2)}\n` : historyMarkdown(rows, base, head), call.text("out"));
    },
  },
  {
    name: "new",
    usage: "<dir> [--lang ts|js] [--template blank|lib|cli|api|web] [--agent claude|cursor] [--no-git]",
    help: ["A project from scratch: package.json, tsconfig, archdiff.json with the", "template's layers, ARCHITECTURE.md with its intent, the first commit.", "Then: web opens the intent view to draw in; the agent builds what is drawn"],
    arity: 1,
    flags: [flag("lang", true), flag("template", true), flag("agent", true), flag("no-git")],
    async run(call) {
      const target = call.positional[0];

      if (!target) return fail("new: a directory is required (archdiff new my-app --lang ts)");
      const lang = call.flags.get("lang") ?? "ts";

      if (lang !== "ts" && lang !== "js") return fail("new: --lang must be ts or js");
      const template = (call.flags.get("template") ?? "blank") as string;

      if (!TEMPLATES.includes(template as Template)) return fail(`new: --template must be one of ${TEMPLATES.join(", ")}`);
      const agentFlag = call.flags.get("agent");

      if (agentFlag !== undefined && agentFlag !== "claude" && agentFlag !== "cursor") return fail("new: --agent must be claude or cursor");
      let written: string[];

      try {
        written = scaffold(resolve(target), { lang, template: template as Template, agent: (agentFlag as "claude" | "cursor" | undefined) ?? null, git: !call.has("no-git") });
      } catch (error) {
        return fail(`new: ${error instanceof Error ? error.message : String(error)}`);
      }

      process.stdout.write(`${written.map((file) => `${target}/${file}`).join("\n")}\n`);
      process.stderr.write(`archdiff new: ${template} (${lang}) in ${resolve(target)}${call.has("no-git") ? "" : ", committed on main"}. Next: cd ${target} && npx @ivlad003/archdiff web${agentFlag ? "" : " --agent claude"}\n`);

      return 0;
    },
  },
  {
    name: "import",
    usage: "<file> [dir]",
    help: ["A Markdown document with a Mermaid flowchart (a design note, an ISD, a", "tool's export) becomes ARCHITECTURE.md: subgraphs are layers, nodes are", "modules (the label is the path, then what it does), arrows are imports"],
    arity: 2,
    flags: [],
    async run(call) {
      const file = call.positional[0];

      if (!file) return fail("import: a Markdown file with a Mermaid flowchart is required");

      if (!existsSync(resolve(file))) return fail(`import: ${file} does not exist`);
      const root = call.dir(1);
      const intent = parseIntent(readFileSync(resolve(file), "utf8"));

      if (intent.modules.length === 0 && intent.layers.length === 0) return fail(`import: no Mermaid flowchart with layers or modules in ${file}`);
      const wrote = writeIntent(root, intent);
      process.stderr.write(`archdiff import: ${intent.layers.length} layers, ${intent.modules.length} modules, ${intent.edges.length} imports → ${wrote}\n`);

      return 0;
    },
  },
  {
    name: "intent",
    usage: "[dir] [--init [--force] [--layers]] [--view V] [--json] [--out FILE]",
    help: ["Print ARCHITECTURE.md; --init writes it from the code (--layers: the", "layers with a few modules each, which a big repository gets by itself);", "--view folds the saved drawing of a view into it"],
    arity: 1,
    flags: [flag("init"), flag("force"), flag("layers"), flag("view", true), flag("json"), flag("out", true)],
    async run(call) {
      const analysis = await analyze(call.dir(0));
      let intent = analysis.intent;

      if (call.has("init")) {
        if (intent && !call.has("force")) return fail(`intent: ${INTENT_FILE} exists; --force overwrites it from the code`);
        intent = intentFromCode(analysis, { level: call.has("layers") ? "layers" : "auto" });
        writeIntent(analysis.root, intent);
        process.stderr.write(`archdiff intent: ${INTENT_FILE} written from the code (${intent.layers.length} layers, ${intent.modules.length} modules)\n`);
      }

      const key = call.text("view");

      if (key !== null) {
        const saved = readLayout(analysis.root, key);

        if (!saved) return fail(`intent: ${key} has no saved drawing`);
        intent = mergePlan(intent ?? parseIntent(""), planFromScene(analysis, key, saved.elements), analysis.graph);
        writeIntent(analysis.root, intent);
        process.stderr.write(`archdiff intent: the drawing of ${key} folded into ${INTENT_FILE}\n`);
      }

      if (!intent) return fail(`intent: no ${INTENT_FILE} (archdiff intent --init writes one from the code; archdiff import <file> from a document)`);

      return writeOut(call.has("json") ? `${JSON.stringify({ layers: intent.layers, modules: intent.modules, edges: intent.edges }, null, 2)}\n` : intentMarkdown(intent), call.text("out"));
    },
  },
  {
    name: "spec",
    usage: "[dir] [--json] [--prompt <view>|all|update] [--validate] [--out FILE]",
    help: ["The specification: list openspec/specs and features/; --prompt prints", "the task that has the agent write the spec of a view's subject (or of", "every layer, or review every spec); --validate runs the OpenSpec CLI"],
    arity: 1,
    flags: [flag("json"), flag("prompt", true), flag("validate"), flag("out", true)],
    async run(call) {
      const analysis = await analyze(call.dir(0));

      if (call.has("validate")) {
        const result = validateSpecs(analysis.root);
        process.stdout.write(`${result.output}\n`);

        return result.ok ? 0 : 1;
      }

      const prompt = call.flags.get("prompt");

      if (prompt !== undefined) {
        if (prompt === true) return fail("spec: --prompt needs a view, all or update");
        const mode = prompt === "update" ? "update" : "generate";
        const view = prompt === "all" || prompt === "update" ? null : parseView(prompt);

        if (prompt !== "all" && prompt !== "update" && !view) return fail(`spec: unknown view "${prompt}"`);
        const subject = view && "id" in view ? view.id : view && "name" in view ? `the layer ${view.name}` : view && "path" in view ? `the directory ${view.path}` : null;

        return writeOut(specPrompt(analysis, mode, subject), call.text("out"));
      }

      const { initialised, specs } = listSpecs(analysis.root);

      if (call.has("json")) return writeOut(`${JSON.stringify({ initialised, specs }, null, 2)}\n`, call.text("out"));
      process.stdout.write(specs.length === 0 ? `no specs yet${initialised ? "" : " (no openspec/)"}: archdiff spec --prompt all writes the agent's task\n` : `${specs.map((spec) => `${spec.path}\t${spec.title}`).join("\n")}\n`);

      return 0;
    },
  },
  {
    name: "check",
    usage: "[dir] [--json] [--out FILE]",
    help: ["The code against ARCHITECTURE.md: imports between layers the intent does", "not allow (exit 1), what is planned and not built, what is built beyond it"],
    arity: 1,
    flags: [flag("json"), flag("out", true)],
    async run(call) {
      const analysis = await analyze(call.dir(0));

      if (!analysis.intent) {
        process.stderr.write(`archdiff check: no ${INTENT_FILE}, nothing to check against (archdiff intent --init)\n`);

        return 0;
      }

      const report = checkIntent(analysis, analysis.intent);
      const code = writeOut(call.has("json") ? `${JSON.stringify(report, null, 2)}\n` : checkMarkdown(report, analysis.root), call.text("out"));
      process.stderr.write(report.ok ? "archdiff check: the code follows the intent\n" : `archdiff check: ${report.violations.length} imports go against the intent\n`);

      return code !== 0 ? code : report.ok ? 0 : 1;
    },
  },
  {
    name: "plan",
    usage: "<view> [dir] [--json] [--out FILE]",
    help: ["The task drawn on the saved drawing of a view (the page's ✎ edit): new", "shapes as modules or functions to add, arrows as imports or calls,", "deleted shapes as removals, notes — as a Markdown task for an agent"],
    arity: 2,
    flags: [flag("json"), flag("out", true)],
    async run(call) {
      const key = call.positional[0];

      if (!key || !parseView(key)) return fail("plan: a view is required (archdiff views lists them)");
      const analysis = await analyze(call.dir(1));
      const saved = readLayout(analysis.root, key);

      if (!saved) return fail(`plan: ${key} has no saved drawing (draw and save it on the page first)`);
      const plan = planFromScene(analysis, key, saved.elements);

      return writeOut(call.has("json") ? `${JSON.stringify(plan, null, 2)}\n` : planMarkdown(plan, analysis), call.text("out"));
    },
  },
  {
    name: "web",
    usage: "[dir] [--port N] [--host H] [--base REF] [--agent claude|cursor] [--no-watch]",
    help: ["Serve the diagrams in a browser: views, the canvas, the code and the", "Markdown of a shape, the review against REF. --agent (or \"agent\" in", "archdiff.json) lets the Chat tab hand a drawn task to Claude Code or", "Cursor's CLI, run in this repository; every run starts from a button.", "The page reloads when a source file changes (--no-watch: it does not).", "Without --port: 7080, or the next free port above it when it is taken"],
    arity: 1,
    flags: [flag("port", true), flag("host", true), flag("base", true), flag("agent", true), flag("no-watch")],
    async run(call) {
      const port = call.has("port") ? Number(call.text("port")) : null;

      if (port !== null && (!Number.isInteger(port) || port < 0 || port > 65535)) return fail("web: --port must be a port number");
      const agentFlag = call.flags.get("agent");

      if (agentFlag === true) return fail("web: --agent needs claude or cursor");
      const agent = typeof agentFlag === "string" ? agentFromConfig(agentFlag) : null;
      await serve(call.dir(0), { port, host: call.text("host") ?? "127.0.0.1", base: call.text("base"), agent, watch: !call.has("no-watch") });

      return 0;
    },
  },
];

const HELP_HEAD = `archdiff: live diagrams of a TypeScript/JavaScript repository, and the architectural diff of a change

Usage: archdiff <command> [options] [dir]

Commands:
`;

/** The help, printed from the table: the usage of every command and its lines, aligned. */
export function helpText(): string {
  const lines: string[] = [];

  for (const command of COMMANDS) {
    lines.push(`  ${command.name} ${command.usage}`.trimEnd());

    for (const line of command.help) lines.push(`${" ".repeat(21)}${line}`);
  }

  lines.push("  --version          Print the version", "", "Exit codes: 0 ok, 1 differences found (review, check), 2 wrong invocation or I/O error.");

  return `${HELP_HEAD}${lines.join("\n")}\n`;
}

/** The names at an edit distance of at most two from `name`, for "did you mean". */
function nearest(name: string, candidates: readonly string[]): string[] {
  const distance = (a: string, b: string): number => {
    const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);

    for (let j = 1; j <= b.length; j++) rows[0]![j] = j;

    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));

    return rows[a.length]![b.length]!;
  };

  return candidates.filter((candidate) => distance(name, candidate) <= 2);
}

/** The arguments of one command: `--flag`, `--flag=value` and `--flag value` (for the flags that take one), the rest positional. */
function parseCall(command: Command | null, argv: readonly string[]): { call: Call } | { error: string } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const known = new Map((command?.flags ?? []).map((item) => [item.name, item.value]));

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const at = arg.indexOf("=");
    const name = at === -1 ? arg.slice(2) : arg.slice(2, at);

    if (name === "help" || name === "version") {
      flags.set(name, true);
      continue;
    }

    if (command && !known.has(name)) {
      const near = nearest(name, [...known.keys()]);

      return { error: `${command.name}: unknown flag --${name}${near.length > 0 ? ` (did you mean --${near.join(", --")}?)` : ` (archdiff --help lists them)`}` };
    }

    if (at !== -1) flags.set(name, arg.slice(at + 1));
    else if (known.get(name) === true && i + 1 < argv.length) flags.set(name, argv[++i]!);
    else flags.set(name, true);
  }

  const call: Call = {
    positional,
    flags,
    dir: (index) => resolve(positional[index] ?? "."),
    text: (name) => {
      const value = flags.get(name);

      return typeof value === "string" ? value : null;
    },
    has: (name) => flags.has(name),
  };

  return { call };
}

const require = (await import("node:module")).createRequire(import.meta.url);

export async function main(argv: readonly string[]): Promise<number> {
  const name = argv.find((arg) => !arg.startsWith("--")) ?? null;
  const command = COMMANDS.find((candidate) => candidate.name === name) ?? null;
  const parsed = parseCall(command, argv.filter((arg) => arg !== name || name === null));

  if ("error" in parsed) return fail(parsed.error);
  const { call } = parsed;

  if (call.has("version") || name === "version") {
    process.stdout.write(`${(require("../package.json") as { version: string }).version}\n`);

    return 0;
  }

  if (name === null || call.has("help") || name === "help") {
    process.stdout.write(helpText());

    return name === null && !call.has("help") ? 2 : 0;
  }

  if (!command) return fail(`unknown command "${name}" (archdiff --help)`);

  if (call.positional.length > command.arity) return fail(`${command.name}: unexpected argument "${call.positional[command.arity]}" (archdiff --help)`);

  try {
    return await command.run(call);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
