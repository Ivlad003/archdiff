// The look of every kind of shape and line, said once for every drawing of
// a picture: the Excalidraw export, the draw.io export and the page's 3D
// view draw the same picture in the same colours. A kind's outline (a
// box, an ellipse, a diamond), its stroke and fill, the line of its stroke
// and the size of its label; a change's mark as the stroke and a shape's
// heat as the fill (`lookOf`); the stroke of a line by its kind
// (`lineStroke`); the one scale of heat (`heatColour`). Node-free, in the
// core beside the vocabularies the page bundles.
//
// Entry points: `LOOKS`, `Look`, `lookOf`, `lineStroke`, `heatColour`, `DIFF_STROKE`.

import type { Line, Shape } from "./diagram.ts";

/** A fill from near white to a deep blue by `heat` 0–1. */
export function heatColour(heat: number): string {
  const t = Math.max(0, Math.min(1, heat));
  const channel = (from: number, to: number): string => Math.round(from + (to - from) * t).toString(16).padStart(2, "0");

  return `#${channel(0xf7, 0x1e)}${channel(0xf9, 0x5a)}${channel(0xfc, 0x9e)}`;
}

/** The stroke of a shape or a line a change marks: added green, removed red, changed and warned orange, planned blue. */
export const DIFF_STROKE = { added: "#2e7d32", removed: "#c62828", changed: "#ef6c00", warning: "#ef6c00", planned: "#1565c0" } as const;

/** How a stroke is drawn: whole, dashed (a removed or a planned shape, a frame), dotted (a folded tail). */
export type StrokeStyle = "solid" | "dashed" | "dotted";

/** How a kind of shape looks: its outline, the colours of its stroke and its fill, the line of its stroke, the size of its label (in Excalidraw's units). */
export interface Look {
  type: "rectangle" | "ellipse" | "diamond";
  stroke: string;
  fill: string;
  style: StrokeStyle;
  fontSize: number;
}

/** The look of every kind of shape: an entry point, a package, an event and an exit are ellipses, a gap and a branch diamonds. */
export const LOOKS: Record<Shape["kind"], Look> = {
  layer: { type: "rectangle", stroke: "#1e1e1e", fill: "#f5f5f5", style: "solid", fontSize: 15 },
  module: { type: "rectangle", stroke: "#1e1e1e", fill: "#ffffff", style: "solid", fontSize: 12 },
  fn: { type: "rectangle", stroke: "#1565c0", fill: "#e3f2fd", style: "solid", fontSize: 12 },
  external: { type: "ellipse", stroke: "#757575", fill: "#ffffff", style: "solid", fontSize: 12 },
  hole: { type: "diamond", stroke: "#ef6c00", fill: "#fff3e0", style: "dashed", fontSize: 12 },
  start: { type: "ellipse", stroke: "#1e1e1e", fill: "#c8e6c9", style: "solid", fontSize: 12 },
  more: { type: "rectangle", stroke: "#757575", fill: "#f5f5f5", style: "dotted", fontSize: 12 },
  participant: { type: "rectangle", stroke: "#1e1e1e", fill: "#f5f5f5", style: "solid", fontSize: 12 },
  // The foot of a lifeline is drawn invisible (toExcalidraw), whatever its look.
  anchor: { type: "ellipse", stroke: "#1e1e1e", fill: "transparent", style: "solid", fontSize: 12 },
  event: { type: "ellipse", stroke: "#f9a825", fill: "#fff8e1", style: "solid", fontSize: 12 },
  cell: { type: "rectangle", stroke: "#757575", fill: "#f5f5f5", style: "solid", fontSize: 10 },
  package: { type: "rectangle", stroke: "#3949ab", fill: "#e8eaf6", style: "solid", fontSize: 12 },
  class: { type: "rectangle", stroke: "#4e342e", fill: "#fff8e1", style: "solid", fontSize: 11 },
  state: { type: "rectangle", stroke: "#2e7d32", fill: "#e8f5e9", style: "solid", fontSize: 12 },
  machine: { type: "rectangle", stroke: "#2e7d32", fill: "#e8f5e9", style: "solid", fontSize: 12 },
  fragment: { type: "rectangle", stroke: "#9e9e9e", fill: "transparent", style: "dashed", fontSize: 12 },
  decision: { type: "diamond", stroke: "#6a1b9a", fill: "#f3e5f5", style: "solid", fontSize: 11 },
  action: { type: "rectangle", stroke: "#424242", fill: "#ffffff", style: "solid", fontSize: 11 },
  end: { type: "ellipse", stroke: "#616161", fill: "#eeeeee", style: "solid", fontSize: 11 },
};

/** The look of a shape as drawn: its kind's, with a change's mark as the stroke (thicker; dashed when removed or planned) and its heat as the fill. */
export function lookOf(node: Shape): Look & { width: number } {
  const look = LOOKS[node.kind];
  // Heat darkens the fill; a diff mark is the stroke, so both show at once.
  const fill = node.heat !== undefined && node.heat > 0 ? heatColour(node.heat) : look.fill;
  const stroke = node.diff ? DIFF_STROKE[node.diff] : look.stroke;
  const style = node.diff === "removed" || node.diff === "planned" ? "dashed" : look.style;

  return { ...look, fill, stroke, style, width: node.diff ? 3 : 1 };
}

/** The stroke of a line by its kind, unless a change marks it: calls and messages blue, lifelines faint, a type-only import grey. */
export function lineStroke(edge: Line): string {
  if (edge.diff) return DIFF_STROKE[edge.diff];

  switch (edge.kind) {
    case "call":
    case "message":
      return "#1565c0";
    case "lifeline":
      return "#b0bec5";
    case "flow":
      return "#424242";
    default:
      return edge.typeOnly ? "#9e9e9e" : "#616161";
  }
}
