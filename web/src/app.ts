// The page: the list of views on the left, one Excalidraw canvas in the
// middle (reading by default, drawing on demand), and on the right the
// Markdown of the diagram or of the picked shape (rendered, or raw), the
// code it stands for, and the coverage report. The view, depth and
// options live in the URL hash, so a link opens the same picture and the
// browser's back button walks the path taken. Every change re-asks the
// server, which re-analyses from its cache: the diagrams are live.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { api, type ChangeSummary, type Line, type Shape, type ViewEntry } from "./api.ts";
import { mountCanvas, VIEW_LINK, type CanvasHandle, type PickedLine } from "./editor.tsx";
import { element, h, remember } from "./dom.ts";
import { agentNameOf, askAbout, loadTasks, runButton, setAgentName, transcript } from "./chat.ts";
import { flowText, loadFlow } from "./flow-tab.ts";
import { bindPage } from "./page.ts";
import { loadBranches, loadCommits } from "./review.ts";
import { loadSpecs, specTextOf } from "./spec-tab.ts";
import "./theme.ts";
import { closeMenu, menuOpen, openMenu, type MenuItem } from "./menu.ts";
import { mapDots, mapSettled, projectMapOpen, refreshProjectMap, toggleProjectMap } from "./project-map.ts";
import { chainFrom, findShapes, lineElementId, neighbourhoodOf, pathBetween } from "./graph.ts";
import { crumbsOf, ownView, siblingViews, subjectOf, tagOf } from "./navigation.ts";
import { DETAIL, OVERVIEWS, PRESETS, forgetDefaults, refsOf, rememberDefaults, reviewing, setHash, stateFromHash, type State } from "./state.ts";
import { parseView } from "../../src/view-keys.ts";
import { MERMAID_STYLES, OVERLAYS, type MermaidStyle, type Overlay } from "../../src/options.ts";

let views: ViewEntry[] = [];
let diagramMarkdown = "";
let nodes = new Map<string, Shape>();
/** The lines of the current view, in the diagram's order (the order the canvas names them by). */
let edges: Line[] = [];
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

// The tab modules reach the page through this context (page.ts), bound before any of them runs a handler.
bindPage({
  canvas: () => canvas,
  nodes: () => nodes,
  edges: () => edges,
  views: () => views,
  mode: () => mode,
  mocks: () => mocks,
  setMocks: (next) => {
    mocks = next;
  },
  title,
  baseInput,
  headInput,
  showTab: (name) => showTab(name),
  renderMarkdown: (target, markdown) => renderMarkdown(target, markdown),
  showCode: (node) => showCode(node),
  load: () => load(),
  loadViews: () => loadViews(),
});


function renderCrumbs(state: State): void {
  const box = element<HTMLSpanElement>("crumbs");
  box.replaceChildren();

  const crumbs = crumbsOf(views, state.view);

  for (const [i, crumb] of crumbs.entries()) {
    if (i > 0) box.append(" › ");

    if (i === crumbs.length - 1) {
      box.append(crumb.label);
    } else {
      const link = document.createElement("a");
      link.textContent = crumb.label;
      link.addEventListener("click", () => setHash({ ...stateFromHash(), view: crumb.key }));
      box.append(link);
    }
  }
}

// ── The viewport of every view, remembered in this browser ──────────────────

function viewportKey(state: State): string {
  return `archdiff.viewport.${state.view}`;
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
      return flowText();
    case "chat":
      return [...transcript.querySelectorAll<HTMLElement>(".ev")].map((row) => row.textContent ?? "").join("\n");
    case "spec":
      return specTextOf();
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
async function showCode(node: Shape): Promise<void> {
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

  let markdown: string;

  try {
    markdown = (await api.shape(state.view, node.id, state, refsOf(state))).markdown;
  } catch (error) {
    markdown = error instanceof Error ? error.message : String(error);
  }

  // A review: what the change did to the shape, and the commits that touched its file.
  const file = node.ref?.file;

  if (reviewing(state.view) && file) {
    try {
      const { commits } = await api.fileHistory(file);
      markdown += `\n\n_${node.diff ?? "context"} in this change._${commits.length > 0 ? `\n\n## Commits that touched it\n\n${commits.map((commit) => `- \`${commit.short}\` ${commit.date} ${commit.author}: ${commit.subject}`).join("\n")}` : ""}\n`;
    } catch {
      // Outside git: the shape's page alone.
    }
  }

  setMarkdown(markdownPanel, markdown);

  showTab("markdown");
  renderNeighbours(node);
  await showCode(node);
}

/**
 * The strip above a shape's page: its neighbours in this picture — what it imports or calls (→) and what imports or
 * calls it (←) — as chips. A click picks the neighbour here (sideways, the same picture); Shift+click opens the
 * neighbour's own view (sideways, the same kind of picture for another subject). The ← → keys do the same walk.
 */
function renderNeighbours(node: Shape | null): void {
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

        if (own) setHash({ ...stateFromHash(), view: own });
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
  select([id], true);
}

// ── The selection: several shapes at once ────────────────────────────────────

/** The shapes selected with Shift or Ctrl (or a box in the editor), in the order picked; a plain tap selects one. */
let selected: string[] = [];

/** The strip under the tabs: the selected shapes as chips, and what to do with them together. */
function renderSelection(): void {
  const strip = element<HTMLDivElement>("selection");
  strip.replaceChildren();
  strip.className = "line-strip";
  strip.hidden = selected.length < 2;

  if (strip.hidden) return;
  strip.append(h("span", { class: "muted" }, `${selected.length} selected:`));

  for (const id of selected) strip.append(h("button", { class: "chip", title: "Centre on it; Shift+click takes it out of the selection", on: { click: (event) => (event.shiftKey ? toggleSelected(id) : canvas?.centreOn(id)) } }, labelOf(id)));
  strip.append(
    h("button", { class: "act", title: "Ask the agent about the selected shapes (the Chat tab): their code and calls go along as context", on: { click: () => askSelected() } }, "ask about them"),
    h("button", { class: "act", title: "Dim everything but the selected shapes and their neighbours", on: { click: () => canvas?.dim([...new Set(selected.flatMap((id) => neighbourhoodOf(edges, id)))]) } }, "dim others"),
    h("button", { class: "act", title: "Clear the selection (Esc)", on: { click: () => select([]) } }, "clear"),
  );
}

/**
 * Selects shapes: one is picked (its page, its neighbours), two light the
 * shortest path between them, more list themselves with the lines among
 * them; an empty list clears everything back to the picture's page.
 */
function select(ids: string[], centre = false): void {
  selected = ids.filter((id) => nodes.has(id));
  canvas?.highlight(selected);
  renderSelection();

  if (selected.length === 1) {
    lastPicked = selected[0]!;

    if (centre) canvas?.centreOn(lastPicked);
    void showNode(lastPicked);
  } else if (selected.length === 2) showPath(selected[0]!, selected[1]!);
  else if (selected.length > 2) showSelection();
  else void showNode(null);
}

function toggleSelected(id: string): void {
  if (!nodes.has(id)) return;
  select(selected.includes(id) ? selected.filter((each) => each !== id) : [...selected, id]);
}

/** The page of several selected shapes: what each is, and the lines among them in this picture. */
function showSelection(): void {
  const lines = [`# ${selected.length} shapes selected`, "", ...selected.map((id) => {
    const node = nodes.get(id)!;

    return `- **${labelOf(id)}** (${node.kind})${node.ref?.file ? ` — \`${node.ref.file}${node.ref.line ? `:${node.ref.line}` : ""}\`` : ""}`;
  })];
  const among = edges.filter((edge) => selected.includes(edge.from) && selected.includes(edge.to) && edge.kind !== "lifeline");
  lines.push("", `## Lines among them (${among.length})`, "", ...(among.length === 0 ? ["none in this picture"] : among.map((edge) => `- ${labelOf(edge.from)} → **${labelOf(edge.to)}**${edge.kind === "dependency" ? "" : ` (${edge.kind})`}`)), "", "_Shift+tap or Ctrl+tap adds or removes a shape; **ask about them** sends them to the agent; **dim others** keeps their neighbourhood._");
  setMarkdown(markdownPanel, `${lines.join("\n")}\n`);
  showTab("markdown");
  renderNeighbours(null);
}

/** The question box of the Chat tab with the shapes attached: the selection, else the picked shape, else the picture alone. */
function askSelected(ids: string[] = selected.length > 0 ? selected : lastPicked ? [lastPicked] : []): void {
  askAbout(ids.map((id) => nodes.get(id)).filter((node): node is Shape => node !== undefined).map(tagOf).filter((tag): tag is { tag: string; label: string } => tag !== null));
}

// ── The context menu ─────────────────────────────────────────────────────────

/** What "open" means for a view key: the words of the second tap. */
function openLabel(key: string): string {
  const kind = key.slice(0, key.indexOf(":") === -1 ? key.length : key.indexOf(":"));
  const words: Record<string, string> = { inside: "Open: inside it (its functions and calls)", calls: "Open: its calls", layer: "Open: the layer", logic: "Open: its logic", machine: "Open: the machine", dir: "Open: the directory" };

  return words[kind] ?? `Open ${key}`;
}

/** The menu of a right click: on a shape (its views, the selection, the agent, its code), on a line, or on the empty canvas. */
function menuItems(id: string | null, lines: PickedLine[]): MenuItem[] {
  const now = stateFromHash();
  const go = (key: string) => () => setHash({ ...now, view: key });
  const node = id ? nodes.get(id) : undefined;

  if (node) {
    const own = ownView(node);
    const subject = subjectOf(node);
    const target = node.ref?.id ?? node.id;
    const fnLike = node.kind === "fn" || (node.kind === "action" && target.includes("#"));
    const tag = tagOf(node);
    const items: MenuItem[] = [];

    if (own) items.push({ label: openLabel(own), hint: "tap again", run: go(own) });

    if (node.kind === "module" || node.kind === "participant" || fnLike) items.push({ label: "Focus: everything joined to it", hint: "callers, callees, imports, across the modules", run: go(`focus:${target}`) });

    if (fnLike) items.push({ label: "Logic: the flowchart and its rules", run: go(`logic:${target}`) });

    for (const sibling of subject ? siblingViews(subject) : []) if (sibling.key !== own && !sibling.key.startsWith("focus:") && !sibling.key.startsWith("logic:")) items.push({ label: sibling.label, run: go(sibling.key) });
    items.push("—", { label: selected.includes(node.id) ? "Take out of the selection" : "Add to the selection", hint: "Shift+tap", run: () => toggleSelected(node.id) });
    items.push({ label: "Ask the agent about it", hint: tag?.tag ?? "no tag for this kind of shape", disabled: tag === null, run: () => askSelected([node.id]) });
    items.push({ label: "Dim all but its neighbours", run: () => canvas?.dim(neighbourhoodOf(edges, node.id)) });
    items.push("—", { label: "Show the code", disabled: !node.ref?.file, run: () => void showCode(node) });
    items.push({ label: "Copy the name", hint: target, run: () => void copyText(target) });

    return items;
  }

  if (lines.length > 0) {
    const line = lines[0]!;

    return [{ label: "Where this line leads", hint: `${labelOf(line.from)} → ${labelOf(line.to)}`, run: () => void showEdge(lines, false) }, { label: "Follow the chain onward", hint: "Shift+tap", run: () => void showEdge(lines, true) }];
  }

  return [
    { label: "Ask the agent about this picture", run: () => askSelected([]) },
    { label: "Project map", hint: "g", run: () => toggleProjectMap(true) },
    { label: "Fit the picture", hint: "0", run: () => canvas?.scrollToContent() },
    { label: "Clear the selection", hint: "Esc", disabled: selected.length === 0, run: () => select([]) },
    { label: "Edit the drawing", hint: "e", run: () => setMode("edit") },
  ];
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
/** Shown unless this browser turned it off (null: the default, on). */
let minimapWanted: boolean | null = remembered("archdiff.minimap.off") ? false : null;
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
  const dark = document.documentElement.classList.contains("dark");
  // The lines first, faint, so the shape of the picture reads; then the shapes over them.
  context.strokeStyle = dark ? "rgba(144,164,174,0.5)" : "rgba(96,125,139,0.35)";
  context.lineWidth = 1;

  for (const line of canvas.scene()) {
    if (line.isDeleted || line.customData?.["archdiff"] !== "edge") continue;
    const points = (line as { points?: [number, number][] }).points ?? [];

    if (points.length < 2) continue;
    context.beginPath();

    for (const [i, [px, py]] of points.entries()) {
      const x = (line.x + px - minimapFrame.minX) * scale;
      const y = (line.y + py - minimapFrame.minY) * scale;

      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }

    context.stroke();
  }

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

/** Shows the minimap unless it was turned off (the button, remembered) and keeps it drawn while the viewport moves. */
function updateMinimap(): void {
  const shown = minimapWanted ?? true;
  minimap.hidden = !shown || document.body.classList.contains("editing");
  element<HTMLButtonElement>("tool-map").classList.toggle("active", shown);

  if (minimapTimer) clearInterval(minimapTimer);
  minimapTimer = null;

  if (!minimap.hidden) {
    drawMinimap();
    minimapTimer = setInterval(drawMinimap, 300);
  }
}

/** Moves the viewport so the scene point under the pointer is at its centre; a drag keeps moving it. */
function minimapMoveTo(event: PointerEvent): void {
  if (!canvas || !minimapFrame) return;
  const viewport = canvas.viewport();
  const size = canvas.size();

  if (!viewport) return;
  const box = minimap.getBoundingClientRect();
  const sceneX = minimapFrame.minX + (event.clientX - box.left) / minimapFrame.scale;
  const sceneY = minimapFrame.minY + (event.clientY - box.top) / minimapFrame.scale;
  canvas.setViewport({ scrollX: size.width / viewport.zoom / 2 - sceneX, scrollY: size.height / viewport.zoom / 2 - sceneY, zoom: viewport.zoom });
  drawMinimap();
}

let minimapDragging = false;
minimap.addEventListener("pointerdown", (event) => {
  minimapDragging = true;
  minimap.setPointerCapture(event.pointerId);
  minimapMoveTo(event);
});
minimap.addEventListener("pointermove", (event) => {
  if (minimapDragging) minimapMoveTo(event);
});
minimap.addEventListener("pointerup", () => (minimapDragging = false));
minimap.addEventListener("pointercancel", () => (minimapDragging = false));

/** The canvas toolbar: the picture select (this subject's pictures, then the overviews), the detail buttons and the tool states. */
function renderCanvasTools(state: State): void {
  const select = element<HTMLSelectElement>("picture");
  select.replaceChildren();
  const siblings = siblingViews(state.view);

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
  element<HTMLButtonElement>("tool-graph").classList.toggle("active", projectMapOpen());
  renderLanes(state, currentGroups);
  updateMinimap();
}

/** The lanes of the current picture, for the lanes menu. */
let currentGroups: { id: string; label: string }[] = [];

/** How the current picture's lanes lie, as the layout says: the lanes button flips it. */
let currentLanes: "rows" | "columns" = "rows";

/** What a review or a comparison found, for the title: the files changed and the new layer dependencies (against the contract, when there is one). */
function changeTitle(change: ChangeSummary | null): string {
  if (!change) return "";

  if (change.kind === "compare") {
    const warnings = change.heads.filter((head) => head.diff.layerEdgesAdded.length > 0).length;

    return warnings > 0 ? ` — ⚠ ${warnings} head${warnings === 1 ? "" : "s"} add a layer dependency` : "";
  }

  const { diff, contract } = change;
  const findings = contract ? diff.layerEdgesAdded.filter((edge) => edge.against) : diff.layerEdgesAdded;

  return ` — ${diff.changedFiles.length} source files changed${findings.length > 0 ? ` — ⚠ ${findings.length} new layer dependencies${contract ? " against ARCHITECTURE.md" : ""}` : diff.layerEdgesAdded.length > 0 ? ` — ${diff.layerEdgesAdded.length} new layer dependencies, allowed by ARCHITECTURE.md` : ""}`;
}

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
    markdown = (await api.line(state.view, line.from, line.to, line.kind, state, refsOf(state))).markdown;
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
      item.classList.toggle("active", view.key === state.view);
      item.addEventListener("click", () => setHash({ ...state, view: view.key }));
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

/** The export menu: the picture as the link shows it (every option of options.ts, the refs) in every format, and the Mermaid types that fit the view. */
function renderExports(state: State): void {
  exportLinks.replaceChildren();
  const refs = refsOf(state);

  for (const format of ["mermaid", "drawio", "excalidraw", "archimate", "json"]) exportLinks.append(h("a", { href: api.exportUrl(state.view, format, state, refs), title: `Download the diagram as ${format}` }, format === "mermaid" && state.mermaid !== "auto" ? `mermaid (${state.mermaid})` : format));

  // The Mermaid types that read better for some views.
  const kind = parseView(state.view)?.kind;
  const styles: [MermaidStyle, string][] = kind === "hotspots" ? [["quadrant", "mermaid: quadrant chart"]] : kind === "layers" || kind === "packages" ? [["c4", "mermaid: C4 context"], ["pie", "mermaid: pie of modules"]] : kind === "dir" || kind === "layer" ? [["mindmap", "mermaid: mindmap"]] : [];

  for (const [style, label] of styles) exportLinks.append(h("a", { href: api.exportUrl(state.view, "mermaid", { ...state, mermaid: style }, refs) }, label));
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
    pick: (id, lines, extend) => {
      closeMenu();

      // A tap on lines lights them with their ends (or the chain onward, with Shift); a shape or nothing puts the light out.
      if (lines && lines.length > 0) {
        void showEdge(lines, extend === true);

        return;
      }

      const node = id === null ? null : nodes.get(id);

      // Shift or Ctrl held: the shape joins the selection or leaves it (two selected light the path between them); a tap
      // on nothing with them held changes nothing.
      if (extend) {
        if (node) toggleSelected(node.id);

        return;
      }

      canvas?.highlight([]);

      if (node) lastPicked = node.id;

      // The mix tool: a module opens in place, an opened module's "rest" shape closes it.
      if (tools.mix && node && (node.kind === "module" || node.kind === "participant")) {
        const module = node.ref?.id ?? node.id;
        const now = stateFromHash();
        setHash({ ...now, expand: now.expand.includes(module) ? now.expand.filter((each) => each !== module) : [...now.expand, module] });

        return;
      }

      // The dim tool: everything but the shape and its neighbours dims; a tap on nothing clears it.
      if (tools.focus) canvas?.dim(node ? neighbourhoodOf(edges, node.id) : null);
      select(node ? [node.id] : []);
    },
    open: (id, link) => {
      const key = link?.startsWith(VIEW_LINK) ? decodeURIComponent(link.slice(VIEW_LINK.length)) : nodes.has(id) ? ownView(nodes.get(id)!) : null;

      if (key && mode === "view") setHash({ ...stateFromHash(), view: key });
    },
    changed: () => {
      if (mode === "edit") {
        dirty = true;
        saveButton.classList.add("dirty");
      }
    },
    // The editor's own selection (a box around several shapes) is the page's selection too.
    selection: (ids) => select(ids),
    menu: (id, at, lines) => openMenu(menuItems(id, lines), at),
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
  const scene = await api.scene(now.view, { ...now, onlyChanges: false, changes: false }, refsOf(now));
  canvas.replace(scene.elements);
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function load(): Promise<void> {
  const state = stateFromHash();
  const base = new URLSearchParams(location.hash.slice(1)).get("base");
  // A new picture: nothing selected in it yet.
  selected = [];
  renderSelection();
  closeMenu();

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
  // A review and a comparison are read, not drawn on; the chat has nothing to build from them.
  element<HTMLButtonElement>("edit").disabled = reviewing(state.view);
  element("chat-tab").hidden = reviewing(state.view);

  try {
    renderCrumbs(state);
    headInput.value = state.head ?? "";
    element("commits").hidden = state.view !== "review";
    element("branches").hidden = !reviewing(state.view);
    const result = await api.scene(state.view, state, refsOf(state));
    title.textContent = `${result.diagram.title}${changeTitle(result.change)}${result.drawn ? " (drawn by hand)" : ""}`;
    diagramMarkdown = result.markdown;
    nodes = new Map(result.diagram.nodes.map((node) => [node.id, node]));
    edges = result.diagram.edges;
    currentGroups = result.diagram.groups.map((group) => ({ id: group.id, label: group.label }));
    currentLanes = result.diagram.lanes ?? "rows";
    renderLanes(state, currentGroups);
    updateMinimap();
    mocks = result.mocks;
    await ensureCanvas(result.elements);
    reason.textContent = result.diagram.reason ?? "";
    reason.title = reason.textContent;
    title.title = result.diagram.question ? `${result.diagram.question[0]!.toUpperCase()}${result.diagram.question.slice(1)}.` : "";
    renderExports(state);

    if (state.view === "review") void loadCommits(state);

    if (reviewing(state.view)) void loadBranches(state);

    setMarkdown(markdownPanel, diagramMarkdown);
    refreshProjectMap();
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
  setAgentName(response.agent);
  element("agent-name").textContent = agentNameOf() ? `agent: ${agentNameOf()}` : "no agent: start archdiff web --agent claude|cursor to run tasks";
  // With an agent, anything typed in the box can run; without one the box only holds the task.
  runButton.disabled = !agentNameOf();
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
element<HTMLSelectElement>("picture").addEventListener("change", () => setHash({ ...stateFromHash(), view: element<HTMLSelectElement>("picture").value, expand: [] }));

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
  // Rows ↔ columns, from what the picture shows (the layout says how it laid the lanes), so the first press always flips it.
  setHash({ ...stateFromHash(), lanes: currentLanes === "rows" ? "columns" : "rows" });
});
element<HTMLButtonElement>("tool-map").addEventListener("click", () => {
  minimapWanted = !(minimapWanted ?? true);
  remember("archdiff.minimap.off", !minimapWanted);
  updateMinimap();
});
element<HTMLButtonElement>("tool-graph").addEventListener("click", () => toggleProjectMap());
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
      select([first.id], true);
    } else {
      // Nothing in this picture (folded away, or elsewhere): the first view whose subject matches opens instead.
      const needle = findInput.value.trim().toLowerCase();
      const entry = views.find((candidate) => candidate.key.includes(":") && candidate.key.slice(candidate.key.indexOf(":") + 1).toLowerCase() === needle) ?? views.find((candidate) => candidate.key.includes(":") && candidate.key.toLowerCase().includes(needle));

      if (entry) {
        reason.textContent = `not in this picture: opening ${entry.key}`;
        setHash({ ...stateFromHash(), view: entry.key });
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
  if (leaveEdit()) setHash({ ...stateFromHash(), view: "review", head: headInput.value.trim() || null, heads: [] });
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
  if (reviewing(stateFromHash().view)) setHash(stateFromHash());
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

  // The project map and the menu take Escape first; `g` opens and closes the map from anywhere but a field.
  if (event.key === "Escape" && (menuOpen() || projectMapOpen())) {
    closeMenu();
    toggleProjectMap(false);

    return;
  }

  if (event.key === "g" && !typing && mode === "view" && !reviewing(stateFromHash().view)) {
    toggleProjectMap();

    return;
  }

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

    if (own) setHash({ ...stateFromHash(), view: own });
  } else if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
    event.preventDefault();
    element<HTMLInputElement>("find").focus();
  } else if (event.key === "s" && !reviewing(stateFromHash().view) && !document.body.classList.contains("embed")) {
    toggleSplit();
  } else if (event.key === "m" && !reviewing(stateFromHash().view)) {
    element<HTMLButtonElement>("tool-mix").click();
  } else if (event.key === "f" && !reviewing(stateFromHash().view)) {
    element<HTMLButtonElement>("tool-focus").click();
  } else if (event.key === "e" && !reviewing(stateFromHash().view)) {
    setMode("edit");
  } else if (event.key === "Escape") {
    select([]);
  }
});

window.addEventListener("hashchange", () => {
  if (leaveEdit()) void load();
});
window.addEventListener("beforeunload", rememberViewport);
setInterval(rememberViewport, 2000);

// A handle for the browser tests and for debugging in the console: the canvas and the state of the page.
(window as unknown as { archdiff: unknown }).archdiff = { canvas: () => canvas, state: stateFromHash, nodes: () => nodes, selected: () => selected, mapDots, mapSettled, menuOpen };

void (async () => {
  await loadViews();
  await load();
  await loadCoverage();
  await loadTasks();
})();
