// The canvas of the page: one Excalidraw, mounted with the first picture
// and handed each next scene, fitted clear of the toolbar, the bottom row
// and the minimap; the place of a view the reader moved to remembered in
// this browser and given back when the view is shown again; and the two
// modes — reading, and drawing over the picture (edit), saved as the
// view's drawing with its mocks, refreshed from the code with the strokes
// kept, screenshot as PNG or SVG. What a tap means is picking.ts's:
// app.ts hands its handlers over with the scene.
//
// Entry points: `showScene`, `canvasHandle`, `canvasMode`, `setMode`,
// `saveDrawing`, `leaveEdit`.

import { api } from "./api.ts";
import { element } from "./dom.ts";
import { mountCanvas, type CanvasCover, type CanvasEvents, type CanvasHandle, type Viewport } from "./editor.tsx";
import { notice, setOverflow } from "./title.ts";
import { currentLink, refsOf } from "./link.ts";
import { page } from "./page.ts";
import type { SceneElement } from "../../src/scene.ts";

const saveButton = element<HTMLButtonElement>("save");

let canvas: CanvasHandle | null = null;
/** The canvas while it mounts: a scene that comes meanwhile waits for it, so the page has one Excalidraw. */
let mounting: Promise<CanvasHandle> | null = null;
let mode: "view" | "edit" = "view";
/** The view the editor was opened on: what a save writes to, whatever the link says meanwhile. */
let editedView: string | null = null;
/** The drawing changed since it was saved or the editor opened. */
let dirty = false;

export function canvasHandle(): CanvasHandle | null {
  return canvas;
}

export function canvasMode(): "view" | "edit" {
  return mode;
}

// ── The place of every view, remembered in this browser ─────────────────────

/** Where this browser keeps the place of a view: `v2`, as an older page kept every fit, under whichever view the link named then. */
const VIEWPORT_KEY = "archdiff.viewport.v2.";

/** The view whose scene the canvas shows: its place is remembered under it (the link may name the next one already). */
let shown: string | null = null;

try {
  // The places an older page kept are forgotten: many were kept under the wrong view, and they would place pictures off the canvas.
  const stale = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => key !== null && key.startsWith("archdiff.viewport.") && !key.startsWith(VIEWPORT_KEY));

  for (const key of stale) localStorage.removeItem(key);
} catch {
  // No storage: nothing was kept.
}

/** Keeps the place of the shown view when the reader moved it; a view left where the fit put it is fitted again next time, to the window it is shown in then. */
function rememberViewport(): void {
  const viewport = canvas?.viewport();

  if (!canvas || !viewport || shown === null) return;

  try {
    if (canvas.moved()) localStorage.setItem(VIEWPORT_KEY + shown, JSON.stringify(viewport));
    else localStorage.removeItem(VIEWPORT_KEY + shown);
  } catch {
    // No storage: the place is not remembered.
  }
}

/** The place the reader left a view at, when this browser kept one that reads as a place. */
function rememberedViewport(view: string): Viewport | null {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEWPORT_KEY + view) ?? "null") as Partial<Record<keyof Viewport, unknown>> | null;

    if (!saved || typeof saved.scrollX !== "number" || typeof saved.scrollY !== "number" || typeof saved.zoom !== "number" || !(saved.zoom > 0)) return null;

    return { scrollX: saved.scrollX, scrollY: saved.scrollY, zoom: saved.zoom };
  } catch {
    return null;
  }
}

window.addEventListener("beforeunload", rememberViewport);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") rememberViewport();
});

/**
 * What the page lays over the canvas, for the fit to keep the picture clear of: the toolbar over the top, the row of
 * Excalidraw's zoom and help buttons and of the reason along the bottom, the minimap in the bottom right corner.
 */
function coveredEdges(): CanvasCover {
  const box = element("canvas").getBoundingClientRect();
  const tools = element("canvas-tools").getBoundingClientRect();
  // Excalidraw's footer of zoom and help, or in its phone layout (a narrow canvas) the toolbar along the bottom.
  const rows = [element("reason"), ...element("canvas").querySelectorAll(".layer-ui__wrapper__footer, .excalidraw--mobile .App-toolbar")].map((row) => row.getBoundingClientRect()).filter((row) => row.height > 0);
  const minimap = element<HTMLCanvasElement>("minimap");
  const corner = minimap.hidden ? null : minimap.getBoundingClientRect();

  return {
    top: tools.height > 0 ? Math.max(0, tools.bottom - box.top) : 0,
    bottom: Math.max(0, ...rows.map((row) => box.bottom - row.top)),
    corner: corner && corner.width > 0 ? { left: corner.left - box.left, top: corner.top - box.top } : null,
  };
}

// ── The scene ────────────────────────────────────────────────────────────────

/**
 * Shows the scene of a view's picture: the first mounts the canvas with the page's handlers of a tap, a double tap,
 * a selection and a right click (`events`, the same every time); each next one replaces the scene. The place of the
 * view being left is kept, and the view shown comes back where the reader left it, else fitted. A scene that comes
 * while the canvas mounts (the link changed meanwhile) waits for that canvas: a second Excalidraw mounted into the
 * same container would leave the page drawing nowhere.
 */
export async function showScene(view: string, elements: SceneElement[], events: Omit<CanvasEvents, "changed">): Promise<void> {
  if (!canvas && !mounting) {
    shown = view;
    mounting = mountCanvas(
      element("canvas"),
      elements,
      {
        ...events,
        changed: () => {
          if (mode !== "edit") return;
          dirty = true;
          saveButton.classList.add("dirty");
        },
      },
      { cover: coveredEdges, place: rememberedViewport(view), fitted: (whole) => setOverflow(!whole) },
    );
    canvas = await mounting;

    return;
  }

  canvas ??= await mounting!;
  rememberViewport();
  shown = view;
  canvas.replace(elements, rememberedViewport(view));
}

// ── Drawing over the picture ─────────────────────────────────────────────────

export function setMode(next: "view" | "edit"): void {
  mode = next;
  editedView = next === "edit" ? currentLink().view : null;
  canvas?.setMode(next);
  document.body.classList.toggle("editing", next === "edit");
  element("edit-tools").hidden = next !== "edit";
  element("edit").classList.toggle("active", next === "edit");

  if (next === "view") {
    dirty = false;
    saveButton.classList.remove("dirty");
  }
}

/** Saves the scene and the flow's mocks as the view's drawing. */
export async function saveDrawing(): Promise<void> {
  if (!canvas) return;
  const { saved } = await api.saveDrawing(editedView ?? currentLink().view, canvas.scene(), page.mocks());
  dirty = false;
  saveButton.classList.remove("dirty");
  notice(`saved to ${saved}`);
}

/**
 * Leaves the editor, asking first when the drawing has unsaved changes; false when the reader stays. The changes
 * given up go: the picture is drawn again from the code and the saved drawing — unless `next`, a new picture that
 * the link already names, takes the canvas anyway.
 */
export function leaveEdit(next = false): boolean {
  if (mode !== "edit") return true;
  const given = dirty ? editedView : null;

  if (dirty && !confirm("The drawing has unsaved changes. Leave the editor and lose them?")) return false;
  setMode("view");

  if (given !== null && !next) void redraw(given);

  return true;
}

/** The picture of `view` as the code and the saved drawing have it, over whatever the canvas holds, where it is. */
async function redraw(view: string): Promise<void> {
  if (!canvas) return;
  const now = currentLink();
  const scene = await api.scene(view, now, refsOf(now));
  canvas.replace(scene.elements, canvas.viewport());
}

/** A fresh picture of the code merged into the drawing: shapes that still exist keep their place, the strokes stay, stale shapes go. */
async function refreshFromCode(): Promise<void> {
  if (!canvas) return;
  await saveDrawing();
  const now = currentLink();
  const scene = await api.scene(now.view, { ...now, onlyChanges: false, changes: false }, refsOf(now));
  // The drawing stays where it is being drawn.
  canvas.replace(scene.elements, canvas.viewport());
}

function download(blob: Blob, name: string): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** A file name for the picture of the current view. */
function fileName(extension: string): string {
  return `${currentLink().view.replace(/[^A-Za-z0-9._-]+/g, "_")}${extension}`;
}

element<HTMLButtonElement>("edit").addEventListener("click", () => (mode === "edit" ? leaveEdit() : setMode("edit")));
saveButton.addEventListener("click", () => void saveDrawing().catch((error: unknown) => notice(error instanceof Error ? error.message : String(error))));
element<HTMLButtonElement>("refresh").addEventListener("click", () => void refreshFromCode());
element<HTMLButtonElement>("exit").addEventListener("click", () => leaveEdit());
element<HTMLButtonElement>("shot-png").addEventListener("click", () => void canvas?.screenshot("png").then((blob) => download(blob, fileName(".png"))));
element<HTMLButtonElement>("shot-svg").addEventListener("click", () => void canvas?.screenshot("svg").then((blob) => download(blob, fileName(".svg"))));
window.addEventListener("beforeunload", (event) => {
  if (dirty) event.preventDefault();
});
