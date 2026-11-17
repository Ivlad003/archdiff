// The legend under the canvas: the kinds of shape and of line the picture
// shown has, each drawn by the look the canvas draws it with
// (src/looks.ts), and the marks of a change when the picture carries
// any. A picture of layers explains a layer and an import, not a
// function's branches: the row says what is on the canvas now, and stays
// one row.
//
// Entry point: `renderLegend`.

import type { Line, Shape } from "./api.ts";
import { element, h } from "./dom.ts";
import { COCHANGE_STROKE, DIFF_STROKE, LOOKS } from "../../src/looks.ts";

/** What the legend calls each kind of shape, in the order it lists them; a kind left out (the foot of a lifeline) is never explained. */
const SHAPES: [kind: Shape["kind"], label: string, title: string][] = [
  ["layer", "layer", "A layer: a named set of modules that depend on other layers in one direction"],
  ["package", "workspace package", "A package of the repository's own workspace"],
  ["module", "module", "A module: a source file"],
  ["participant", "participant", "A module at the top of a sequence, with its lifeline under it"],
  ["start", "entry point", "A declaration execution starts from"],
  ["fn", "function", "A function, a method or a class"],
  ["class", "class", "A class or an interface, with its fields and methods"],
  ["external", "package", "A package or a built-in the code imports"],
  ["event", "event", "An event: emitted, or listened to"],
  ["machine", "machine", "A state machine"],
  ["state", "state", "A state of a machine"],
  ["cell", "cell", "A cell of a table or a bar of a chart: darker, more"],
  ["fragment", "guard", "The calls made under one condition or in one loop"],
  ["decision", "branch", "A branch of a function's logic: an if, a switch, a loop, a try"],
  ["action", "step", "One or two plain statements of a function"],
  ["end", "exit", "Where a path through a function ends: a return, a throw, the end of the body"],
  ["hole", "not followed", "A call the analysis could not follow"],
  ["more", "… more", "The shapes a big picture folds away; the Markdown lists them all"],
];

/** What the legend calls each kind of line, how it draws it, and what a line from A to B says. */
const LINES: [kind: Line["kind"], label: string, stroke: string, dashed: boolean, title: string][] = [
  ["dependency", "A → B: A imports B", "#616161", false, "An import: the left imports the right"],
  ["call", "A calls B", "#1565c0", false, "A call the analysis followed to its target"],
  ["ref", "passed as a value", "#1565c0", true, "A function passed as a value: it may be called"],
  ["message", "message", "#1565c0", false, "One call of a sequence, in order from the top"],
  ["flow", "next step", "#424242", false, "The next step of a function's logic, labelled with the branch taken"],
  ["cochange", "changed together", COCHANGE_STROKE, true, "Two files the commits of the range changed together at least twice (the coupling overlay)"],
];

/** What the legend calls each mark of a change, in the order it lists them. */
const MARKS: [mark: keyof typeof DIFF_STROKE, label: string, fill: string, dashed: boolean][] = [
  ["added", "added", "#d4f8d4", false],
  ["removed", "removed", "#f8d4d4", true],
  ["changed", "changed", "#fff4c2", false],
  ["planned", "planned", "#e3f2fd", true],
];

/** A swatch of a shape: its outline (a box, an ellipse, a diamond), its stroke and its fill. */
function swatch(type: "rectangle" | "ellipse" | "diamond", stroke: string, fill: string, style: string, width = 1.5): HTMLElement {
  const box = h("i", { class: `sw ${type}` });
  box.style.borderColor = stroke;
  box.style.background = fill;
  box.style.borderStyle = style;
  box.style.borderWidth = `${width}px`;

  return box;
}

/** The legend of the picture shown: its kinds of shape, its kinds of line, the marks on them; nothing for an empty picture. */
export function renderLegend(nodes: Iterable<Shape>, edges: readonly Line[]): void {
  const shapes = [...nodes];
  const kinds = new Set(shapes.map((shape) => shape.kind));
  const lines = new Set(edges.map((edge) => edge.kind));
  const marks = new Set([...shapes.map((shape) => shape.diff), ...edges.map((edge) => edge.diff)]);
  const entries: HTMLElement[] = [];

  for (const [kind, label, title] of SHAPES) {
    if (!kinds.has(kind)) continue;
    const look = LOOKS[kind];
    entries.push(h("span", { title }, swatch(look.type, look.stroke, look.fill === "transparent" ? "none" : look.fill, look.style), label));
  }

  for (const [kind, label, stroke, dashed, title] of LINES) {
    if (!lines.has(kind)) continue;
    const line = h("i", { class: "ln" });
    line.style.borderTopColor = stroke;
    line.style.borderTopStyle = dashed ? "dashed" : "solid";
    entries.push(h("span", { title }, line, label));
  }

  if (edges.some((edge) => edge.typeOnly)) {
    const line = h("i", { class: "ln" });
    line.style.borderTopColor = "#9e9e9e";
    line.style.borderTopStyle = "dashed";
    entries.push(h("span", { title: "Only types cross the line (import type): no dependency at run time" }, line, "types only"));
  }

  for (const [mark, label, fill, dashed] of MARKS) if (marks.has(mark)) entries.push(h("span", { title: `${label[0]!.toUpperCase()}${label.slice(1)}: what the change, or the contract, says of the shape or the line` }, swatch("rectangle", DIFF_STROKE[mark], fill, dashed ? "dashed" : "solid", 2), label));

  element("legend").replaceChildren(...entries);
}
