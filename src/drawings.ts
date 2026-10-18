// Saved drawings: what the editor (Excalidraw on the page) keeps of a view
// in `.archdiff/layouts/<slug>.json` (the directory keeps the name it had,
// so drawings saved before stay found) — the scene as drawn (moved shapes,
// pencil strokes, notes) and the mocks of the data-flow panel. The picture
// of a view reads a drawing's places back into `layout`, so the read-only
// canvas and every export follow the hand-made placement, and the editor
// merges a fresh picture of the code into the drawing ("refresh"): shapes
// that still exist keep their place, strokes stay, stale shapes go.
//
// Sits beside the views at the I/O edge: root + view key ↔ DrawingFile.
// Entry points: `readDrawing`, `writeDrawing`, `drawingSlug`, `parseDrawing`,
// `DrawingFile`; the pure scene helpers are re-exported from scene.ts.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIRECTORY } from "./cache.ts";
import { isJsonNumber, isJsonObject, isJsonString, parseJson, type JsonObject, type JsonValue } from "./json.ts";
import type { Mock, SceneElement } from "./scene.ts";

export type { Mock, SceneElement } from "./scene.ts";
export { mergeScene, positionsOf } from "./scene.ts";

export const DRAWING_FORMAT = 1;

export const DRAWINGS_DIRECTORY = `${CACHE_DIRECTORY}/layouts`;

export interface DrawingFile {
  format: typeof DRAWING_FORMAT;
  view: string;
  /** The scene as drawn, every element. */
  elements: SceneElement[];
  mocks: Mock[];
  /** ISO time of the save, for the reader; not compared. */
  saved: string;
}

/** The file name of a view: letters, digits, dots, dashes; everything else `_`. */
export function drawingSlug(view: string): string {
  return view.replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 150) || "view";
}

/**
 * The file of a view's drawing, relative to the root: `<slug>.json`, or — when two views spell one slug
 * (`module:src/lib_log.ts`, `module:src/lib/log.ts`; a key over 150 characters) and that file is the other view's —
 * `<slug>-<hash>.json`, named by the whole key. A drawing written before keeps its plain name.
 */
export function drawingFile(root: string, view: string): string {
  const plain = `${DRAWINGS_DIRECTORY}/${drawingSlug(view)}.json`;
  const there = readDrawingFile(join(root, plain));

  return there === null || there.view === view ? plain : `${DRAWINGS_DIRECTORY}/${drawingSlug(view)}-${createHash("sha256").update(view).digest("hex").slice(0, 10)}.json`;
}

export function drawingPath(root: string, view: string): string {
  return join(root, drawingFile(root, view));
}

function isElement(value: JsonValue): value is SceneElement {
  return isJsonObject(value) && isJsonString(value["id"]) && isJsonString(value["type"]) && isJsonNumber(value["x"]) && isJsonNumber(value["y"]) && isJsonNumber(value["width"]) && isJsonNumber(value["height"]);
}

function isMock(value: JsonValue): value is Mock & JsonObject {
  return isJsonObject(value) && isJsonString(value["id"]) && (value["kind"] === "input" || value["kind"] === "storage") && isJsonString(value["value"]);
}

/** Validates a drawing as the page sends it (without `format` and `saved`). Throws naming the field. */
export function parseDrawing(value: JsonValue, view: string): DrawingFile {
  if (!isJsonObject(value)) throw new Error("drawing: must be an object");
  const elements = value["elements"];

  if (!Array.isArray(elements) || !elements.every(isElement)) throw new Error('drawing: "elements" must be a list of Excalidraw elements (id, type, x, y, width, height)');
  const mocks = value["mocks"] ?? [];

  if (!Array.isArray(mocks) || !mocks.every(isMock)) throw new Error('drawing: "mocks" must be a list of {id, kind: input|storage, value}');

  return { format: DRAWING_FORMAT, view, elements, mocks, saved: new Date().toISOString() };
}

/** The saved drawing of a view, or null; a file of another format is ignored as if absent. */
export function readDrawing(root: string, view: string): DrawingFile | null {
  const drawing = readDrawingFile(drawingPath(root, view));

  return drawing && drawing.view === view ? drawing : null;
}

/** A drawing's file by path, whatever view it names; null when missing or not a drawing. */
export function readDrawingFile(file: string): DrawingFile | null {
  if (!existsSync(file)) return null;

  try {
    const parsed = parseJson(readFileSync(file, "utf8"));

    if (!isJsonObject(parsed) || parsed["format"] !== DRAWING_FORMAT || !isJsonString(parsed["view"])) return null;
    const drawing = parseDrawing(parsed, parsed["view"]);

    return { ...drawing, saved: isJsonString(parsed["saved"]) ? parsed["saved"] : drawing.saved };
  } catch {
    return null;
  }
}

/** Writes the drawing atomically; returns the path relative to the root. */
export function writeDrawing(root: string, drawing: DrawingFile): string {
  // Never over another view's drawing that spells the same slug.
  const relative = drawingFile(root, drawing.view);
  const file = join(root, relative);
  mkdirSync(join(root, DRAWINGS_DIRECTORY), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(drawing, null, 2)}\n`);
  renameSync(temporary, file);

  return relative;
}

