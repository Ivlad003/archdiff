// The canvas of the page: one Excalidraw, mounted with the first picture
// and handed each next scene; the viewport remembered per view in this
// browser; and the two modes — reading, and drawing over the picture
// (edit), saved as the view's drawing with its mocks, refreshed from the
// code with the strokes kept, screenshot as PNG or SVG. What a tap means
// is picking.ts's: app.ts hands its handlers over with the scene.
//
// Entry points: `showScene`, `canvasHandle`, `canvasMode`, `setMode`,
// `saveDrawing`, `leaveEdit`.

import { api } from "./api.ts";
import { element } from "./dom.ts";
import { mountCanvas, type CanvasEvents, type CanvasHandle } from "./editor.tsx";
import { notice } from "./title.ts";
import { currentLink, refsOf, type Link } from "./link.ts";
import { page } from "./page.ts";
import type { SceneElement } from "../../src/scene.ts";

const saveButton = element<HTMLButtonElement>("save");

let canvas: CanvasHandle | null = null;
/** The canvas while it mounts: a scene that comes meanwhile waits for it, so the page has one Excalidraw. */
let mounting: Promise<CanvasHandle> | null = null;
let mode: "view" | "edit" = "view";
/** The drawing changed since it was saved or the editor opened. */
let dirty = false;

export function canvasHandle(): CanvasHandle | null {
  return canvas;
}

export function canvasMode(): "view" | "edit" {
  return mode;
}

// ── The viewport of every view, remembered in this browser ──────────────────

function viewportKey(state: Link): string {
  return `archdiff.viewport.${state.view}`;
}

function rememberViewport(): void {
  const viewport = canvas?.viewport();

  if (!viewport) return;

  try {
    localStorage.setItem(viewportKey(currentLink()), JSON.stringify(viewport));
  } catch {
    // No storage: the viewport is not remembered.
  }
}

function restoreViewport(state: Link): boolean {
  try {
    const saved = localStorage.getItem(viewportKey(state));

    if (!saved || !canvas) return false;
    canvas.setViewport(JSON.parse(saved) as { scrollX: number; scrollY: number; zoom: number });

    return true;
  } catch {
    return false;
  }
}

window.addEventListener("beforeunload", rememberViewport);
setInterval(rememberViewport, 2000);

// ── The scene ────────────────────────────────────────────────────────────────

/**
 * Shows a picture's scene: the first mounts the canvas with the page's handlers of a tap, a double tap, a selection
 * and a right click (`events`, the same every time); each next one replaces the scene where this browser left the
 * view's viewport. A scene that comes while the canvas mounts (the link changed meanwhile) waits for that canvas:
 * a second Excalidraw mounted into the same container would leave the page drawing nowhere.
 */
export async function showScene(elements: SceneElement[], events: Omit<CanvasEvents, "changed">): Promise<void> {
  if (!canvas && !mounting) {
    mounting = mountCanvas(element("canvas"), elements, {
      ...events,
      changed: () => {
        if (mode !== "edit") return;
        dirty = true;
        saveButton.classList.add("dirty");
      },
    });
    canvas = await mounting;

    return;
  }

  canvas ??= await mounting!;
  canvas.replace(elements);
  restoreViewport(currentLink());
}

// ── Drawing over the picture ─────────────────────────────────────────────────

export function setMode(next: "view" | "edit"): void {
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

/** Saves the scene and the flow's mocks as the view's drawing. */
export async function saveDrawing(): Promise<void> {
  if (!canvas) return;
  const { saved } = await api.saveDrawing(currentLink().view, canvas.scene(), page.mocks());
  dirty = false;
  saveButton.classList.remove("dirty");
  notice(`saved to ${saved}`);
}

/** Leaves the editor, asking first when the drawing has unsaved changes; false when the reader stays. */
export function leaveEdit(): boolean {
  if (mode !== "edit") return true;

  if (dirty && !confirm("The drawing has unsaved changes. Leave the editor and lose them?")) return false;
  setMode("view");

  return true;
}

/** A fresh picture of the code merged into the drawing: shapes that still exist keep their place, the strokes stay, stale shapes go. */
async function refreshFromCode(): Promise<void> {
  if (!canvas) return;
  await saveDrawing();
  const now = currentLink();
  const scene = await api.scene(now.view, { ...now, onlyChanges: false, changes: false }, refsOf(now));
  canvas.replace(scene.elements);
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
