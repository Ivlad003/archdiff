// How the centre of the page shows a view, as the link says (`as`): the
// canvas (Excalidraw, the default), the same picture in 3D (three-view.ts,
// a chunk loaded when first asked for), the view's Markdown page, or the
// code of its subject — the file the view names, a function's lines
// marked. The 3D scene and the reader cover the canvas,
// which stays mounted beneath with the picture on it; the tools of the
// canvas alone, the minimap and the legend hide meanwhile (page.css, by
// `body[data-as]`). Takes the page as its context (page.ts).
//
// Entry points: `markPresentation`, `applyPresentation`, `fitPresentation`,
// `presentationState` (for the browser tests).

import type { Diagram, Shape } from "./api.ts";
import { element } from "./dom.ts";
import { currentLink, type Link, type Presentation } from "./link.ts";
import { page } from "./page.ts";
import { picturePageMarkdown, renderCode, renderMarkdown } from "./panel.ts";
import { openShape, tap } from "./picking.ts";
import { parseView, subjectFile } from "../../src/view-keys.ts";

type ThreeModule = typeof import("./three-view.ts");

/** The 3D module, loading or loaded: a chunk of its own, fetched when the centre first shows a picture in 3D. */
let threeLoading: Promise<ThreeModule> | null = null;
/** The 3D module once it arrived, for the calls that cannot wait (the fit, the state). */
let three: ThreeModule | null = null;

/** What the hint under the title says for each presentation; the canvas's is the page's own. */
const HINTS: Record<Exclude<Presentation, "canvas">, string> = {
  "3d": "drag to orbit · wheel to zoom · right-drag to pan · tap a block for its code · double-tap it to open its own view · 0 fits",
  markdown: "the page of this view · a file:line in it opens the code on the right",
  code: "the code of the view's subject · double-tap a shape on the canvas or in 3D for its own view, then its code · the picture's page is on the right",
};

/** The hint of the canvas, as index.html writes it, to put back. */
const canvasHint = element("hint").textContent ?? "";

/** The presentation on the body, for the styles, as soon as the link is read (before the picture arrives). */
export function markPresentation(state: Link): void {
  document.body.dataset["as"] = state.as;
}

/**
 * The centre as the link says, once the picture is drawn: the 3D scene of the diagram, the Markdown page, the code
 * of the subject — or the canvas alone, the others hidden. `diagram` is null when no picture could be drawn: the
 * canvas says why in the middle, and the others show nothing.
 */
export async function applyPresentation(state: Link, diagram: Diagram | null): Promise<void> {
  markPresentation(state);
  const box = element<HTMLDivElement>("three");
  const reader = element<HTMLDivElement>("reader");
  element("hint").textContent = state.as === "canvas" ? canvasHint : HINTS[state.as];

  if (state.as !== "3d") {
    box.hidden = true;
    three?.hideThree();
  }

  if (state.as === "3d") {
    reader.hidden = true;
    box.hidden = false;
    threeLoading ??= import("./three-view.ts");
    three = await threeLoading;

    // A tap goes where the canvas's goes: the shape on the right; a double tap opens the shape's own view.
    if (diagram) three.showThree(box, state.view, diagram, { pick: (id) => tap(id), open: (id) => openShape(id) });
    else three.hideThree();

    return;
  }

  if (state.as === "canvas") {
    reader.hidden = true;

    return;
  }

  reader.hidden = false;
  const note = element<HTMLDivElement>("reader-note");
  const body = element<HTMLDivElement>("reader-body");
  const code = element<HTMLPreElement>("reader-code");
  note.hidden = true;
  body.hidden = true;
  code.hidden = true;

  if (state.as === "markdown") {
    body.hidden = false;
    renderMarkdown(body, diagram ? picturePageMarkdown() : "");
    reader.scrollTop = 0;

    return;
  }

  // The code of the subject's file; a view without one (an overview, a layer, a directory) says so over its page.
  const node = diagram ? codeSubject(state) : null;

  if (!node) {
    note.hidden = false;
    note.textContent = "This view has no file of its own, so its page is shown instead. Double-tap a shape on the canvas or in 3D for its own view, then show that as code.";
    body.hidden = false;
    renderMarkdown(body, diagram ? picturePageMarkdown() : "");

    return;
  }

  code.hidden = false;
  const first = await renderCode(code, node);
  first?.scrollIntoView({ block: "center" });
}

/** The shape whose code the centre shows: the shape of the view's subject (a function's lines marked), else the file the subject names. */
function codeSubject(state: Link): Shape | null {
  const view = parseView(state.view);
  const file = subjectFile(view);

  if (!file) return null;
  const own = page.nodes().get(view!.subject!);

  // The subject's shape when the picture holds it (its lines marked); else the file itself, whole.
  return own?.ref?.file ? own : { id: view!.subject!, kind: "module", label: view!.subject!, ref: { file: file.file }, x: 0, y: 0, w: 0, h: 0 };
}

/** Fits what the centre shows: the 3D scene, or the canvas's picture. */
export function fitPresentation(): void {
  if (currentLink().as === "3d" && three) three.fitThree();
  else page.canvas()?.scrollToContent();
}

/** For the browser tests: the presentation shown, whether the reader is up, and what the 3D scene holds. */
export function presentationState(): { as: Presentation; reader: boolean; three: ReturnType<ThreeModule["threeState"]> | null } {
  return { as: currentLink().as, reader: !element<HTMLDivElement>("reader").hidden, three: three?.threeState() ?? null };
}
