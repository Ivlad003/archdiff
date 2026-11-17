// The tools `archdiff mcp` serves a coding agent (the protocol is
// mcp.ts): the questions an agent has while it changes the code, each
// answered by what a command of the CLI computes, as text. `views` lists
// what can be drawn; `diagram` draws one view as Markdown with Mermaid,
// with the picture's options; `check` holds the code to ARCHITECTURE.md
// and `may_import` asks the contract about one import before it is
// written; `impact` names who depends on a module or a function and the
// tests that reach it; `review` is the architectural diff of the work so
// far. Every tool only reads: none changes the code, the contract or a
// drawing (the fact cache under .archdiff/ is written, as by any command).
//
// An answer is of the code as it is now: every call reads the analysis
// again (calls that come while one is being made share it; the fact cache
// keeps it fast), so the agent's own edits are in the next answer. A wrong argument — a
// view that does not exist, a depth that is no number, a ref git does not
// know — is refused with the message the CLI gives for it; the arguments
// of a picture are the one table of options (options.ts), read as the
// API's query reads them.
//
// Sits at the edge beside picture.ts and review.ts, which read git for
// it. Entry points: `archdiffTools`, `MCP_INSTRUCTIONS`.

import { analyze, type Analysis } from "./analyze.ts";
import { shortCommits } from "./diff.ts";
import { commitOf } from "./git.ts";
import { DEFAULT_IMPACT_DEPTH, impactMarkdown, impactOf } from "./impact.ts";
import { checkIntent, checkMarkdown, importVerdict, importVerdictText, INTENT_FILE, judgesLayers, nothingToCheck } from "./intent.ts";
import type { McpTool } from "./mcp.ts";
import { DEFAULT_PICTURE_OPTIONS, PICTURE_OPTIONS, readPictureOptions, type PictureOptions } from "./options.ts";
import { drawPicture, type Refs } from "./picture.ts";
import { ok, wrong, type Result } from "./result.ts";
import { analysisAt, reviewOf } from "./review.ts";
import { drawnAtHead, parseView, VIEW_KINDS, viewSyntax, viewsOfFiles } from "./view-keys.ts";
import { viewList } from "./views.ts";
import { counted } from "./words.ts";

/** What a client hands its model at the start: which tool answers which question, and when to ask. */
export const MCP_INSTRUCTIONS = `archdiff answers questions about the architecture of this repository from its code, read again at every call, so an answer follows your edits. Before you add an import across directories, ask may_import; before you change or remove a module or a function, ask impact (who depends on it, which tests reach it); to see how a part of the code hangs together without reading every file, ask diagram (views lists what it draws); after a change, ask check (the code against the contract in ${INTENT_FILE}) and review (what the change did to the architecture).`;

type Args = Readonly<Record<string, unknown>>;

/**
 * The working tree's analysis for a call: the calls that come while one is being made share it (an agent asks several
 * things in one turn), and the first call after it is made reads the code again — no timer decides how old an answer
 * may be, so a file edited between two calls is always in the second answer.
 */
function analysisPerCall(root: string): () => Promise<Analysis> {
  let making: Promise<Analysis> | null = null;

  return () => {
    if (making) return making;
    const made = analyze(root).finally(() => {
      if (making === made) making = null;
    });
    making = made;

    return made;
  };
}

/** A text argument: null when absent; anything but a string is the call's problem. */
function textOf(tool: string, args: Args, name: string): Result<string | null> {
  const value = args[name];

  if (value === undefined || value === null) return ok(null);

  return typeof value === "string" ? ok(value) : wrong(`${tool}: "${name}" must be a string`);
}

/** A revision an argument names (a branch, a tag, a commit): one git does not know is refused by name, as the CLI refuses it; outside a repository git's refusal is thrown. */
function knownRef(root: string, ref: string): Result<string> {
  if (ref === "" || ref.startsWith("-")) return wrong(`not a git ref: "${ref}"`);

  return commitOf(root, ref) === null ? wrong(`no branch, tag or commit "${ref}" (archdiff branches lists the branches)`) : ok(ref);
}

/** The revisions of a call — `base`, `head`, and `heads` for a comparison (a list, or one text with commas; `WORKTREE` is the working tree) — each known to git. */
function refsOf(root: string, tool: string, args: Args): Result<Refs> {
  const refs: { base: string | null; head: string | null } = { base: null, head: null };

  for (const name of ["base", "head"] as const) {
    const text = textOf(tool, args, name);

    if (!text.ok) return text;

    if (text.value === null) continue;
    const known = knownRef(root, text.value);

    if (!known.ok) return known;
    refs[name] = known.value;
  }

  const given = args["heads"];
  const heads = given === undefined || given === null ? [] : typeof given === "string" ? given.split(",").filter((head) => head !== "") : given;

  if (!Array.isArray(heads) || !heads.every((head): head is string => typeof head === "string")) return wrong(`${tool}: "heads" must be a list of branches, tags or commits`);

  for (const head of heads) {
    const known = head === "WORKTREE" ? ok(head) : knownRef(root, head);

    if (!known.ok) return known;
  }

  return ok({ ...refs, heads });
}

type OptionSpec = (typeof PICTURE_OPTIONS)[number];

/** The options of a picture as the properties of a JSON Schema, from the one table of them: a whole number, a yes or no, a list, one of a few words. */
function optionProperties(): Record<string, object> {
  const schema = (spec: OptionSpec): object => {
    if (spec.type === "int") return { type: "integer", minimum: spec.min, description: spec.help };

    if (spec.type === "bool") return { type: "boolean", description: `${spec.help} (default ${spec.default})` };

    if (spec.type === "enum") return { type: "string", enum: [...spec.values], description: spec.help };

    return { type: "array", items: spec.type === "enum-list" ? { type: "string", enum: [...spec.values] } : { type: "string" }, description: spec.help };
  };

  return Object.fromEntries(PICTURE_OPTIONS.map((spec) => [spec.param, schema(spec)]));
}

/** What an option's value must be, for the message of one that is not. */
function expected(spec: OptionSpec): string {
  if (spec.type === "int") return "a whole number";

  if (spec.type === "bool") return "true or false";

  return spec.type === "enum" ? `one of ${spec.values.join(", ")}` : "a list of strings";
}

/**
 * An option's value as the API's query writes it, which `readPictureOptions` reads: yes and no as 1 and 0, a number
 * as its digits, a list joined by commas (`none` when empty); a text is taken as written. Null for a value of a
 * type the option does not take.
 */
function asParam(spec: OptionSpec, value: unknown): string | null {
  if (typeof value === "string") return value;

  if (spec.type === "bool") return typeof value === "boolean" ? (value ? "1" : "0") : null;

  if (spec.type === "int") return typeof value === "number" ? String(value) : null;

  if (spec.type === "enum" || !Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;

  return value.length > 0 ? value.join(",") : "none";
}

/** The options of a picture from the arguments of a call, by the names the API's query gives them (`depth`, `limit`, `overlay`, `hide`, …). */
function optionsOf(tool: string, args: Args): Result<PictureOptions> {
  const params = new Map<string, string>();

  for (const spec of PICTURE_OPTIONS) {
    const value = args[spec.param];

    if (value === undefined || value === null) continue;
    const param = asParam(spec, value);

    if (param === null) return wrong(`${tool}: ${spec.param} must be ${expected(spec)}`);
    params.set(spec.param, param);
  }

  const read = readPictureOptions((name) => params.get(name), "param");

  return read.ok ? ok(read.value.options) : wrong(`${tool}: ${read.problem.message}`);
}

const REF_PROPERTIES = {
  base: { type: "string", description: "the revision a change is measured from: a branch, a tag or a commit (default: where the head left develop, main or master)" },
  head: { type: "string", description: "the revision to read instead of the working tree: a branch, a tag or a commit" },
};

/** The tools on the repository at `root`. */
export function archdiffTools(root: string): McpTool[] {
  const fresh = analysisPerCall(root);
  const tool = (name: string, title: string, description: string, properties: Record<string, object>, required: string[], call: McpTool["call"]): McpTool => ({ name, title, description, inputSchema: required.length > 0 ? { type: "object", properties, required, additionalProperties: false } : { type: "object", properties, additionalProperties: false }, readOnly: true, call });

  return [
    tool(
      "views",
      "List the views",
      "List what `diagram` can draw of this repository, one view per line as `key<TAB>title`: the layers, every layer, directory and module, the call tree of every entry point, the types, and the overviews (cycles, matrix, metrics, coverage, tests and more). `kind` keeps the views of one kind; `changed` keeps the views of the files changed since `base`.",
      {
        kind: { type: "string", description: `keep the views of one kind: ${Object.keys(VIEW_KINDS).join(", ")}` },
        changed: { type: "boolean", description: "keep the views of the files changed since the base (and the overviews)" },
        ...REF_PROPERTIES,
      },
      [],
      async (args) => {
        const kind = textOf("views", args, "kind");
        const base = textOf("views", args, "base");
        const head = textOf("views", args, "head");

        if (!kind.ok) return kind;

        if (!base.ok) return base;

        if (!head.ok) return head;

        if (kind.value !== null && !Object.hasOwn(VIEW_KINDS, kind.value)) return wrong(`views: unknown kind "${kind.value}" (${Object.keys(VIEW_KINDS).join(", ")})`);
        const changed = args["changed"] ?? false;

        if (typeof changed !== "boolean") return wrong("views: changed must be true or false");
        const analysis = await fresh();
        let views = viewList(analysis);
        const notes: string[] = [];

        if (changed) {
          try {
            const result = await reviewOf(analysis, base.value, head.value);
            views = viewsOfFiles(views, new Set(result.diff.changedFiles));
            notes.push(`${counted(result.diff.changedFiles.length, "file")} changed since ${shortCommits(result.diff.base)}`);
          } catch (error) {
            // Outside git, or a bad ref: every view, and why the changed files could not be told apart — as the CLI lists them.
            notes.push(`the changed files could not be told apart: ${error instanceof Error ? error.message : String(error)}; every view listed`);
          }
        }

        return ok(`${[...notes, ...views.filter((view) => kind.value === null || view.kind === kind.value).map((view) => `${view.key}\t${view.title}`)].join("\n")}\n`);
      },
    ),
    tool(
      "diagram",
      "Draw a view",
      "Draw one view of the code as Markdown: a Mermaid diagram and the list of its shapes with their files and lines. What a module imports and what imports it (`module:<path>`), what a function calls step by step (`calls:<path>#<fn>`), a layer's modules (`layer:<name>`), the import cycles (`cycles`), the layers (`layers`) and the rest `views` lists. Ask it to learn how a part of the code hangs together without reading every file.",
      {
        view: { type: "string", description: `the key of the view, as \`views\` lists it: ${viewSyntax().join(" | ")}` },
        ...REF_PROPERTIES,
        heads: { type: "array", items: { type: "string" }, description: "the heads of a `compare` view: branches, tags or commits, `WORKTREE` for the working tree" },
        ...optionProperties(),
      },
      ["view"],
      async (args) => {
        const key = textOf("diagram", args, "view");

        if (!key.ok) return key;

        if (key.value === null || key.value === "") return wrong("diagram: a view is required (archdiff views lists them)");
        const view = parseView(key.value);

        if (!view) return wrong(`diagram: unknown view "${key.value}"`);
        const options = optionsOf("diagram", args);

        if (!options.ok) return options;
        const refs = refsOf(root, "diagram", args);

        if (!refs.ok) return refs;
        // `head` on a view that is no change draws the code at that revision, read from git without a checkout.
        const analysis = drawnAtHead(view.kind) && refs.value.head ? await analysisAt(root, refs.value.head) : await fresh();
        const picture = await drawPicture(analysis, { view, options: options.value, refs: refs.value });

        // A missing subject: the reason, and where the subjects are listed, unless the reason says so already (a machine's).
        if (picture.diagram.missing) {
          const reason = picture.diagram.reason ?? "";

          return wrong(`diagram: ${reason}${/ lists them\)$/.test(reason) ? "" : " (archdiff views lists them)"}`);
        }

        return ok(picture.markdown);
      },
    ),
    tool(
      "check",
      "Check the code against the contract",
      `Hold the code as it is now to the contract in ${INTENT_FILE}: the imports between layers the contract does not allow (the violations, each with its file and line), what is planned and not built, what is built beyond it. Ask it after adding a module or an import.`,
      {},
      [],
      async () => {
        const analysis = await fresh();

        return ok(judgesLayers(analysis.intent) ? checkMarkdown(checkIntent(analysis, analysis.intent), analysis.root) : `${nothingToCheck(analysis.intent)}\n`);
      },
    ),
    tool(
      "may_import",
      "Ask the contract about an import",
      `Whether the contract in ${INTENT_FILE} lets one module import another, asked before the import is written: the layer of each, allowed or not, and for a forbidden import the layers the importer may use instead. Each end is a file's path (one not written yet is placed by its path) or a layer's name.`,
      {
        from: { type: "string", description: "the importing module: its path (`src/views.ts`), or a layer's name" },
        to: { type: "string", description: "the imported module: its path, or a layer's name" },
      },
      ["from", "to"],
      async (args) => {
        const from = textOf("may_import", args, "from");
        const to = textOf("may_import", args, "to");

        if (!from.ok) return from;

        if (!to.ok) return to;

        if (!from.value || !to.value) return wrong("may_import: from and to are required: a module's path or a layer's name each");
        const analysis = await fresh();

        return ok(judgesLayers(analysis.intent) ? importVerdictText(importVerdict(analysis, analysis.intent, from.value, to.value)) : `Not judged: ${nothingToCheck(analysis.intent)}.\n`);
      },
    ),
    tool(
      "impact",
      "Who depends on it",
      "Who depends on a module or a function: the modules importing it and the functions calling it, and who imports and calls those, up to `depth` steps away, with the file and line of each; and every test file that reaches it, however far. Ask it before changing or removing something, to know what the change can break and which tests to run.",
      {
        target: { type: "string", description: "a module by its path (`src/db/store.ts`) or a function, class or type by its ID (`src/db/store.ts#saveOrder`, `src/lib/orders.ts#OrderService.place`)" },
        depth: { type: "integer", minimum: 1, description: `how many steps up the imports and the calls the lists go (default ${DEFAULT_IMPACT_DEPTH}); the tests are found at any distance` },
      },
      ["target"],
      async (args) => {
        const target = textOf("impact", args, "target");

        if (!target.ok) return target;

        if (!target.value) return wrong("impact: a target is required: a module's path or a function's <path>#<name> (archdiff views lists them)");
        const given = args["depth"] ?? DEFAULT_IMPACT_DEPTH;
        const depth = typeof given === "string" && given.trim() !== "" ? Number(given) : given;

        if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) return wrong("impact: depth must be a whole number of at least 1");
        const analysis = await fresh();
        // A view's key names its subject as surely: `module:src/x.ts`, `calls:src/x.ts#f`.
        const impact = impactOf(analysis.graph, target.value, depth) ?? impactOf(analysis.graph, parseView(target.value)?.subject ?? "", depth);

        return impact ? ok(impactMarkdown(impact)) : wrong(`impact: no module or function "${target.value}" (archdiff views lists them)`);
      },
    ),
    tool(
      "review",
      "Review the change",
      `The architectural diff of the working tree (or \`head\`) against \`base\`: the modules, functions, imports and calls added, removed or changed, and the new dependencies between layers, each marked when ${INTENT_FILE} does not allow it — as Markdown with a Mermaid diagram of the change. Ask it when a piece of work is done, to see what it did to the architecture.`,
      REF_PROPERTIES,
      [],
      async (args) => {
        const refs = refsOf(root, "review", args);

        if (!refs.ok) return refs;

        return ok((await drawPicture(await fresh(), { view: { kind: "review", subject: null }, options: DEFAULT_PICTURE_OPTIONS, refs: refs.value })).markdown);
      },
    ),
  ];
}
