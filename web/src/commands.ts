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
import { t, translated } from "./i18n.ts";
import { showPanel, toggleFullCanvas } from "./layout.ts";
import { currentLink, detailPresets, PRESENTATIONS, PRESETS, refsOf, setLink, type Detail, type Link, type Presentation } from "./link.ts";
import { page } from "./page.ts";
import { explainSelected, select, showPath } from "./picking.ts";
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

  if (!named) throw new Error(t("{what}: one of {allowed}", { what, allowed: allowed.join(", ") }));

  return named;
}

/** A whole number of an argument, or null for `auto` (the view's own); thrown for anything else. */
function numberOr(argument: string, what: string, least: number): number | null {
  if (argument === "" || argument === "auto") return null;
  const value = Number(argument);

  if (!Number.isInteger(value) || value < least) throw new Error(t("{what}: a whole number of at least {least}, or auto", { what, least }));

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

  if (written === "") throw new Error(t("which view? Its key (`layers`, `module:src/x.ts`), or words of its title"));
  const prefixed = kind && !written.startsWith(`${kind}:`) ? `${kind}:${written}` : written;
  const candidates = viewsNamed(written).filter((entry) => kind === null || entry.key.startsWith(`${kind}:`));

  // A key of the list, or one written whole (a subject the list folds away is a view all the same).
  if (candidates.some((entry) => entry.key === prefixed)) return prefixed;

  if (candidates.length === 1) return candidates[0]!.key;

  if (candidates.length === 0 && parseView(prefixed) && (prefixed.includes(":") || kind === null)) return prefixed;

  if (candidates.length === 0) throw new Error(t("no view has \"{written}\" in its key or its title", { written }));

  throw new Error(t("\"{written}\" names {count} views — be more exact: {keys}", { written, count: candidates.length, keys: `${candidates.slice(0, 8).map((entry) => entry.key).join(", ")}${candidates.length > 8 ? ", …" : ""}` }));
}

/** The module `text` names: its path, or the one module whose path has the text. */
function moduleNamed(text: string): string {
  const paths = page.views().filter((entry) => entry.key.startsWith("module:")).map((entry) => entry.key.slice("module:".length));
  const found = paths.includes(text) ? [text] : paths.filter((path) => path.toLowerCase().includes(text.toLowerCase()));

  if (found.length === 1) return found[0]!;

  throw new Error(found.length === 0 ? t("no module has \"{text}\" in its path", { text }) : t("\"{text}\" names {count} modules: {paths}", { text, count: found.length, paths: `${found.slice(0, 8).join(", ")}${found.length > 8 ? ", …" : ""}` }));
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
  if (pattern === "") throw new Error(t("what to search for? A text, or a regular expression between slashes"));
  const link = currentLink();
  const found = await api.grep(pattern, inChange, link.view, link, refsOf(link));
  const lit = shapesOfFiles(new Set(found.matches.map((match) => match.file)));

  if (lit.length > 0) page.canvas()?.highlight(lit);

  return lit.length > 0 ? `${found.markdown}\n\n${lit.length === 1 ? t("The shape of that file is lit on the picture.") : t("The {count} shapes of those files are lit on the picture.", { count: lit.length })}` : found.markdown;
}

const HANDLERS: Record<string, Handler> = {
  help: (argument) => {
    const help = commandsHelp(argument === "" ? null : argument, translated);

    if (help === null) throw new Error(t("no command \"{argument}\" (/help lists them)", { argument }));

    return help;
  },
  view: (argument) => {
    const key = viewKey(argument);

    return open({ view: key }, t("Opened {key}.", { key: code(key) }));
  },
  back: () => {
    history.back();

    return t("Back to the view before.");
  },
  as: (argument) => {
    const name = oneOf(argument, PRESENTATIONS.map((each) => each.name) as Presentation[], "as");

    return open({ as: name }, name === "canvas" ? t("The view is shown as the canvas.") : name === "3d" ? t("The view is shown as a 3D scene.") : name === "markdown" ? t("The view is shown as its page.") : t("The view is shown as the code of its subject."));
  },
  detail: (argument) => {
    const name = oneOf(argument, ["minimal", "normal", "full"] as Detail[], "detail");

    return open(detailPresets(currentLink().view)[name], t("The detail is {name}.", { name }));
  },
  depth: (argument) => {
    const depth = numberOr(argument, "depth", 0);

    return open({ depth }, depth === null ? t("The depth is the view's own.") : depth === 1 ? t("The picture goes {depth} step from its subject.", { depth }) : t("The picture goes {depth} steps from its subject.", { depth }));
  },
  limit: (argument) => {
    const limit = numberOr(argument, "limit", 1);

    return open({ limit }, limit === null ? t("The fold limit is the view's own.") : t("More than {limit} shapes fold by directory.", { limit }));
  },
  weight: (argument) => {
    const weight = numberOr(argument, "weight", 1);

    return open({ weight }, weight === null ? t("Every line is drawn.") : t("Lines of fewer than {weight} imports or calls are left out.", { weight }));
  },
  hubs: (argument) => {
    const hubs = onOff(argument, "hubs");

    return open({ hubs }, hubs ? t("Hubs are badges.") : t("Hubs are drawn with their lines."));
  },
  packages: (argument) => {
    const packages = onOff(argument, "packages");

    return open({ packages }, packages ? t("The packages are drawn.") : t("The packages are left out."));
  },
  overlay: (argument) => {
    const asked = words(argument.toLowerCase());
    const overlays = asked.length === 0 || asked[0] === "none" ? [] : asked.map((each) => oneOf(each, OVERLAYS, "overlay"));

    return open({ overlays }, overlays.length === 0 ? t("No overlay.") : t("Laid over the picture: {overlays}.", { overlays: overlays.join(", ") }));
  },
  changes: (argument) => {
    const changes = onOff(argument, "changes");

    return open({ changes }, changes ? t("The changes since the base are laid over the picture.") : t("The changes are taken off the picture."));
  },
  changed: (argument) => {
    const changed = onOff(argument, "changed");

    return open({ changed }, changed ? t("Only the files changed since the base are kept.") : t("Every file is back."));
  },
  preset: (argument) => {
    const name = oneOf(argument, Object.keys(PRESETS), "preset");

    return open(PRESETS[name]!, t("The options are the {name}'s.", { name }));
  },
  mix: (argument) => {
    const modules = words(argument).map(moduleNamed);

    if (modules.length === 0) throw new Error(t("which modules? Their paths, or a part of each"));
    const expand = [...new Set([...currentLink().expand, ...modules])];

    return open({ expand }, t("Opened in place: {modules}.", { modules: modules.map(code).join(", ") }));
  },
  unmix: () => open({ expand: [] }, t("The modules opened in place are closed.")),
  lanes: (argument) => {
    const lanes = oneOf(argument, ["rows", "columns"], "lanes");

    return open({ lanes }, t("The lanes are {lanes}.", { lanes }));
  },
  select: (argument) => {
    const asked = words(argument);
    const ids = [...new Set(asked.flatMap(shapesNamed))];
    // A name that is on no shape of this picture is said, not dropped: the reader asked for it.
    const unknown = asked.filter((word) => shapesNamed(word).length === 0);

    if (ids.length === 0) throw new Error(t("no shape of this picture is named {names}", { names: code(argument) }));
    // The page of what is picked is filled behind the transcript: the Chat tab, where the command was typed, stays in front.
    select(ids, true, false);

    return `${ids.length === 1 ? t("Picked {shape}.", { shape: code(ids[0]!) }) : t("Picked {count} shapes.", { count: ids.length })}${unknown.length > 0 ? ` ${t("No shape of this picture is named {names}.", { names: unknown.map(code).join(", ") })}` : ""}`;
  },
  path: (argument) => {
    const asked = words(argument);
    const unknown = asked.filter((word) => shapesNamed(word).length === 0);

    if (unknown.length > 0) throw new Error(t("no shape of this picture is named {names}", { names: unknown.map(code).join(", ") }));

    if (asked.length < 2) throw new Error(t("path: two or more shapes of the picture, in the order of the way"));
    // Each name is one shape: the one it names exactly, else the first that has it.
    const ids = asked.map((word) => shapesNamed(word)[0]!);
    showPath(ids);

    return t("The way through {shapes} is lit.", { shapes: ids.map(code).join(" → ") });
  },
  find: (argument) => {
    const field = element<HTMLInputElement>("find");
    field.value = argument;
    field.dispatchEvent(new Event("input"));
    const hits = shapesNamed(argument).length;

    return argument === "" ? t("The find is cleared.") : hits === 0 ? t("No shape of the picture have {text} in their name.", { text: code(argument) }) : hits === 1 ? t("One shape of the picture has {text} in its name.", { text: code(argument) }) : t("{hits} shapes of the picture have {text} in their name.", { hits, text: code(argument) });
  },
  grep: (argument) => search(argument, false),
  diff: (argument) => search(argument, true),
  review: (argument) => {
    const [base, head] = words(argument);

    if (base !== undefined) element<HTMLInputElement>("base").value = base;

    return open({ view: "review", head: head ?? currentLink().head }, t("The review of {head} against {base}.", { head: head ?? currentLink().head ?? t("the working tree"), base: base ?? t("the base") }));
  },
  compare: (argument) => {
    const heads = words(argument);

    if (heads.length < 2) throw new Error(t("compare: two or more heads (branches, tags, commits; WORKTREE is the working tree)"));

    return open({ view: "compare", heads }, t("Comparing {heads}.", { heads: heads.map(code).join(", ") }));
  },
  commit: (argument) => {
    if (!/^[0-9a-f]{4,40}$/i.test(argument)) throw new Error(t("commit: a commit's hash, or its first characters"));

    return open({ view: `commit:${argument}` }, t("The change of commit {commit}.", { commit: code(argument) }));
  },
  board: () => open({ view: "changes" }, t("The uncommitted changes.")),
  impact: (argument) => {
    if (argument === "") throw new Error(t("impact: a module (src/x.ts) or a function (src/x.ts#fn)"));
    // A path or a function as written; a word is the one module whose path has it.
    const key = `impact:${argument.includes("/") || argument.includes("#") ? argument : moduleNamed(argument)}`;

    return open({ view: key }, t("What a change to {subject} reaches.", { subject: code(key.slice("impact:".length)) }));
  },
  logic: (argument) => {
    const key = viewKey(argument, "logic");

    return open({ view: key }, t("The logic of {subject}.", { subject: code(key.slice("logic:".length)) }));
  },
  export: (argument) => {
    const format = oneOf(argument, FORMATS, "export");
    const link = currentLink();
    const anchor = Object.assign(document.createElement("a"), { href: api.exportUrl(link.view, format, link, refsOf(link)), download: "" });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    return t("The picture is downloaded as {format}.", { format });
  },
  split: (argument) => {
    if (argument === "off") {
      toggleSplit(false);

      return t("One picture again.");
    }

    // The second picture is the page itself, embedded: another view is its link.
    const key = argument === "" ? currentLink().view : viewKey(argument);
    toggleSplit(true);
    element<HTMLIFrameElement>("split-frame").src = `${location.pathname}?embed=1#view=${encodeURIComponent(key)}`;

    return t("Beside this picture: {key}.", { key: code(key) });
  },
  dim: () => {
    toggleTool("dim");

    return t("The dim tool is switched.");
  },
  full: () => {
    toggleFullCanvas();

    return t("The full canvas is switched.");
  },
  panel: (argument) => {
    showPanel(oneOf(argument, ["left", "right"], "panel"));

    return t("The {panel} panel is switched.", { panel: argument });
  },
  edit: () => {
    setMode("edit");

    return t("Drawing: the pencil and the shapes are yours.");
  },
  done: () => {
    setMode("view");

    return t("Back to reading.");
  },
  ask: (argument) => {
    if (argument === "") throw new Error(t("ask: a question"));
    askAgent(argument);

    return "";
  },
  explain: (argument) => {
    explainSelected(undefined, argument);

    return "";
  },
  agent: (argument) => pickAgent(argument),
  stop: () => (stopRun() ? t("The run is being stopped.") : t("No run is going.")),
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

  if (!parsed) throw new Error(t("{name} is no command (/help lists them)", { name: code(line.trim().split(/\s/)[0] ?? line) }));

  if (by === "agent" && !parsed.command.agent) throw new Error(t("/{name} is the reader's to run, not an agent's", { name: parsed.command.name }));

  return HANDLERS[parsed.command.name]!(parsed.argument);
}
