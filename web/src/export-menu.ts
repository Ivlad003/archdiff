// The export menu of the header: the picture as the link shows it (every
// option of options.ts and the refs) in each format the server writes,
// and the Mermaid types that read better for some views. A link per
// format: the browser downloads what the server answers.
//
// Entry point: `renderExports`.

import { api } from "./api.ts";
import { element, h } from "./dom.ts";
import { t } from "./i18n.ts";
import { refsOf, type Link } from "./link.ts";
import type { MermaidStyle } from "../../src/options.ts";
import { mermaidTypesOf, parseView, type ViewKind } from "../../src/view-keys.ts";

const FORMATS = ["mermaid", "drawio", "excalidraw", "archimate", "json"] as const;

/** How the menu names a Mermaid type that reads better than the default for some kinds of view (the table of kinds says which). */
const MERMAID_LABELS: Partial<Record<MermaidStyle, string>> = { quadrant: "mermaid: quadrant chart", c4: "mermaid: C4 context", pie: t("mermaid: pie of modules"), mindmap: "mermaid: mindmap" };

/** The Mermaid types the kind offers besides the default, each with its label. */
function mermaidStylesOf(kind: ViewKind | undefined): [MermaidStyle, string][] {
  return kind === undefined ? [] : mermaidTypesOf(kind).flatMap((style) => (MERMAID_LABELS[style] === undefined ? [] : [[style, MERMAID_LABELS[style]] as [MermaidStyle, string]]));
}

export function renderExports(state: Link): void {
  const links = element<HTMLDivElement>("export");
  links.replaceChildren();
  const refs = refsOf(state);

  for (const format of FORMATS) links.append(h("a", { href: api.exportUrl(state.view, format, state, refs), title: t("Download the diagram as {format}", { format }) }, format === "mermaid" && state.mermaid !== "auto" ? `mermaid (${state.mermaid})` : format));

  for (const [style, label] of mermaidStylesOf(parseView(state.view)?.kind)) links.append(h("a", { href: api.exportUrl(state.view, "mermaid", { ...state, mermaid: style }, refs) }, label));
  const view = parseView(state.view);

  // An APIs picture downloads as a Postman collection too: every family's operations, or the one family the picture is of.
  if (view?.kind === "apis") links.append(h("a", { href: api.postmanUrl(view.subject !== null && !/[/.]/.test(view.subject) ? view.subject : null, refs.head), title: t("Download the operations as a Postman collection") }, t("postman collection")));
}

// A pick in the menu downloads; the menu closes behind it.
element<HTMLDivElement>("export").addEventListener("click", () => element<HTMLDetailsElement>("export-menu").removeAttribute("open"));

// The list is fixed, as the options are: the header clips what overflows it, and the list hung under its button was cut
// to nothing. Placed under the button when it opens, its right edge at the button's, kept inside the window.
const menu = element<HTMLDetailsElement>("export-menu");
menu.addEventListener("toggle", () => {
  if (!menu.open) return;
  const summary = menu.querySelector("summary")!.getBoundingClientRect();
  const list = element<HTMLDivElement>("export");
  list.style.top = `${summary.bottom + 4}px`;
  list.style.left = `${Math.max(8, Math.min(summary.right - list.offsetWidth, window.innerWidth - list.offsetWidth - 8))}px`;
});
