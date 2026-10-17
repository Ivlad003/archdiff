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
  /** The head of a review: a ref, or null for the working tree. */
  head: string | null;
  /** The heads of a comparison (two or more branches, `WORKTREE` the working tree); empty: a plain review. */
  heads: string[];
  /** Lay the review's marks over the view. */
  changes: boolean;
  /** More shapes than this fold; null: the built-in limit. */
  limit: number | null;
  /** Overlays laid over the view, in order: tests, storages, heat. */
  overlays: string[];
  /** The Mermaid type of the Markdown and the export; `auto` picks per view. */
  mermaid: string;
}

/** The options a link may leave out, remembered in this browser as defaults ("remember as defaults"). */
interface Defaults {
  depth: number | null;
  limit: number | null;
  packages: boolean;
  overlays: string[];
  mermaid: string;
}

function readDefaults(): Defaults {
  try {
    const saved = localStorage.getItem("archdiff.defaults");

    if (saved) return JSON.parse(saved) as Defaults;
  } catch {
    // No storage: the built-in defaults.
  }

  return { depth: null, limit: null, packages: false, overlays: [], mermaid: "auto" };
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

  const defaults = readDefaults();
  const limit = params.get("limit");
  // A link without an option takes the remembered default; `packages=0`, `overlay=none`, `mermaid=auto` say "none" explicitly.
  const overlay = params.get("overlay");

  return {
    view: params.get("view") ?? "layers",
    depth: depth === null ? defaults.depth : depth === "" ? null : Number(depth),
    review: params.get("review") === "1",
    packages: params.has("packages") ? params.get("packages") === "1" : defaults.packages,
    head: params.get("head") || null,
    heads: (params.get("heads") ?? "").split(",").filter((head) => head !== ""),
    changes: params.get("changes") === "1",
    limit: limit === null ? defaults.limit : limit === "" ? null : Number(limit),
    overlays: overlay === null ? defaults.overlays : overlay.split(",").filter((name) => name !== "" && name !== "none"),
    mermaid: params.get("mermaid") ?? defaults.mermaid,
  };
}

function setHash(state: State): void {
  const params = new URLSearchParams();
  params.set("view", state.view);

  if (state.depth !== null) params.set("depth", String(state.depth));

  if (state.review) params.set("review", "1");

  if (state.packages) params.set("packages", "1");
  const base = baseInput.value.trim();

  if (base) params.set("base", base);

  if (state.head) params.set("head", state.head);

  if (state.heads.length > 0) params.set("heads", state.heads.join(","));

  if (state.changes) params.set("changes", "1");
  const defaults = readDefaults();

  // Written only when they differ from the defaults, so a plain link stays short; an explicit "none" when a default is turned off.
  if (state.limit !== defaults.limit) params.set("limit", state.limit === null ? "" : String(state.limit));

  if (state.packages !== defaults.packages) params.set("packages", state.packages ? "1" : "0");

  if (state.overlays.join(",") !== defaults.overlays.join(",")) params.set("overlay", state.overlays.length > 0 ? state.overlays.join(",") : "none");

  if (state.mermaid !== defaults.mermaid) params.set("mermaid", state.mermaid);
  location.hash = params.toString();
}

const changesInput = element<HTMLInputElement>("changes");

const headInput = element<HTMLInputElement>("head");

/** The view a shape opens: a layer its modules, a module its imports, a function its calls. */
function ownView(node: DiagramNode): string | null {
  const id = node.ref?.id ?? node.id;

  switch (node.kind) {
    case "layer":
      return `layer:${id}`;
    case "module":
    case "participant":
      return `inside:${id}`;
    case "fn":
      return `calls:${id}`;
    case "more":
      return node.ref?.id ?? null;
    default:
      return null;
  }
}

/** The other pictures of the same subject: a module's dependencies or its inside, a function's call tree or its sequence. */
function siblingViews(view: string): { label: string; key: string }[] {
  const at = view.indexOf(":");
  const kind = view.slice(0, at);
  const rest = view.slice(at + 1);

  if (kind === "module" || kind === "inside" || kind === "contract" || kind === "cycle" || (kind === "classes" && rest !== "" && !rest.endsWith("/") && /\.[a-z]+$/.test(rest))) return [{ label: "dependencies", key: `module:${rest}` }, { label: "inside: functions and calls", key: `inside:${rest}` }, { label: "classes: fields and methods", key: `classes:${rest}` }, { label: "contract: exports and their users", key: `contract:${rest}` }, { label: "its import cycle", key: `cycle:${rest}` }];

  if (kind === "dir" || kind === "classes") return [{ label: "modules of the directory", key: `dir:${rest}` }, { label: "classes of the directory", key: `classes:${rest}` }];

  if (kind === "calls" || kind === "sequence" || kind === "path") return [{ label: "call tree", key: `calls:${rest}` }, { label: "sequence of calls", key: `sequence:${rest}` }, { label: "path to the storages", key: `path:${rest}` }];

  return [];
}

/** The path above a view, for the breadcrumbs: layers › layer › directories › module › function. */
function crumbsOf(view: string): { label: string; key: string }[] {
  const crumbs: { label: string; key: string }[] = [{ label: "layers", key: "layers" }];
  const at = view.indexOf(":");
  const kind = at === -1 ? view : view.slice(0, at);
  const rest = at === -1 ? "" : view.slice(at + 1);
  const layerOf = (module: string): string | null => views.find((entry) => entry.key === `module:${module}`)?.layer ?? null;

  const directories = (module: string): void => {
    const parts = module.split("/");

    for (let depth = 1; depth < parts.length; depth++) {
      const key = `dir:${parts.slice(0, depth).join("/")}`;

      if (views.some((entry) => entry.key === key)) crumbs.push({ label: `${parts[depth - 1]}/`, key });
    }
  };

  if (kind === "layer") crumbs.push({ label: rest, key: view });
  else if (kind === "dir") {
    const parts = rest.split("/");

    for (let depth = 1; depth <= parts.length; depth++) crumbs.push({ label: `${parts[depth - 1]}/`, key: `dir:${parts.slice(0, depth).join("/")}` });
  } else if (kind === "classes" && rest !== "") {
    const module = rest;
    const layer = layerOf(module);

    if (layer) crumbs.push({ label: layer, key: `layer:${layer}` });
    directories(module);
    crumbs.push({ label: module.slice(module.lastIndexOf("/") + 1), key: /\.[a-z]+$/.test(module) ? `module:${module}` : `dir:${module}` });
    crumbs.push({ label: "classes", key: view });
  } else if (["module", "inside", "contract", "cycle", "calls", "sequence", "path", "type"].includes(kind)) {
    const hash = rest.indexOf("#");
    const module = hash === -1 ? rest : rest.slice(0, hash);
    const layer = layerOf(module);

    if (layer) crumbs.push({ label: layer, key: `layer:${layer}` });
    directories(module);
    crumbs.push({ label: module.slice(module.lastIndexOf("/") + 1), key: `module:${module}` });

    if (kind === "inside" || kind === "contract" || kind === "cycle") crumbs.push({ label: kind, key: view });

    if (kind === "calls" || kind === "sequence" || kind === "path") crumbs.push({ label: rest.slice(hash + 1), key: `calls:${rest}` });

    if (kind === "sequence" || kind === "path") crumbs.push({ label: kind, key: view });

    if (kind === "type") crumbs.push({ label: `type ${rest.slice(hash + 1)}`, key: view });
  } else if (kind !== "layers") crumbs.push({ label: kind, key: view });

  return crumbs;
}

function renderTypeSelect(state: State): void {
  const select = element<HTMLSelectElement>("view-type");
  const siblings = state.review ? [] : siblingViews(state.view);
  select.replaceChildren();
  select.hidden = siblings.length === 0;

  for (const sibling of siblings) {
    const option = document.createElement("option");
    option.value = sibling.key;
    option.textContent = sibling.label;
    option.selected = sibling.key === state.view;
    select.append(option);
  }
}

function renderCrumbs(state: State): void {
  renderTypeSelect(state);
  const box = element<HTMLSpanElement>("crumbs");
  box.replaceChildren();

  if (state.review) {
    box.append("review");

    return;
  }

  const crumbs = crumbsOf(state.view);

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
  await showCode(node);
}

/** The page of a tapped line: what it joins and the imports and calls behind it. */
async function showEdge(edge: { from: string; to: string; kind: string }): Promise<void> {
  const state = stateFromHash();

  try {
    const { markdown } = await api.edge(state.view, edge.from, edge.to, edge.kind);
    setMarkdown(markdownPanel, markdown);
  } catch (error) {
    setMarkdown(markdownPanel, error instanceof Error ? error.message : String(error));
  }

  showTab("markdown");
}

// ── The left panel ───────────────────────────────────────────────────────────

function renderViews(filter: string): void {
  const state = stateFromHash();
  viewsList.replaceChildren();
  const needle = filter.trim().toLowerCase();
  const groups: [string, ViewEntry["kind"][]][] = [
    ["Overview", ["layers", "coverage", "classes", "matrix", "cycles", "events", "tests", "hotspots", "packages", "timeline"]],
    ["Layers", ["layer"]],
    ["Directories", ["dir"]],
    ["Entry points (call flows)", ["calls"]],
    ["Types (where they flow)", ["type"]],
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

function renderExports(view: string, base: string | null, head: string | null = null, heads: string[] = []): void {
  exportLinks.replaceChildren();

  const now = stateFromHash();
  const extra = `${now.overlays.length > 0 ? `&overlay=${encodeURIComponent(now.overlays.join(","))}` : ""}${now.changes ? "&changes=1" : ""}${now.limit !== null ? `&limit=${now.limit}` : ""}${now.packages ? "&packages=1" : ""}`;

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
    pick: (id, edge) => {
      // A tap lights what it picked: a line with its two ends; a shape or nothing puts the light out.
      canvas?.highlight(edge && id ? [id, edge.from, edge.to] : []);

      if (edge) void showEdge(edge);
      else void showNode(id);
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
  const scene = await api.scene(now.view, { depth: now.depth, limit: now.limit, packages: now.packages, changes: false, overlays: now.overlays, mermaid: now.mermaid, base: null, head: null });
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
  element<HTMLSelectElement>("mermaid").value = state.mermaid;

  for (const box of document.querySelectorAll<HTMLInputElement>("#options .overlay")) box.checked = state.overlays.includes(box.value);
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
      await ensureCanvas(result.elements);
      reason.textContent = result.diagram.reason ?? "";
      reason.title = reason.textContent;
      renderExports("compare", baseInput.value.trim() || null, null, state.heads);
      element("commits").hidden = true;
      void loadBranches(state);
    } else if (state.review) {
      const result = await api.review(baseInput.value.trim() || null, state.head);
      title.textContent = `${result.diagram.title} — ${result.diff.changedFiles.length} source files changed${result.diff.layerEdgesAdded.length > 0 ? ` — ⚠ ${result.diff.layerEdgesAdded.length} new layer dependencies` : ""}`;
      diagramMarkdown = result.markdown;
      nodes = new Map(result.diagram.nodes.map((node) => [node.id, node]));
      await ensureCanvas(result.elements);
      reason.textContent = result.diagram.reason ?? "";
      reason.title = reason.textContent;
      renderExports(`review:${result.diff.base}`, baseInput.value.trim() || null, state.head);
      void loadCommits(state);
      void loadBranches(state);
    } else {
      const result = await api.scene(state.view, { depth: state.depth, limit: state.limit, packages: state.packages, changes: state.changes, overlays: state.overlays, mermaid: state.mermaid, base: state.view === "timeline" || state.changes ? baseInput.value.trim() || null : null, head: state.view === "timeline" || state.changes ? state.head : null });
      title.textContent = `${result.diagram.title}${result.drawn ? " (drawn by hand)" : ""}`;
      diagramMarkdown = result.markdown;
      nodes = new Map(result.diagram.nodes.map((node) => [node.id, node]));
      mocks = result.mocks;
      await ensureCanvas(result.elements);
      reason.textContent = result.diagram.reason ?? "";
      reason.title = reason.textContent;
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
  const { flow } = await api.flow(state.view, state.depth);
  lastFlow = flow;
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
  row.className = `ev ${kind}`;
  row.textContent = text;
  transcript.append(row);
  transcript.scrollTop = transcript.scrollHeight;
}

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

function runTask(written: string, resume: string | null): void {
  if (!agentName || written.trim() === "") return;
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
          runState.textContent = `${agentName} finished; the diagram is reloaded — compare with review`;
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
runButton.addEventListener("click", () => runTask(taskField.value, null));
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
element<HTMLSelectElement>("view-type").addEventListener("change", () => setHash({ ...stateFromHash(), view: element<HTMLSelectElement>("view-type").value, review: false }));
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
depthInput.addEventListener("change", () => setHash({ ...stateFromHash(), depth: depthInput.value === "" ? null : Number(depthInput.value) }));
packagesInput.addEventListener("change", () => setHash({ ...stateFromHash(), packages: packagesInput.checked }));
changesInput.addEventListener("change", () => setHash({ ...stateFromHash(), changes: changesInput.checked }));
element<HTMLInputElement>("limit").addEventListener("change", () => {
  const value = element<HTMLInputElement>("limit").value;
  setHash({ ...stateFromHash(), limit: value === "" ? null : Math.max(1, Number(value)) });
});
element<HTMLSelectElement>("mermaid").addEventListener("change", () => setHash({ ...stateFromHash(), mermaid: element<HTMLSelectElement>("mermaid").value }));

for (const box of document.querySelectorAll<HTMLInputElement>("#options .overlay")) {
  box.addEventListener("change", () => {
    const overlays = [...document.querySelectorAll<HTMLInputElement>("#options .overlay:checked")].map((checked) => checked.value);
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
  const defaults: Defaults = { depth: now.depth, limit: now.limit, packages: now.packages, overlays: now.overlays, mermaid: now.mermaid };

  try {
    localStorage.setItem("archdiff.defaults", JSON.stringify(defaults));
    reason.textContent = "options remembered as the defaults of this browser";
  } catch {
    reason.textContent = "no storage: the options last this page";
  }

  applyOptions(now);
});
element<HTMLButtonElement>("options-reset").addEventListener("click", () => {
  try {
    localStorage.removeItem("archdiff.defaults");
  } catch {
    // Nothing stored.
  }

  applyOptions({ ...stateFromHash(), depth: null, limit: null, packages: false, overlays: [], mermaid: "auto", changes: false });
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
