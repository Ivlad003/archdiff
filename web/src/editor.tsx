// The one canvas of the page: Excalidraw, in view mode for reading and in
// full mode for drawing. The scene is archdiff's Excalidraw export of the
// view (shapes marked with `customData.archdiff`) merged into the saved
// drawing. In view mode Excalidraw selects nothing, so clicks are read
// from the pointer: a tap on a generated shape picks it (the page shows
// its code), a second tap within half a second opens its own view; the
// link icon of a shape does the same through `onLinkOpen`.
//
// Entry point: `mountCanvas` (returns a handle: scene, replace, mode,
// screenshot, scrollToContent, unmount), used by app.ts.

import { Excalidraw, exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SceneElement } from "../../src/scene.ts";

export interface CanvasEvents {
  /** A tap on a generated shape (its element ID is the node ID), or on nothing. */
  pick(id: string | null): void;
  /** A double tap on a shape, or its link: open the view the link names (`archdiff://view/<key>`). */
  open(id: string, link: string | null): void;
  /** The scene changed by hand (edit mode). */
  changed(): void;
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
  unmount(): void;
}

/** The link archdiff puts on a shape that has its own view. */
export const VIEW_LINK = "archdiff://view/";

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

function CanvasView({ elements, events, onApi, modeState }: CanvasProps) {
  const [mode, setMode] = useState(modeState[0]);
  useEffect(() => modeState[1](setMode), [modeState]);
  let api: ExcalidrawImperativeAPI | null = null;
  let lastTap: { id: string; at: number } | null = null;
  let down: { x: number; y: number } | null = null;

  return (
    <Excalidraw
      initialData={{ elements: elements as never, appState: { viewBackgroundColor: "#ffffff" }, scrollToContent: true }}
      excalidrawAPI={(ready) => {
        api = ready;
        // The container may still be laid out when Excalidraw mounts: fit once the frame is drawn, and whenever the window changes.
        const fit = (): void => ready.scrollToContent(undefined, { fitToContent: true, animate: false });
        requestAnimationFrame(() => requestAnimationFrame(fit));
        onApi(ready);
      }}
      viewModeEnabled={mode === "view"}
      onChange={(_elements, appState) => {
        if (mode === "edit") {
          events.changed();
          const selected = Object.keys(appState.selectedElementIds);
          events.pick(selected.length === 1 ? (selected[0] ?? null) : null);
        }
      }}
      onPointerUpdate={({ pointer, button }) => {
        if (mode !== "view") return;

        if (button === "down") {
          down = { x: pointer.x, y: pointer.y };

          return;
        }

        if (!down) return;
        const moved = Math.hypot(pointer.x - down.x, pointer.y - down.y);
        down = null;

        // A drag is a pan, not a tap.
        if (moved > 6 || !api) return;
        const hit = shapeAt(api.getSceneElements() as unknown as SceneElement[], pointer.x, pointer.y);
        const now = Date.now();

        if (hit && lastTap && lastTap.id === hit.id && now - lastTap.at < 500) {
          lastTap = null;
          events.open(hit.id, typeof hit.customData?.["view"] === "string" && hit.customData["view"] !== "" ? hit.customData["view"] : null);

          return;
        }

        lastTap = hit ? { id: hit.id, at: now } : null;
        events.pick(hit?.id ?? null);
      }}
      onLinkOpen={(element, event) => {
        if (element.link?.startsWith(VIEW_LINK)) {
          event.preventDefault();
          events.open(element.id, element.link);
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

    const handle: CanvasHandle = {
      scene: () => (api ? (api.getSceneElementsIncludingDeleted() as unknown as SceneElement[]) : elements),
      replace: (next) => {
        api?.updateScene({ elements: next as never });
        api?.scrollToContent(undefined, { fitToContent: true, animate: false });
      },
      setMode: (next) => {
        mode = next;

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
      scrollToContent: () => api?.scrollToContent(undefined, { fitToContent: true, animate: false }),
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
          resolve(handle);
        }}
      />,
    );
  });
}
