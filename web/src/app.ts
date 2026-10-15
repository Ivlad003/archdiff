// The page: the list of views on the left, the canvas in the middle, and
// on the right the Markdown of the diagram or the picked shape, the code
// it stands for, and the coverage report. The view and depth live in the
// URL hash, so a link opens the same picture. Every change re-asks the
// server, which re-analyses from its cache: the diagrams are live.

import { api, type DiagramNode, type ViewEntry } from "./api.ts";
import { Canvas } from "./canvas.ts";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);

  if (!found) throw new Error(`no #${id}`);

  return found as T;
}

const viewsList = element<HTMLUListElement>("views");
const search = element<HTMLInputElement>("search");
const title = element<HTMLSpanElement>("title-text");
const reason = element<HTMLDivElement>("reason");
const markdownPanel = element<HTMLPreElement>("markdown");
const codePanel = element<HTMLPreElement>("code");
const coveragePanel = element<HTMLPreElement>("coverage");
const depthInput = element<HTMLInputElement>("depth");
const baseInput = element<HTMLInputElement>("base");
const exportLinks = element<HTMLSpanElement>("export");

interface State {
  view: string;
  depth: number | null;
  review: boolean;
}

let views: ViewEntry[] = [];
let diagramMarkdown = "";

function stateFromHash(): State {
  const params = new URLSearchParams(location.hash.slice(1));
  const depth = params.get("depth");

  return { view: params.get("view") ?? "layers", depth: depth === null || depth === "" ? null : Number(depth), review: params.get("review") === "1" };
}

function setHash(state: State): void {
  const params = new URLSearchParams();
  params.set("view", state.view);

  if (state.depth !== null) params.set("depth", String(state.depth));

  if (state.review) params.set("review", "1");
  const base = baseInput.value.trim();

  if (base) params.set("base", base);
  location.hash = params.toString();
}

const canvas = new Canvas(element("canvas"), element("minimap"), {
  select: (node) => {
    void showNode(node);
  },
  open: (node) => {
    const own = ownView(node);

    if (own) setHash({ ...stateFromHash(), view: own, review: false });
  },
});

/** The view a shape opens on a double click: a layer its modules, a module its imports, a function its calls. */
function ownView(node: DiagramNode): string | null {
  const id = node.ref?.id ?? node.id;

  switch (node.kind) {
    case "layer":
      return `layer:${id}`;
    case "module":
      return `module:${id}`;
    case "fn":
      return `calls:${id}`;
    default:
      return null;
  }
}

function showTab(name: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("#tabs button")) button.classList.toggle("active", button.dataset["tab"] === name);

  for (const panel of document.querySelectorAll<HTMLElement>(".panel")) panel.classList.toggle("active", panel.id === name);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("#tabs button")) button.addEventListener("click", () => showTab(button.dataset["tab"]!));

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
  const to = node.ref?.endLine ?? (node.kind === "module" ? Infinity : from);
  codePanel.replaceChildren();
  const lines = text.split("\n");
  let first: HTMLElement | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = document.createElement("span");
    line.className = `line${i + 1 >= from && i + 1 <= to && node.kind !== "module" ? " hit" : ""}`;
    const number = document.createElement("span");
    number.className = "n";
    number.textContent = String(i + 1);
    line.append(number, lines[i] ?? "");
    codePanel.append(line);

    if (i + 1 === from) first = line;
  }

  codePanel.prepend(Object.assign(document.createElement("div"), { className: "muted", textContent: `${file}${from > 1 ? `:${from}` : ""}` }));
  first?.scrollIntoView({ block: "center" });
}

async function showNode(node: DiagramNode | null): Promise<void> {
  const state = stateFromHash();

  if (!node) {
    markdownPanel.textContent = diagramMarkdown;

    return;
  }

  if (!state.review) {
    try {
      const { markdown } = await api.node(state.view, node.id);
      markdownPanel.textContent = markdown;
    } catch (error) {
      markdownPanel.textContent = error instanceof Error ? error.message : String(error);
    }
  } else {
    markdownPanel.textContent = `# ${node.label}\n\n${node.diff ?? "context"} — ${node.ref?.file ?? ""}`;
  }

  await showCode(node);
}

function renderViews(filter: string): void {
  const state = stateFromHash();
  viewsList.replaceChildren();
  const needle = filter.trim().toLowerCase();
  const groups: [string, ViewEntry["kind"][]][] = [
    ["Overview", ["layers", "coverage"]],
    ["Layers", ["layer"]],
    ["Entry points (call flows)", ["calls"]],
    ["Modules", ["module"]],
  ];

  for (const [label, kinds] of groups) {
    const members = views.filter((view) => kinds.includes(view.kind) && (needle === "" || view.title.toLowerCase().includes(needle) || view.key.toLowerCase().includes(needle)));

    if (members.length === 0) continue;
    const head = document.createElement("li");
    head.className = "group";
    head.textContent = `${label} (${members.length})`;
    viewsList.append(head);

    for (const view of members) {
      const item = document.createElement("li");
      item.textContent = view.title;
      item.title = view.key;
      item.classList.toggle("active", view.key === state.view && !state.review);
      item.addEventListener("click", () => setHash({ ...state, view: view.key, review: false }));
      viewsList.append(item);
    }
  }
}

search.addEventListener("input", () => renderViews(search.value));

function renderExports(view: string, base: string | null): void {
  exportLinks.replaceChildren();

  for (const format of ["mermaid", "drawio", "excalidraw", "archimate", "json"]) {
    const link = document.createElement("a");
    link.href = api.exportUrl(view, format, base);
    link.textContent = format;
    link.title = `Download the diagram as ${format}`;
    exportLinks.append(link);
  }
}

async function load(): Promise<void> {
  const state = stateFromHash();
  const base = new URLSearchParams(location.hash.slice(1)).get("base");

  if (base !== null) baseInput.value = base;
  depthInput.value = state.depth === null ? "" : String(state.depth);
  renderViews(search.value);
  reason.textContent = "";

  try {
    if (state.review) {
      const result = await api.review(baseInput.value.trim() || null);
      title.textContent = `${result.diagram.title} — ${result.diff.changedFiles.length} source files changed${result.diff.layerEdgesAdded.length > 0 ? ` — ⚠ ${result.diff.layerEdgesAdded.length} new layer dependencies` : ""}`;
      diagramMarkdown = result.markdown;
      canvas.show(result.diagram);
      reason.textContent = result.diagram.reason ?? "";
      renderExports(`review:${result.diff.base}`, baseInput.value.trim() || null);
    } else {
      const result = await api.diagram(state.view, state.depth);
      title.textContent = result.diagram.title;
      diagramMarkdown = result.markdown;
      canvas.show(result.diagram);
      reason.textContent = result.diagram.reason ?? "";
      renderExports(state.view, null);
    }

    markdownPanel.textContent = diagramMarkdown;
  } catch (error) {
    title.textContent = "archdiff";
    markdownPanel.textContent = error instanceof Error ? error.message : String(error);
    showTab("markdown");
  }
}

async function loadViews(): Promise<void> {
  const response = await api.views();
  views = response.views;
  element("root").textContent = response.root;
  const s = response.stats;
  element("stats").textContent = `${s.files} files · ${s.fns} functions · ${s.deps} imports · ${s.calls} calls · ${s.gaps} gaps · ${s.ms.total} ms`;
  renderViews(search.value);
}

async function loadCoverage(): Promise<void> {
  try {
    const report = await api.coverage();
    coveragePanel.textContent = report.markdown;
  } catch (error) {
    coveragePanel.textContent = error instanceof Error ? error.message : String(error);
  }
}

element<HTMLButtonElement>("fit").addEventListener("click", () => canvas.fit());
element<HTMLButtonElement>("zoom-in").addEventListener("click", () => canvas.zoomAt(1.25));
element<HTMLButtonElement>("zoom-out").addEventListener("click", () => canvas.zoomAt(1 / 1.25));
element<HTMLButtonElement>("back").addEventListener("click", () => history.back());
element<HTMLButtonElement>("review").addEventListener("click", () => setHash({ ...stateFromHash(), review: true }));
element<HTMLDivElement>("export").addEventListener("click", () => element<HTMLDetailsElement>("export-menu").removeAttribute("open"));

// The side panels fold away (the choice is remembered in this browser); the canvas refits when they do.
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

  requestAnimationFrame(() => canvas.fit());
}

element<HTMLButtonElement>("toggle-left").addEventListener("click", () => togglePanel("left"));
element<HTMLButtonElement>("toggle-right").addEventListener("click", () => togglePanel("right"));

if (remembered("archdiff.hide-left")) document.body.classList.add("hide-left");

if (remembered("archdiff.hide-right")) document.body.classList.add("hide-right");

// Keyboard: Ctrl+B / Ctrl+] fold the panels, + − 0 zoom, Backspace goes back, / finds a view, Escape clears the pick.
window.addEventListener("keydown", (event) => {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

  if (event.ctrlKey && event.key === "b") {
    event.preventDefault();
    togglePanel("left");
  } else if (event.ctrlKey && event.key === "]") {
    event.preventDefault();
    togglePanel("right");
  } else if (typing) {
    if (event.key === "Escape") (event.target as HTMLElement).blur();
  } else if (event.key === "+" || event.key === "=") {
    canvas.zoomAt(1.25);
  } else if (event.key === "-") {
    canvas.zoomAt(1 / 1.25);
  } else if (event.key === "0") {
    canvas.fit();
  } else if (event.key === "Backspace") {
    history.back();
  } else if (event.key === "/") {
    event.preventDefault();
    togglePanel("left", false);
    search.focus();
  } else if (event.key === "Escape") {
    canvas.select(null);
    void showNode(null);
  }
});
depthInput.addEventListener("change", () => setHash({ ...stateFromHash(), depth: depthInput.value === "" ? null : Number(depthInput.value) }));
baseInput.addEventListener("change", () => {
  if (stateFromHash().review) setHash(stateFromHash());
});
window.addEventListener("hashchange", () => void load());
window.addEventListener("resize", () => canvas.fit());

void (async () => {
  await loadViews();
  await load();
  await loadCoverage();
})();
