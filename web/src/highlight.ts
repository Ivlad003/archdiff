// The colours of code: the keywords, strings, comments, numbers and names
// of a file's language, for the Code tab, the code in the centre and the
// code blocks of a page. highlight.js reads the text (the core and the
// languages named here, not its whole catalogue: the page stays small);
// the language is the file's extension, or the name a Markdown block gives.
// A file of a language not named here, or a very long one, stays plain.
//
// The Code tab draws a file line by line (a number, a tint for a changed
// line), and a token may run over many lines — a block comment, a template
// string — so `highlightedLines` cuts the coloured text at the line ends
// and opens every token again on the next line.
//
// Entry points: `languageOf`, `highlightedLines`, `highlightBlock`.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, python, ruby, rust, scss, sql, typescript, xml, yaml };

for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

/** The language of a file by its extension (or its whole name, for a file without one). */
const BY_EXTENSION: Readonly<Record<string, keyof typeof LANGUAGES>> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", rs: "rust", php: "php", go: "go", java: "java", cs: "csharp", kt: "kotlin", kts: "kotlin", rb: "ruby",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", properties: "ini",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", isml: "xml", xsd: "xml",
  css: "css", scss: "scss", less: "scss", sh: "bash", bash: "bash", zsh: "bash", sql: "sql", md: "markdown", markdown: "markdown",
  diff: "diff", patch: "diff", dockerfile: "dockerfile",
};

/** The names a Markdown block may give a language by, beside the language's own. */
const BY_NAME: Readonly<Record<string, keyof typeof LANGUAGES>> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", rs: "rust", "c#": "csharp", cs: "csharp", sh: "bash", shell: "bash", yml: "yaml", html: "xml", toml: "ini", golang: "go", kt: "kotlin", rb: "ruby", "c++": "cpp" };

/** Longer than this, a text stays plain: the colours are not worth a page that waits. */
const LONGEST = 400_000;

/** The language a file is read in, by its name; null for one the page has no colours for. */
export function languageOf(file: string): string | null {
  const name = file.split("/").pop()!.toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;

  return BY_EXTENSION[extension] ?? null;
}

/** The text as highlight.js marks it (its own escaped HTML: spans of `hljs-…` classes around the text); null when it is left plain. */
function marked(text: string, language: string): string | null {
  if (text.length > LONGEST || !hljs.getLanguage(language)) return null;

  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/**
 * The lines of a file in its colours: for every line of `text`, the nodes to put after its number. A token that runs
 * over a line's end is opened again on the next line, so every line stands by itself. Null when the file stays plain
 * (a language not known, a text too long).
 */
export function highlightedLines(text: string, language: string | null): Node[][] | null {
  const html = language === null ? null : marked(text, language);

  if (html === null) return null;
  const template = document.createElement("template");
  // highlight.js's own output: the file's text escaped, in spans of its classes.
  template.innerHTML = html;
  const lines: Node[][] = [[]];

  /** A piece of one line inside the spans open around it, the outermost first. */
  const piece = (part: string, classes: readonly string[]): Node => {
    let node: Node = document.createTextNode(part);

    for (let i = classes.length - 1; i >= 0; i--) {
      const span = document.createElement("span");
      span.className = classes[i]!;
      span.append(node);
      node = span;
    }

    return node;
  };

  const walk = (node: Node, classes: readonly string[]): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const [i, part] of (node.textContent ?? "").split("\n").entries()) {
        if (i > 0) lines.push([]);

        if (part !== "") lines[lines.length - 1]!.push(piece(part, classes));
      }
    } else if (node instanceof HTMLElement) {
      for (const child of node.childNodes) walk(child, [...classes, node.className]);
    }
  };

  for (const child of template.content.childNodes) walk(child, []);

  // The lines must be the file's own, one for one: a text whose line ends the reading above took otherwise (a lone
  // carriage return, which it reads as a line's end) stays plain rather than wear its colours a line off.
  return lines.length === text.split("\n").length ? lines : null;
}

/** A code block of a page in the colours of the language its class names (`language-ts`); one of no known language stays as it is. */
export function highlightBlock(code: HTMLElement): void {
  const named = [...code.classList].find((name) => name.startsWith("language-"))?.slice("language-".length).toLowerCase();

  if (named === undefined) return;
  const html = marked(code.textContent ?? "", BY_NAME[named] ?? named);

  if (html === null) return;
  // highlight.js's own output over the block's text, which it escapes.
  code.innerHTML = html;
  code.classList.add("hljs");
}
