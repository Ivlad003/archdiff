// What the commands of the Chat tab do on the page: the table of
// src/chat-commands.ts names them once — for the help, the suggestions and
// the agent's protocol — and here each one is the few lines that do it,
// through what the page already has: the link (a view, its options, how it
// is shown, the refs), the tools of the toolbar, the panels, the selection,
// the search of the code and of the change, the downloads, and the Chat
// tab's own buttons. A command answers in a line of Markdown the transcript
// shows; what cannot be done is thrown, with the reason, and shown there.
//
// A command an agent wrote in its answer is run the same, when the table
// lets an agent run it: the ones that show something, never one that
// writes a drawing, picks an agent or starts a run.
//
// Entry point: `runCommandLine` (bound to the page's context by app.ts, so
// that chat.ts reaches it without importing what imports chat.ts).

import { api, type ViewEntry } from "./api.ts";
import { setMode } from "./canvas.ts";
import { agentCommand, askAgent, pickAgent, runChecksNow, stopRun } from "./chat.ts";
import { element } from "./dom.ts";
import { showPanel, toggleFullCanvas } from "./layout.ts";
import { currentLink, detailPresets, PRESENTATIONS, PRESETS, refsOf, setLink, type Detail, type Link, type Presentation } from "./link.ts";
import { page } from "./page.ts";
import { select } from "./picking.ts";
import { toggleSplit, toggleTool } from "./toolbar.ts";
import { commandsHelp, parseCommandLine } from "../../src/chat-commands.ts";
import { OVERLAYS } from "../../src/options.ts";
import { parseView } from "../../src/view-keys.ts";

/** What a command is asked to do with: the words after its name. */
type Handler = (argument: string) => Promise<string> | string;

/** The formats a picture downloads in. */
const FORMATS = ["md", "mermaid", "json", "drawio", "excalidraw", "archimate"];

const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

/** The words of an argument: apart at spaces and commas. */
function words(argument: string): string[] {
  return argument.split(/[\s,]+/).filter((word) => word !== "");
}

/** Opens the link changed by `change`, and says `said`. */
function open(change: Partial<Link>, said: string): string {
  setLink({ ...currentLink(), ...change });

  return said;
}

/** One of `allowed`, as the argument names it; thrown with the choices when it names none. */
function oneOf<T extends string>(argument: string, allowed: readonly T[], what: string): T {
  const named = allowed.find((each) => each === argument.trim().toLowerCase());

  if (!named) throw new Error(`${what}: one of ${allowed.join(", ")}`);

  return named;
}

/** A whole number of an argument, or null for `auto` (the view's own); thrown for anything else. */
function numberOr(argument: string, what: string, least: number): number | null {
  if (argument === "" || argument === "auto") return null;
  const value = Number(argument);

  if (!Number.isInteger(value) || value < least) throw new Error(`${what}: a whole number of at least ${least}, or auto`);

  return value;
}

function onOff(argument: string, what: string): boolean {
  return oneOf(argument || "on", ["on", "off"], what) === "on";
}

/** The views whose key or title has every word of `text`: the one whose key is the text first. */
function viewsNamed(text: string): ViewEntry[] {
  const asked = words(text.toLowerCase());
  const all = page.views();
  const exact = all.filter((entry) => entry.key === text.trim());

  return exact.length > 0 ? exact : all.filter((entry) => asked.every((word) => `${entry.key} ${entry.title}`.toLowerCase().includes(word)));
}

/** The key of the view `text` names — a key as it is, or the one view whose title has its words; thrown with the candidates when it names none or several. */
function viewKey(text: string, kind: string | null = null): string {
  const written = text.trim();

  if (written === "") throw new Error("which view? Its key (`layers`, `module:src/x.ts`), or words of its title");
  const prefixed = kind && !written.startsWith(`${kind}:`) ? `${kind}:${written}` : written;
  const candidates = viewsNamed(written).filter((entry) => kind === null || entry.key.startsWith(`${kind}:`));

  // A key of the list, or one written whole (a subject the list folds away is a view all the same).
  if (candidates.some((entry) => entry.key === prefixed)) return prefixed;

  if (candidates.length === 1) return candidates[0]!.key;

  if (candidates.length === 0 && parseView(prefixed) && (prefixed.includes(":") || kind === null)) return prefixed;

  if (candidates.length === 0) throw new Error(`no view has "${written}" in its key or its title`);

  throw new Error(`"${written}" names ${candidates.length} views — be more exact: ${candidates.slice(0, 8).map((entry) => entry.key).join(", ")}${candidates.length > 8 ? ", …" : ""}`);
}

/** The module `text` names: its path, or the one module whose path has the text. */
function moduleNamed(text: string): string {
  const paths = page.views().filter((entry) => entry.key.startsWith("module:")).map((entry) => entry.key.slice("module:".length));
  const found = paths.includes(text) ? [text] : paths.filter((path) => path.toLowerCase().includes(text.toLowerCase()));

  if (found.length === 1) return found[0]!;

  throw new Error(found.length === 0 ? `no module has "${text}" in its path` : `"${text}" names ${found.length} modules: ${found.slice(0, 8).join(", ")}${found.length > 8 ? ", …" : ""}`);
}

/** The shapes of the picture a word names: by their ID, or by their label. */
function shapesNamed(word: string): string[] {
  const nodes = [...page.nodes().values()];
  const lowered = word.toLowerCase();
  const exact = nodes.filter((node) => node.id === word || node.label.split("\n")[0]!.toLowerCase() === lowered);

  return (exact.length > 0 ? exact : nodes.filter((node) => node.id.toLowerCase().includes(lowered) || node.label.toLowerCase().includes(lowered))).map((node) => node.id);
}

/** The shapes that stand for the files given, to light on the picture. */
function shapesOfFiles(files: ReadonlySet<string>): string[] {
  return [...page.nodes().values()].filter((node) => node.ref?.file !== undefined && files.has(node.ref.file)).map((node) => node.id);
}

/** A search of the code, or of the change: its list for the transcript, the shapes of the files found lit on the picture. */
async function search(pattern: string, inChange: boolean): Promise<string> {
  if (pattern === "") throw new Error("what to search for? A text, or a regular expression between slashes");
  const link = currentLink();
  const found = await api.grep(pattern, inChange, link.view, link, refsOf(link));
  const lit = shapesOfFiles(new Set(found.matches.map((match) => match.file)));

  if (lit.length > 0) page.canvas()?.highlight(lit);

  return lit.length > 0 ? `${found.markdown}\n\n${lit.length === 1 ? "The shape of that file is" : `The ${lit.length} shapes of those files are`} lit on the picture.` : found.markdown;
}

const HANDLERS: Record<string, Handler> = {
  help: (argument) => {
    const help = commandsHelp(argument === "" ? null : argument);

    if (help === null) throw new Error(`no command "${argument}" (/help lists them)`);

    return help;
  },
  view: (argument) => {
    const key = viewKey(argument);

    return open({ view: key }, `Opened ${code(key)}.`);
  },
  back: () => {
    history.back();

    return "Back to the view before.";
  },
  as: (argument) => {
    const name = oneOf(argument, PRESENTATIONS.map((each) => each.name) as Presentation[], "as");

    return open({ as: name }, `The view is shown as ${name === "canvas" ? "the canvas" : name === "3d" ? "a 3D scene" : name === "markdown" ? "its page" : "the code of its subject"}.`);
  },
  detail: (argument) => {
    const name = oneOf(argument, ["minimal", "normal", "full"] as Detail[], "detail");

    return open(detailPresets(currentLink().view)[name], `The detail is ${name}.`);
  },
  depth: (argument) => {
    const depth = numberOr(argument, "depth", 0);

    return open({ depth }, depth === null ? "The depth is the view's own." : `The picture goes ${depth} ${depth === 1 ? "step" : "steps"} from its subject.`);
  },
  limit: (argument) => {
    const limit = numberOr(argument, "limit", 1);

    return open({ limit }, limit === null ? "The fold limit is the view's own." : `More than ${limit} shapes fold by directory.`);
  },
  weight: (argument) => {
    const weight = numberOr(argument, "weight", 1);

    return open({ weight }, weight === null ? "Every line is drawn." : `Lines of fewer than ${weight} imports or calls are left out.`);
  },
  hubs: (argument) => {
    const hubs = onOff(argument, "hubs");

    return open({ hubs }, hubs ? "Hubs are badges." : "Hubs are drawn with their lines.");
  },
  packages: (argument) => {
    const packages = onOff(argument, "packages");

    return open({ packages }, packages ? "The packages are drawn." : "The packages are left out.");
  },
  overlay: (argument) => {
    const asked = words(argument.toLowerCase());
    const overlays = asked.length === 0 || asked[0] === "none" ? [] : asked.map((each) => oneOf(each, OVERLAYS, "overlay"));

    return open({ overlays }, overlays.length === 0 ? "No overlay." : `Laid over the picture: ${overlays.join(", ")}.`);
  },
  changes: (argument) => {
    const changes = onOff(argument, "changes");

    return open({ changes }, changes ? "The changes since the base are laid over the picture." : "The changes are taken off the picture.");
  },
  changed: (argument) => {
    const changed = onOff(argument, "changed");

    return open({ changed }, changed ? "Only the files changed since the base are kept." : "Every file is back.");
  },
  preset: (argument) => {
    const name = oneOf(argument, Object.keys(PRESETS), "preset");

    return open(PRESETS[name]!, `The options are the ${name}'s.`);
  },
  mix: (argument) => {
    const modules = words(argument).map(moduleNamed);

    if (modules.length === 0) throw new Error("which modules? Their paths, or a part of each");
    const expand = [...new Set([...currentLink().expand, ...modules])];

    return open({ expand }, `Opened in place: ${modules.map(code).join(", ")}.`);
  },
  unmix: () => open({ expand: [] }, "The modules opened in place are closed."),
  lanes: (argument) => {
    const lanes = oneOf(argument, ["rows", "columns"], "lanes");

    return open({ lanes }, `The lanes are ${lanes}.`);
  },
  select: (argument) => {
    const ids = [...new Set(words(argument).flatMap(shapesNamed))];

    if (ids.length === 0) throw new Error(`no shape of this picture is named ${code(argument)}`);
    select(ids, true);

    return `Picked ${ids.length === 1 ? code(ids[0]!) : `${ids.length} shapes`}.`;
  },
  find: (argument) => {
    const field = element<HTMLInputElement>("find");
    field.value = argument;
    field.dispatchEvent(new Event("input"));
    const hits = shapesNamed(argument).length;

    return argument === "" ? "The find is cleared." : `${hits === 0 ? "No shape" : hits === 1 ? "One shape" : `${hits} shapes`} of the picture ${hits === 1 ? "has" : "have"} ${code(argument)} in ${hits === 1 ? "its" : "their"} name.`;
  },
  grep: (argument) => search(argument, false),
  diff: (argument) => search(argument, true),
  review: (argument) => {
    const [base, head] = words(argument);

    if (base !== undefined) element<HTMLInputElement>("base").value = base;

    return open({ view: "review", head: head ?? currentLink().head }, `The review of ${head ?? currentLink().head ?? "the working tree"} against ${base ?? "the base"}.`);
  },
  compare: (argument) => {
    const heads = words(argument);

    if (heads.length < 2) throw new Error("compare: two or more heads (branches, tags, commits; WORKTREE is the working tree)");

    return open({ view: "compare", heads }, `Comparing ${heads.map(code).join(", ")}.`);
  },
  commit: (argument) => {
    if (!/^[0-9a-f]{4,40}$/i.test(argument)) throw new Error("commit: a commit's hash, or its first characters");

    return open({ view: `commit:${argument}` }, `The change of commit ${code(argument)}.`);
  },
  board: () => open({ view: "changes" }, "The uncommitted changes."),
  impact: (argument) => {
    if (argument === "") throw new Error("impact: a module (src/x.ts) or a function (src/x.ts#fn)");
    // A path or a function as written; a word is the one module whose path has it.
    const key = `impact:${argument.includes("/") || argument.includes("#") ? argument : moduleNamed(argument)}`;

    return open({ view: key }, `What a change to ${code(key.slice("impact:".length))} reaches.`);
  },
  logic: (argument) => {
    const key = viewKey(argument, "logic");

    return open({ view: key }, `The logic of ${code(key.slice("logic:".length))}.`);
  },
  export: (argument) => {
    const format = oneOf(argument, FORMATS, "export");
    const link = currentLink();
    const anchor = Object.assign(document.createElement("a"), { href: api.exportUrl(link.view, format, link, refsOf(link)), download: "" });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    return `The picture is downloaded as ${format}.`;
  },
  split: (argument) => {
    if (argument === "off") {
      toggleSplit(false);

      return "One picture again.";
    }

    // The second picture is the page itself, embedded: another view is its link.
    const key = argument === "" ? currentLink().view : viewKey(argument);
    toggleSplit(true);
    element<HTMLIFrameElement>("split-frame").src = `${location.pathname}?embed=1#view=${encodeURIComponent(key)}`;

    return `Beside this picture: ${code(key)}.`;
  },
  dim: () => {
    toggleTool("dim");

    return "The dim tool is switched.";
  },
  full: () => {
    toggleFullCanvas();

    return "The full canvas is switched.";
  },
  panel: (argument) => {
    showPanel(oneOf(argument, ["left", "right"], "panel"));

    return `The ${argument} panel is switched.`;
  },
  edit: () => {
    setMode("edit");

    return "Drawing: the pencil and the shapes are yours.";
  },
  done: () => {
    setMode("view");

    return "Back to reading.";
  },
  ask: (argument) => {
    if (argument === "") throw new Error("ask: a question");
    askAgent(argument);

    return "";
  },
  agent: (argument) => pickAgent(argument),
  stop: () => (stopRun() ? "The run is being stopped." : "No run is going."),
  check: async () => {
    await runChecksNow();

    return "";
  },
  code: async () => {
    await agentCommand("code", "");

    return "";
  },
  diagram: async (argument) => {
    await agentCommand("diagram", argument);

    return "";
  },
  doc: async (argument) => {
    await agentCommand("doc", argument);

    return "";
  },
  settings: () => {
    element<HTMLButtonElement>("settings-open").click();

    return "";
  },
};

/**
 * Runs one command line (`/view layers`) for the reader, or for an agent that wrote it in its answer, and gives
 * what it says of itself as Markdown (nothing, for a command that speaks through the page). Thrown: a line that is
 * no command, a command an agent may not run, an argument the command cannot take.
 */
export async function runCommandLine(line: string, by: "reader" | "agent"): Promise<string> {
  const parsed = parseCommandLine(line);

  if (!parsed) throw new Error(`${code(line.trim().split(/\s/)[0] ?? line)} is no command (/help lists them)`);

  if (by === "agent" && !parsed.command.agent) throw new Error(`/${parsed.command.name} is the reader's to run, not an agent's`);

  return HANDLERS[parsed.command.name]!(parsed.argument);
}
