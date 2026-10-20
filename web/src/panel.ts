// The side panels. On the right, the tabs: the Markdown of the picture or
// of what is picked on it (rendered, or raw), the code a shape stands
// for, the coverage report, and the flow, the chat and the spec of their
// own modules; the copy button takes the active tab's text. The Markdown
// tab shows the picture's page until a shape, a line or a selection is
// picked, and `showPicturePage` brings it back. A rendered page is a
// navigation too: its sections fold by their headings (which stay folded
// across pages, remembered), a module or a function named in bold opens
// its view, and a module's bullet unfolds its functions. Both side panels
// fold away, remembered in this browser.
//
// Entry points: `showTab`, `renderMarkdown`, `setMarkdown`, `showCode`,
// `renderCode`, `copyText`, `setPicturePage`, `showPicturePage`,
// `picturePageMarkdown`, `markdownPanel`, `loadCoverage`, `togglePanel`.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { api, type Shape } from "./api.ts";
import { transcript } from "./chat.ts";
import { element, remember, remembered } from "./dom.ts";
import { flowText } from "./flow-tab.ts";
import { codeHead, currentLink, setLink } from "./link.ts";
import { fnView, functionsOf, isFilePath } from "./modules.ts";
import { page } from "./page.ts";
import { loadSpecs, specTextOf } from "./spec-tab.ts";

export const markdownPanel = element<HTMLDivElement>("markdown");
const codePanel = element<HTMLPreElement>("code");
const coveragePanel = element<HTMLDivElement>("coverage");

/** Markdown shown as its source rather than rendered (the raw toggle). */
let rawMarkdown = false;
/** The Markdown of the current picture, shown again when nothing is picked. */
let picturePage = "";

/** A `file:line` in a page's code spans, of a source file of the five languages: a click shows the code. */
const CODE_REFERENCE = /^([\w./@-]+\.(?:[cm]?[jt]sx?|py|rs|php))(?::(\d+))?$/;

/** Where this browser keeps the headings the reader folded: a section folded on one page stays folded on the next with that heading. */
const FOLDED_KEY = "archdiff.folded.v1";

const folded = new Set<string>(readFolded());

function readFolded(): string[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]");

    return Array.isArray(kept) ? kept.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function rememberFolded(): void {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
  } catch {
    // No storage: the folds last the page.
  }
}

/**
 * Each heading of `tag` with what follows it, up to the next heading of its level or a higher one, becomes a folding
 * section with the heading as its summary; the sections the reader folded before stay folded.
 */
function foldSections(target: HTMLElement, tag: "h2" | "h3"): void {
  const above = tag === "h2" ? ["H1", "H2"] : ["H1", "H2", "H3"];

  for (const heading of [...target.querySelectorAll<HTMLElement>(tag)]) {
    if (heading.closest("summary")) continue;
    const title = (heading.textContent ?? "").trim();
    const details = document.createElement("details");
    details.className = "section";
    details.open = !folded.has(title);
    const summary = document.createElement("summary");
    heading.replaceWith(details);
    summary.append(heading);
    details.append(summary);

    // The section's body: every sibling up to the next heading of this level or above.
    for (let next = details.nextSibling; next && !(next instanceof HTMLElement && above.includes(next.tagName)); next = details.nextSibling) details.append(next);

    details.addEventListener("toggle", () => {
      if (details.open) folded.delete(title);
      else folded.add(title);
      rememberFolded();
    });
  }
}

/** A module or a function named in bold (`**src/x.ts**`, `**src/x.ts#f**`) opens its view with the centre as it is. */
function linkNames(target: HTMLElement): void {
  const keys = new Set(page.views().map((entry) => entry.key));

  for (const strong of target.querySelectorAll("strong")) {
    const name = (strong.textContent ?? "").trim();

    if (!isFilePath(name)) continue;
    strong.classList.add("link");
    strong.title = name.includes("#") ? "Open the function's view" : "Open the module's view";
    strong.addEventListener("click", () => setLink({ ...currentLink(), view: name.includes("#") ? fnView(name, keys) : `module:${name}` }));
  }
}

/** A bullet that names a module gets a caret: open, it lists the module's functions (read once), each opening its view. */
function unfoldModules(target: HTMLElement): void {
  const keys = new Set(page.views().map((entry) => entry.key));

  for (const item of target.querySelectorAll("li")) {
    const strong = item.firstElementChild;

    if (!(strong instanceof HTMLElement) || strong.tagName !== "STRONG") continue;
    const path = (strong.textContent ?? "").trim();

    if (!isFilePath(path) || path.includes("#")) continue;
    const caret = document.createElement("span");
    caret.className = "fold";
    caret.textContent = "▸";
    caret.title = "The module's functions";
    item.prepend(caret);
    let list: HTMLUListElement | null = null;
    caret.addEventListener("click", () => {
      if (list) {
        list.hidden = !list.hidden;
        caret.textContent = list.hidden ? "▸" : "▾";

        return;
      }

      list = document.createElement("ul");
      list.className = "fns";
      list.append(Object.assign(document.createElement("li"), { className: "muted", textContent: "loading…" }));
      item.append(list);
      caret.textContent = "▾";
      void functionsOf(path).then((functions) => {
        list!.replaceChildren(...functions.map((fn) => {
          const name = document.createElement("strong");
          name.className = "link";
          name.textContent = fn.name;
          name.title = "Open the function's view";
          name.addEventListener("click", () => setLink({ ...currentLink(), view: fnView(fn.id, keys) }));
          const at = document.createElement("code");
          at.className = "link";
          at.textContent = `${path}:${fn.line}`;
          at.title = "Show the code";
          at.addEventListener("click", () => void showCode({ id: fn.id, kind: "fn", label: fn.name, ref: { file: path, line: fn.line }, x: 0, y: 0, w: 0, h: 0 }));
          const row = document.createElement("li");
          row.append(name, " — ", at);

          return row;
        }));

        if (functions.length === 0) list!.append(Object.assign(document.createElement("li"), { className: "muted", textContent: "no function of its own" }));
      });
    });
  }
}

export function showTab(name: string): void {
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
export async function copyText(text: string): Promise<boolean> {
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

// ── Markdown ──────────────────────────────────────────────────────────────────

/** Markdown as HTML (sanitised: a doc comment of the repository is not trusted), or as text when the raw toggle is on. */
export function renderMarkdown(target: HTMLElement, markdown: string): void {
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

  // The page as a navigation: folding sections, names that open views, bullets that unfold a module's functions.
  foldSections(target, "h2");
  foldSections(target, "h3");
  linkNames(target);
  unfoldModules(target);

  // A `file:line` in the text opens the code (once a picture is shown, so the server has the repository read).
  for (const code of target.querySelectorAll("code")) {
    const text = code.textContent ?? "";
    const match = text.match(CODE_REFERENCE);

    if (match && page.nodes().size > 0) {
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

/** Shows Markdown in a panel and keeps its source for the raw toggle and the copy button. */
export function setMarkdown(target: HTMLElement, markdown: string): void {
  target.dataset["markdown"] = markdown;
  renderMarkdown(target, markdown);
}

/** The Markdown of a new picture, shown now and kept for when nothing is picked. */
export function setPicturePage(markdown: string): void {
  picturePage = markdown;
  setMarkdown(markdownPanel, markdown);
}

/** The current picture's Markdown back on the Markdown tab. */
export function showPicturePage(): void {
  setMarkdown(markdownPanel, picturePage);
}

/** The Markdown of the current picture, for the centre when it shows the page. */
export function picturePageMarkdown(): string {
  return picturePage;
}

// ── Code and coverage ────────────────────────────────────────────────────────

/** The files each code element has asked for: only the newest one is drawn in it. */
const codeLoads = new WeakMap<HTMLElement, number>();

/**
 * The code of a shape in `target`: the file, line by line with its numbers, the shape's lines marked (a module's
 * are not: the whole file is the shape); the first marked line comes back, for the caller to scroll to. A file asked
 * for after this one draws instead: the code of the shape picked last, however slow the first was. Null when the
 * shape has no file, or the file could not be read: the element says so, or is empty.
 */
export async function renderCode(target: HTMLElement, node: Shape): Promise<HTMLElement | null> {
  const file = node.ref?.file;
  const mine = (codeLoads.get(target) ?? 0) + 1;
  codeLoads.set(target, mine);

  if (!file) {
    // Nothing to copy either: the last file's text would pass for this shape's.
    target.textContent = "";
    delete target.dataset["text"];

    return null;
  }

  let text: string;

  try {
    text = await api.file(file, codeHead(currentLink()));
  } catch (error) {
    if (mine !== codeLoads.get(target)) return null;
    target.textContent = error instanceof Error ? error.message : String(error);
    delete target.dataset["text"];

    return null;
  }

  if (mine !== codeLoads.get(target)) return null;

  const from = node.ref?.line ?? 1;
  const to = node.ref?.endLine ?? from;
  const mark = node.kind !== "module";
  target.replaceChildren();
  target.dataset["text"] = text;
  const lines = text.split("\n");
  let first: HTMLElement | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = document.createElement("span");
    line.className = `line${mark && i + 1 >= from && i + 1 <= to ? " hit" : ""}`;
    const number = document.createElement("span");
    number.className = "n";
    number.textContent = String(i + 1);
    line.append(number, lines[i] ?? "");
    target.append(line);

    if (i + 1 === from) first = line;
  }

  target.prepend(Object.assign(document.createElement("div"), { className: "muted", textContent: `${file}${from > 1 ? `:${from}` : ""}` }));

  return first;
}

/** The code of a shape on the Code tab: the file with the shape's lines marked and scrolled into view. */
export async function showCode(node: Shape): Promise<void> {
  const first = await renderCode(codePanel, node);

  // No file, or one that could not be read: the panel says so where it is, without coming to the front.
  if (codePanel.dataset["text"] === undefined) return;
  showTab("code");
  first?.scrollIntoView({ block: "center" });
}

/** The coverage report of the analysis: what it read, what it could not, and why. */
export async function loadCoverage(): Promise<void> {
  try {
    const report = await api.coverage(codeHead(currentLink()));
    setMarkdown(coveragePanel, report.markdown);
  } catch (error) {
    setMarkdown(coveragePanel, error instanceof Error ? error.message : String(error));
  }
}

// ── Folding the side panels ──────────────────────────────────────────────────

/** Folds a side panel away or back (Ctrl+B the left, Ctrl+] the right); the choice is remembered in this browser. */
export function togglePanel(side: "left" | "right", force?: boolean): void {
  const hidden = document.body.classList.toggle(`hide-${side}`, force);
  remember(`archdiff.hide-${side}`, hidden);
}

element<HTMLButtonElement>("toggle-left").addEventListener("click", () => togglePanel("left"));
element<HTMLButtonElement>("toggle-right").addEventListener("click", () => togglePanel("right"));

if (remembered("archdiff.hide-left")) document.body.classList.add("hide-left");

if (remembered("archdiff.hide-right")) document.body.classList.add("hide-right");
