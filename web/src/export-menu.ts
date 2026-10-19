// The export menu of the header: the picture as the link shows it (every
// option of options.ts and the refs) in each format the server writes,
// and the Mermaid types that read better for some views. A link per
// format: the browser downloads what the server answers.
//
// Entry point: `renderExports`.

import { api } from "./api.ts";
import { element, h } from "./dom.ts";
import { refsOf, type Link } from "./link.ts";
import type { MermaidStyle } from "../../src/options.ts";
import { parseView } from "../../src/view-keys.ts";

const FORMATS = ["mermaid", "drawio", "excalidraw", "archimate", "json"] as const;

/** The Mermaid types that read better than the default for a kind of view. */
function mermaidStylesOf(kind: string | undefined): [MermaidStyle, string][] {
  if (kind === "hotspots") return [["quadrant", "mermaid: quadrant chart"]];

  if (kind === "layers" || kind === "packages") return [["c4", "mermaid: C4 context"], ["pie", "mermaid: pie of modules"]];

  if (kind === "dir" || kind === "layer") return [["mindmap", "mermaid: mindmap"]];

  return [];
}

export function renderExports(state: Link): void {
  const links = element<HTMLDivElement>("export");
  links.replaceChildren();
  const refs = refsOf(state);

  for (const format of FORMATS) links.append(h("a", { href: api.exportUrl(state.view, format, state, refs), title: `Download the diagram as ${format}` }, format === "mermaid" && state.mermaid !== "auto" ? `mermaid (${state.mermaid})` : format));

  for (const [style, label] of mermaidStylesOf(parseView(state.view)?.kind)) links.append(h("a", { href: api.exportUrl(state.view, "mermaid", { ...state, mermaid: style }, refs) }, label));
  const view = parseView(state.view);

  // An APIs picture downloads as a Postman collection too: every family's operations, or the one family the picture is of.
  if (view?.kind === "apis") links.append(h("a", { href: api.postmanUrl(view.subject !== null && !view.subject.includes("/") ? view.subject : null, refs.head), title: "Download the operations as a Postman collection" }, "postman collection"));
}

// A pick in the menu downloads; the menu closes behind it.
element<HTMLDivElement>("export").addEventListener("click", () => element<HTMLDetailsElement>("export-menu").removeAttribute("open"));
