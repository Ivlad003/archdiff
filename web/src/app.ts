// The page: the list of views on the left, one Excalidraw canvas in the
// middle (reading by default, drawing on demand), and on the right the
// Markdown of the diagram or of the picked shape (rendered, or raw), the
// code it stands for, and the coverage report. The view, depth and
// options live in the URL hash, so a link opens the same picture and the
// browser's back button walks the path taken. Every change re-asks the
// server, which re-analyses from its cache: the diagrams are live.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { api, type DiagramEdge, type DiagramNode, type ViewEntry } from "./api.ts";
import { mountCanvas, VIEW_LINK, type CanvasHandle, type PickedLine } from "./editor.tsx";
import { element } from "./dom.ts";
import { chainFrom, findShapes, lineElementId, neighbourhoodOf, pathBetween } from "./graph.ts";
import { crumbsOf, ownView, siblingViews } from "./navigation.ts";
import { DETAIL, OVERVIEWS, PRESETS, forgetDefaults, rememberDefaults, setHash, stateFromHash, type State } from "./state.ts";
import { MERMAID_STYLES, OVERLAYS, pictureQueryText, type MermaidStyle, type Overlay } from "../../src/options.ts";

let views: ViewEntry[] = [];
let diagramMarkdown = "";
let nodes = new Map<string, DiagramNode>();
/** The lines of the current view, in the diagram's order (the order the canvas names them by). */
let edges: DiagramEdge[] = [];
let canvas: CanvasHandle | null = null;
let mode: "view" | "edit" = "view";
let dirty = false;
let mocks: unknown[] = [];
let rawMarkdown = false;

const viewsList = element<HTMLUListElement>("views");
const search = element<HTMLInputElement>("search");
const title = element<HTMLSpanElement>("title-text");
const reason = element<HTMLDivElement>("reason");
const markdownPanel = element<HTMLDivElement>("markdown");
const codePanel = element<HTMLPreElement>("code");
const coveragePanel = element<HTMLDivElement>("coverage");
const depthInput = element<HTMLInputElement>("depth");
const baseInput = element<HTMLInputElement>("base");
const packagesInput = element<HTMLInputElement>("packages");
const exportLinks = element<HTMLDivElement>("export");
const saveButton = element<HTMLButtonElement>("save");

const changesInput = element<HTMLInputElement>("changes");

const headInput = element<HTMLInputElement>("head");


function renderCrumbs(state: State): void {
  const box = element<HTMLSpanElement>("crumbs");
  box.replaceChildren();

  if (state.review) {
    box.append("review");

    return;
  }

  const crumbs = crumbsOf(views, state.view);

  for (const [i, crumb] of crumbs.entries()) {
    if (i > 0) box.append(" › ");

    if (i === crumbs.length - 1) {
      box.append(crumb.label);
    } else {
      const link = document.createElement("a");
      link.textContent = crumb.label;
      link.addEventListener("click", () => setHash({ ...stateFromHash(), view: crumb.key, review: false }));
      box.append(link);
    }
  }
}

// ── The viewport of every view, remembered in this browser ──────────────────

function viewportKey(state: State): string {
  return `archdiff.viewport.${state.review ? "review" : state.view}`;
}

function rememberViewport(): void {
  const viewport = canvas?.viewport();

  if (!viewport) return;

  try {
    localStorage.setItem(viewportKey(stateFromHash()), JSON.stringify(viewport));
  } catch {
    // No storage: the viewport is not remembered.
  }
}

function restoreViewport(state: State): boolean {
  try {
    const saved = localStorage.getItem(viewportKey(state));

    if (!saved || !canvas) return false;
    canvas.setViewport(JSON.parse(saved) as { scrollX: number; scrollY: number; zoom: number });

    return true;
  } catch {
    return false;
  }
}

// ── The right panel ──────────────────────────────────────────────────────────

function showTab(name: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("#tabs button")) button.classList.toggle("active", button.dataset["tab"] === name);

  for (const panel of document.querySelectorAll<HTMLElement>(".panel")) panel.classList.toggle("active", panel.id === name);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
  if (!button.dataset["tab"]) continue;
  button.addEventListener("click", () => {
    showTab(button.dataset["tab"]!);

    if (button.dataset["tab"] === "spec") void loadSpecs();
  });
}

// ── The Spec tab ──────────────────────────────────────────────────────────────

/** The text of the spec shown, for copy. */
let specText = "";

/** The Markdown of the flow shown, for copy. */
let flowMarkdown = "";

/** Lists the specs and features of the repository and shows the picked one. */
async function loadSpecs(): Promise<void> {
  const list = element<HTMLSelectElement>("spec-list");
  const state = element<HTMLSpanElement>("spec-state");
  const picked = list.value;

  try {
    const { initialised, specs } = await api.specs();
    list.replaceChildren();

    for (const spec of specs) list.append(new Option(`${spec.kind === "openspec" ? "spec" : "feature"}: ${spec.title}`, spec.path, false, spec.path === picked));
    list.hidden = specs.length === 0;
    state.textContent = specs.length === 0 ? (initialised ? "no specs yet: spec this view, or review all" : "no openspec/ yet: the first run creates it") : `${specs.length} files`;

    if (specs.length > 0) await showSpec(list.value);
    else {
      specText = "";
      element<HTMLDivElement>("spec-text").replaceChildren();
    }
  } catch (error) {
    state.textContent = error instanceof Error ? error.message : String(error);
  }
}

/** Shows one spec: Markdown rendered, a feature as text. */
async function showSpec(path: string): Promise<void> {
  const target = element<HTMLDivElement>("spec-text");

  try {
    const { text } = await api.spec(path);
    specText = text;

    if (path.endsWith(".feature")) target.replaceChildren(Object.assign(document.createElement("pre"), { textContent: text }));
    else renderMarkdown(target, text);
  } catch (error) {
    target.textContent = error instanceof Error ? error.message : String(error);
  }
}

element<HTMLSelectElement>("spec-list").addEventListener("change", () => void showSpec(element<HTMLSelectElement>("spec-list").value));

/** Puts the agent's spec task in the Chat tab and runs it there; the Spec tab reloads when the run ends. */
async function specTask(mode: "generate" | "update"): Promise<void> {
  const state = element<HTMLSpanElement>("spec-state");

  try {
    const view = stateFromHash().view;
    const { markdown } = await api.specPrompt(mode, mode === "generate" && view.includes(":") ? view : null);
    taskField.value = markdown;
    showTab("chat");

    if (agentName) runTask(markdown, null);
    else runState.textContent = "no agent: the task is in the box; start web with --agent claude to run it, or copy it";
  } catch (error) {
    state.textContent = error instanceof Error ? error.message : String(error);
  }
}

element<HTMLButtonElement>("spec-generate").addEventListener("click", () => void specTask("generate"));
element<HTMLButtonElement>("spec-update").addEventListener("click", () => void specTask("update"));
element<HTMLButtonElement>("spec-validate").addEventListener("click", () => {
  const state = element<HTMLSpanElement>("spec-state");
  state.textContent = "validating…";
  void api
    .validateSpecs()
    .then((result) => {
      state.textContent = result.ok ? "valid" : "problems";
      element<HTMLDivElement>("spec-text").replaceChildren(Object.assign(document.createElement("pre"), { textContent: result.output }));
      specText = result.output;
    })
    .catch((error: unknown) => (state.textContent = error instanceof Error ? error.message : String(error)));
});

// ── Copy ──────────────────────────────────────────────────────────────────────

/** The text of the active tab: the Markdown, the file, the coverage, the flow, the transcript or the spec. */
function activeText(): string {
  const active = document.querySelector<HTMLElement>(".panel.active")?.id ?? "markdown";

  switch (active) {
    case "code":
      return codePanel.dataset["text"] ?? "";
    case "coverage":
      return coveragePanel.dataset["markdown"] ?? "";
    case "flow":
      return flowMarkdown;
    case "chat":
      return [...transcript.querySelectorAll<HTMLElement>(".ev")].map((row) => row.textContent ?? "").join("\n");
    case "spec":
      return specText;
    default:
      return markdownPanel.dataset["markdown"] ?? "";
  }
}

/** Copies the text to the clipboard: the async API, else a selection in a hidden textarea. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const done = document.execCommand("copy");
    field.remove();

    return done;
  }
}

element<HTMLButtonElement>("copy").addEventListener("click", () => {
  const button = element<HTMLButtonElement>("copy");
  const text = activeText();

  void copyText(text).then((done) => {
    button.textContent = done ? `copied ${text.length > 999 ? `${Math.round(text.length / 1000)}k` : text.length}` : "copy failed";
    setTimeout(() => (button.textContent = "copy"), 1500);
  });
});

/** Markdown as HTML (sanitised: a doc comment of the repository is not trusted), or as text when the raw toggle is on. */
function renderMarkdown(target: HTMLElement, markdown: string): void {
  if (rawMarkdown) {
    target.replaceChildren(Object.assign(document.createElement("pre"), { textContent: markdown }));

    return;
  }

  const html = marked.parse(markdown, { async: false, gfm: true });
  // No images or media: a doc comment could name any URL, and the page would fetch it.
  target.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ["img", "picture", "video", "audio", "iframe", "object", "embed"] });

  // The Mermaid source of the picture is for copying, not reading: folded under a summary.
  for (const code of target.querySelectorAll("pre > code.language-mermaid")) {
    const pre = code.parentElement!;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Mermaid source";
    details.append(summary);
    pre.replaceWith(details);
    details.append(pre);
  }

  // A `file:line` in the text opens the code; a view key opens the view.
  for (const code of target.querySelectorAll("code")) {
    const text = code.textContent ?? "";
    const match = text.match(/^([\w./@-]+\.[cm]?[jt]sx?)(?::(\d+))?$/);

    if (match && nodes.size > 0) {
      code.classList.add("link");
      code.title = "Show the code";
      code.addEventListener("click", () => void showCode({ id: text, kind: "module", label: text, ref: { file: match[1]!, line: match[2] ? Number(match[2]) : 1 }, x: 0, y: 0, w: 0, h: 0 }));
    }
  }
}

element<HTMLButtonElement>("raw").addEventListener("click", () => {
  rawMarkdown = !rawMarkdown;
  element("raw").classList.toggle("active", rawMarkdown);
  renderMarkdown(markdownPanel, markdownPanel.dataset["markdown"] ?? "");
  renderMarkdown(coveragePanel, coveragePanel.dataset["markdown"] ?? "");
});

function setMarkdown(target: HTMLElement, markdown: string): void {
  target.dataset["markdown"] = markdown;
  renderMarkdown(target, markdown);
}

/** The code of a shape: the file with the shape's lines marked and scrolled into view. */
async function showCode(node: DiagramNode): Promise<void> {
  const file = node.ref?.file;

  if (!file) {
    codePanel.textContent = "";

    return;
  }

  let text: string;

  try {
    text = await api.file(file);
  } catch (error) {
    codePanel.textContent = error instanceof Error ? error.message : String(error);

    return;
  }

  const from = node.ref?.line ?? 1;
  const to = node.ref?.endLine ?? from;
  const mark = node.kind !== "module";
  codePanel.replaceChildren();
  codePanel.dataset["text"] = text;
  const lines = text.split("\n");
  let first: HTMLElement | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = document.createElement("span");
    line.className = `line${mark && i + 1 >= from && i + 1 <= to ? " hit" : ""}`;
    const number = document.createElement("span");
    number.className = "n";
    number.textContent = String(i + 1);
    line.append(number, lines[i] ?? "");
    codePanel.append(line);

    if (i + 1 === from) first = line;
  }

  codePanel.prepend(Object.assign(document.createElement("div"), { className: "muted", textContent: `${file}${from > 1 ? `:${from}` : ""}` }));
  showTab("code");
  first?.scrollIntoView({ block: "center" });
}

async function showNode(id: string | null): Promise<void> {
  const state = stateFromHash();
  const node = id === null ? null : nodes.get(id);

  if (!node) {
    setMarkdown(markdownPanel, diagramMarkdown);
    renderNeighbours(null);

    return;
  }

  if (!state.review) {
    try {
      const { markdown } = await api.node(state.view, node.id, pictureQueryText(state));
      setMarkdown(markdownPanel, markdown);
    } catch (error) {
      setMarkdown(markdownPanel, error instanceof Error ? error.message : String(error));
    }
  } else {
    // A review: what changed, and the commits that touched the file.
    const file = node.ref?.file;
    let history = "";

    if (file) {
      try {
        const { commits } = await api.fileHistory(file);
        history = commits.length > 0 ? `\n\n## Commits that touched it\n\n${commits.map((commit) => `- \`${commit.short}\` ${commit.date} ${commit.author}: ${commit.subject}`).join("\n")}` : "";
      } catch {
        history = "";
      }
    }

    setMarkdown(markdownPanel, `# ${node.label.split("\n")[0]}\n\n${node.diff ?? "context"} — ${file ?? ""}${history}`);
  }

  showTab("markdown");
  renderNeighbours(node);
  await showCode(node);
}

/**
 * The strip above a shape's page: its neighbours in this picture — what it imports or calls (→) and what imports or
 * calls it (←) — as chips. A click picks the neighbour here (sideways, the same picture); Shift+click opens the
 * neighbour's own view (sideways, the same kind of picture for another subject). The ← → keys do the same walk.
 */
function renderNeighbours(node: DiagramNode | null): void {
  const strip = element<HTMLDivElement>("neighbours");
  strip.replaceChildren();
  strip.className = "line-strip neighbours";
  const out = node ? edges.filter((edge) => edge.from === node.id && edge.kind !== "lifeline" && nodes.has(edge.to)) : [];
  const into = node ? edges.filter((edge) => edge.to === node.id && edge.kind !== "lifeline" && nodes.has(edge.from)) : [];
  strip.hidden = out.length === 0 && into.length === 0;

  if (strip.hidden) return;

  const chip = (id: string, arrow: string): HTMLButtonElement => {
    const button = document.createElement("button");
    button.textContent = `${arrow} ${labelOf(id)}`;
    button.title = `${arrow === "→" ? "imported or called by this shape" : "imports or calls this shape"}: click picks it here, Shift+click opens its own view, ← → walk the neighbours`;
    button.addEventListener("click", (event) => {
      if (event.shiftKey) {
        const own = nodes.has(id) ? ownView(nodes.get(id)!) : null;

        if (own) setHash({ ...stateFromHash(), view: own, review: false });
      } else pickShape(id);
    });

    return button;
  };

  if (into.length > 0) {
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = `${into.length} in:`;
    strip.append(label, ...into.slice(0, 12).map((edge) => chip(edge.from, "←")));
  }

  if (out.length > 0) {
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = `${out.length} out:`;
    strip.append(label, ...out.slice(0, 12).map((edge) => chip(edge.to, "→")));
  }
}

/** Picks a shape as a tap would: centred, lit, its page shown; the start of the next path or arrow-key walk. */
function pickShape(id: string): void {
  if (!nodes.has(id)) return;
  canvas?.centreOn(id);
  canvas?.highlight([id]);
  lastPicked = id;
  void showNode(id);
}

/** The next shape along the arrows from the picked one (→), against them (←), or beside it in its lane (↑ ↓); cycles on repeated presses. */
function walk(direction: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): void {
  if (!lastPicked || !nodes.has(lastPicked)) return;
  const current = nodes.get(lastPicked)!;
  let candidates: string[];

  if (direction === "ArrowRight") candidates = edges.filter((edge) => edge.from === current.id && edge.kind !== "lifeline" && nodes.has(edge.to)).map((edge) => edge.to);
  else if (direction === "ArrowLeft") candidates = edges.filter((edge) => edge.to === current.id && edge.kind !== "lifeline" && nodes.has(edge.from)).map((edge) => edge.from);
  else {
    // Up and down: the shapes of the same lane, by their place from the top; the next below or above.
    const lane = [...nodes.values()].filter((node) => node.group === current.group && node.kind !== "anchor").sort((a, b) => a.y - b.y || a.x - b.x);
    const at = lane.findIndex((node) => node.id === current.id);
    candidates = at === -1 ? [] : [lane[(at + (direction === "ArrowDown" ? 1 : lane.length - 1)) % lane.length]!.id];
  }

  if (candidates.length === 0) return;
  // Along the arrows: repeated presses cycle through the neighbours.
  const previous = walked.direction === direction && walked.from === current.id ? walked.index + 1 : 0;
  const next = candidates[previous % candidates.length]!;
  walked = { direction, from: current.id, index: previous };
  pickShape(next);
  // Picking moved the start; keep the cycle anchored at where the walk began.
  walked.from = next;
}

let walked: { direction: string; from: string; index: number } = { direction: "", from: "", index: 0 };

/** The options that change which shapes a picture has, as query parameters, so a shape's page is asked for the picture the page shows. */

/** The tools of the canvas that change what a tap does. */
const tools = { mix: false, focus: false };

/** The shape picked last, the start of a path when the next tap holds Shift. */
let lastPicked: string | null = null;

/** Lights the shortest path between two shapes and writes it to the Markdown panel. */
function showPath(from: string, to: string): void {
  const directed = pathBetween(edges, from, to, true);
  const chain = directed ?? pathBetween(edges, from, to, false);
  const title = `# Path: ${labelOf(from)} → ${labelOf(to)}`;

  if (!chain) {
    canvas?.highlight([from, to]);
    setMarkdown(markdownPanel, `${title}\n\nNo chain of lines joins them in this picture, in either direction.\n`);
    showTab("markdown");

    return;
  }

  const ids = new Set([from, to]);

  for (const step of chain) {
    ids.add(lineElementId(step.edge, step.index));
    ids.add(step.edge.from);
    ids.add(step.edge.to);
  }

  canvas?.highlight([...ids]);
  const lines = [title, "", `${chain.length} ${chain.length === 1 ? "line" : "lines"}${directed ? "" : ", read against the arrows where needed"}:`, ""];

  for (const [i, step] of chain.entries()) lines.push(`${i + 1}. ${labelOf(step.edge.from)} → **${labelOf(step.edge.to)}**${step.edge.kind === "dependency" ? "" : ` (${step.edge.kind})`}`);
  setMarkdown(markdownPanel, `${lines.join("\n")}\n`);
  showTab("markdown");
}

/** The lanes menu: a box per lane of the picture (and per hidden lane, to bring it back). */
function renderLanes(state: State, groups: readonly { id: string; label: string }[]): void {
  const list = element<HTMLDivElement>("lanes");
  list.replaceChildren();
  const all = [...groups.map((group) => ({ id: group.id, label: group.label })), ...state.hideLanes.filter((id) => !groups.some((group) => group.id === id)).map((id) => ({ id, label: id }))];
  element<HTMLDetailsElement>("lanes-menu").hidden = all.length === 0;

  for (const lane of all) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !state.hideLanes.includes(lane.id);
    box.addEventListener("change", () => {
      const now = stateFromHash();
      setHash({ ...now, hideLanes: box.checked ? now.hideLanes.filter((id) => id !== lane.id) : [...now.hideLanes, lane.id] });
    });
    label.append(box, lane.label);
    list.append(label);
  }
}

const minimap = element<HTMLCanvasElement>("minimap");
let minimapWanted: boolean | null = null;
let minimapTimer: ReturnType<typeof setInterval> | null = null;
let minimapFrame: { scale: number; minX: number; minY: number } | null = null;

/** Draws the whole scene small, with the viewport as a box; the frame it drew in is kept for taps. */
function drawMinimap(): void {
  if (!canvas || minimap.hidden) return;
  const elements = canvas.scene().filter((element) => !element.isDeleted && (element.customData?.["archdiff"] === "node" || element.customData?.["archdiff"] === "lane"));

  if (elements.length === 0) return;
  const minX = Math.min(...elements.map((element) => element.x));
  const minY = Math.min(...elements.map((element) => element.y));
  const maxX = Math.max(...elements.map((element) => element.x + element.width));
  const maxY = Math.max(...elements.map((element) => element.y + element.height));
  const pad = 6;
  const scale = Math.min((minimap.width - 2 * pad) / Math.max(1, maxX - minX), (minimap.height - 2 * pad) / Math.max(1, maxY - minY));
  minimapFrame = { scale, minX: minX - pad / scale, minY: minY - pad / scale };
  const context = minimap.getContext("2d")!;
  context.clearRect(0, 0, minimap.width, minimap.height);
  const dark = document.body.classList.contains("dark");

  for (const element of elements) {
    const role = element.customData?.["archdiff"];
    const kind = String(element.customData?.["kind"] ?? "");
    context.fillStyle = role === "lane" ? (dark ? "#2a2a2a" : "#f1f1f1") : kind === "fn" ? "#90caf9" : kind === "more" ? "#bdbdbd" : dark ? "#9e9e9e" : "#616161";
    context.fillRect((element.x - minimapFrame.minX) * scale, (element.y - minimapFrame.minY) * scale, Math.max(1, element.width * scale), Math.max(1, element.height * scale));
  }

  // The viewport: what the canvas shows, in scene coordinates.
  const viewport = canvas.viewport();
  const size = canvas.size();

  if (viewport && size.width > 0) {
    context.strokeStyle = "#ff6f00";
    context.lineWidth = 1.5;
    context.strokeRect((-viewport.scrollX - minimapFrame.minX) * scale, (-viewport.scrollY - minimapFrame.minY) * scale, (size.width / viewport.zoom) * scale, (size.height / viewport.zoom) * scale);
  }
}

/** Shows the minimap when wanted (by the button, or by a picture over 60 shapes) and keeps it drawn while the viewport moves. */
function updateMinimap(): void {
  const shown = minimapWanted ?? nodes.size > 60;
  minimap.hidden = !shown || document.body.classList.contains("editing");
  element<HTMLButtonElement>("tool-map").classList.toggle("active", shown);

  if (minimapTimer) clearInterval(minimapTimer);
  minimapTimer = null;

  if (!minimap.hidden) {
    drawMinimap();
    minimapTimer = setInterval(drawMinimap, 300);
  }
}

minimap.addEventListener("click", (event) => {
  if (!canvas || !minimapFrame) return;
  const viewport = canvas.viewport();
  const size = canvas.size();

  if (!viewport) return;
  const box = minimap.getBoundingClientRect();
  const sceneX = minimapFrame.minX + (event.clientX - box.left) / minimapFrame.scale;
  const sceneY = minimapFrame.minY + (event.clientY - box.top) / minimapFrame.scale;
  canvas.setViewport({ scrollX: size.width / viewport.zoom / 2 - sceneX, scrollY: size.height / viewport.zoom / 2 - sceneY, zoom: viewport.zoom });
  drawMinimap();
});

/** The canvas toolbar: the picture select (this subject's pictures, then the overviews), the detail buttons and the tool states. */
function renderCanvasTools(state: State): void {
  const select = element<HTMLSelectElement>("picture");
  select.replaceChildren();
  const siblings = state.review ? [] : siblingViews(state.view);

  if (siblings.length > 0) {
    const group = document.createElement("optgroup");
    group.label = "this subject";

    for (const sibling of siblings) group.append(new Option(sibling.label, sibling.key, false, sibling.key === state.view));
    select.append(group);
  }

  const overview = document.createElement("optgroup");
  overview.label = "overview";

  for (const [key, label] of OVERVIEWS) overview.append(new Option(label, key, false, key === state.view));
  select.append(overview);

  if (!siblings.some((sibling) => sibling.key === state.view) && !OVERVIEWS.some(([key]) => key === state.view)) select.prepend(new Option(state.view, state.view, true, true));
  const detail = Object.entries(DETAIL).find(([, preset]) => (preset.depth ?? null) === state.depth && (preset.limit ?? null) === state.limit && (preset.weight ?? null) === state.weight && preset.hubs === state.hubs)?.[0];

  for (const button of document.querySelectorAll<HTMLButtonElement>("#canvas-tools [data-detail]")) button.classList.toggle("active", button.dataset["detail"] === detail);
  element<HTMLButtonElement>("tool-mix").classList.toggle("active", tools.mix);
  element<HTMLButtonElement>("tool-focus").classList.toggle("active", tools.focus);
  element<HTMLButtonElement>("mix-clear").hidden = state.expand.length === 0;
  element<HTMLButtonElement>("mix-clear").textContent = `close opened (${state.expand.length})`;
  element<HTMLButtonElement>("tool-split").classList.toggle("active", document.body.classList.contains("split"));
  renderLanes(state, currentGroups);
  updateMinimap();
}

/** The lanes of the current picture, for the lanes menu. */
let currentGroups: { id: string; label: string }[] = [];

/** Opens or closes the second picture beside the canvas: the same page, embedded, starting from the current link. */
/** Two canvases side by side need the room Excalidraw's desktop layout wants; below it the split stacks. */
const SPLIT_SIDE_BY_SIDE = 1520;

function toggleSplit(force?: boolean): void {
  const on = document.body.classList.toggle("split", force);
  const pane = element<HTMLDivElement>("split");
  const frame = element<HTMLIFrameElement>("split-frame");
  pane.hidden = !on;
  document.body.classList.toggle("stacked", on && window.innerWidth < SPLIT_SIDE_BY_SIDE);

  if (on && !frame.src) frame.src = `${location.pathname}?embed=1${location.hash}`;
  element<HTMLButtonElement>("tool-split").classList.toggle("active", on);
  // The canvas has its new width only after the layout settles: fit then, not now.
  setTimeout(() => canvas?.scrollToContent(), 200);
}

/** The first line of a shape's label, or its ID when the shape is not in the view. */
function labelOf(id: string): string {
  return nodes.get(id)?.label.split("\n")[0] ?? id;
}

/**
 * The page of tapped lines: the nearest line's page, a strip to pick another of the bundle when several ran under
 * the tap, and `follow` to light the chain onward from the line (Shift+tap does the same) with the shapes it reaches.
 */
async function showEdge(lines: PickedLine[], follow: boolean): Promise<void> {
  const state = stateFromHash();
  const line = lines[0]!;
  const chain = follow ? chainFrom(edges, line) : null;
  canvas?.highlight(chain ? [...chain.lineIds, ...chain.nodeIds] : [...new Set(lines.flatMap((each) => [each.id, each.from, each.to]))]);
  let markdown: string;

  try {
    markdown = (await api.edge(state.view, line.from, line.to, line.kind, pictureQueryText(state))).markdown;
  } catch (error) {
    markdown = error instanceof Error ? error.message : String(error);
  }

  if (chain) {
    const reached = chain.nodeIds.slice(2);
    markdown += `\n## Chain onward (${chain.hops.length} lines, ${reached.length} shapes)\n\n`;
    markdown += chain.hops.length === 0 ? "Nothing leads on from here in this view.\n" : chain.hops.map((hop) => `- ${"  ".repeat(hop.depth - 1)}${labelOf(hop.edge.from)} → **${labelOf(hop.edge.to)}**${hop.edge.kind === "dependency" ? "" : ` (${hop.edge.kind})`}${nodes.get(hop.edge.to)?.ref?.file ? ` — \`${nodes.get(hop.edge.to)!.ref!.file}${nodes.get(hop.edge.to)!.ref!.line ? `:${nodes.get(hop.edge.to)!.ref!.line}` : ""}\`` : ""}`).join("\n");

    if (chain.lineIds.length >= 300) markdown += "\n- … cut at 300 lines";
    markdown += "\n";
  }

  setMarkdown(markdownPanel, markdown);

  // The strip above the page: the bundle under the tap and the follow switch.
  const strip = document.createElement("div");
  strip.className = "line-strip";

  if (lines.length > 1) {
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = `${lines.length} lines under the tap:`;
    strip.append(label);

    for (const each of lines) {
      const button = document.createElement("button");
      button.textContent = `${labelOf(each.from)} → ${labelOf(each.to)}`;
      button.title = `Show this line (${each.kind})`;
      button.classList.toggle("active", each.id === line.id);
      button.addEventListener("click", () => void showEdge([each, ...lines.filter((other) => other.id !== each.id)], false));
      strip.append(button);
    }
  }

  const followButton = document.createElement("button");
  followButton.textContent = follow ? "stop following" : "follow →";
  followButton.title = follow ? "Light only this line again" : "Light every line and shape the arrows lead on to from here (Shift+tap does the same)";
  followButton.classList.toggle("active", follow);
  followButton.addEventListener("click", () => void showEdge(lines, !follow));
  strip.append(followButton);
  markdownPanel.prepend(strip);
  showTab("markdown");
}

// ── The left panel ───────────────────────────────────────────────────────────

function renderViews(filter: string): void {
  const state = stateFromHash();
  viewsList.replaceChildren();
  const needle = filter.trim().toLowerCase();
  const groups: [string, string[]][] = [
    ["Overview", ["layers", "coverage", "classes", "matrix", "metrics", "cycles", "cycles:fns", "machines", "events", "tests", "hotspots", "packages", "timeline"]],
    ["State machines", ["machine"]],
    ["Layers", ["layer"]],
    ["Directories", ["dir"]],
    ["Entry points (call flows)", ["calls"]],
    ["Types (where they flow)", ["type"]],
    ["Modules", ["module"]],
  ];

  for (const [label, kinds] of groups) {
    // The overviews are named by key (a plain view's key is its kind, `cycles:fns` is a key of the cycles kind); the rest by kind.
    const members = views.filter((view) => (label === "Overview" ? kinds.includes(view.key) : kinds.includes(view.kind)) && (needle === "" || view.title.toLowerCase().includes(needle) || view.key.toLowerCase().includes(needle)));

    if (members.length === 0) continue;
    const head = document.createElement("li");
    head.className = "group";
    head.textContent = `${label} (${members.length})`;
    viewsList.append(head);

    // A long group (every module) shows its first entries; the filter finds the rest.
    for (const view of members.slice(0, needle === "" ? 60 : 400)) {
      const item = document.createElement("li");
      item.textContent = view.title;
      item.title = view.key;
      item.classList.toggle("active", view.key === state.view && !state.review);
      item.addEventListener("click", () => setHash({ ...state, view: view.key, review: false }));
      viewsList.append(item);
    }

    if (members.length > (needle === "" ? 60 : 400)) {
      const more = document.createElement("li");
      more.className = "muted";
      more.textContent = `… ${members.length - 60} more: type to filter`;
      viewsList.append(more);
    }
  }
}

search.addEventListener("input", () => renderViews(search.value));

function renderExports(view: string, base: string | null, head: string | null = null, heads: string[] = []): void {
  exportLinks.replaceChildren();

  const now = stateFromHash();
  const extra = `${now.overlays.length > 0 ? `&overlay=${encodeURIComponent(now.overlays.join(","))}` : ""}${now.changes ? "&changes=1" : ""}${now.limit !== null ? `&limit=${now.limit}` : ""}${now.weight !== null ? `&weight=${now.weight}` : ""}${now.hubs ? "" : "&hubs=0"}${now.packages ? "&packages=1" : ""}`;

  for (const format of ["mermaid", "drawio", "excalidraw", "archimate", "json"]) {
    const link = document.createElement("a");
    link.href = api.exportUrl(view, format, base, head, heads, `${extra}${format === "mermaid" && now.mermaid !== "auto" ? `&mermaid=${now.mermaid}` : ""}`);
    link.textContent = format === "mermaid" && now.mermaid !== "auto" ? `mermaid (${now.mermaid})` : format;
    link.title = `Download the diagram as ${format}`;
    exportLinks.append(link);
  }

  // The Mermaid types that read better for some views.
  const kind = view.slice(0, view.indexOf(":") === -1 ? view.length : view.indexOf(":"));
  const styles: [string, string][] = kind === "hotspots" ? [["quadrant", "mermaid: quadrant chart"]] : kind === "layers" || kind === "packages" ? [["c4", "mermaid: C4 context"], ["pie", "mermaid: pie of modules"]] : kind === "dir" || kind === "layer" ? [["mindmap", "mermaid: mindmap"]] : [];

  for (const [style, label] of styles) {
    const link = document.createElement("a");
    link.href = `${api.exportUrl(view, "mermaid", base, head, heads, extra)}&mermaid=${style}`;
    link.textContent = label;
    exportLinks.append(link);
  }
}

// ── The canvas ───────────────────────────────────────────────────────────────

function download(blob: Blob, name: string): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function fileName(extension: string): string {
  return `${stateFromHash().view.replace(/[^A-Za-z0-9._-]+/g, "_")}${extension}`;
}

async function ensureCanvas(elements: import("../../src/scene.ts").SceneElement[]): Promise<CanvasHandle> {
  if (canvas) {
    canvas.replace(elements);
    restoreViewport(stateFromHash());

    return canvas;
  }

  canvas = await mountCanvas(element("canvas"), elements, {
    pick: (id, lines, shift) => {
      // A tap on lines lights them with their ends (or the chain onward, with Shift); a shape or nothing puts the light out.
      if (lines && lines.length > 0) {
        void showEdge(lines, shift === true);

        return;
      }

      canvas?.highlight([]);
      const node = id === null ? null : nodes.get(id);

      // Shift+tap on a second shape: the shortest path from the one picked before, along the arrows.
      if (shift && node && lastPicked && lastPicked !== node.id && nodes.has(lastPicked)) {
        showPath(lastPicked, node.id);

        return;
      }

      if (node) lastPicked = node.id;

      // The mix tool: a module opens in place, an opened module's "rest" shape closes it.
      if (tools.mix && node && (node.kind === "module" || node.kind === "participant")) {
        const module = node.ref?.id ?? node.id;
        const now = stateFromHash();
        setHash({ ...now, expand: now.expand.includes(module) ? now.expand.filter((each) => each !== module) : [...now.expand, module] });

        return;
      }

      // The focus tool: everything but the shape and its neighbours dims; a tap on nothing clears it.
      if (tools.focus) canvas?.dim(node ? neighbourhoodOf(edges, node.id) : null);
      void showNode(id);
    },
    open: (id, link) => {
      const key = link?.startsWith(VIEW_LINK) ? decodeURIComponent(link.slice(VIEW_LINK.length)) : nodes.has(id) ? ownView(nodes.get(id)!) : null;

      if (key && mode === "view") setHash({ ...stateFromHash(), view: key, review: false });
    },
    changed: () => {
      if (mode === "edit") {
        dirty = true;
        saveButton.classList.add("dirty");
      }
    },
  });

  return canvas;
}

function setMode(next: "view" | "edit"): void {
  mode = next;
  canvas?.setMode(next);
  document.body.classList.toggle("editing", next === "edit");
  element("edit-tools").hidden = next !== "edit";
  element("edit").classList.toggle("active", next === "edit");

  if (next === "view") {
    dirty = false;
    saveButton.classList.remove("dirty");
  }
}

async function saveDrawing(): Promise<void> {
  if (!canvas) return;
  const { saved } = await api.saveLayout(stateFromHash().view, canvas.scene(), mocks);
  dirty = false;
  saveButton.classList.remove("dirty");
  reason.textContent = `saved to ${saved}`;
}

function leaveEdit(): boolean {
  if (mode !== "edit") return true;

  if (dirty && !confirm("The drawing has unsaved changes. Leave the editor and lose them?")) return false;
  setMode("view");

  return true;
}

async function relayout(): Promise<void> {
  if (!canvas) return;
  await saveDrawing();
  const now = stateFromHash();
  const scene = await api.scene(now.view, { ...now, onlyChanges: false, changes: false }, null, null);
  canvas.replace(scene.elements);
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function load(): Promise<void> {
  const state = stateFromHash();
  const base = new URLSearchParams(location.hash.slice(1)).get("base");

  if (base !== null) baseInput.value = base;
  depthInput.value = state.depth === null ? "" : String(state.depth);
  packagesInput.checked = state.packages;
  changesInput.checked = state.changes;
  element<HTMLInputElement>("limit").value = state.limit === null ? "" : String(state.limit);
  element<HTMLInputElement>("weight").value = state.weight === null ? "" : String(state.weight);
  element<HTMLInputElement>("hubs").checked = state.hubs;
  element<HTMLInputElement>("only-changes").checked = state.onlyChanges;
  renderCanvasTools(state);
  element<HTMLSelectElement>("mermaid").value = state.mermaid;

  for (const box of document.querySelectorAll<HTMLInputElement>("#options .overlay")) box.checked = state.overlays.includes(box.value as Overlay);
  renderViews(search.value);
  reason.textContent = "";
  element<HTMLButtonElement>("edit").disabled = state.review;
  element("chat-tab").hidden = state.review;

  try {
    renderCrumbs(state);
    headInput.value = state.head ?? "";
    element("commits").hidden = !state.review;

    element("branches").hidden = !state.review;

    if (state.review && state.heads.length > 0) {
      // Several heads against the base: the comparison picture, every module marked with the heads that touched it.
      const result = await api.compare(baseInput.value.trim() || null, state.heads);
      const warnings = result.heads.filter((head) => head.diff.layerEdgesAdded.length > 0).length;
      title.textContent = `${result.diagram.title}${warnings > 0 ? ` — ⚠ ${warnings} head${warnings === 1 ? "" : "s"} add a layer dependency` : ""}`;
      diagramMarkdown = result.markdown;
      nodes = new Map(result.diagram.nodes.map((node) => [node.id, node]));
      edges = result.diagram.edges;
      currentGroups = result.diagram.groups.map((group) => ({ id: group.id, label: group.label }));
      renderLanes(state, currentGroups);
      updateMinimap();
      await ensureCanvas(result.elements);
      reason.textContent = result.diagram.reason ?? "";
      reason.title = reason.textContent;
      title.title = result.diagram.question ? `${result.diagram.question[0]!.toUpperCase()}${result.diagram.question.slice(1)}.` : "";
      renderExports("compare", baseInput.value.trim() || null, null, state.heads);
      element("commits").hidden = true;
      void loadBranches(state);
    } else if (state.review) {
      const result = await api.review(baseInput.value.trim() || null, state.head);
      const findings = result.contract ? result.diff.layerEdgesAdded.filter((edge) => edge.against) : result.diff.layerEdgesAdded;
      title.textContent = `${result.diagram.title} — ${result.diff.changedFiles.length} source files changed${findings.length > 0 ? ` — ⚠ ${findings.length} new layer dependencies${result.contract ? " against ARCHITECTURE.md" : ""}` : result.diff.layerEdgesAdded.length > 0 ? ` — ${result.diff.layerEdgesAdded.length} new layer dependencies, allowed by ARCHITECTURE.md` : ""}`;
      diagramMarkdown = result.markdown;
      nodes = new Map(result.diagram.nodes.map((node) => [node.id, node]));
      edges = result.diagram.edges;
      currentGroups = result.diagram.groups.map((group) => ({ id: group.id, label: group.label }));
      renderLanes(state, currentGroups);
      updateMinimap();
      await ensureCanvas(result.elements);
      reason.textContent = result.diagram.reason ?? "";
      reason.title = reason.textContent;
      title.title = result.diagram.question ? `${result.diagram.question[0]!.toUpperCase()}${result.diagram.question.slice(1)}.` : "";
      renderExports(`review:${result.diff.base}`, baseInput.value.trim() || null, state.head);
      void loadCommits(state);
      void loadBranches(state);
    } else {
      const result = await api.scene(state.view, state, state.view === "timeline" || state.changes ? baseInput.value.trim() || null : null, state.view === "timeline" || state.changes ? state.head : null);
      title.textContent = `${result.diagram.title}${result.drawn ? " (drawn by hand)" : ""}`;
      diagramMarkdown = result.markdown;
      nodes = new Map(result.diagram.nodes.map((node) => [node.id, node]));
      edges = result.diagram.edges;
      currentGroups = result.diagram.groups.map((group) => ({ id: group.id, label: group.label }));
      renderLanes(state, currentGroups);
      updateMinimap();
      mocks = result.mocks;
      await ensureCanvas(result.elements);
      reason.textContent = result.diagram.reason ?? "";
      reason.title = reason.textContent;
      title.title = result.diagram.question ? `${result.diagram.question[0]!.toUpperCase()}${result.diagram.question.slice(1)}.` : "";
      renderExports(state.view, null);
    }

    setMarkdown(markdownPanel, diagramMarkdown);
    await loadFlow();
  } catch (error) {
    title.textContent = "archdiff";
    setMarkdown(markdownPanel, error instanceof Error ? error.message : String(error));
    showTab("markdown");
  }
}

async function loadViews(): Promise<void> {
  const response = await api.views();
  views = response.views;
  agentName = response.agent;
  element("agent-name").textContent = agentName ? `agent: ${agentName}` : "no agent: start archdiff web --agent claude|cursor to run tasks";
  // With an agent, anything typed in the box can run; without one the box only holds the task.
  runButton.disabled = !agentName;
  element("root").textContent = response.root;
  const s = response.stats;
  element("stats").textContent = `${s.files} files · ${s.fns} functions · ${s.deps} imports · ${s.calls} calls · ${s.gaps} gaps · ${s.ms.total} ms`;
  renderViews(search.value);
}

async function loadCoverage(): Promise<void> {
  try {
    const report = await api.coverage();
    setMarkdown(coveragePanel, report.markdown);
  } catch (error) {
    setMarkdown(coveragePanel, error instanceof Error ? error.message : String(error));
  }
}

// ── The Flow tab: the data flow of a calls view with its mocks ───────────────

const flowMocks = element<HTMLDivElement>("flow-mocks");
const flowSteps = element<HTMLDivElement>("flow-steps");

function textarea(label: string, value: string, placeholder: string): HTMLTextAreaElement {
  const field = document.createElement("textarea");
  field.value = value;
  field.placeholder = placeholder;
  const caption = document.createElement("label");
  caption.textContent = label;
  flowMocks.append(caption, field);

  return field;
}

let lastFlow: import("./api.ts").FlowResponse["flow"] | null = null;
let mockInput: HTMLTextAreaElement | null = null;
let mockStorages: { id: string; field: HTMLTextAreaElement }[] = [];

async function loadFlow(): Promise<void> {
  const state = stateFromHash();
  flowMocks.replaceChildren();
  flowSteps.replaceChildren();
  element("flow-tab").hidden = !state.view.startsWith("calls:") || state.review;

  if (element("flow-tab").hidden) return;
  const { flow, markdown } = await api.flow(state.view, state.depth);
  lastFlow = flow;
  flowMarkdown = markdown;
  const entryId = state.view.slice("calls:".length);
  const input = textarea(`Mock input of ${entryId.slice(entryId.indexOf("#") + 1)} (JSON object: a key per parameter)`, flow.input ?? "", '{"request": {"total": 42}}');
  const storageFields = flow.storages.map((storage) => ({ id: storage.id, field: textarea(`Mock content of ${storage.module} (${storage.storage})`, storage.content ?? "", '{"rows": [{"id": 1}]}') }));
  mockInput = input;
  mockStorages = storageFields;
  const apply = document.createElement("button");
  apply.textContent = "apply mocks";
  apply.title = "Save the mocks with the drawing of this view and carry the values through the steps";
  apply.addEventListener("click", () => {
    const next: unknown[] = [];

    if (input.value.trim() !== "") next.push({ id: entryId, kind: "input", value: input.value.trim() });

    for (const { id, field } of storageFields) if (field.value.trim() !== "") next.push({ id, kind: "storage", value: field.value.trim() });
    mocks = next;
    void (canvas ? api.saveLayout(state.view, canvas.scene(), mocks) : Promise.resolve()).then(() => loadFlow()).catch((error: unknown) => (flowSteps.textContent = error instanceof Error ? error.message : String(error)));
  });
  flowMocks.append(apply);

  for (const step of flow.steps) {
    const box = document.createElement("div");
    box.className = `step${step.storage ? " storage" : ""}`;
    box.dataset["id"] = step.id;
    box.style.marginLeft = `${step.depth * 14}px`;
    const head = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = step.name;
    name.style.cursor = "pointer";
    name.title = "Show the code";
    name.addEventListener("click", () => void showCode({ id: step.id, kind: "fn", label: step.name, ref: { id: step.id, file: step.module, line: step.line }, x: 0, y: 0, w: 0, h: 0 }));
    head.append(name, "(");

    for (const [i, param] of step.params.entries()) {
      if (i > 0) head.append(", ");
      head.append(`${param.name}: ${param.type}`);

      if (param.value !== undefined) {
        const value = document.createElement("span");
        value.className = "value";
        value.textContent = ` = ${param.value}`;
        value.title = `from ${param.from ?? ""}`;
        head.append(value);
      }
    }

    head.append(`)${step.returns ? ` → ${step.returns}` : ""}`);
    const where = document.createElement("div");
    where.className = "where";
    where.textContent = `${step.module}:${step.line}${step.storage ? ` · storage: ${step.storage}${step.content !== undefined ? ` holds ${step.content}` : ""}` : ""}${step.gaps > 0 ? ` · ${step.gaps} calls not followed` : ""}`;
    box.append(head, where);
    flowSteps.append(box);
  }

  if (flow.steps.length === 0) flowSteps.textContent = "No such function in the graph.";
}

/** Mocks for the entry and the storages: the agent with the description when there is one, else the types; the fields are filled, not saved. */
async function generateMocks(): Promise<void> {
  const state = stateFromHash();
  const note = element<HTMLInputElement>("mock-description");

  if (!state.view.startsWith("calls:") || !mockInput) return;
  note.disabled = true;
  flowSteps.prepend(Object.assign(document.createElement("div"), { className: "muted", id: "mock-note", textContent: "generating mocks…" }));

  try {
    const result = await api.mocks(state.view, note.value);
    mockInput.value = JSON.stringify(result.input, null, 2);

    for (const { id, field } of mockStorages) if (result.storages[id] !== undefined) field.value = JSON.stringify(result.storages[id], null, 2);
    element("mock-note").textContent = `mocks from ${result.source}${result.note ? ` (${result.note})` : ""}; apply to carry them through the steps`;
  } catch (error) {
    element("mock-note").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    note.disabled = false;
  }
}

/** Plays the steps of the flow on the diagram: each step's shape lights up in turn, its row in the panel too, as a run would pass through them. */
async function playFlow(): Promise<void> {
  const state = stateFromHash();

  if (!lastFlow || !canvas || !state.view.startsWith("calls:")) return;
  const button = element<HTMLButtonElement>("flow-play");
  button.disabled = true;
  showTab("flow");

  try {
    for (const step of lastFlow.steps) {
      canvas.highlight([step.id]);

      for (const row of flowSteps.querySelectorAll<HTMLElement>(".step")) row.classList.toggle("playing", row.dataset["id"] === step.id);
      flowSteps.querySelector<HTMLElement>(".step.playing")?.scrollIntoView({ block: "nearest" });
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  } finally {
    canvas.highlight([]);

    for (const row of flowSteps.querySelectorAll<HTMLElement>(".step")) row.classList.remove("playing");
    button.disabled = false;
  }
}

element<HTMLButtonElement>("mock-generate").addEventListener("click", () => void generateMocks());
element<HTMLButtonElement>("flow-play").addEventListener("click", () => void playFlow());

/** The entry run for real: the functions it entered light up green, the predicted ones it missed dim; the report goes under the steps. */
async function runFlowNow(): Promise<void> {
  const state = stateFromHash();

  if (!state.view.startsWith("calls:")) return;
  const button = element<HTMLButtonElement>("flow-run");
  const panel = element<HTMLDivElement>("flow-run-result");
  button.disabled = true;
  panel.textContent = "running…";
  showTab("flow");

  try {
    const { run, markdown } = await api.runFlow(state.view);
    flowMarkdown = `${flowMarkdown}\n\n${markdown}`;
    renderMarkdown(panel, markdown);
    const entered = run.steps.map((step) => step.id);

    if (canvas) {
      canvas.highlight(entered, "#66bb6a");
      canvas.dim(entered.length > 0 ? [...entered, ...run.unexpected] : null);
    }

    for (const row of flowSteps.querySelectorAll<HTMLElement>(".step")) {
      row.classList.toggle("entered", entered.includes(row.dataset["id"] ?? ""));
      row.classList.toggle("missed", run.missed.includes(row.dataset["id"] ?? ""));
    }
  } catch (error) {
    panel.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
}

element<HTMLButtonElement>("flow-run").addEventListener("click", () => void runFlowNow());

// ── The Chat tab: the task drawn on the view, and the agent that does it ─────

const taskField = element<HTMLTextAreaElement>("task");
const runButton = element<HTMLButtonElement>("run");
const stopButton = element<HTMLButtonElement>("stop");
const runState = element<HTMLSpanElement>("run-state");
const transcript = element<HTMLDivElement>("transcript");
const followup = element<HTMLInputElement>("followup");
let agentName: string | null = null;
let currentRun: { id: string; close: () => void; sessionId: string | null } | null = null;

function appendEvent(kind: string, text: string): void {
  const row = document.createElement("div");
  row.className = `ev ${kind}${kind === "check" && text.startsWith("✘") ? " failed" : ""}`;
  row.textContent = text;
  transcript.append(row);
  transcript.scrollTop = transcript.scrollHeight;
}

/** The contract and the configured checks, run now and shown in the transcript. */
async function runChecksNow(): Promise<void> {
  const button = element<HTMLButtonElement>("checks");
  button.disabled = true;
  runState.textContent = "running the checks…";

  try {
    const { events } = await api.runChecks();

    for (const event of events) appendEvent(event.kind, event.text);
    runState.textContent = events.length === 0 ? "no checks: no ARCHITECTURE.md and no \"checks\" in archdiff.json" : events.every((event) => event.text.startsWith("✔")) ? "every check passed" : "a check failed; see the transcript";
    showTab("chat");
  } catch (error) {
    runState.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
}

element<HTMLButtonElement>("checks").addEventListener("click", () => void runChecksNow());

/** The shapes of the current diagram that stand for `files` (a path, or its end), to light while the agent works on them. */
function shapesOfFiles(files: readonly string[]): string[] {
  const ids: string[] = [];

  for (const node of nodes.values()) {
    const file = node.ref?.file;

    if (!file) continue;

    if (files.some((candidate) => candidate === file || candidate.endsWith(`/${file}`))) ids.push(node.id);
  }

  return ids;
}

/** Tags in a text (@module:…, @fn:…, @layer:…, @dir:…, @flow:…, @type:…) become their context for the agent. */
async function withContext(prompt: string): Promise<string> {
  if (!/@(module|fn|layer|dir|flow|type):\S/.test(prompt)) return prompt;

  try {
    const context = await api.expand(prompt);

    return context ? `${prompt}\n\n${context}` : prompt;
  } catch {
    return prompt;
  }
}

// `@` in the task or the follow-up opens suggestions; Enter or a click inserts the tag.
const suggest = element<HTMLUListElement>("tag-suggest");
let suggestFor: HTMLTextAreaElement | HTMLInputElement | null = null;
let suggestIndex = 0;

function tagAtCursor(field: HTMLTextAreaElement | HTMLInputElement): { start: number; query: string } | null {
  const upTo = field.value.slice(0, field.selectionStart ?? field.value.length);
  const match = upTo.match(/@([\w:/#.\-]*)$/);

  return match ? { start: upTo.length - match[0].length, query: match[1] ?? "" } : null;
}

async function showSuggestions(field: HTMLTextAreaElement | HTMLInputElement): Promise<void> {
  const at = tagAtCursor(field);

  if (!at) {
    suggest.hidden = true;

    return;
  }

  const { tags } = await api.tags(at.query);
  suggest.replaceChildren();
  suggestFor = field;
  suggestIndex = 0;

  for (const [i, tag] of tags.entries()) {
    const item = document.createElement("li");
    item.className = i === 0 ? "active" : "";
    const code = document.createElement("code");
    code.textContent = tag.tag;
    item.append(code, tag.title);
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      insertTag(tag.tag);
    });
    suggest.append(item);
  }

  suggest.hidden = tags.length === 0;
  const box = field.getBoundingClientRect();
  const parent = element("chat").getBoundingClientRect();
  suggest.style.left = `${box.left - parent.left}px`;
  suggest.style.top = `${box.bottom - parent.top}px`;
}

function insertTag(tag: string): void {
  if (!suggestFor) return;
  const at = tagAtCursor(suggestFor);

  if (!at) return;
  const after = suggestFor.value.slice(suggestFor.selectionStart ?? suggestFor.value.length);
  suggestFor.value = `${suggestFor.value.slice(0, at.start)}${tag} ${after}`;
  const caret = at.start + tag.length + 1;
  suggestFor.setSelectionRange(caret, caret);
  suggest.hidden = true;
  suggestFor.focus();
}

for (const field of [element<HTMLTextAreaElement>("task"), element<HTMLInputElement>("followup")]) {
  field.addEventListener("input", () => void showSuggestions(field));
  field.addEventListener("blur", () => setTimeout(() => (suggest.hidden = true), 150));
  field.addEventListener("keydown", (event: Event) => {
    if (suggest.hidden) return;
    const key = (event as KeyboardEvent).key;
    const items = [...suggest.querySelectorAll("li")];

    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      suggestIndex = (suggestIndex + (key === "ArrowDown" ? 1 : items.length - 1)) % Math.max(1, items.length);
      items.forEach((item, i) => item.classList.toggle("active", i === suggestIndex));
    } else if (key === "Enter" || key === "Tab") {
      event.preventDefault();
      const code = items[suggestIndex]?.querySelector("code")?.textContent;

      if (code) insertTag(code);
    } else if (key === "Escape") suggest.hidden = true;
  });
}

async function readTask(): Promise<void> {
  const state = stateFromHash();

  if (state.review) return;

  // The current drawing first, so an unsaved stroke counts.
  if (canvas && mode === "edit") await api.saveLayout(state.view, canvas.scene(), mocks);
  const { markdown, drawn } = await api.plan(state.view);
  taskField.value = markdown;
  runButton.disabled = !agentName;
  runState.textContent = drawn ? "" : "no drawing saved for this view: edit, draw, save";
}

/** The question box: a fenced ```archdiff-question block in the agent's text, rendered as the question and its options; an answer resumes the session. */
function showQuestion(text: string, run: { sessionId: string | null }): boolean {
  const match = text.match(/```archdiff-question\s*\n([\s\S]*?)```/);

  if (!match) return false;
  let asked: { question?: unknown; options?: unknown };

  try {
    asked = JSON.parse(match[1]!) as { question?: unknown; options?: unknown };
  } catch {
    return false;
  }

  const question = typeof asked.question === "string" ? asked.question : "";
  const options = Array.isArray(asked.options) ? asked.options.filter((option): option is string => typeof option === "string") : [];

  if (question === "") return false;
  const box = element<HTMLDivElement>("question");
  box.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "q";
  heading.textContent = `❓ ${question}`;
  box.append(heading);
  const row = document.createElement("div");
  row.className = "options";

  const answer = (reply: string): void => {
    box.hidden = true;
    runTask(reply, run.sessionId);
  };

  for (const option of options) {
    const button = document.createElement("button");
    button.textContent = option;
    button.addEventListener("click", () => answer(option));
    row.append(button);
  }

  const other = document.createElement("input");
  other.placeholder = "another answer (Enter)";
  other.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && other.value.trim() !== "") answer(other.value.trim());
    event.stopPropagation();
  });
  row.append(other);
  box.append(row);
  box.hidden = false;

  return true;
}

/** The Chat tab's commands, by button or by a slash line in the task field. */
async function runCommand(command: "code" | "diagram" | "doc", argument: string): Promise<void> {
  const state = stateFromHash();

  if (command === "doc") {
    const textarea = element<HTMLTextAreaElement>("document");
    const hidden = textarea.hidden;
    textarea.hidden = !hidden ? true : false;
    element<HTMLDivElement>("document-row").hidden = textarea.hidden;

    if (!textarea.hidden) {
      if (argument) textarea.value = argument;
      textarea.focus();
    }

    return;
  }

  if (command === "code") {
    // The drawing first, so an unsaved stroke counts; then the contract, then the task.
    if (canvas && mode === "edit") await api.saveLayout(state.view, canvas.scene(), mocks);
    runState.textContent = "folding the drawing into the contract…";
    const result = await api.code(state.view);
    taskField.value = result.markdown;
    runState.textContent = result.planned === 0 ? "the contract is built already; the task has nothing to build" : `${result.planned} planned items in the contract`;

    if (result.planned > 0 && agentName) runTask(result.markdown, null);
    else if (!agentName) runState.textContent = "no agent: the task is in the box; start web with --agent claude to run it";

    return;
  }

  const ask = argument.trim() === "" ? "Review ARCHITECTURE.md as an architect would: are the layer names and module paths clear and consistent, is anything missing between the layers (an import that will be needed), is any layer too thin or too fat, does anything in the prose contradict the diagram? Fix what is clearly wrong in the file (keep the Mermaid valid, keep the prose), and ask me about anything that is a real choice." : `About ARCHITECTURE.md: ${argument.trim()}. Edit the file (keep the Mermaid valid, keep the prose) and ask me when a choice is mine.`;
  taskField.value = ask;

  if (agentName) runTask(ask, null);
  else runState.textContent = "no agent: start web with --agent claude to run it";
}

function runTask(written: string, resume: string | null): void {
  if (!agentName || written.trim() === "") return;
  element<HTMLDivElement>("question").hidden = true;

  // A slash line is a command, not a task.
  const slash = written.trim().match(/^\/(code|diagram|doc)\b\s*([\s\S]*)$/);

  if (slash) {
    void runCommand(slash[1] as "code" | "diagram" | "doc", slash[2] ?? "").catch((error: unknown) => (runState.textContent = error instanceof Error ? error.message : String(error)));

    return;
  }
  const state = stateFromHash();
  runButton.disabled = true;
  runButton.classList.add("running");
  stopButton.disabled = false;
  followup.disabled = true;
  runState.textContent = `running ${agentName}…`;

  if (!resume) transcript.replaceChildren();
  appendEvent("you", `▸ ${written.length > 300 ? `${written.slice(0, 300)}…` : written}`);
  const touched = new Set<string>();
  let lightTimer: ReturnType<typeof setTimeout> | null = null;
  void withContext(written)
    .then((prompt) => api.runAgent(state.view, prompt, resume))
    .then(({ id, task }) => {
      runState.textContent = `running ${agentName} (${id}); task saved to ${task}`;
      const run = { id, sessionId: resume, close: () => {} };
      currentRun = run;
      run.close = api.agentEvents(
        id,
        (event) => {
          if (event.sessionId) run.sessionId = event.sessionId;

          if (event.kind !== "init") appendEvent(event.kind, event.text);

          if (event.kind === "text" || event.kind === "result") showQuestion(event.text, run);

          // The shapes of the files the agent touches light up as it works, like a run passing through them.
          if (event.files && canvas) {
            const ids = shapesOfFiles(event.files);

            for (const id of ids) touched.add(id);

            if (ids.length > 0) {
              canvas.highlight(ids);

              if (lightTimer) clearTimeout(lightTimer);
              lightTimer = setTimeout(() => canvas?.highlight([...touched], "#ffb74d"), 1200);
            }
          }
        },
        () => {
          runButton.disabled = false;
          runButton.classList.remove("running");
          stopButton.disabled = true;
          followup.disabled = run.sessionId === null;
          runState.textContent = element<HTMLDivElement>("question").hidden ? `${agentName} finished; the diagram is reloaded — compare with review, check against the contract` : `${agentName} asks a question`;
          canvas?.highlight([]);
          // The agent changed the code: the live diagram and the views follow.
          void loadViews().then(() => load());
          void loadTasks();
        },
      );
    })
    .catch((error: unknown) => {
      runState.textContent = error instanceof Error ? error.message : String(error);
      runButton.disabled = false;
      runButton.classList.remove("running");
      stopButton.disabled = true;
    });
}

element<HTMLButtonElement>("plan").addEventListener("click", () => void readTask().catch((error: unknown) => (runState.textContent = error instanceof Error ? error.message : String(error))));
element<HTMLButtonElement>("code-this").addEventListener("click", () => void runCommand("code", "").catch((error: unknown) => (runState.textContent = error instanceof Error ? error.message : String(error))));
element<HTMLButtonElement>("improve-diagram").addEventListener("click", () => void runCommand("diagram", "").catch((error: unknown) => (runState.textContent = error instanceof Error ? error.message : String(error))));
element<HTMLButtonElement>("from-document").addEventListener("click", () => void runCommand("doc", ""));

const documentGo = async (): Promise<void> => {
  const text = element<HTMLTextAreaElement>("document").value.trim();

  if (text === "") return;
  const state = element<HTMLSpanElement>("document-state");
  state.textContent = "writing the architecture…";
  element<HTMLButtonElement>("document-go").disabled = true;

  try {
    const result = await api.intentFromDocument(text);
    state.textContent = `${result.file}: ${result.layers} layers, ${result.modules} modules, ${result.edges} imports (from ${result.source})`;
    element<HTMLTextAreaElement>("document").hidden = true;
    element<HTMLDivElement>("document-row").hidden = true;
    setHash({ ...stateFromHash(), view: "intent", review: false });
    void loadViews().then(() => load());
  } catch (error) {
    state.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    element<HTMLButtonElement>("document-go").disabled = false;
  }
};

element<HTMLButtonElement>("document-go").addEventListener("click", () => void documentGo());
element<HTMLTextAreaElement>("document").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void documentGo();
  event.stopPropagation();
});
runButton.addEventListener("click", () => runTask(taskField.value, null));
taskField.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey || /^\/(code|diagram|doc)\b/.test(taskField.value.trim()))) {
    event.preventDefault();
    runTask(taskField.value, null);
  }
});
stopButton.addEventListener("click", () => {
  if (currentRun) void api.stopAgent(currentRun.id);
});
followup.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && followup.value.trim() !== "" && currentRun) {
    const message = followup.value.trim();
    followup.value = "";
    runTask(message, currentRun.sessionId);
  }
});

// ── The commits of a review: step through the branch ────────────────────────

const commitList = element<HTMLSelectElement>("commit-list");
let commits: import("./api.ts").Commit[] = [];

async function loadCommits(state: State): Promise<void> {
  try {
    const result = await api.commits(baseInput.value.trim() || null, state.head);
    commits = result.commits;
    commitList.replaceChildren();
    const whole = document.createElement("option");
    whole.value = "";
    whole.textContent = `whole range: ${result.base.slice(0, 10)} → ${state.head ?? "working tree"} (${commits.length} commits)`;
    commitList.append(whole);

    for (const commit of commits) {
      const option = document.createElement("option");
      option.value = commit.sha;
      option.textContent = `${commit.short} ${commit.date} ${commit.subject}`;
      commitList.append(option);
    }

    // The picked commit is the head whose base is the commit before it.
    const picked = commits.find((commit) => commit.sha === state.head || commit.short === state.head);
    commitList.value = picked ? picked.sha : "";
    element("commit-note").textContent = picked ? `this commit against the one before it` : commits.length === 0 ? "no commits between the base and the head" : "pick a commit to see its own change";
  } catch (error) {
    element("commit-note").textContent = error instanceof Error ? error.message : String(error);
  }
}

function reviewCommit(index: number): void {
  const commit = commits[index];

  if (!commit) return;
  const previous = commits[index - 1];
  baseInput.value = previous ? previous.sha : "";
  setHash({ ...stateFromHash(), review: true, head: commit.sha });
}

commitList.addEventListener("change", () => {
  const index = commits.findIndex((commit) => commit.sha === commitList.value);

  if (index === -1) {
    baseInput.value = "";
    setHash({ ...stateFromHash(), review: true, head: null });
  } else reviewCommit(index);
});
element<HTMLButtonElement>("commit-prev").addEventListener("click", () => {
  const index = commits.findIndex((commit) => commit.sha === commitList.value);
  reviewCommit(index <= 0 ? commits.length - 1 : index - 1);
});
element<HTMLButtonElement>("commit-next").addEventListener("click", () => {
  const index = commits.findIndex((commit) => commit.sha === commitList.value);
  reviewCommit(index === -1 ? 0 : Math.min(commits.length - 1, index + 1));
});
headInput.addEventListener("change", () => {
  if (stateFromHash().review) setHash({ ...stateFromHash(), head: headInput.value.trim() || null });
});

// ── The branches: a base and any number of heads to compare ────────────────

let branchesLoaded = false;

async function loadBranches(state: State): Promise<void> {
  const note = element<HTMLSpanElement>("compare-note");

  try {
    const result = await api.branches();
    const baseSelect = element<HTMLSelectElement>("base-select");
    const list = element<HTMLSpanElement>("head-list");

    if (!branchesLoaded) {
      baseSelect.replaceChildren();
      const own = document.createElement("option");
      own.value = "";
      own.textContent = result.base ? `${result.base} (default)` : "merge-base";
      baseSelect.append(own);

      for (const branch of result.branches) {
        const option = document.createElement("option");
        option.value = branch.name;
        option.textContent = `${branch.name}${branch.remote ? " (remote)" : ""}`;
        baseSelect.append(option);
      }

      list.replaceChildren();
      const worktree = document.createElement("label");
      worktree.className = "current";
      const tick = document.createElement("input");
      tick.type = "checkbox";
      tick.value = "WORKTREE";
      worktree.append(tick, ` working tree${result.current ? ` (${result.current})` : ""}`);
      list.append(worktree);

      for (const branch of result.branches) {
        const label = document.createElement("label");
        label.className = `${branch.current ? "current" : ""} ${branch.remote ? "remote" : ""}`.trim();
        label.title = `${branch.sha} ${branch.date} ${branch.subject}`;
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = branch.name;
        label.append(box, ` ${branch.name}`);
        list.append(label);
      }

      branchesLoaded = true;
    }

    baseSelect.value = baseInput.value.trim();
    const ticked = new Set(state.heads.length > 0 ? state.heads : ["WORKTREE"]);

    for (const box of list.querySelectorAll<HTMLInputElement>("input")) box.checked = ticked.has(box.value);
    note.textContent = state.heads.length > 1 ? `${state.heads.length} heads against ${baseInput.value.trim() || result.base || "the merge-base"}` : "tick two or more heads to compare branches";
  } catch (error) {
    note.textContent = error instanceof Error ? error.message : String(error);
  }
}

element<HTMLSelectElement>("base-select").addEventListener("change", () => {
  baseInput.value = element<HTMLSelectElement>("base-select").value;
  setHash(stateFromHash());
});
element<HTMLButtonElement>("compare").addEventListener("click", () => {
  const heads = [...element("head-list").querySelectorAll<HTMLInputElement>("input:checked")].map((box) => box.value);

  if (heads.length === 0) {
    element("compare-note").textContent = "tick at least one head";

    return;
  }

  // One head that is the working tree is the plain review; anything else is a comparison.
  if (heads.length === 1 && heads[0] === "WORKTREE") setHash({ ...stateFromHash(), review: true, head: null, heads: [] });
  else if (heads.length === 1) setHash({ ...stateFromHash(), review: true, head: heads[0]!, heads: [] });
  else setHash({ ...stateFromHash(), review: true, head: null, heads });
});

// ── Theme ────────────────────────────────────────────────────────────────────

function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);

  try {
    localStorage.setItem("archdiff.theme", dark ? "dark" : "light");
  } catch {
    // Not remembered.
  }
}

element<HTMLButtonElement>("theme").addEventListener("click", () => applyTheme(!document.documentElement.classList.contains("dark")));

try {
  const saved = localStorage.getItem("archdiff.theme");
  applyTheme(saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
} catch {
  // Light.
}

// ── Previous tasks ───────────────────────────────────────────────────────────

async function loadTasks(): Promise<void> {
  try {
    const { tasks } = await api.tasks();
    const list = element<HTMLUListElement>("tasks");
    list.replaceChildren();

    for (const task of tasks.slice(0, 30)) {
      const item = document.createElement("li");
      item.textContent = `${task.file.slice(task.file.lastIndexOf("/") + 1)} — ${task.head}`;
      list.append(item);
    }

    element("tasks-box").hidden = tasks.length === 0;
  } catch {
    element("tasks-box").hidden = true;
  }
}

// ── Live reload: the server watches the sources ─────────────────────────────

api.changes((path) => {
  if (mode === "edit") {
    reason.textContent = `${path} changed; the drawing stays until you leave the editor`;

    return;
  }

  reason.textContent = `${path} changed — reloaded`;
  void loadViews().then(() => load());
});

// ── Controls ─────────────────────────────────────────────────────────────────

element<HTMLButtonElement>("fit").addEventListener("click", () => canvas?.scrollToContent());
element<HTMLSelectElement>("picture").addEventListener("change", () => setHash({ ...stateFromHash(), view: element<HTMLSelectElement>("picture").value, review: false, expand: [] }));

for (const button of document.querySelectorAll<HTMLButtonElement>("#canvas-tools [data-detail]")) {
  button.addEventListener("click", () => applyOptions({ ...stateFromHash(), ...DETAIL[button.dataset["detail"]!] }));
}

element<HTMLButtonElement>("depth-less").addEventListener("click", () => {
  const now = stateFromHash();
  const current = now.depth ?? (Number(depthInput.placeholder) || 1);
  setHash({ ...now, depth: Math.max(0, current - 1) });
});
element<HTMLButtonElement>("depth-more").addEventListener("click", () => {
  const now = stateFromHash();
  const current = now.depth ?? (Number(depthInput.placeholder) || 1);
  setHash({ ...now, depth: Math.min(12, current + 1) });
});
element<HTMLButtonElement>("tool-mix").addEventListener("click", () => {
  tools.mix = !tools.mix;

  if (tools.mix) tools.focus = false;
  renderCanvasTools(stateFromHash());
  reason.textContent = tools.mix ? "mix: tap a module to open it in place; tap its rest shape to close it" : (reason.title || "");
});
element<HTMLButtonElement>("tool-focus").addEventListener("click", () => {
  tools.focus = !tools.focus;

  if (tools.focus) tools.mix = false;
  else canvas?.dim(null);
  renderCanvasTools(stateFromHash());
  reason.textContent = tools.focus ? "focus: tap a shape to dim all but its neighbours; tap nothing to clear" : (reason.title || "");
});
element<HTMLButtonElement>("mix-clear").addEventListener("click", () => setHash({ ...stateFromHash(), expand: [] }));
element<HTMLButtonElement>("tool-split").addEventListener("click", () => toggleSplit());
window.addEventListener("resize", () => {
  if (document.body.classList.contains("split")) document.body.classList.toggle("stacked", window.innerWidth < SPLIT_SIDE_BY_SIDE);
});
element<HTMLButtonElement>("tool-lanes").addEventListener("click", () => {
  // Rows ↔ columns; auto (the layout's own choice) counts as whatever the picture shows, so the first press flips it.
  const now = stateFromHash();
  const rows = now.lanes === "rows" || (now.lanes === "auto" && !(currentGroups.length > 6 && (now.view === "modules" || now.view.startsWith("layer:") || now.view.startsWith("dir:"))));
  setHash({ ...now, lanes: rows ? "columns" : "rows" });
});
element<HTMLButtonElement>("tool-map").addEventListener("click", () => {
  minimapWanted = minimapWanted === null ? !(nodes.size > 60) : !minimapWanted;
  updateMinimap();
});
element<HTMLInputElement>("only-changes").addEventListener("change", () => setHash({ ...stateFromHash(), onlyChanges: element<HTMLInputElement>("only-changes").checked, changes: element<HTMLInputElement>("only-changes").checked ? true : stateFromHash().changes }));

const findInput = element<HTMLInputElement>("find");
findInput.addEventListener("input", () => {
  const hits = findShapes(nodes, findInput.value);
  canvas?.highlight(hits.slice(0, 20).map((node) => node.id));
  reason.textContent = findInput.value.trim() === "" ? (reason.title || "") : `${hits.length} ${hits.length === 1 ? "shape matches" : "shapes match"}`;
});
findInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const first = findShapes(nodes, findInput.value)[0];

    if (first) {
      canvas?.centreOn(first.id);
      canvas?.highlight([first.id]);
      lastPicked = first.id;
      void showNode(first.id);
    } else {
      // Nothing in this picture (folded away, or elsewhere): the first view whose subject matches opens instead.
      const needle = findInput.value.trim().toLowerCase();
      const entry = views.find((candidate) => candidate.key.includes(":") && candidate.key.slice(candidate.key.indexOf(":") + 1).toLowerCase() === needle) ?? views.find((candidate) => candidate.key.includes(":") && candidate.key.toLowerCase().includes(needle));

      if (entry) {
        reason.textContent = `not in this picture: opening ${entry.key}`;
        setHash({ ...stateFromHash(), view: entry.key, review: false });
      }
    }
  } else if (event.key === "Escape") {
    findInput.value = "";
    canvas?.highlight([]);
    reason.textContent = reason.title || "";
    findInput.blur();
  }

  event.stopPropagation();
});

// Embedded in a split pane: no header, no side panels, just the picture and its toolbar.
if (new URLSearchParams(location.search).get("embed") === "1") document.body.classList.add("embed");
element<HTMLButtonElement>("back").addEventListener("click", () => history.back());
element<HTMLButtonElement>("review").addEventListener("click", () => {
  if (leaveEdit()) setHash({ ...stateFromHash(), review: true, head: headInput.value.trim() || null });
});
element<HTMLButtonElement>("edit").addEventListener("click", () => (mode === "edit" ? leaveEdit() : setMode("edit")));
saveButton.addEventListener("click", () => void saveDrawing().catch((error: unknown) => (reason.textContent = error instanceof Error ? error.message : String(error))));
element<HTMLButtonElement>("relayout").addEventListener("click", () => void relayout());
element<HTMLButtonElement>("exit").addEventListener("click", () => leaveEdit());
element<HTMLButtonElement>("shot-png").addEventListener("click", () => void canvas?.screenshot("png").then((blob) => download(blob, fileName(".png"))));
element<HTMLButtonElement>("shot-svg").addEventListener("click", () => void canvas?.screenshot("svg").then((blob) => download(blob, fileName(".svg"))));
element<HTMLDivElement>("export").addEventListener("click", () => element<HTMLDetailsElement>("export-menu").removeAttribute("open"));
depthInput.addEventListener("change", () => {
  const typed = Number(depthInput.value);
  setHash({ ...stateFromHash(), depth: depthInput.value === "" || !Number.isFinite(typed) ? null : Math.max(0, Math.min(12, Math.floor(typed))) });
});
packagesInput.addEventListener("change", () => setHash({ ...stateFromHash(), packages: packagesInput.checked }));
changesInput.addEventListener("change", () => setHash({ ...stateFromHash(), changes: changesInput.checked }));
element<HTMLInputElement>("limit").addEventListener("change", () => {
  const value = element<HTMLInputElement>("limit").value;
  setHash({ ...stateFromHash(), limit: value === "" ? null : Math.max(1, Number(value)) });
});
element<HTMLSelectElement>("mermaid").addEventListener("change", () => {
  const value = element<HTMLSelectElement>("mermaid").value;
  setHash({ ...stateFromHash(), mermaid: MERMAID_STYLES.includes(value as MermaidStyle) ? (value as MermaidStyle) : "auto" });
});
element<HTMLInputElement>("weight").addEventListener("change", () => {
  const value = element<HTMLInputElement>("weight").value;
  setHash({ ...stateFromHash(), weight: value === "" || Number(value) <= 1 ? null : Math.floor(Number(value)) });
});
element<HTMLInputElement>("hubs").addEventListener("change", () => setHash({ ...stateFromHash(), hubs: element<HTMLInputElement>("hubs").checked }));
element<HTMLSelectElement>("preset").addEventListener("change", () => {
  const preset = PRESETS[element<HTMLSelectElement>("preset").value];
  element<HTMLSelectElement>("preset").value = "";

  if (preset) applyOptions({ ...stateFromHash(), ...preset });
});

for (const box of document.querySelectorAll<HTMLInputElement>("#options .overlay")) {
  box.addEventListener("change", () => {
    const overlays = [...document.querySelectorAll<HTMLInputElement>("#options .overlay:checked")].map((checked) => checked.value).filter((value): value is Overlay => OVERLAYS.includes(value as Overlay));
    setHash({ ...stateFromHash(), overlays });
  });
}

// The panel is fixed so the header's clipping does not cut it: placed under the summary when it opens, kept inside the window.
element<HTMLDetailsElement>("options-menu").addEventListener("toggle", () => {
  const menu = element<HTMLDetailsElement>("options-menu");

  if (!menu.open) return;
  const summary = menu.querySelector("summary")!.getBoundingClientRect();
  const panel = element<HTMLDivElement>("options");
  panel.style.top = `${summary.bottom + 4}px`;
  panel.style.left = `${Math.max(8, Math.min(summary.left, window.innerWidth - panel.offsetWidth - 8))}px`;
});
document.addEventListener("pointerdown", (event) => {
  const menu = element<HTMLDetailsElement>("options-menu");

  if (menu.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
});

/** Sets the hash as `setHash` does; when the link does not change (the options equal the defaults now), the page still reloads to show them. */
function applyOptions(state: State): void {
  const before = location.hash;
  setHash(state);

  if (location.hash === before) void load();
}

element<HTMLButtonElement>("options-default").addEventListener("click", () => {
  const now = stateFromHash();
  reason.textContent = rememberDefaults(now) ? "options remembered as the defaults of this browser" : "no storage: the options last this page";
  applyOptions(now);
});
element<HTMLButtonElement>("options-reset").addEventListener("click", () => {
  forgetDefaults();
  applyOptions({ ...stateFromHash(), depth: null, limit: null, packages: false, overlays: [], mermaid: "auto", changes: false, weight: null, hubs: true, expand: [], lanes: "auto" });
});
baseInput.addEventListener("change", () => {
  if (stateFromHash().review) setHash(stateFromHash());
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) event.preventDefault();
});

// The side panels fold away (the choice is remembered in this browser).
function remembered(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function togglePanel(side: "left" | "right", force?: boolean): void {
  const hidden = document.body.classList.toggle(`hide-${side}`, force);

  try {
    localStorage.setItem(`archdiff.hide-${side}`, hidden ? "1" : "0");
  } catch {
    // A private window: the choice lasts the page.
  }
}

element<HTMLButtonElement>("toggle-left").addEventListener("click", () => togglePanel("left"));
element<HTMLButtonElement>("toggle-right").addEventListener("click", () => togglePanel("right"));

if (remembered("archdiff.hide-left")) document.body.classList.add("hide-left");

if (remembered("archdiff.hide-right")) document.body.classList.add("hide-right");

// Keyboard (outside the editor, which owns its own keys): Ctrl+B / Ctrl+] fold the panels, 0 fits, Backspace goes back, / finds a view, e edits, Escape clears the pick.
window.addEventListener("keydown", (event) => {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

  if (event.ctrlKey && event.key === "b") {
    event.preventDefault();
    togglePanel("left");
  } else if (event.ctrlKey && event.key === "]") {
    event.preventDefault();
    togglePanel("right");
  } else if (event.ctrlKey && event.key === "s" && mode === "edit") {
    event.preventDefault();
    void saveDrawing();
  } else if (mode === "edit" || typing) {
    if (typing && event.key === "Escape") (event.target as HTMLElement).blur();
  } else if (event.key === "0") {
    canvas?.scrollToContent();
  } else if (event.key === "Backspace") {
    history.back();
  } else if (event.key === "/") {
    event.preventDefault();
    togglePanel("left", false);
    search.focus();
  } else if (event.key === "o") {
    element<HTMLDetailsElement>("options-menu").toggleAttribute("open");
  } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLSelectElement) && mode === "view" && lastPicked) {
    event.preventDefault();
    walk(event.key);
  } else if (event.key === "Enter" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLSelectElement) && !(event.target instanceof HTMLButtonElement) && mode === "view" && lastPicked && nodes.has(lastPicked)) {
    // Enter: into the picked shape's own view (deeper), as a second tap would.
    const own = ownView(nodes.get(lastPicked)!);

    if (own) setHash({ ...stateFromHash(), view: own, review: false });
  } else if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
    event.preventDefault();
    element<HTMLInputElement>("find").focus();
  } else if (event.key === "s" && !stateFromHash().review && !document.body.classList.contains("embed")) {
    toggleSplit();
  } else if (event.key === "m" && !stateFromHash().review) {
    element<HTMLButtonElement>("tool-mix").click();
  } else if (event.key === "f" && !stateFromHash().review) {
    element<HTMLButtonElement>("tool-focus").click();
  } else if (event.key === "e" && !stateFromHash().review) {
    setMode("edit");
  } else if (event.key === "Escape") {
    void showNode(null);
  }
});

window.addEventListener("hashchange", () => {
  if (leaveEdit()) void load();
});
window.addEventListener("beforeunload", rememberViewport);
setInterval(rememberViewport, 2000);

// A handle for the browser tests and for debugging in the console: the canvas and the state of the page.
(window as unknown as { archdiff: unknown }).archdiff = { canvas: () => canvas, state: stateFromHash, nodes: () => nodes };

void (async () => {
  await loadViews();
  await load();
  await loadCoverage();
  await loadTasks();
})();
