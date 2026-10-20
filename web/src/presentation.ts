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

import type { Diagram } from "./api.ts";
import { element } from "./dom.ts";
import { currentLink, presentationOf, type Link, type Presentation } from "./link.ts";
import { page } from "./page.ts";
import { picturePageMarkdown, renderCode, renderMarkdown, type CodeSpot } from "./panel.ts";
import { openShape, tap } from "./picking.ts";
import { parseView, subjectFile } from "../../src/view-keys.ts";

type ThreeModule = typeof import("./three-view.ts");

/** The 3D module once it arrived: a chunk of its own, fetched when the centre first shows a picture in 3D. */
let three: ThreeModule | null = null;

/** The 3D module, fetched on the first ask; null when the browser could not load the chunk (the box says so), asked again next time. */
async function loadThree(box: HTMLElement): Promise<ThreeModule | null> {
  if (three) return three;

  try {
    three = await import("./three-view.ts");
  } catch (error) {
    box.replaceChildren(Object.assign(document.createElement("div"), { className: "note", textContent: `3D could not be loaded: ${error instanceof Error ? error.message : String(error)}` }));
  }

  return three;
}

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
  element("hint").textContent = presentationOf(state.as).hint ?? canvasHint;

  if (state.as !== "3d") {
    box.hidden = true;
    three?.hideThree();
  }

  // No picture (git refused, a wrong view): the canvas says why in its middle; nothing covers it.
  if (!diagram || state.as === "canvas") {
    reader.hidden = true;

    if (!diagram) {
      box.hidden = true;
      three?.hideThree();
    }

    return;
  }

  if (state.as === "3d") {
    reader.hidden = true;
    box.hidden = false;
    const module = await loadThree(box);

    // A tap goes where the canvas's goes: the shape on the right; a double tap opens the shape's own view.
    if (module) module.showThree(box, state.view, diagram, { pick: (id) => tap(id), open: (id) => openShape(id) });

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
    renderMarkdown(body, picturePageMarkdown(), true);
    reader.scrollTop = 0;

    return;
  }

  // The code of the subject's file; a view without one (an overview, a layer, a directory) says so over its page.
  const node = codeSubject(state);

  if (!node) {
    note.hidden = false;
    note.textContent = "This view has no file of its own, so its page is shown instead. Double-tap a shape on the canvas or in 3D for its own view, then show that as code.";
    body.hidden = false;
    renderMarkdown(body, picturePageMarkdown(), true);

    return;
  }

  code.hidden = false;
  const first = await renderCode(code, node);
  first?.scrollIntoView({ block: "center" });
}

/** The code the centre shows: the view's subject with its lines marked when the picture holds its shape, else the file the subject names, whole. */
function codeSubject(state: Link): CodeSpot | null {
  const view = parseView(state.view);
  const file = subjectFile(view);

  if (!file) return null;
  const own = page.nodes().get(view!.subject!);

  if (!own?.ref?.file) return { file: file.file };
  const spot: CodeSpot = { file: own.ref.file, mark: own.kind !== "module" };

  if (own.ref.line !== undefined) spot.line = own.ref.line;

  if (own.ref.endLine !== undefined) spot.endLine = own.ref.endLine;

  return spot;
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
