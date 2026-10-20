// The command line: a table of commands — each with its usage, its help,
// how many positional arguments it takes, the flags it knows and the
// function that runs it — from which `--help` is printed, the arguments
// are parsed (a flag the command does not know is an error, as is one
// argument too many) and the command is run. `main` returns the exit code
// (0 success, 1 findings or differences, 2 a wrong invocation or an I/O
// error); bin/archdiff.js sets process.exitCode. Machine output (`--json`)
// goes to stdout alone; notes go to stderr.
//
// Entry points: `main` (bin/archdiff.js runs it), `helpText`.

import { contractsMarkdown, contractsOf } from "./contracts.ts";
import { postmanCollection } from "./postman.ts";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyze } from "./analyze.ts";
import { coverageReport } from "./coverage.ts";
import { dataFlow, flowMarkdown } from "./flow.ts";
import { runFlow, runMarkdown } from "./run.ts";
import { DRAWINGS_DIRECTORY, readDrawing, readDrawingFile } from "./drawings.ts";
import { mergePlan, planFromScene, taskMarkdown } from "./plan.ts";
import { agentFromConfig, AGENTS, type AgentName } from "./agent.ts";
import { metricsMarkdown } from "./markdown.ts";
import { exportDiagram, EXPORT_FORMATS, type ExportFormat } from "./export/index.ts";
import { historyMarkdown, reviewFindings, shortCommits } from "./diff.ts";
import { drawPicture, type Picture, type Refs } from "./picture.ts";
import { analysisAt, history, review } from "./review.ts";
import { defaultBase, isIgnored, listBranches, mergeBase, revisionStamp } from "./git.ts";
import { CACHE_DIRECTORY } from "./cache.ts";
import { serve } from "./server.ts";
import { drawnAtHead, usesDepth, viewSyntax } from "./view-keys.ts";
import { changedViews, parseView, viewList, viewOf, type View } from "./views.ts";
import { checkIntent, checkMarkdown, INTENT_FILE, intentFromCode, intentMarkdown, judgesLayers, parseIntent, writeIntent } from "./intent.ts";
import { scaffold, TEMPLATES, type Template } from "./scaffold.ts";
import { listSpecs, specPrompt, specSubject, validateSpecs } from "./spec.ts";
import { writeTestSkeletons } from "./gherkin.ts";
import { FEATURES_DIRECTORY as FEATURES_DIRECTORY_NAME } from "./spec.ts";
import { DEFAULT_PICTURE_OPTIONS, depthWarning, pictureFlags, pictureOptionsHelp, readPictureOptions, type PictureOptions } from "./options.ts";
import { metricsOf } from "./metrics.ts";
import { counted } from "./words.ts";

/** A flag a command knows: its name after `--`, and whether a value follows it. */
interface FlagSpec {
  name: string;
  /** Whether the flag takes a value (`--out FILE`); "optional": it may stand alone (`--tests [DIR]`). */
  value: boolean | "optional";
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
  /** Older names the command still answers to (`layouts` is `drawings`). */
  aliases?: readonly string[];
  /** The usage line after the name: `[dir] [--json]`. */
  usage: string;
  /** The help, one line per element, already wrapped. */
  help: string[];
  /** How many positional arguments the command takes; one more is a typo, not a silent extra. */
  arity: number;
  flags: FlagSpec[];
  run(call: Call): Promise<number>;
}

const flag = (name: string, value: FlagSpec["value"] = false): FlagSpec => ({ name, value });

/** A flag of a ref (--base, --head): a value. */
const REF_FLAGS = [flag("base", true), flag("head", true)];

/** The refs of a picture from the flags: `--base`, `--head` and `--heads a,b` (a comparison's). */
function refsOf(call: Call): Refs {
  return { base: call.text("base"), head: call.text("head"), heads: (call.text("heads") ?? "").split(",").filter((head) => head !== "") };
}

/**
 * Draws the picture of a view with picture.ts (the refs from the flags)
 * and writes it in the chosen format: its Markdown page, an export of the
 * placed diagram, or for `json` what `json` makes of it (the Diagram by
 * default). A view whose subject does not exist is a wrong call (exit 2);
 * git refusing (outside a repository, a shallow clone) throws, which
 * `main` reports (exit 2). The picture comes back for the exit code.
 */
async function writePicture(call: Call, command: string, root: string, view: View, options: PictureOptions, format: ExportFormat | "md", json: (picture: Picture) => string = (picture) => exportDiagram(picture.diagram, "json")): Promise<{ code: number; picture: Picture | null }> {
  // A deep picture is drawn, not refused: the warning goes to stderr (and first into the picture's reason).
  const deep = usesDepth(view.kind) ? depthWarning(options.depth) : null;

  if (deep) process.stderr.write(`archdiff: ⚠ ${deep}\n`);
  const refs = refsOf(call);
  // `--head` on a view that is no change draws the code at that revision, read from git without a checkout.
  const analysis = drawnAtHead(view.kind) && refs.head ? await analysisAt(root, refs.head) : await analyze(root);
  const picture = await drawPicture(analysis, { view, options, refs });

  // A missing subject: the reason, and where the subjects are listed, unless the reason says so already (a machine's).
  if (picture.diagram.missing) {
    const reason = picture.diagram.reason ?? "";

    return { code: fail(`${command}: ${reason}${/ lists them\)$/.test(reason) ? "" : " (archdiff views lists them)"}`), picture: null };
  }

  const text = format === "md" ? picture.markdown : format === "json" ? json(picture) : exportDiagram(picture.diagram, format, options.mermaid);

  return { code: writeOut(text, call.text("out")), picture };
}

/** The formats a picture is written in: `--format F` and `--out FILE`. */
const OUTPUT_FLAGS = [flag("format", true), flag("out", true)];

function fail(message: string): number {
  process.stderr.write(`archdiff: ${message}\n`);

  return 2;
}

/** Every output archdiff writes carries its name, so `--out` can tell its own file from someone else's. */
/**
 * Whether `existing` is a file archdiff wrote, so `--out` may write `next` over it: the generated mark where each
 * format puts it (the first line of Markdown and Mermaid, the head of draw.io, Excalidraw, ArchiMate and a picture's
 * JSON), or for the JSON of a command (metrics, flow, history…), JSON of the same shape as the one written. A file
 * that only mentions archdiff (a package.json, a README) is the reader's.
 */
function isGenerated(existing: string, next: string): boolean {
  const head = existing.slice(0, 1000);

  if (/^(<!-- archdiff:generated|%% archdiff:generated)/.test(existing) || head.startsWith('<mxfile host="archdiff"') || /^\{\s*"type": "excalidraw",\s*"version": \d+,\s*"source": "archdiff/.test(head) || /^\{\s*"generator": "archdiff"/.test(head)) return true;

  if (head.includes('<documentation xml:lang="en">Generated by archdiff from the code')) return true;

  return sameJsonShape(existing, next);
}

/** Both texts are JSON of one shape: objects with the same keys, or arrays whose first items have the same keys (or both empty). */
function sameJsonShape(a: string, b: string): boolean {
  let left: unknown;
  let right: unknown;

  try {
    left = JSON.parse(a);
    right = JSON.parse(b);
  } catch {
    return false;
  }

  const keys = (value: unknown): string | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join("\u0000") : null);

  if (Array.isArray(left) && Array.isArray(right)) return left.length === 0 || right.length === 0 || keys(left[0]) === keys(right[0]);

  return keys(left) !== null && keys(left) === keys(right);
}

/** Prints to stdout, or writes `--out`: a new file, or one archdiff wrote before; any other file is refused (exit 2) and left as it is. */
function writeOut(text: string, out: string | null): number {
  if (out === null) {
    process.stdout.write(text);

    return 0;
  }

  if (existsSync(out) && statSync(out).isDirectory()) return fail(`--out ${out}: a directory; name a file`);

  if (existsSync(out) && !isGenerated(readFileSync(out, "utf8"), text)) return fail(`--out ${out}: the file exists and was not written by archdiff; nothing written`);
  writeFileSync(out, text);
  process.stderr.write(`${out}: written\n`);

  return 0;
}

/** `--format F` checked against the formats a picture is written in; `md` is the Markdown page. */
function formatOf(call: Call, command: string): ExportFormat | null {
  const written = call.text("format") ?? "md";
  const format = EXPORT_FORMATS.find((candidate) => candidate === written);

  if (format) return format;
  fail(`${command}: unknown format "${written}" (${EXPORT_FORMATS.join(", ")})`);

  return null;
}

/** Text broken into lines of at most `width` characters at its spaces, for the help. */
function wrapped(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }

  if (line !== "") lines.push(line);

  return lines;
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

      // The cache lives in .archdiff/; a repository that does not ignore it sees it in git status. Git says, by any of
      // its ignore files and patterns (`.archdiff/`, or the cache file alone with the drawings committed on purpose).
      if (!call.has("no-cache") && isIgnored(root, `${CACHE_DIRECTORY}/facts.json.gz`) === false) process.stderr.write("archdiff: .archdiff/ (the cache) is not in .gitignore; add it, or commit .archdiff/layouts/ on purpose\n");

      if (call.has("json")) {
        process.stdout.write(`${JSON.stringify(analysis.stats, null, 2)}\n`);
      } else {
        const s = analysis.stats;
        process.stdout.write(`${counted(s.files, "file")}, ${counted(s.modules, "module")} in ${counted(analysis.graph.layers.length, "layer")}, ${counted(s.fns, "function")}, ${counted(s.classes, "class", "classes")}, ${counted(s.types, "type")}\n${counted(s.deps, "import")} (${s.unresolvedImports} unresolved), ${counted(s.calls, "call")} followed, ${counted(s.gaps, "gap")}\n${s.ms.total} ms (list ${s.ms.list}, extract ${s.ms.extract}, graph ${s.ms.graph}; cache ${s.cacheHits} hits, ${s.cacheMisses} misses)\n`);
      }

      return 0;
    },
  },
  {
    name: "views",
    usage: "[dir] [--changed [--base REF] [--head REF]]",
    help: ["List the views that can be drawn: layers, every module, every entry point.", "--changed: only the views of the files changed since the base (the merge-base without --base) at the head"],
    arity: 1,
    flags: [...REF_FLAGS, flag("changed")],
    async run(call) {
      const analysis = await analyze(call.dir(0));
      let views = viewList(analysis);

      if (call.has("changed")) {
        const refs = refsOf(call);
        const result = await review(call.dir(0), refs.base, refs.head, analysis);
        views = changedViews(analysis, views, result.diff.changedFiles);
        process.stderr.write(`${counted(result.diff.changedFiles.length, "file")} changed since ${shortCommits(result.diff.base)}\n`);
      }

      for (const view of views) process.stdout.write(`${view.key}\t${view.title}\n`);

      return 0;
    },
  },
  {
    name: "diagram",
    usage: "<view> [dir] [--format F] [--out FILE] [--base REF] [--head REF] [--heads A,B] [picture options]",
    help: [
      "Draw one view. F: md (Markdown with Mermaid, default), mermaid, json,",
      "drawio, excalidraw, archimate. Views (the table of kinds, view-keys.ts):",
      ...wrapped(viewSyntax().join(" | "), 88),
      "timeline and review take --base --head, compare --base --heads; logic:<path>#<fn> is the",
      "function's body as a flowchart, with its paths as rules; commit:<sha> is one commit's",
      "change against the commit before it. Every export names the commit it was drawn from.",
      "The picture options:",
      ...pictureOptionsHelp().map((line) => `  ${line}`),
    ],
    arity: 2,
    flags: [...OUTPUT_FLAGS, ...REF_FLAGS, flag("heads", true), ...pictureFlags().map((item) => flag(item.name, item.value))],
    async run(call) {
      const key = call.positional[0];

      if (!key) return fail("diagram: a view is required (archdiff views lists them)");
      const view = parseView(key);

      if (!view) return fail(`diagram: unknown view "${key}"`);
      const format = formatOf(call, "diagram");

      if (format === null) return 2;
      const picture = readPictureOptions((name) => call.flags.get(name), "flag");

      if (!picture.ok) return fail(`diagram: ${picture.problem.message}`);

      // The timeline reads the commits from --base to --head, a review and a comparison the revisions, the logic of a
      // function its file, --changes the review's marks: picture.ts reads them.
      return (await writePicture(call, "diagram", call.dir(1), view, picture.value.options, format)).code;
    },
  },
  {
    name: "metrics",
    usage: "[dir] [--layer NAME] [--types] [--json] [--out FILE]",
    help: ["Coupling and cohesion by module and by layer: Ca (modules importing it),", "Ce (modules it imports), instability I = Ce/(Ca+Ce), abstractness A,", "the distance from the main sequence D = |A+I-1| (the zone of pain: concrete", "and depended upon; the zone of uselessness: abstract and depending on all),", "and the cohesion of its functions (one group by calls and shared types: 1).", "--types counts type-only imports too; --layer keeps one layer's modules"],
    arity: 1,
    flags: [flag("layer", true), flag("types"), flag("json"), flag("out", true)],
    async run(call) {
      const analysis = await analyze(call.dir(0));
      const metrics = metricsOf(analysis, call.has("types"));
      const layer = call.text("layer");

      if (layer !== null && !analysis.graph.layers.includes(layer)) return fail(`metrics: no layer "${layer}"`);
      const modules = metrics.modules.filter((row) => layer === null || row.layer === layer).sort((a, b) => b.distance - a.distance || b.ca - a.ca || (a.id < b.id ? -1 : 1));
      const chosen = { modules, layers: layer === null ? metrics.layers : metrics.layers.filter((row) => row.name === layer) };

      if (call.has("json")) return writeOut(`${JSON.stringify(chosen, null, 2)}\n`, call.text("out"));
      const stamp = revisionStamp(analysis.root);

      return writeOut(`${[`<!-- archdiff:generated — metrics${stamp ? ` — commit ${stamp.commit} (${stamp.date})` : ""} -->`, `# Metrics: coupling and cohesion${layer ? ` of ${layer}` : ""}`, "", ...metricsMarkdown(chosen)].join("\n")}\n`, call.text("out"));
    },
  },
  {
    name: "drawings",
    aliases: ["layouts"],
    usage: "[dir] [--prune]",
    help: ["List the saved drawings (.archdiff/layouts/); --prune deletes those", "whose view the code no longer has (a renamed module, a removed function)"],
    arity: 1,
    flags: [flag("prune")],
    async run(call) {
      const root = call.dir(0);
      const analysis = await analyze(root);
      const directory = resolve(root, DRAWINGS_DIRECTORY);
      const files = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".json")).sort() : [];
      // A drawing lives while its view does: a view without a subject (a review, the layers), or one whose subject the
      // code still has — any view of it, not only those the views list names (an inside, a focus, a sequence).
      const lives = (key: string): boolean => {
        const view = parseView(key);

        return view !== null && (view.subject === null || viewOf(analysis, view, DEFAULT_PICTURE_OPTIONS, {}).missing !== true);
      };

      for (const name of files) {
        const saved = readDrawingFile(resolve(directory, name));
        const alive = saved !== null && lives(saved.view);
        const line = `${DRAWINGS_DIRECTORY}/${name}\t${saved ? saved.view : "(unreadable)"}\t${alive ? "ok" : "orphan"}`;

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
      if (!analysis.graph.nodes.has(view.subject)) return fail(`flow: no function "${view.subject}"`);
      const flow = dataFlow(analysis, view.subject, readDrawing(analysis.root, key!)?.mocks ?? [], depth);

      return writeOut(call.has("json") ? `${JSON.stringify(flow, null, 2)}\n` : flowMarkdown(flow), call.text("out"));
    },
  },
  {
    name: "run",
    usage: "<calls:view> [dir] [--input JSON] [--storages JSON] [--timeout MS] [--json] [--out FILE]",
    help: ["Run an entry point for real, with the storages mocked: the repository's own", "TypeScript or JavaScript runs in a child Node process (no writes, no child", "processes) with every function traced and the storage packages (a database", "client, node:fs, fetch) answering from the mocks. --input: the arguments by", "parameter name; --storages: what each storage holds, by package (\"node:fs\")", "or by the module importing it; the mocks saved on the page are used without", "them. Prints the functions entered against the predicted flow, the storage", "calls and the result"],
    arity: 2,
    flags: [flag("input", true), flag("storages", true), flag("timeout", true), flag("json"), flag("out", true)],
    async run(call) {
      const key = call.positional[0];
      const view = key ? parseView(key) : null;

      if (!view || view.kind !== "calls") return fail("run: a calls:<path>#<fn> view is required");
      const analysis = await analyze(call.dir(1));
      const parse = (name: string): Record<string, unknown> | null | undefined => {
        const text = call.text(name);

        if (text === null) return undefined;

        try {
          const value: unknown = JSON.parse(text);

          return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      };
      const input = parse("input");
      const storages = parse("storages");

      if (input === null) return fail("run: --input must be a JSON object");

      if (storages === null) return fail("run: --storages must be a JSON object");
      const timeout = call.has("timeout") ? Number(call.text("timeout")) : undefined;

      if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0)) return fail("run: --timeout must be milliseconds");
      const options: Parameters<typeof runFlow>[2] = { mocks: readDrawing(analysis.root, key!)?.mocks ?? [] };

      if (input) options.input = input;

      if (storages) options.storages = storages;

      if (timeout !== undefined) options.timeoutMs = timeout;
      const result = await runFlow(analysis, view.subject, options);

      if (!result.ok) return fail(`run: ${result.problem.message}`);
      const run = result.value;
      const written = writeOut(call.has("json") ? `${JSON.stringify(run, null, 2)}\n` : runMarkdown(run), call.text("out"));

      return written !== 0 ? written : run.error ? 1 : 0;
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
    name: "apis",
    usage: "[dir] [--json] [--out FILE]",
    help: ["The operations of an external API the code calls (SCAPI), by family, each", "with its contract as used: who calls it, what the code sends (the first", "argument, key by key) and reads of the result; the custom attributes read"],
    arity: 1,
    flags: [flag("json"), flag("out", true)],
    async run(call) {
      const analysis = await analyze(call.dir(0));

      return writeOut(call.has("json") ? `${JSON.stringify([...contractsOf(analysis).values()], null, 2)}\n` : contractsMarkdown(analysis), call.text("out"));
    },
  },
  {
    name: "postman",
    usage: "[dir] [--family NAME] [--out FILE]",
    help: ["A Postman collection (v2.1) of the SCAPI operations the code calls: a", "folder per family, a request per operation with the path the runtime", "declares, the parameters and the body the code sends; --family keeps one"],
    arity: 1,
    flags: [flag("family", true), flag("out", true)],
    async run(call) {
      const analysis = await analyze(call.dir(0));
      const family = call.text("family");
      const collection = postmanCollection(analysis, family);

      if (collection === null) return fail(`postman: the code calls no operation of "${family}" (archdiff apis lists the families)`);

      return writeOut(`${JSON.stringify(collection, null, 2)}\n`, call.text("out"));
    },
  },
  {
    name: "review",
    usage: "[dir] [--base REF] [--head REF] [--format F] [--out FILE]",
    help: ["The architectural diff of the working tree (or --head REF) against", "--base REF (default: where the head left develop, main or master): modules,", "imports and calls added, removed or changed, as Markdown with a Mermaid", "diagram (md, default), json (the diff), or any diagram format (the", "review view's picture). Exit 1 when a layer dependency appeared that", "ARCHITECTURE.md does not allow (any, without one)"],
    arity: 1,
    flags: [...REF_FLAGS, ...OUTPUT_FLAGS],
    async run(call) {
      const format = formatOf(call, "review");

      if (format === null) return 2;

      // `json` is the diff itself; the exit code says whether a layer dependency appeared against the contract.
      const { code, picture } = await writePicture(call, "review", call.dir(0), { kind: "review", subject: null }, DEFAULT_PICTURE_OPTIONS, format, ({ change }) => `${JSON.stringify(change?.kind === "review" ? change.diff : null, null, 2)}\n`);

      if (code !== 0 || picture?.change?.kind !== "review") return code;

      return reviewFindings(picture.change.diff, picture.change.contract).length > 0 ? 1 : 0;
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
    help: ["The architectural diff of several heads (branches, tags, commits; WORKTREE", "for the working tree) against one base (default: develop, main or master),", "each from where it left the base (their merge-base, as its pull request shows it):", "a table per head, one picture of what every head touched, marked by head"],
    arity: 1,
    flags: [flag("base", true), flag("heads", true), ...OUTPUT_FLAGS],
    async run(call) {
      const format = formatOf(call, "compare");

      if (format === null) return 2;

      const { code, picture } = await writePicture(call, "compare", call.dir(0), { kind: "compare", subject: null }, DEFAULT_PICTURE_OPTIONS, format, ({ change }) => `${JSON.stringify(change?.kind === "compare" ? { base: change.base, heads: change.heads } : null, null, 2)}\n`);

      if (code !== 0 || picture?.change?.kind !== "compare") return code;

      return picture.change.heads.some((head) => reviewFindings(head.diff, head.contract).length > 0) ? 1 : 0;
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
      const head = call.text("head") ?? "HEAD";
      const base = call.text("base") ?? mergeBase(root, head);
      const rows = await history(root, base, head);

      return writeOut(call.has("json") ? `${JSON.stringify(rows, null, 2)}\n` : historyMarkdown(rows, base, head), call.text("out"));
    },
  },
  {
    name: "new",
    usage: "<dir> [--lang ts|js] [--template blank|lib|cli|api|web] [--agent claude|cursor|codex|opencode] [--no-git]",
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

      if (agentFlag !== undefined && (typeof agentFlag !== "string" || !(agentFlag in AGENTS))) return fail("new: --agent must be claude, cursor, codex or opencode");
      let written: string[];

      try {
        written = scaffold(resolve(target), { lang, template: template as Template, agent: (agentFlag as AgentName | undefined) ?? null, git: !call.has("no-git") });
      } catch (error) {
        return fail(`new: ${error instanceof Error ? error.message : String(error)}`);
      }

      process.stdout.write(`${written.map((file) => `${target}/${file}`).join("\n")}\n`);
      process.stderr.write(`archdiff new: ${template} (${lang}) in ${resolve(target)}${call.has("no-git") ? "" : ", committed on main"}. Next: cd ${target} && npx @ivlad003/archdiff web (the Chat tab offers the agents installed here)\n`);

      return 0;
    },
  },
  {
    name: "import",
    usage: "<file> [dir] [--force]",
    help: ["A Markdown document with a Mermaid flowchart (a design note, an ISD, a", "tool's export) becomes ARCHITECTURE.md: subgraphs are layers, nodes are", "modules (the label is the path, then what it does), arrows are imports.", "An ARCHITECTURE.md that exists is kept unless --force"],
    arity: 2,
    flags: [flag("force")],
    async run(call) {
      const file = call.positional[0];

      if (!file) return fail("import: a Markdown file with a Mermaid flowchart is required");

      if (!existsSync(resolve(file))) return fail(`import: ${file} does not exist`);
      const root = call.dir(1);
      const intent = parseIntent(readFileSync(resolve(file), "utf8"));

      if (intent.modules.length === 0 && intent.layers.length === 0) return fail(`import: no Mermaid flowchart with layers or modules in ${file}`);

      // The contract is the reader's text too (its prose, its arrows): replaced only when asked.
      if (existsSync(resolve(root, INTENT_FILE)) && !call.has("force")) return fail(`import: ${INTENT_FILE} exists; --force replaces it with ${file}`);
      const wrote = writeIntent(root, intent);
      process.stderr.write(`archdiff import: ${counted(intent.layers.length, "layer")}, ${counted(intent.modules.length, "module")}, ${counted(intent.edges.length, "import")} → ${wrote}\n`);

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
        process.stderr.write(`archdiff intent: ${INTENT_FILE} written from the code (${counted(intent.layers.length, "layer")}, ${counted(intent.modules.length, "module")})\n`);
      }

      const key = call.text("view");

      if (key !== null) {
        const saved = readDrawing(analysis.root, key);

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
    usage: "[dir] [--json] [--prompt <view>|all|update] [--validate] [--tests [DIR]] [--out FILE]",
    help: ["The specification: list openspec/specs and features/; --prompt prints", "the task that has the agent write the spec of a view's subject (or of", "every layer, or review every spec); --validate runs the OpenSpec CLI;", "--tests writes a test skeleton per Gherkin scenario (tests/<feature>.test.ts,", "each test to do with its steps as comments; a file archdiff did not write is kept)"],
    arity: 1,
    flags: [flag("json"), flag("prompt", true), flag("validate"), flag("tests", "optional"), flag("out", true)],
    async run(call) {
      const analysis = await analyze(call.dir(0));

      if (call.has("tests")) {
        const target = call.text("tests") ?? "tests";
        const { written, skipped } = writeTestSkeletons(analysis.root, target);

        for (const file of written) process.stdout.write(`${file}\twritten\n`);

        for (const file of skipped) process.stdout.write(`${file}\tkept (not written by archdiff)\n`);
        process.stderr.write(`archdiff spec: ${written.length} test files written from ${FEATURES_DIRECTORY_NAME}/, ${skipped.length} kept\n`);

        return 0;
      }

      if (call.has("validate")) {
        const result = await validateSpecs(analysis.root);
        process.stdout.write(`${result.output}\n`);

        return result.ok ? 0 : 1;
      }

      const prompt = call.flags.get("prompt");

      if (prompt !== undefined) {
        if (prompt === true) return fail("spec: --prompt needs a view, all or update");
        const mode = prompt === "update" ? "update" : "generate";
        const view = prompt === "all" || prompt === "update" ? null : parseView(prompt);

        if (prompt !== "all" && prompt !== "update" && !view) return fail(`spec: unknown view "${prompt}"`);

        // A spec of a subject the code does not have would be a task about nothing.
        if (view && view.subject !== null && viewOf(analysis, view, DEFAULT_PICTURE_OPTIONS, {}).missing) return fail(`spec: ${viewOf(analysis, view, DEFAULT_PICTURE_OPTIONS, {}).reason ?? `no ${view.subject}`}`);

        return writeOut(specPrompt(analysis, mode, specSubject(view)), call.text("out"));
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

      if (!judgesLayers(analysis.intent)) {
        process.stderr.write(`archdiff check: ${INTENT_FILE} names no layer (no Mermaid flowchart with a subgraph, or a module in one): nothing to check against (archdiff intent --init --force)\n`);

        return 0;
      }

      const report = checkIntent(analysis, analysis.intent);
      const code = writeOut(call.has("json") ? `${JSON.stringify(report, null, 2)}\n` : checkMarkdown(report, analysis.root), call.text("out"));
      process.stderr.write(report.ok ? "archdiff check: the code follows the intent\n" : `archdiff check: ${report.violations.length} ${report.violations.length === 1 ? "import goes" : "imports go"} against the intent\n`);

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

      if (!key) return fail("plan: a view is required (archdiff views lists them)");

      if (!parseView(key)) return fail(`plan: unknown view "${key}" (archdiff views lists them)`);
      const analysis = await analyze(call.dir(1));
      const saved = readDrawing(analysis.root, key);

      if (!saved) return fail(`plan: ${key} has no saved drawing (draw and save it on the page first)`);
      const plan = planFromScene(analysis, key, saved.elements);

      return writeOut(call.has("json") ? `${JSON.stringify(plan, null, 2)}\n` : taskMarkdown(plan, analysis), call.text("out"));
    },
  },
  {
    name: "web",
    usage: "[dir] [--port N] [--host H] [--base REF] [--agent claude|cursor|codex|opencode] [--no-watch]",
    help: ["Serve the diagrams in a browser: views, the canvas, the code and the", "Markdown of a shape, the review against REF. The Chat tab hands a drawn", "task or a question to the coding agent picked there — Claude Code, Cursor,", "Codex or OpenCode, whichever is installed — run in this repository; every", "run starts from a button. --agent (or \"agent\" in archdiff.json) is the one", "picked first. The page reloads when a source file changes (--no-watch: it", "does not). Without --port: 7080, or the next free port above it when it is taken"],
    arity: 1,
    flags: [flag("port", true), flag("host", true), flag("base", true), flag("agent", true), flag("no-watch")],
    async run(call) {
      const port = call.has("port") ? Number(call.text("port")) : null;

      if (port !== null && (!Number.isInteger(port) || port < 0 || port > 65535)) return fail("web: --port must be a port number");
      const agentFlag = call.flags.get("agent");

      if (agentFlag === true) return fail("web: --agent needs claude, cursor, codex or opencode");
      const agent = typeof agentFlag === "string" ? agentFromConfig(agentFlag) : null;
      await serve(call.dir(0), { port, host: call.text("host") ?? "127.0.0.1", base: call.text("base"), agent, watch: !call.has("no-watch") });

      return 0;
    },
  },
];

const HELP_HEAD = `archdiff: live diagrams of a TypeScript, JavaScript, Python, Rust or PHP repository, and the architectural diff of a change

Usage: archdiff <command> [options] [dir]

Commands:
`;

/** The help, printed from the table: the usage of every command and its lines, aligned. */
export function helpText(): string {
  const lines: string[] = [];

  for (const command of COMMANDS) {
    lines.push(`  ${command.name} ${command.usage}${command.aliases ? `  (also: ${command.aliases.join(", ")})` : ""}`.trimEnd());

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

    // `-h` is help; any other word with one dash is a flag written short, which archdiff has none of.
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }

    if (/^-[^-]/.test(arg)) return { error: `${command?.name ?? "archdiff"}: unknown flag ${arg} (flags are written --name; archdiff --help lists them)` };

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

    const takes = known.get(name) ?? false;
    const next = argv[i + 1];

    // A flag of a value takes the next word, never the next flag: `--out --json` is an --out without its file.
    if (at !== -1) flags.set(name, arg.slice(at + 1));
    else if (takes === false) flags.set(name, true);
    else if (next !== undefined && !next.startsWith("--")) flags.set(name, argv[++i]!);
    else if (takes === "optional") flags.set(name, true);
    else return { error: `${command?.name ?? "archdiff"}: --${name} needs a value` };
  }

  const call: Call = {
    positional,
    flags,
    // A directory the call names must be one: a missing path is the call's mistake, not a scandir error.
    dir: (index) => {
      const dir = resolve(positional[index] ?? ".");

      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${command?.name ?? "archdiff"}: no directory ${positional[index] ?? "."}`);

      return dir;
    },
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
  const command = COMMANDS.find((candidate) => candidate.name === name || (name !== null && candidate.aliases?.includes(name))) ?? null;
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
