// The words of the page in the reader's language: English, as the page is
// written, or Ukrainian (i18n-uk.ts). The language is the user's setting,
// which the server writes into the page it serves (`<html lang>`), so the
// page knows it before it draws a word.
//
// A text is named by its English: `t("fit")` is "fit" in English and its
// translation otherwise, the English again when none is written — a text
// added without a translation shows in English, never as a blank. `{name}`
// in a text is filled from the values given. The page as index.html holds
// it (the labels, the hints of the `title`s, the placeholders, the notes)
// is translated once, here, as the page starts: by the same English.
//
// What archdiff writes about the code — a picture's page, the Mermaid, the
// names on the canvas — is not the page's own words and stays as it is.
//
// A text the page shares with the command line — a group's heading of the
// views, what a chat command does (src/view-keys.ts, src/chat-commands.ts)
// — is written there once, in English; `translated` says it in the page's
// language from the same table, and the tests hold the table to every one.
//
// Entry points: `t`, `translated`, `language`, `translate`, `untranslated`.

import { isPageLanguage, type PageLanguage } from "../../src/page-language.ts";
import { UK } from "./i18n-uk.ts";

/** What a text takes in place of its `{name}` marks. */
export type Values = Readonly<Record<string, string | number>>;

/** A translation: the text, or — where the words turn on a number — what makes the text from the values. */
export type Translation = string | ((values: Values) => string);

const asked = document.documentElement.lang;

/** The language the page speaks. */
export const language: PageLanguage = isPageLanguage(asked) ? asked : "en";

const TABLES: Readonly<Record<PageLanguage, Readonly<Record<string, Translation>> | null>> = { en: null, uk: UK };
const table = TABLES[language];

/** The texts asked for that the language has no translation of: shown in English, and listed for the tests. */
const missing = new Set<string>();

function fill(text: string, values: Values): string {
  return text.replace(/\{(\w+)\}/g, (mark, name: string) => (name in values ? String(values[name]) : mark));
}

/** The text in the page's language, its `{name}` marks filled from `values`. */
export function t(text: string, values: Values = {}): string {
  const said = table?.[text];

  if (said === undefined) {
    if (table) missing.add(text);

    return fill(text, values);
  }

  return typeof said === "function" ? said(values) : fill(said, values);
}

/** A text archdiff's shared modules write (a group's heading, what a command does) in the page's language; never a text of the repository or of the server's own making. */
export function translated(text: string): string {
  return t(text);
}

/** The texts the page asked for and showed in English for want of a translation. */
export function untranslated(): string[] {
  return [...missing];
}

/** A text of the page's own HTML as the table names it: its spaces and line ends as one space. */
function plain(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The translation of a text of index.html, or null in English and for a text the table does not hold (kept, and listed). */
function said(text: string): string | null {
  const key = plain(text);

  if (!table || key === "" || !/\p{L}/u.test(key)) return null;
  const found = table[key];

  if (typeof found === "string") return found;
  missing.add(key);

  return null;
}

/**
 * Translates what index.html wrote under `root`: the hints (`title`), the placeholders, the labels, and the text
 * itself. A paragraph is one text with its marks (`<em>`, `<code>`) — a sentence is not translated by its halves — the
 * rest piece by piece. An element marked `data-keep` holds what is not the page's words (a path, the code) and is left.
 */
export function translate(root: ParentNode = document.body): void {
  if (!table) return;

  for (const element of root.querySelectorAll<HTMLElement>("[title], [placeholder], [aria-label], [label]")) {
    for (const attribute of ["title", "placeholder", "aria-label", "label"]) {
      const value = element.getAttribute(attribute);
      const text = value === null ? null : said(value);

      if (text !== null) element.setAttribute(attribute, text);
    }
  }

  for (const paragraph of root.querySelectorAll<HTMLElement>("p")) {
    if (paragraph.childElementCount === 0) continue;
    const found = table[plain(paragraph.innerHTML)];

    // The table's own text, written beside the page: its marks are the page's.
    if (typeof found === "string") paragraph.innerHTML = found;
    else missing.add(plain(paragraph.innerHTML));
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);

  for (const node of texts) {
    const parent = node.parentElement;

    if (!parent || parent.closest("script, style, [data-keep]") || (parent.closest("p")?.childElementCount ?? 0) > 0) continue;
    const text = said(node.data);

    // The spaces around the text stay: they part it from the field or the button beside it.
    if (text !== null) node.data = node.data.replace(node.data.trim(), text);
  }
}

translate();
