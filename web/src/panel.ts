// The side panels. On the right, the tabs: the Markdown of the picture or
// of what is picked on it (rendered, or raw), the code a shape stands
// for, the coverage report, and the flow, the chat and the spec of their
// own modules; the copy button takes the active tab's text. The Markdown
// tab shows the picture's page until a shape, a line or a selection is
// picked, and `showPicturePage` brings it back. Both side panels fold
// away, remembered in this browser.
//
// Entry points: `showTab`, `renderMarkdown`, `setMarkdown`, `showCode`,
// `copyText`, `setPicturePage`, `showPicturePage`, `markdownPanel`,
// `loadCoverage`, `togglePanel`.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { api, type Shape } from "./api.ts";
import { transcript } from "./chat.ts";
import { element, remember, remembered } from "./dom.ts";
import { flowText } from "./flow-tab.ts";
import { codeHead, currentLink } from "./link.ts";
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

// ── Code and coverage ────────────────────────────────────────────────────────

/** The code of a shape: the file with the shape's lines marked and scrolled into view. */
/** The files the Code tab has asked for: only the newest one is drawn. */
let codeLoads = 0;

export async function showCode(node: Shape): Promise<void> {
  const file = node.ref?.file;
  // A file asked for after this one draws instead: the code of the shape picked last, however slow the first was.
  const mine = ++codeLoads;

  if (!file) {
    // Nothing to copy either: the last file's text would pass for this shape's.
    codePanel.textContent = "";
    delete codePanel.dataset["text"];

    return;
  }

  let text: string;

  try {
    text = await api.file(file, codeHead(currentLink()));
  } catch (error) {
    if (mine !== codeLoads) return;
    codePanel.textContent = error instanceof Error ? error.message : String(error);
    delete codePanel.dataset["text"];

    return;
  }

  if (mine !== codeLoads) return;

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
