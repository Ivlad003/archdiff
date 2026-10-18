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
// A scene is placed where the reader left the view when that place still
// shows it, else fitted clear of what the page lays over the canvas (the
// toolbar, the bottom row, the minimap's corner), and fitted again when
// the canvas changes size until the reader moves it.
//
// Entry point: `mountCanvas` (returns a handle: scene, replace, mode,
// screenshot, scrollToContent, moved, unmount), used by canvas.ts.

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

/** Where the viewport is: the scene's scroll and the zoom. */
export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/**
 * What the page lays over the canvas, in screen pixels, for the fit to keep the scene clear of: a toolbar down from
 * the top edge, a row up from the bottom edge, and a box in the bottom right corner (its left and top edges, from the
 * canvas's left and top), or none.
 */
export interface CanvasCover {
  top: number;
  bottom: number;
  corner: { left: number; top: number } | null;
}

export interface CanvasHandle {
  scene(): SceneElement[];
  /** Replaces the scene: at `place` (where the reader left the view) when that still shows a good part of it, else fitted to the window. */
  replace(elements: SceneElement[], place?: Viewport | null): void;
  /** View mode (reading) or edit mode (Excalidraw's whole UI). */
  setMode(mode: "view" | "edit"): void;
  /** A PNG or SVG of the whole scene, or of the selected elements when there are some. */
  screenshot(kind: "png" | "svg"): Promise<Blob>;
  scrollToContent(): void;
  /** Whether the reader has a place worth keeping: the viewport moved since the fit (a pan, a zoom), or a remembered place was given back. */
  moved(): boolean;
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
  viewport(): Viewport | null;
  setViewport(viewport: Viewport): void;
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
 * conversion each way, here, for every call into the API.
 */
function asExcalidraw(elements: readonly SceneElement[]): readonly ExcalidrawElement[] {
  return elements as unknown as readonly ExcalidrawElement[];
}

/** An element of the scene with the fields of Excalidraw's the page reads and lights: the look, a label's container, a line's points. */
type CanvasElement = SceneElement & { strokeColor: string; strokeWidth: number; backgroundColor: string; opacity: number; containerId?: string | null; points?: [number, number][] };

/** The scene as the page reads it (without the deleted elements, unless asked): Excalidraw's elements have every field of `CanvasElement`. */
function elementsOf(api: ExcalidrawImperativeAPI, withDeleted = false): CanvasElement[] {
  return (withDeleted ? api.getSceneElementsIncludingDeleted() : api.getSceneElements()) as unknown as CanvasElement[];
}

/** A zoom factor as Excalidraw's branded type (a number in 0.1–30). */
function asZoom(value: number): NormalizedZoomValue {
  return value as NormalizedZoomValue;
}

/** How far from a line, in screen pixels, a tap or the pointer still reaches it. */
const LINE_REACH = 8;
/** How far the pointer may move, in screen pixels, for a press and a release to be a tap rather than a pan. */
const TAP_SLOP = 6;
/** Two taps on one shape within this many milliseconds are a double tap. */
const DOUBLE_TAP_MS = 500;
/** The room left around the scene when it is fitted to the canvas, in screen pixels. */
const FIT_MARGIN = 32;
/** The room left between the fitted scene and what the page lays over the canvas, in screen pixels. */
const FIT_GAP = 12;
/** Excalidraw's own floor of the zoom. */
const MIN_ZOOM = 0.1;
/** The opacity of what the dim tool fades, in percent. */
const DIMMED_OPACITY = 18;

/** How the scene's elements changed: the versions now, and those when the editor opened (a change is measured from them). */
interface SceneVersions {
  fingerprint: string;
  baseline: string | null;
}

/**
 * What the parts of a mounted canvas share: the container, Excalidraw's API once it is ready, the mode, the scene's
 * versions, what the page lays over the canvas, and how the scene was placed — not yet (`null`), by the fit (with the
 * viewport it set, to tell a pan or a zoom since), or at a place given back (`given`).
 */
interface Mounted {
  container: HTMLElement;
  api: ExcalidrawImperativeAPI | null;
  mode: "view" | "edit";
  versions: SceneVersions | null;
  cover: () => CanvasCover;
  placed: { by: "fit"; at: Viewport } | { by: "given" } | null;
  /** Told after every fit whether the whole scene is on the canvas (a picture too big even at the smallest zoom is not). */
  fitted: (whole: boolean) => void;
}

interface CanvasProps {
  elements: SceneElement[];
  events: CanvasEvents;
  mounted: Mounted;
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
function arrowsAt(elements: readonly CanvasElement[], x: number, y: number, tolerance: number): PickedLine[] {
  const near: { line: PickedLine; distance: number }[] = [];

  for (const element of elements) {
    if (element.isDeleted || element.customData?.["archdiff"] !== "edge") continue;
    const points = element.points ?? [];
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

function CanvasView({ elements, events, mounted, onApi, modeState }: CanvasProps) {
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
        const baseline = mounted.versions?.baseline ?? null;
        mounted.versions = { fingerprint, baseline };

        if (mode === "edit") {
          if (baseline !== null && fingerprint !== baseline) events.changed();
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

/** A client point as a scene point, through the app state's scroll and zoom; null before the canvas is drawn. */
function scenePoint(mounted: Mounted, event: MouseEvent): { x: number; y: number } | null {
  const canvas = mounted.container.querySelector<HTMLCanvasElement>(".excalidraw__canvas.interactive");

  if (!mounted.api || !canvas) return null;
  const box = canvas.getBoundingClientRect();
  const state = mounted.api.getAppState();

  return { x: (event.clientX - box.left) / state.zoom.value - state.scrollX, y: (event.clientY - box.top) / state.zoom.value - state.scrollY };
}

/** Screen pixels as scene units at the current zoom. */
function sceneUnits(api: ExcalidrawImperativeAPI, pixels: number): number {
  return pixels / api.getAppState().zoom.value;
}

/**
 * Taps and right clicks in view mode, from the container's own pointer events (Excalidraw reports none of its own
 * there): a tap picks the shape under it, or the lines within reach; a second tap on a shape opens its view; a right
 * click asks for the page's menu. A second tap is one whose press comes within half a second of the first tap's
 * release, by the events' own times: the page may still be busy with the first tap (a big file's code, a big scene
 * lit) when the second is handled, long after it happened.
 */
function listenForTaps(mounted: Mounted, events: CanvasEvents): void {
  const { container } = mounted;
  let down: { x: number; y: number; at: number } | null = null;
  let lastTap: { id: string; at: number } | null = null;

  // Only the main button taps: a right click is the menu (below), and on Linux its press comes before its contextmenu.
  container.addEventListener(
    "pointerdown",
    (event) => {
      const point = mounted.mode === "view" && event.button === 0 ? scenePoint(mounted, event) : null;

      if (point) down = { ...point, at: event.timeStamp };
    },
    true,
  );
  container.addEventListener(
    "pointerup",
    (event) => {
      const { api } = mounted;

      if (mounted.mode !== "view" || !down || !api || event.button !== 0) return;
      const at = scenePoint(mounted, event);
      const from = down;
      down = null;

      // A drag is a pan, not a tap.
      if (!at || Math.hypot(at.x - from.x, at.y - from.y) > sceneUnits(api, TAP_SLOP)) return;
      const scene = elementsOf(api);
      const hit = shapeAt(scene, at.x, at.y);
      const extend = event.shiftKey || event.ctrlKey || event.metaKey;

      // No shape under the tap: the lines within a few screen pixels, when any; Shift follows the chain from the nearest.
      if (!hit) {
        const lines = arrowsAt(scene, at.x, at.y, sceneUnits(api, LINE_REACH));
        lastTap = null;

        if (lines.length > 0) {
          events.pick(lines[0]!.id, lines, extend);

          return;
        }
      }

      if (hit && !extend && lastTap && lastTap.id === hit.id && from.at - lastTap.at < DOUBLE_TAP_MS) {
        lastTap = null;
        events.open(hit.id, typeof hit.customData?.["view"] === "string" && hit.customData["view"] !== "" ? hit.customData["view"] : null);

        return;
      }

      lastTap = hit ? { id: hit.id, at: event.timeStamp } : null;
      events.pick(hit?.id ?? null, undefined, extend);
    },
    true,
  );

  // A right click in view mode is the page's menu, not Excalidraw's: the shape or the lines under the pointer.
  container.addEventListener(
    "contextmenu",
    (event) => {
      const { api } = mounted;

      if (mounted.mode !== "view" || !api || !events.menu) return;
      event.preventDefault();
      event.stopPropagation();
      const at = scenePoint(mounted, event);

      if (!at) return;
      const scene = elementsOf(api);
      const hit = shapeAt(scene, at.x, at.y);
      const lines = hit ? [] : arrowsAt(scene, at.x, at.y, sceneUnits(api, LINE_REACH));
      events.menu(hit?.id ?? null, { x: event.clientX, y: event.clientY }, lines);
    },
    true,
  );
}

/** Hover: the line under the pointer, lit lightly; checked at most once a frame, and never over a shape. */
function listenForHover(mounted: Mounted, hover: (id: string | null) => void): void {
  const { container } = mounted;
  let hovered: string | null = null;
  let pending: PointerEvent | null = null;

  container.addEventListener("pointermove", (event) => {
    if (mounted.mode !== "view" || !mounted.api || pending) {
      pending = pending ?? (mounted.mode === "view" ? event : null);

      return;
    }

    pending = event;
    requestAnimationFrame(() => {
      const last = pending;
      pending = null;
      const { api } = mounted;

      if (!last || !api || mounted.mode !== "view") return;
      const at = scenePoint(mounted, last);
      const scene = elementsOf(api);
      const line = at && !shapeAt(scene, at.x, at.y) ? (arrowsAt(scene, at.x, at.y, sceneUnits(api, LINE_REACH))[0] ?? null) : null;
      const id = line?.id ?? null;

      if (id === hovered) return;
      hovered = id;
      container.style.cursor = id ? "pointer" : "";
      hover(id);
    });
  });
  container.addEventListener("pointerleave", () => {
    if (!hovered) return;
    hovered = null;
    container.style.cursor = "";
    hover(null);
  });
}

/** The box around the scene's elements, or null for an empty scene (a loop: a big scene's coordinates would overflow a spread). */
function boundsOf(elements: readonly SceneElement[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (elements.length === 0) return null;
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  for (const element of elements) {
    bounds.minX = Math.min(bounds.minX, element.x);
    bounds.minY = Math.min(bounds.minY, element.y);
    bounds.maxX = Math.max(bounds.maxX, element.x + element.width);
    bounds.maxY = Math.max(bounds.maxY, element.y + element.height);
  }

  return bounds;
}

/**
 * The scene in a rectangle of the canvas (screen pixels from its corner), as large as fits there but never above 1:
 * centred, and — where it is bigger than the rectangle even at the smallest zoom — from its beginning (its left or top
 * edge at the rectangle's), where a flow starts; with where its right and bottom edges land, and whether it is whole.
 */
function placeIn(bounds: NonNullable<ReturnType<typeof boundsOf>>, area: { left: number; top: number; right: number; bottom: number }): Viewport & { right: number; bottom: number; whole: boolean } {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const zoom = Math.max(MIN_ZOOM, Math.min(1, (area.right - area.left) / width, (area.bottom - area.top) / height));
  const across = width * zoom <= area.right - area.left + 0.5;
  const down = height * zoom <= area.bottom - area.top + 0.5;
  const left = across ? (area.left + area.right) / 2 - (width * zoom) / 2 : area.left;
  const top = down ? (area.top + area.bottom) / 2 - (height * zoom) / 2 : area.top;

  return { zoom, scrollX: left / zoom - bounds.minX, scrollY: top / zoom - bounds.minY, right: left + width * zoom, bottom: top + height * zoom, whole: across && down };
}

/**
 * Fits the whole scene into the container, clear of what the page lays over it: below the toolbar, above the bottom
 * row, and — when the scene would reach under the corner's box — beside the box or above it, whichever leaves the
 * scene larger. Excalidraw's own scrollToContent zooms out far too much for a small scene and knows nothing of the
 * page, so the zoom is computed here from the scene's bounds (never above 1, so a tiny diagram stays readable).
 */
function fitScene(mounted: Mounted): void {
  const { api, container } = mounted;
  const bounds = api ? boundsOf(elementsOf(api)) : null;
  const width = container.clientWidth;
  const height = container.clientHeight;

  if (!api || !bounds || width === 0 || height === 0) return;
  const cover = mounted.cover();
  const area = { left: FIT_MARGIN, top: Math.max(FIT_MARGIN, cover.top + FIT_GAP), right: width - FIT_MARGIN, bottom: height - Math.max(FIT_MARGIN, cover.bottom + FIT_GAP) };
  let place = placeIn(bounds, area);
  const corner = cover.corner;

  // A whole scene that would reach under the corner's box goes beside it or above it; one too big for the canvas stays from its beginning.
  if (corner && place.whole && place.right > corner.left - FIT_GAP && place.bottom > corner.top - FIT_GAP) {
    const beside = placeIn(bounds, { ...area, right: Math.min(area.right, corner.left - FIT_GAP) });
    const above = placeIn(bounds, { ...area, bottom: Math.min(area.bottom, corner.top - FIT_GAP) });
    const best = beside.zoom >= above.zoom ? beside : above;

    if (best.whole) place = best;
  }

  const at = { scrollX: place.scrollX, scrollY: place.scrollY, zoom: place.zoom };
  api.updateScene({ appState: { scrollX: at.scrollX, scrollY: at.scrollY, zoom: { value: asZoom(at.zoom) } } });
  mounted.placed = { by: "fit", at };
  mounted.fitted(place.whole);
}

/** Whether a place of the viewport shows a good part of the scene: a quarter of what the canvas shows, or of the scene when the scene is the smaller. */
function showsScene(mounted: Mounted, place: Viewport): boolean {
  const { api, container } = mounted;
  const bounds = api ? boundsOf(elementsOf(api)) : null;

  if (!bounds || !(place.zoom > 0) || container.clientWidth === 0) return false;
  const width = container.clientWidth / place.zoom;
  const height = container.clientHeight / place.zoom;
  const across = Math.min(-place.scrollX + width, bounds.maxX) - Math.max(-place.scrollX, bounds.minX);
  const down = Math.min(-place.scrollY + height, bounds.maxY) - Math.max(-place.scrollY, bounds.minY);

  return across > 0 && down > 0 && across * down >= 0.25 * Math.min(width * height, Math.max(1, bounds.maxX - bounds.minX) * Math.max(1, bounds.maxY - bounds.minY));
}

/** What the lights change of an element: its stroke, its fill, its opacity. */
type Look = Pick<CanvasElement, "strokeColor" | "strokeWidth" | "backgroundColor" | "opacity">;

/** The colour of the tap's light and of the hover's, under it. */
const TAP_COLOUR = "#ff6f00";
const HOVER_COLOUR = "#ffa726";

/**
 * The lights over the scene: the tap's light (a run of shapes and lines), the dimming of all but some, and the
 * hover's light under the tap's. Every element a light touched keeps the look the scene drew it with, and its look
 * is worked out again from all the lights on it whenever one changes — so lights come off in any order: the hover
 * leaving a lit line no longer puts back its unlit look, and the tap's light, cleared later, no longer puts back the
 * hover's (both kept a line orange after the reader tapped elsewhere). Lights are for reading: entering the editor
 * puts every one out (`clear`), as the editor marks its own selection and a light would overwrite a colour drawn there.
 */
function makeLights(mounted: Mounted): { highlight: CanvasHandle["highlight"]; dim: CanvasHandle["dim"]; hover: CanvasHandle["hover"]; clear(): void; forget(): void } {
  /** The look the scene drew each touched element with. */
  const drawn = new Map<string, Look>();
  let lit: { ids: ReadonlySet<string>; colour: string } = { ids: new Set(), colour: TAP_COLOUR };
  let hovered: string | null = null;
  /** The shapes and lines the dim keeps; null: nothing is dimmed. */
  let kept: ReadonlySet<string> | null = null;

  /** An element's look under the lights on it now, from the look it was drawn with. */
  const litLook = (element: CanvasElement, look: Look, owner: CanvasElement | undefined): Look => {
    const role = element.customData?.["archdiff"];
    const next = { ...look };

    // The dim fades a shape, a line and the label of one it does not keep; a lane never.
    if (kept !== null && owner !== undefined && (role === "node" || role === "edge" || role === "label") && !kept.has(owner.id)) next.opacity = DIMMED_OPACITY;

    // The tap's light: a line gets the colour and a thick stroke, a shape a warm fill too; the hover's sits under it.
    if (lit.ids.has(element.id) && (role === "node" || role === "edge")) {
      next.strokeColor = lit.colour;
      next.strokeWidth = 4;

      if (role === "node") next.backgroundColor = "#ffe0b2";
    } else if (hovered === element.id) {
      next.strokeColor = HOVER_COLOUR;
      next.strokeWidth = 3;
    }

    return next;
  };

  /** Works out the look of every element a light is or was on, and writes the scene back only when one changed. */
  const apply = (): void => {
    const { api } = mounted;

    if (!api) return;
    const elements = elementsOf(api, true);
    const byId = new Map(elements.map((element) => [element.id, element]));
    let changed = false;
    const next = elements.map((element) => {
      if (!drawn.has(element.id) && !lit.ids.has(element.id) && hovered !== element.id && kept === null) return element;
      const look = drawn.get(element.id) ?? { strokeColor: element.strokeColor, strokeWidth: element.strokeWidth, backgroundColor: element.backgroundColor, opacity: element.opacity };
      drawn.set(element.id, look);
      // A label follows its shape or line.
      const role = element.customData?.["archdiff"];
      const owner = role === "label" ? byId.get(element.containerId ?? element.id.replace(/:text$/, "")) : element;
      const wanted = litLook(element, look, owner);

      if (wanted.strokeColor === element.strokeColor && wanted.strokeWidth === element.strokeWidth && wanted.backgroundColor === element.backgroundColor && wanted.opacity === element.opacity) return element;
      changed = true;

      return { ...element, ...wanted };
    });

    if (changed) api.updateScene({ elements: asExcalidraw(next) });
  };

  /** A light changes only in view mode: the editor's scene is the reader's own. */
  const reading = (change: () => void): void => {
    if (mounted.mode !== "view") return;
    change();
    apply();
  };

  return {
    highlight: (ids, colour = TAP_COLOUR) => reading(() => (lit = { ids: new Set(ids), colour })),
    dim: (keep) => reading(() => (kept = keep === null ? null : new Set(keep))),
    hover: (id) => reading(() => (hovered = id)),
    clear: () => {
      lit = { ids: new Set(), colour: TAP_COLOUR };
      hovered = null;
      kept = null;
      apply();
      drawn.clear();
    },
    // A new scene: its elements are drawn afresh, and no light is on them.
    forget: () => {
      lit = { ids: new Set(), colour: TAP_COLOUR };
      hovered = null;
      kept = null;
      drawn.clear();
    },
  };
}

/**
 * Mounts the canvas with its first scene. `cover` says what the page lays over the canvas (the fit keeps clear of
 * it); `place` is where the reader left the view, kept when it still shows the scene; `fitted` hears after every fit
 * whether the whole scene is on the canvas.
 */
export function mountCanvas(container: HTMLElement, elements: SceneElement[], events: CanvasEvents, options: { cover?: () => CanvasCover; place?: Viewport | null; fitted?: (whole: boolean) => void } = {}): Promise<CanvasHandle> {
  return new Promise((resolve) => {
    let root: Root | null = createRoot(container);
    const mounted: Mounted = { container, api: null, mode: "view", versions: null, cover: options.cover ?? (() => ({ top: 0, bottom: 0, corner: null })), placed: null, fitted: options.fitted ?? (() => {}) };
    const listeners = new Set<(mode: "view" | "edit") => void>();
    const modeState: CanvasProps["modeState"] = [
      mounted.mode,
      (listener) => {
        listeners.add(listener);

        return () => listeners.delete(listener);
      },
    ];
    const lights = makeLights(mounted);
    const fit = (): void => fitScene(mounted);
    // A place worth keeping: the reader's own — moved since the fit, or given back; a scene not placed yet has none.
    const moved = (): boolean => {
      const { placed } = mounted;
      const state = mounted.api?.getAppState();

      if (!placed || !state) return false;

      return placed.by === "given" || Math.abs(state.scrollX - placed.at.scrollX) > 0.5 || Math.abs(state.scrollY - placed.at.scrollY) > 0.5 || Math.abs(state.zoom.value - placed.at.zoom) > 0.0005;
    };
    // The scene where the reader left the view when that still shows it (a picture that changed may not), else fitted.
    const settle = (place: Viewport | null): void => {
      if (place && mounted.api && showsScene(mounted, place)) {
        mounted.api.updateScene({ appState: { scrollX: place.scrollX, scrollY: place.scrollY, zoom: { value: asZoom(place.zoom) } } });
        mounted.placed = { by: "given" };
      } else fit();
    };
    // The canvas grows and shrinks with the window and the panels: a scene the reader did not move is fitted again.
    const resizes = new ResizeObserver(() => {
      if (!moved()) requestAnimationFrame(fit);
    });
    resizes.observe(container);
    listenForTaps(mounted, events);
    listenForHover(mounted, lights.hover);

    const handle: CanvasHandle = {
      scene: () => (mounted.api ? elementsOf(mounted.api, true) : elements),
      replace: (next, place = null) => {
        // A saved element may lack fields Excalidraw needs (a scene saved through the API, an older version): restore fills them.
        lights.forget();
        mounted.api?.updateScene({ elements: restoreElements(asExcalidraw(next), null) });
        mounted.placed = null;
        requestAnimationFrame(() => settle(place));
      },
      setMode: (next) => {
        if (next === "edit") lights.clear();
        mounted.mode = next;

        // Entering the editor: the scene as it is now is the baseline a change is measured from.
        if (mounted.versions) mounted.versions.baseline = next === "edit" ? mounted.versions.fingerprint : null;

        for (const listener of listeners) listener(next);
      },
      screenshot: async (kind) => {
        const { api } = mounted;

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
      moved,
      highlight: lights.highlight,
      hover: lights.hover,
      dim: lights.dim,
      centreOn: (id) => {
        const { api } = mounted;
        const target = api ? elementsOf(api).find((element) => element.id === id) : undefined;

        if (!api || !target) return;
        const zoom = api.getAppState().zoom.value;
        api.updateScene({ appState: { scrollX: container.clientWidth / zoom / 2 - (target.x + target.width / 2), scrollY: container.clientHeight / zoom / 2 - (target.y + target.height / 2) } });
      },
      size: () => ({ width: container.clientWidth, height: container.clientHeight }),
      viewport: () => {
        if (!mounted.api) return null;
        const state = mounted.api.getAppState();

        return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value };
      },
      setViewport: (viewport) => mounted.api?.updateScene({ appState: { scrollX: viewport.scrollX, scrollY: viewport.scrollY, zoom: { value: asZoom(viewport.zoom) } } }),
      unmount: () => {
        resizes.disconnect();
        root?.unmount();
        root = null;
        mounted.api = null;
      },
    };

    root.render(
      <CanvasView
        elements={elements}
        events={events}
        mounted={mounted}
        modeState={modeState}
        onApi={(ready) => {
          mounted.api = ready;
          // The container may still be laid out when Excalidraw mounts: placed once the frames are drawn, fitted again a moment later unless the reader has a place.
          requestAnimationFrame(() => requestAnimationFrame(() => settle(options.place ?? null)));
          setTimeout(() => {
            if (!moved()) fit();
          }, 300);
          resolve(handle);
        }}
      />,
    );
  });
}
