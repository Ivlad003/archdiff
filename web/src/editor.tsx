// The one canvas of the page: Excalidraw, in view mode for reading and in
// full mode for drawing. The scene is archdiff's Excalidraw export of the
// view (shapes marked with `customData.archdiff`) merged into the saved
// drawing. In view mode Excalidraw selects nothing, so clicks are read
// from the pointer: a tap on a generated shape picks it (the page shows
// its code), a tap with Shift or Ctrl adds it to the selection, a second
// tap within half a second opens its own view, a right click asks the
// page for its menu; the link icon of a shape does the same through
// `onLinkOpen`.
//
// Entry point: `mountCanvas` (returns a handle: scene, replace, mode,
// screenshot, scrollToContent, unmount), used by canvas.ts.

import { Excalidraw, exportToBlob, exportToSvg, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SceneElement } from "../../src/scene.ts";

export interface CanvasEvents {
  /**
   * A tap on a generated shape (its element ID is the node ID), on a generated line, or on nothing. `lines` are the
   * generated lines within reach of the tap, the nearest first (several where arrows run close together); `extend` is a
   * tap with Shift, Ctrl or Cmd held: on a shape, add it to the selection; on a line, trace the chain onward from it.
   */
  pick(id: string | null, lines?: PickedLine[], extend?: boolean): void;
  /** A double tap on a shape, or its link: open the view the link names (`archdiff://view/<key>`). */
  open(id: string, link: string | null): void;
  /** The scene changed by hand (edit mode). */
  changed(): void;
  /** The generated shapes Excalidraw has selected (edit mode: a box drawn around several, Shift+clicks). */
  selection?(ids: string[]): void;
  /** A right click (view mode): on a shape, on a line, or on nothing, at these client coordinates. */
  menu?(id: string | null, at: { x: number; y: number }, lines: PickedLine[]): void;
}

export interface CanvasHandle {
  scene(): SceneElement[];
  /** Replaces the scene and fits it to the window. */
  replace(elements: SceneElement[]): void;
  /** View mode (reading) or edit mode (Excalidraw's whole UI). */
  setMode(mode: "view" | "edit"): void;
  /** A PNG or SVG of the whole scene, or of the selected elements when there are some. */
  screenshot(kind: "png" | "svg"): Promise<Blob>;
  scrollToContent(): void;
  /** Lights the shapes of `ids` (a run passing through them); an empty list clears every light. */
  highlight(ids: readonly string[], colour?: string): void;
  /** Lights the line under the pointer, under the tap's own light; null puts it out. */
  hover(id: string | null): void;
  /** Dims every generated shape and line not in `keep` (and the labels of the dimmed); null clears the dimming. */
  dim(keep: readonly string[] | null): void;
  /** Scrolls so the element is at the centre of the canvas, at the current zoom. */
  centreOn(id: string): void;
  /** The size of the canvas on screen, for the minimap's viewport box. */
  size(): { width: number; height: number };
  /** Where the viewport is, to remember per view. */
  viewport(): { scrollX: number; scrollY: number; zoom: number } | null;
  setViewport(viewport: { scrollX: number; scrollY: number; zoom: number }): void;
  unmount(): void;
}

/** A generated line under a tap or the pointer: its element ID and the ends it joins. */
export interface PickedLine {
  id: string;
  from: string;
  to: string;
  kind: string;
}

/** The prefix of the view a shape opens (`customData.view` of a generated shape). */
export const VIEW_LINK = "archdiff://view/";

/**
 * A scene element as Excalidraw's own type. archdiff's `SceneElement` types
 * only what it reads (id, type, box, customData); Excalidraw's type has every
 * field of every element kind, which `restoreElements` fills in. One
 * conversion, here, for every call into the API.
 */
function asExcalidraw(elements: readonly SceneElement[]): readonly ExcalidrawElement[] {
  return elements as unknown as readonly ExcalidrawElement[];
}

/** A zoom factor as Excalidraw's branded type (a number in 0.1–30). */
function asZoom(value: number): NormalizedZoomValue {
  return value as NormalizedZoomValue;
}

interface CanvasProps {
  elements: SceneElement[];
  events: CanvasEvents;
  onApi: (api: ExcalidrawImperativeAPI) => void;
  modeState: [mode: "view" | "edit", subscribe: (listener: (mode: "view" | "edit") => void) => () => void];
}

/** A generated shape under the scene point, the smallest first (a label sits inside its shape). */
function shapeAt(elements: readonly SceneElement[], x: number, y: number): SceneElement | null {
  let best: SceneElement | null = null;

  for (const element of elements) {
    if (element.isDeleted || element.customData?.["archdiff"] !== "node") continue;

    if (x < element.x || y < element.y || x > element.x + element.width || y > element.y + element.height) continue;

    if (!best || element.width * element.height < best.width * best.height) best = element;
  }

  return best;
}

/** The distance from a point to a segment. */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));

  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The generated lines within `tolerance` of the scene point, the nearest first: a bundle where arrows run close together. */
function arrowsAt(elements: readonly SceneElement[], x: number, y: number, tolerance: number): PickedLine[] {
  const near: { line: PickedLine; distance: number }[] = [];

  for (const element of elements) {
    if (element.isDeleted || element.customData?.["archdiff"] !== "edge") continue;
    const points = (element as SceneElement & { points?: [number, number][] }).points ?? [];
    let closest = Infinity;

    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1]!;
      const [bx, by] = points[i]!;
      closest = Math.min(closest, distanceToSegment(x, y, element.x + ax, element.y + ay, element.x + bx, element.y + by));
    }

    if (closest <= tolerance) {
      const data = element.customData;
      near.push({ line: { id: element.id, from: String(data["from"] ?? ""), to: String(data["to"] ?? ""), kind: String(data["kind"] ?? "") }, distance: closest });
    }
  }

  return near.sort((a, b) => a.distance - b.distance).map((entry) => entry.line);
}

function CanvasView({ elements, events, onApi, modeState }: CanvasProps) {
  const [mode, setMode] = useState(modeState[0]);
  useEffect(() => modeState[1](setMode), [modeState]);
  return (
    <Excalidraw
      initialData={{ elements: restoreElements(asExcalidraw(elements), null), appState: { viewBackgroundColor: "#ffffff" }, scrollToContent: true }}
      excalidrawAPI={(ready) => {
        onApi(ready);
      }}
      viewModeEnabled={mode === "view"}
      onChange={(changed, appState) => {
        // Excalidraw reports a change on mount and on every mode switch too: only a scene whose elements' versions moved counts.
        const fingerprint = changed.map((element) => `${element.id}:${element.version}:${element.isDeleted ? 1 : 0}`).join("|");
        const window_ = window as unknown as { archdiffScene?: { fingerprint: string; baseline: string | null } };
        const known = window_.archdiffScene ?? { fingerprint, baseline: null };
        window_.archdiffScene = { fingerprint, baseline: known.baseline };

        if (mode === "edit") {
          if (known.baseline !== null && fingerprint !== known.baseline) events.changed();
          // The generated shapes among the selected elements, in the scene's order: one picks, several select.
          const chosen = new Set(Object.keys(appState.selectedElementIds));
          const selected = changed.filter((element) => chosen.has(element.id) && !element.isDeleted && (element.customData as { archdiff?: string } | undefined)?.archdiff === "node").map((element) => element.id);
          events.pick(selected.length === 1 ? (selected[0] ?? null) : null);

          if (selected.length !== 1) events.selection?.(selected);
        }
      }}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: true, toggleTheme: false, clearCanvas: false, changeViewBackgroundColor: false } }}
      langCode="en"
    />
  );
}

export function mountCanvas(container: HTMLElement, elements: SceneElement[], events: CanvasEvents): Promise<CanvasHandle> {
  return new Promise((resolve) => {
    let root: Root | null = createRoot(container);
    let api: ExcalidrawImperativeAPI | null = null;
    let mode: "view" | "edit" = "view";
    const listeners = new Set<(mode: "view" | "edit") => void>();
    const modeState: CanvasProps["modeState"] = [
      mode,
      (listener) => {
        listeners.add(listener);

        return () => listeners.delete(listener);
      },
    ];

    // Taps in view mode, from the container's own pointer events (Excalidraw reports none of its own there):
    // client coordinates become scene coordinates through the app state's scroll and zoom.
    let down: { x: number; y: number } | null = null;
    let lastTap: { id: string; at: number } | null = null;

    const scenePoint = (event: PointerEvent): { x: number; y: number } | null => {
      if (!api) return null;
      const canvas = container.querySelector<HTMLCanvasElement>(".excalidraw__canvas.interactive");

      if (!canvas) return null;
      const box = canvas.getBoundingClientRect();
      const state = api.getAppState();

      return { x: (event.clientX - box.left) / state.zoom.value - state.scrollX, y: (event.clientY - box.top) / state.zoom.value - state.scrollY };
    };

    // Only the main button taps: a right click is the menu (below), and on Linux its press comes before its contextmenu.
    container.addEventListener(
      "pointerdown",
      (event) => {
        if (mode === "view" && event.button === 0) down = scenePoint(event);
      },
      true,
    );
    container.addEventListener(
      "pointerup",
      (event) => {
        if (mode !== "view" || !down || !api || event.button !== 0) return;
        const at = scenePoint(event);
        const from = down;
        down = null;

        if (!at) return;

        // A drag is a pan, not a tap.
        if (Math.hypot(at.x - from.x, at.y - from.y) > 6 / api.getAppState().zoom.value) return;
        const scene = api.getSceneElements() as unknown as SceneElement[];
        const hit = shapeAt(scene, at.x, at.y);
        const now = Date.now();

        const extend = event.shiftKey || event.ctrlKey || event.metaKey;

        // No shape under the tap: the lines within a few screen pixels, when any; Shift follows the chain from the nearest.
        if (!hit) {
          const lines = arrowsAt(scene, at.x, at.y, 8 / api.getAppState().zoom.value);
          lastTap = null;

          if (lines.length > 0) {
            events.pick(lines[0]!.id, lines, extend);

            return;
          }
        }

        if (hit && !extend && lastTap && lastTap.id === hit.id && now - lastTap.at < 500) {
          lastTap = null;
          events.open(hit.id, typeof hit.customData?.["view"] === "string" && hit.customData["view"] !== "" ? hit.customData["view"] : null);

          return;
        }

        lastTap = hit ? { id: hit.id, at: now } : null;
        events.pick(hit?.id ?? null, undefined, extend);
      },
      true,
    );

    // A right click in view mode is the page's menu, not Excalidraw's: the shape or the lines under the pointer.
    container.addEventListener(
      "contextmenu",
      (event) => {
        if (mode !== "view" || !api || !events.menu) return;
        event.preventDefault();
        event.stopPropagation();
        const at = scenePoint(event as unknown as PointerEvent);

        if (!at) return;
        const scene = api.getSceneElements() as unknown as SceneElement[];
        const hit = shapeAt(scene, at.x, at.y);
        const lines = hit ? [] : arrowsAt(scene, at.x, at.y, 8 / api.getAppState().zoom.value);
        events.menu(hit?.id ?? null, { x: event.clientX, y: event.clientY }, lines);
      },
      true,
    );

    // Fits the whole scene into the container: Excalidraw's own scrollToContent zooms out far too much for a small
    // scene, so the zoom is computed here from the scene's bounds (never above 1, so a tiny diagram stays readable).
    const fit = (): void => {
      if (!api) return;
      const all = (api.getSceneElements() as unknown as SceneElement[]).filter((element) => !element.isDeleted);

      if (all.length === 0) return;
      const minX = Math.min(...all.map((element) => element.x));
      const minY = Math.min(...all.map((element) => element.y));
      const maxX = Math.max(...all.map((element) => element.x + element.width));
      const maxY = Math.max(...all.map((element) => element.y + element.height));
      const width = container.clientWidth;
      const height = container.clientHeight;

      if (width === 0 || height === 0) return;
      const margin = 32;
      const zoom = Math.max(0.1, Math.min(1, (width - 2 * margin) / (maxX - minX), (height - 2 * margin) / (maxY - minY)));
      const scrollX = width / zoom / 2 - (minX + (maxX - minX) / 2);
      const scrollY = height / zoom / 2 - (minY + (maxY - minY) / 2);
      api.updateScene({ appState: { scrollX, scrollY, zoom: { value: asZoom(zoom) } } });
    };

    // Hover: the line under the pointer, lit lightly; checked at most once a frame, and never over a lit shape or line.
    let hovered: string | null = null;
    let pending: PointerEvent | null = null;
    container.addEventListener("pointermove", (event) => {
      if (mode !== "view" || !api || pending) {
        pending = pending ?? (mode === "view" ? event : null);

        return;
      }

      pending = event;
      requestAnimationFrame(() => {
        const last = pending;
        pending = null;

        if (!last || !api || mode !== "view") return;
        const at = scenePoint(last);
        const scene = api.getSceneElements() as unknown as SceneElement[];
        const line = at && !shapeAt(scene, at.x, at.y) ? (arrowsAt(scene, at.x, at.y, 8 / api.getAppState().zoom.value)[0] ?? null) : null;
        const id = line?.id ?? null;

        if (id === hovered) return;
        hovered = id;
        container.style.cursor = id ? "pointer" : "";
        hover(id);
      });
    });
    container.addEventListener("pointerleave", () => {
      if (hovered) {
        hovered = null;
        container.style.cursor = "";
        hover(null);
      }
    });

    // Highlight: the original look of every lit shape, to put back when the light goes.
    const lit = new Map<string, { strokeColor: string; strokeWidth: number; backgroundColor: string }>();

    const highlight = (ids: readonly string[], colour = "#ff6f00"): void => {
      if (!api) return;
      const wanted = new Set(ids);
      const elements = api.getSceneElementsIncludingDeleted() as unknown as (SceneElement & { strokeColor: string; strokeWidth: number; backgroundColor: string })[];
      let changed = false;
      const next = elements.map((element) => {
        const original = lit.get(element.id);

        if (wanted.has(element.id) && (element.customData?.["archdiff"] === "node" || element.customData?.["archdiff"] === "edge")) {
          if (!original) lit.set(element.id, { strokeColor: element.strokeColor, strokeWidth: element.strokeWidth, backgroundColor: element.backgroundColor });
          changed = true;

          // A line keeps its fill (none) and gets the colour and a thick stroke; a shape also gets a warm fill.
          return element.customData?.["archdiff"] === "edge" ? { ...element, strokeColor: colour, strokeWidth: 4 } : { ...element, strokeColor: colour, strokeWidth: 4, backgroundColor: "#ffe0b2" };
        }

        if (original) {
          lit.delete(element.id);
          changed = true;

          return { ...element, ...original };
        }

        return element;
      });

      if (changed) api.updateScene({ elements: asExcalidraw(next) });
    };

    // Dimming: the opacity of everything outside the focus, put back when the focus clears.
    const dimmed = new Map<string, number>();

    const dim = (keep: readonly string[] | null): void => {
      if (!api) return;
      const kept = keep === null ? null : new Set(keep);
      const elements = api.getSceneElementsIncludingDeleted() as unknown as (SceneElement & { opacity: number; containerId?: string | null })[];
      const byId = new Map(elements.map((element) => [element.id, element]));
      let changed = false;
      const next = elements.map((element) => {
        const role = element.customData?.["archdiff"];
        // A label follows its shape or line; a lane is never dimmed.
        const owner = role === "label" && element.containerId ? byId.get(element.containerId) : role === "label" ? byId.get(element.id.replace(/:text$/, "")) : element;
        const wanted = kept !== null && owner !== undefined && (role === "node" || role === "edge" || role === "label") && !kept.has(owner.id);
        const original = dimmed.get(element.id);

        if (wanted && original === undefined) {
          dimmed.set(element.id, element.opacity);
          changed = true;

          return { ...element, opacity: 18 };
        }

        if (!wanted && original !== undefined) {
          dimmed.delete(element.id);
          changed = true;

          return { ...element, opacity: original };
        }

        return element;
      });

      if (changed) api.updateScene({ elements: asExcalidraw(next) });
    };

    // The hover light sits under the tap light: a line the tap lit keeps its look; one line at a time.
    const hoverLit = new Map<string, { strokeColor: string; strokeWidth: number }>();

    const hover = (id: string | null): void => {
      if (!api) return;
      const elements = api.getSceneElementsIncludingDeleted() as unknown as (SceneElement & { strokeColor: string; strokeWidth: number })[];
      let changed = false;
      const next = elements.map((element) => {
        const original = hoverLit.get(element.id);

        if (element.id === id && !lit.has(element.id) && !original) {
          hoverLit.set(element.id, { strokeColor: element.strokeColor, strokeWidth: element.strokeWidth });
          changed = true;

          return { ...element, strokeColor: "#ffa726", strokeWidth: 3 };
        }

        if (original && element.id !== id) {
          hoverLit.delete(element.id);
          changed = true;

          return { ...element, ...original };
        }

        return element;
      });

      if (changed) api.updateScene({ elements: asExcalidraw(next) });
    };

    const handle: CanvasHandle = {
      scene: () => (api ? (api.getSceneElementsIncludingDeleted() as unknown as SceneElement[]) : elements),
      replace: (next) => {
        // A saved element may lack fields Excalidraw needs (a scene saved through the API, an older version): restore fills them.
        lit.clear();
        api?.updateScene({ elements: restoreElements(asExcalidraw(next), null) });
        requestAnimationFrame(fit);
      },
      setMode: (next) => {
        mode = next;
        // Entering the editor: the scene as it is now is the baseline a change is measured from.
        const window_ = window as unknown as { archdiffScene?: { fingerprint: string; baseline: string | null } };

        if (window_.archdiffScene) window_.archdiffScene.baseline = next === "edit" ? window_.archdiffScene.fingerprint : null;

        for (const listener of listeners) listener(next);
      },
      screenshot: async (kind) => {
        if (!api) throw new Error("the canvas is not ready");
        const all = api.getSceneElements();
        const selected = Object.keys(api.getAppState().selectedElementIds);
        const chosen = selected.length > 0 ? all.filter((element) => selected.includes(element.id)) : all;
        const files = api.getFiles();
        const appState = { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false };

        if (kind === "svg") {
          const svg = await exportToSvg({ elements: chosen, appState, files });

          return new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
        }

        return exportToBlob({ elements: chosen, appState, files, mimeType: "image/png", quality: 1, exportPadding: 24 });
      },
      scrollToContent: fit,
      highlight,
      hover,
      dim,
      centreOn: (id) => {
        if (!api) return;
        const target = (api.getSceneElements() as unknown as SceneElement[]).find((element) => element.id === id);

        if (!target) return;
        const zoom = api.getAppState().zoom.value;
        api.updateScene({ appState: { scrollX: container.clientWidth / zoom / 2 - (target.x + target.width / 2), scrollY: container.clientHeight / zoom / 2 - (target.y + target.height / 2) } });
      },
      size: () => ({ width: container.clientWidth, height: container.clientHeight }),
      viewport: () => {
        if (!api) return null;
        const state = api.getAppState();

        return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value };
      },
      setViewport: (viewport) => api?.updateScene({ appState: { scrollX: viewport.scrollX, scrollY: viewport.scrollY, zoom: { value: asZoom(viewport.zoom) } } }),
      unmount: () => {
        root?.unmount();
        root = null;
        api = null;
      },
    };

    root.render(
      <CanvasView
        elements={elements}
        events={events}
        modeState={modeState}
        onApi={(ready) => {
          api = ready;
          // The container may still be laid out when Excalidraw mounts: fit once the frames are drawn.
          requestAnimationFrame(() => requestAnimationFrame(fit));
          setTimeout(fit, 300);
          resolve(handle);
        }}
      />,
    );
  });
}
