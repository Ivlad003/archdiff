// What happens to a picture after its view built it and before it is laid
// out, as data: a list of steps, each a pure Diagram → Diagram with the
// condition under which it runs. The order is the list's order — hidden
// lanes leave first, modules open in place, hubs become badges before the
// fold (they would eat its budget), the question is set, the tail folds,
// light lines go after the fold (on the merged lines), the review's marks
// and the overlays come last so they sit on the shapes that stay, and the
// lanes are set as rows or columns for the layout. Every step appends to
// `reason`, so a picture says what was done to it.
//
// Sits between views.ts (which builds the full picture) and layout.
// Entry points: `STEPS`, `runSteps`, `Step`, `StepContext`.

import type { Analysis } from "./analyze.ts";
import type { Diagram } from "./diagram.ts";
import { onlyChanged, overlayDiff } from "./diff.ts";
import type { Graph } from "./graph.ts";
import { applyOverlays } from "./overlays.ts";
import { dropLightLines, expandInPlace, fold, hideLanes, hubsAsBadges, MAX_SHAPES } from "./shape.ts";
import type { PictureOptions } from "./options.ts";
import { isMapView, isModuleView, questionOf, type View } from "./view-keys.ts";
import type { EdgeReads } from "./views.ts";

export interface StepContext {
  analysis: Analysis;
  graph: Graph;
  view: View;
  options: PictureOptions;
  /** What the edge read for the view (picture.ts): the review's diff for `changes` among it. */
  reads: EdgeReads;
  /** The subject of the view (a module, a function), never folded or made a hub; null for a view without one. */
  subject: string | null;
}

export interface Step {
  name: string;
  /** Whether the step runs for this picture and these options. */
  applies(ctx: StepContext, diagram: Diagram): boolean;
  run(diagram: Diagram, ctx: StepContext): Diagram;
}

/** More lanes than this on a map of modules (the whole map, a layer, a directory), and `auto` lays them as columns. */
const COLUMNS_ABOVE = 6;

/** The pictures whose shapes carry a review's marks: the review's own marks, or those `changes` laid over the picture. */
function marked({ reads, view }: StepContext): boolean {
  return (reads.diff !== undefined && view.kind !== "timeline") || view.kind === "review" || view.kind === "compare";
}

export const STEPS: readonly Step[] = [
  { name: "hide lanes", applies: ({ options }) => options.hideLanes.length > 0, run: (diagram, { options }) => hideLanes(diagram, options.hideLanes) },
  { name: "open in place", applies: ({ options, view }) => options.expand.length > 0 && isModuleView(view.kind), run: (diagram, { graph, options }) => expandInPlace(diagram, graph, options.expand) },
  { name: "hubs as badges", applies: ({ options, view }) => options.hubs && isModuleView(view.kind), run: (diagram, { subject, analysis }) => hubsAsBadges(diagram, subject, analysis.config.hubs) },
  { name: "question", applies: (_ctx, diagram) => !diagram.question, run: (diagram, { view }) => ({ ...diagram, question: questionOf(view.kind) }) },
  { name: "fold", applies: (_ctx, diagram) => !diagram.placed && !diagram.classes && !diagram.logic, run: (diagram, { options }) => fold(diagram, options.limit ?? MAX_SHAPES) },
  { name: "light lines", applies: ({ options }) => (options.weight ?? 1) > 1, run: (diagram, { options }) => dropLightLines(diagram, options.weight ?? 1) },
  { name: "changes", applies: ({ reads, view }) => reads.diff !== undefined && view.kind !== "timeline" && view.kind !== "review" && view.kind !== "compare", run: (diagram, { reads }) => overlayDiff(diagram, reads.diff!) },
  { name: "only changes", applies: (ctx) => ctx.options.onlyChanges && marked(ctx), run: (diagram) => onlyChanged(diagram) },
  { name: "overlays", applies: ({ options }) => options.overlays.length > 0, run: (diagram, { analysis, options }) => applyOverlays(diagram, analysis, options.overlays) },
  // Rows or columns, said once, here: `layout` lays the lanes as the picture says and writes back what it could do.
  { name: "lane mode", applies: () => true, run: (diagram, { options, view }) => ({ ...diagram, lanes: options.lanes !== "auto" ? options.lanes : isMapView(view.kind) && diagram.groups.length > COLUMNS_ABOVE ? "columns" : "rows" }) },
];

/** The picture after every step that applies, in order. */
export function runSteps(diagram: Diagram, ctx: StepContext): Diagram {
  return STEPS.reduce((picture, step) => (step.applies(ctx, picture) ? step.run(picture, ctx) : picture), diagram);
}
