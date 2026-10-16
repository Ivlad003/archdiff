// Saved drawings: what the editor (Excalidraw on the page) keeps of a view
// in `.archdiff/layouts/<slug>.json` — the scene as drawn (moved shapes,
// pencil strokes, notes) and the mocks of the data-flow panel. The server
// reads a scene's positions back into `layout`, so the read-only canvas
// and every export follow the hand-made placement, and the editor merges
// a fresh picture of the code into the saved scene ("re-layout"): shapes
// that still exist keep their place, drawings stay, stale shapes go.
//
// Sits beside the views at the I/O edge: root + view key ↔ LayoutFile.
// Entry points: `readLayout`, `writeLayout`, `layoutSlug`, `parseLayout`,
// `LayoutFile`; the pure scene helpers are re-exported from scene.ts.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIRECTORY } from "./cache.ts";
import { isJsonNumber, isJsonObject, isJsonString, parseJson, type JsonObject, type JsonValue } from "./json.ts";
import type { Mock, SceneElement } from "./scene.ts";

export type { Mock, SceneElement } from "./scene.ts";
export { mergeScene, positionsOf } from "./scene.ts";

export const LAYOUT_FORMAT = 1;

export const LAYOUTS_DIRECTORY = `${CACHE_DIRECTORY}/layouts`;

export interface LayoutFile {
  format: typeof LAYOUT_FORMAT;
  view: string;
  /** The scene as drawn, every element. */
  elements: SceneElement[];
  mocks: Mock[];
  /** ISO time of the save, for the reader; not compared. */
  saved: string;
}

/** The file name of a view: letters, digits, dots, dashes; everything else `_`. */
export function layoutSlug(view: string): string {
  return view.replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 150) || "view";
}

export function layoutPath(root: string, view: string): string {
  return join(root, LAYOUTS_DIRECTORY, `${layoutSlug(view)}.json`);
}

function isElement(value: JsonValue): value is SceneElement {
  return isJsonObject(value) && isJsonString(value["id"]) && isJsonString(value["type"]) && isJsonNumber(value["x"]) && isJsonNumber(value["y"]) && isJsonNumber(value["width"]) && isJsonNumber(value["height"]);
}

function isMock(value: JsonValue): value is Mock & JsonObject {
  return isJsonObject(value) && isJsonString(value["id"]) && (value["kind"] === "input" || value["kind"] === "storage") && isJsonString(value["value"]);
}

/** Validates a layout as the page sends it (without `format` and `saved`). Throws naming the field. */
export function parseLayout(value: JsonValue, view: string): LayoutFile {
  if (!isJsonObject(value)) throw new Error("layout: must be an object");
  const elements = value["elements"];

  if (!Array.isArray(elements) || !elements.every(isElement)) throw new Error('layout: "elements" must be a list of Excalidraw elements (id, type, x, y, width, height)');
  const mocks = value["mocks"] ?? [];

  if (!Array.isArray(mocks) || !mocks.every(isMock)) throw new Error('layout: "mocks" must be a list of {id, kind: input|storage, value}');

  return { format: LAYOUT_FORMAT, view, elements, mocks, saved: new Date().toISOString() };
}

/** The saved layout of a view, or null; a file of another format is ignored as if absent. */
export function readLayout(root: string, view: string): LayoutFile | null {
  const layout = readLayoutFile(layoutPath(root, view));

  return layout && layout.view === view ? layout : null;
}

/** A layout file by path, whatever view it names; null when missing or not a layout. */
export function readLayoutFile(file: string): LayoutFile | null {
  if (!existsSync(file)) return null;

  try {
    const parsed = parseJson(readFileSync(file, "utf8"));

    if (!isJsonObject(parsed) || parsed["format"] !== LAYOUT_FORMAT || !isJsonString(parsed["view"])) return null;
    const layout = parseLayout(parsed, parsed["view"]);

    return { ...layout, saved: isJsonString(parsed["saved"]) ? parsed["saved"] : layout.saved };
  } catch {
    return null;
  }
}

/** Writes the layout atomically; returns the path relative to the root. */
export function writeLayout(root: string, layout: LayoutFile): string {
  const file = layoutPath(root, layout.view);
  mkdirSync(join(root, LAYOUTS_DIRECTORY), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(layout, null, 2)}\n`);
  renameSync(temporary, file);

  return `${LAYOUTS_DIRECTORY}/${layoutSlug(layout.view)}.json`;
}

