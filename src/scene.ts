// The scene of the editor as data: Excalidraw elements with archdiff's
// marks (`customData.archdiff`), the mocks of the data-flow panel, the
// places of generated shapes for `layout`, and the merge of a fresh
// picture of the code into a saved drawing. Pure and free of Node, so the
// page (web/src) and the server share it.
//
// Entry points: `positionsOf`, `mergeScene`, `SceneElement`, `Mock`.

import type { Positions } from "./diagram.ts";
import { isJsonObject, isJsonString, type JsonObject } from "./json.ts";

/** One Excalidraw element as the page sends it; only what archdiff reads is typed. */
export interface SceneElement extends JsonObject {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  /** Set by archdiff's export on every generated element: the view it was drawn for. */
  customData?: JsonObject;
}

/** A mock the data-flow panel attaches to a shape: its node ID and the value as JSON text. */
export interface Mock {
  id: string;
  /** `input`: the arguments of an entry; `storage`: what a store, db or cache holds. */
  kind: "input" | "storage";
  value: string;
}

/** The places of the generated shapes of a scene, by node ID (the element's ID), for `layout`'s manual positions. */
export function positionsOf(elements: readonly SceneElement[] | null): Positions {
  const positions: Record<string, { x: number; y: number; w: number; h: number }> = {};

  if (!elements) return positions;

  for (const element of elements) {
    if (element.isDeleted || element.type === "text" || element.type === "arrow" || element.type === "freedraw" || element.type === "line") continue;

    if (!isJsonObject(element.customData) || element.customData["archdiff"] !== "node") continue;
    positions[element.id] = { x: element.x, y: element.y, w: element.width, h: element.height };
  }

  return positions;
}

/**
 * A fresh scene of the code merged into a saved one: generated elements
 * (`customData.archdiff`) come from the fresh scene, at the saved place
 * when the saved scene had them; everything the user drew (no
 * `customData.archdiff`) is kept. Generated elements the fresh scene no
 * longer has are dropped: the code moved on.
 */
export function mergeScene(saved: readonly SceneElement[], fresh: readonly SceneElement[]): SceneElement[] {
  const generated = (element: SceneElement): boolean => isJsonObject(element.customData) && isJsonString(element.customData["archdiff"]);
  const savedById = new Map(saved.filter(generated).map((element) => [element.id, element]));
  const merged: SceneElement[] = [];

  for (const element of fresh) {
    const before = savedById.get(element.id);

    if (before && isJsonObject(element.customData) && element.customData["archdiff"] === "node") {
      merged.push({ ...element, x: before.x, y: before.y, width: before.width, height: before.height });
    } else if (before && isJsonObject(element.customData) && element.customData["archdiff"] === "label") {
      // A label follows its container: Excalidraw re-places bound text on load, so the fresh one is enough.
      merged.push(element);
    } else {
      merged.push(element);
    }
  }

  for (const element of saved) if (!generated(element) && !element.isDeleted) merged.push(element);

  return merged;
}
