// The page: the list of views on the left, one Excalidraw canvas in the
// middle (reading by default, drawing on demand), and on the right the
// Markdown of the diagram or of the picked shape (rendered, or raw), the
// code it stands for, and the coverage report. The view, depth and
// options live in the URL hash, so a link opens the same picture and the
// browser's back button walks the path taken. Every change re-asks the
// server, which re-analyses from its cache: the diagrams are live.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { api, type DiagramNode, type ViewEntry } from "./api.ts";
import { mountCanvas, VIEW_LINK, type CanvasHandle } from "./editor.tsx";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);

  if (!found) throw new Error(`no #${id}`);

  return found as T;
}

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

interface State {
  view: string;
  depth: number | null;
  review: boolean;
  /** Draw packages and built-ins in the module views. */
  packages: boolean;
}

let views: ViewEntry[] = [];
let diagramMarkdown = "";
let nodes = new Map<string, DiagramNode>();
let canvas: CanvasHandle | null = null;
let mode: "view" | "edit" = "view";
let dirty = false;
let mocks: unknown[] = [];
let rawMarkdown = false;

function stateFromHash(): State {
  const params = new URLSearchParams(location.hash.slice(1));
  const depth = params.get("depth");

  return { view: params.get("view") ?? "layers", depth: depth === null || depth === "" ? null : Number(depth), review: params.get("review") === "1", packages: params.get("packages") === "1" };
}

function setHash(state: State): void {
  const params = new URLSearchParams();
  params.set("view", state.view);

  if (state.depth !== null) params.set("depth", String(state.depth));

  if (state.review) params.set("review", "1");

  if (state.packages) params.set("packages", "1");
  const base = baseInput.value.trim();

  if (base) params.set("base", base);
  location.hash = params.toString();
}

/** The view a shape opens: a layer its modules, a module its imports, a function its calls. */
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

// ── The right panel ──────────────────────────────────────────────────────────

function showTab(name: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("#tabs button")) button.classList.toggle("active", button.dataset["tab"] === name);

  for (const panel of document.querySelectorAll<HTMLElement>(".panel")) panel.classList.toggle("active", panel.id === name);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("#tabs button")) button.addEventListener("click", () => showTab(button.dataset["tab"]!));

/** Markdown as HTML (sanitised: a doc comment of the repository is not trusted), or as text when the raw toggle is on. */
function renderMarkdown(target: HTMLElement, markdown: string): void {
  if (rawMarkdown) {
    target.replaceChildren(Object.assign(document.createElement("pre"), { textContent: markdown }));

    return;
  }

  const html = marked.parse(markdown, { async: false, gfm: true });
  target.innerHTML = DOMPurify.sanitize(html);

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

    return;
  }

  if (!state.review) {
    try {
      const { markdown } = await api.node(state.view, node.id);
      setMarkdown(markdownPanel, markdown);
    } catch (error) {
      setMarkdown(markdownPanel, error instanceof Error ? error.message : String(error));
    }
  } else {
    setMarkdown(markdownPanel, `# ${node.label}\n\n${node.diff ?? "context"} — ${node.ref?.file ?? ""}`);
  }

  showTab("markdown");
  await showCode(node);
}

// ── The left panel ───────────────────────────────────────────────────────────

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

    return canvas;
  }

  canvas = await mountCanvas(element("canvas"), elements, {
    pick: (id) => void showNode(id),
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
  const scene = await api.scene(stateFromHash().view, stateFromHash().depth, stateFromHash().packages);
  canvas.replace(scene.elements);
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function load(): Promise<void> {
  const state = stateFromHash();
  const base = new URLSearchParams(location.hash.slice(1)).get("base");

  if (base !== null) baseInput.value = base;
  depthInput.value = state.depth === null ? "" : String(state.depth);
  packagesInput.checked = state.packages;
  renderViews(search.value);
  reason.textContent = "";
  element<HTMLButtonElement>("edit").disabled = state.review;

  try {
    if (state.review) {
      const result = await api.review(baseInput.value.trim() || null);
      title.textContent = `${result.diagram.title} — ${result.diff.changedFiles.length} source files changed${result.diff.layerEdgesAdded.length > 0 ? ` — ⚠ ${result.diff.layerEdgesAdded.length} new layer dependencies` : ""}`;
      diagramMarkdown = result.markdown;
      nodes = new Map(result.diagram.nodes.map((node) => [node.id, node]));
      await ensureCanvas(result.elements);
      reason.textContent = result.diagram.reason ?? "";
      renderExports(`review:${result.diff.base}`, baseInput.value.trim() || null);
    } else {
      const result = await api.scene(state.view, state.depth, state.packages);
      title.textContent = `${result.diagram.title}${result.drawn ? " (drawn by hand)" : ""}`;
      diagramMarkdown = result.markdown;
      nodes = new Map(result.diagram.nodes.map((node) => [node.id, node]));
      mocks = result.mocks;
      await ensureCanvas(result.elements);
      reason.textContent = result.diagram.reason ?? "";
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

async function loadFlow(): Promise<void> {
  const state = stateFromHash();
  flowMocks.replaceChildren();
  flowSteps.replaceChildren();
  element("flow-tab").hidden = !state.view.startsWith("calls:") || state.review;

  if (element("flow-tab").hidden) return;
  const { flow } = await api.flow(state.view, state.depth);
  const entryId = state.view.slice("calls:".length);
  const input = textarea(`Mock input of ${entryId.slice(entryId.indexOf("#") + 1)} (JSON object: a key per parameter)`, flow.input ?? "", '{"request": {"total": 42}}');
  const storageFields = flow.storages.map((storage) => ({ id: storage.id, field: textarea(`Mock content of ${storage.module} (${storage.storage})`, storage.content ?? "", '{"rows": [{"id": 1}]}') }));
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

// ── Controls ─────────────────────────────────────────────────────────────────

element<HTMLButtonElement>("fit").addEventListener("click", () => canvas?.scrollToContent());
element<HTMLButtonElement>("back").addEventListener("click", () => history.back());
element<HTMLButtonElement>("review").addEventListener("click", () => {
  if (leaveEdit()) setHash({ ...stateFromHash(), review: true });
});
element<HTMLButtonElement>("edit").addEventListener("click", () => (mode === "edit" ? leaveEdit() : setMode("edit")));
saveButton.addEventListener("click", () => void saveDrawing().catch((error: unknown) => (reason.textContent = error instanceof Error ? error.message : String(error))));
element<HTMLButtonElement>("relayout").addEventListener("click", () => void relayout());
element<HTMLButtonElement>("exit").addEventListener("click", () => leaveEdit());
element<HTMLButtonElement>("shot-png").addEventListener("click", () => void canvas?.screenshot("png").then((blob) => download(blob, fileName(".png"))));
element<HTMLButtonElement>("shot-svg").addEventListener("click", () => void canvas?.screenshot("svg").then((blob) => download(blob, fileName(".svg"))));
element<HTMLDivElement>("export").addEventListener("click", () => element<HTMLDetailsElement>("export-menu").removeAttribute("open"));
depthInput.addEventListener("change", () => setHash({ ...stateFromHash(), depth: depthInput.value === "" ? null : Number(depthInput.value) }));
packagesInput.addEventListener("change", () => setHash({ ...stateFromHash(), packages: packagesInput.checked }));
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
  } else if (event.key === "e" && !stateFromHash().review) {
    setMode("edit");
  } else if (event.key === "Escape") {
    void showNode(null);
  }
});

window.addEventListener("hashchange", () => {
  if (leaveEdit()) void load();
});

void (async () => {
  await loadViews();
  await load();
  await loadCoverage();
})();
