// A Diagram as an Excalidraw scene (`.excalidraw`, JSON): lanes as
// rectangles behind the shapes, shapes as rectangles, ellipses or diamonds
// with a bound text element, lines as arrows along the routes of the
// orthogonal router (not bound: Excalidraw would pull their ends to the
// centres of the sides). IDs and seeds derive from the archdiff IDs, so
// the same diagram gives the same file. The router is shared with the
// draw.io export and the page.
//
// Entry points: `toExcalidraw`, `routeEdges`, `Point`.

import type { Diagram, Line, Shape } from "../diagram.ts";
import { heatColour } from "./colour.ts";
import { routeFree } from "./route-free.ts";
import { lineElementId, opensView } from "../shape-keys.ts";

interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: 0;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: "solid" | "hachure";
  strokeWidth: number;
  strokeStyle: "solid" | "dashed" | "dotted";
  roughness: 0 | 1;
  opacity: number;
  groupIds: string[];
  frameId: null;
  roundness: { type: number } | null;
  seed: number;
  version: 1;
  versionNonce: number;
  isDeleted: false;
  boundElements: { id: string; type: "text" | "arrow" }[] | null;
  updated: 1;
  link: string | null;
  locked: boolean;
  [extra: string]: unknown;
}

/** Characters of a line of a label inside a shape. */
const LINE = 22;
/** The height of a line of text, in font sizes. */
const LINE_HEIGHT = 1.25;
/** How far a shape's label keeps from the shape's sides (and a class box's from its top). */
const LABEL_INSET = 8;
/** The label of a lane, and of a sequence's fragment: top left in the frame, at its offset, in a box of its size. */
const LANE_LABEL = { dx: 8, dy: 4, w: 120, h: 20, fontSize: 14 } as const;
const FRAGMENT_LABEL = { dx: 8, dy: 2, w: 200, h: 18, fontSize: 12 } as const;
/** The label of a line: at most this wide, on the line (labelSpot); a message's sits above its line, a self-call's beside its loop. */
const LINE_LABEL = { w: 120, h: 16, fontSize: 12, above: 18, selfDx: 80, selfDy: 4 } as const;
/** The label of a step of a function's logic: up to four lines of 32 characters (24 for an exit), its start kept. */
const LOGIC_LABEL = { lines: 4, width: 32, endWidth: 24 } as const;
/** The counts of a shape's neighbours beyond the picture: small, grey, under its corners — before it on the left, after it on the right. */
const BEYOND_LABEL = { w: 60, h: 14, gap: 2, fontSize: 11, colour: "#78909c" } as const;

/** Where an element sits on the scene and how big it is: a shape's and a lane's box. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The width a line of text takes at `fontSize`, roughly: the hand-drawn face averages six tenths of the size a character. */
function textWidth(text: string, fontSize: number): number {
  return Math.max(...text.split("\n").map((line) => line.length)) * fontSize * 0.6;
}

/** Whether two boxes overlap. */
function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Where a line's label sits: on the line itself — the midpoint of its start and its end, which the label kept before,
 * lies off an elbowed route, often on a shape or on another line's label. Spots along each segment are tried, the
 * longest segment first — its middle, then a third, two thirds, a fifth and four fifths along — above a horizontal
 * segment and then below it, beside a vertical one on the right and then on the left (lines running together share
 * a segment, and their labels take turns along it); the first spot clear of every shape and of the labels placed
 * before wins. Where no spot is clear (a label wider than the gap its line crosses), the one that covers the least:
 * another label counts double, as two labels on each other read as neither.
 */
function labelSpot(route: readonly Point[], size: { w: number; h: number }, shapes: readonly Box[], placed: readonly Box[]): Box {
  const segments = route.slice(1).map((end, i) => ({ start: route[i]!, end, length: Math.hypot(end.x - route[i]!.x, end.y - route[i]!.y) })).sort((a, b) => b.length - a.length);
  const spots: Box[] = [];

  for (const { start, end } of segments) {
    const vertical = Math.abs(end.x - start.x) < Math.abs(end.y - start.y);

    for (const t of [0.5, 1 / 3, 2 / 3, 0.2, 0.8]) {
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;

      if (vertical) spots.push({ x: x + 4, y: y - size.h / 2, w: size.w, h: size.h }, { x: x - 4 - size.w, y: y - size.h / 2, w: size.w, h: size.h });
      else spots.push({ x: x - size.w / 2, y: y - size.h - 2, w: size.w, h: size.h }, { x: x - size.w / 2, y: y + 2, w: size.w, h: size.h });
    }
  }

  const clear = spots.find((spot) => !shapes.some((shape) => overlaps(spot, shape)) && !placed.some((other) => overlaps(spot, other)));

  if (clear || spots.length === 0) return clear ?? { x: route[0]!.x, y: route[0]!.y, w: size.w, h: size.h };
  const covered = (spot: Box): number => shapes.reduce((sum, shape) => sum + overlapArea(spot, shape), 0) + 2 * placed.reduce((sum, other) => sum + overlapArea(spot, other), 0);

  return spots.reduce((best, spot) => (covered(spot) < covered(best) ? spot : best));
}

/** How much of two boxes overlaps, in square units. */
function overlapArea(a: Box, b: Box): number {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

/** The height of `lines` lines of text at `fontSize`. */
function textHeight(lines: number, fontSize: number): number {
  return lines * fontSize * LINE_HEIGHT;
}

/**
 * A label in lines of at most `width` characters (`LINE` by default), broken after slashes, dots and spaces, `max` lines at
 * most; the end of a path says the most, so the start is cut — except for `keepStart` (a statement of code), whose end is cut.
 */
export function wrapLabel(text: string, max = 3, width = LINE, keepStart = false): string {
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    let line = "";

    for (const part of paragraph.split(keepStart ? /(?<=[./ ])/ : /(?<=[./])/)) {
      if (line !== "" && line.length + part.length > width) {
        lines.push(line);
        line = "";
      }

      line += part;

      while (line.length > width) {
        lines.push(line.slice(0, width));
        line = line.slice(width);
      }
    }

    if (line !== "") lines.push(line);
  }

  if (lines.length <= max) return lines.join("\n");

  if (keepStart) return [...lines.slice(0, max - 1), `${lines[max - 1]!.slice(0, width - 1)}…`].join("\n");

  return [`…${lines.slice(0, lines.length - max + 1).join("").slice(-(width - 1))}`, ...lines.slice(lines.length - max + 1)].join("\n");
}

/** A stable 31-bit number from a string, for `seed` and `versionNonce`: FNV-1a (its offset basis and prime), folded below 2³¹ − 1. */
function seed(text: string): number {
  let hash = 2166136261;

  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);

  return (hash >>> 0) % 2147483647 || 1;
}

const DIFF_STROKE = { added: "#2e7d32", removed: "#c62828", changed: "#ef6c00", warning: "#ef6c00", planned: "#1565c0" } as const;

function base(id: string, type: string, box: Box): ExcalidrawElement {
  return { id, type, x: box.x, y: box.y, width: box.w, height: box.h, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: seed(id), version: 1, versionNonce: seed(`${id}:v`), isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
}

/** A text element: `content` in `box`, grown to hold its lines; `container` is the shape or line it labels, null for a free label. */
function text(id: string, container: string | null, box: Box, content: string, fontSize: number): ExcalidrawElement {
  const height = Math.max(box.h, textHeight(content.split("\n").length, fontSize));

  return { ...base(id, "text", { ...box, h: height }), text: content, originalText: content, fontSize, fontFamily: 1, textAlign: "center", verticalAlign: "middle", containerId: container, lineHeight: LINE_HEIGHT, autoResize: true };
}

/** How a kind of shape looks: its outline, the colours of its stroke and its fill, the line of its stroke, the size of its label. */
interface Look {
  type: "rectangle" | "ellipse" | "diamond";
  stroke: string;
  fill: string;
  style: ExcalidrawElement["strokeStyle"];
  fontSize: number;
}

/** The look of every kind of shape: an entry point, a package, an event and an exit are ellipses, a gap and a branch diamonds. */
const LOOKS: Record<Shape["kind"], Look> = {
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
  fragment: { type: "rectangle", stroke: "#9e9e9e", fill: "transparent", style: "dashed", fontSize: FRAGMENT_LABEL.fontSize },
  decision: { type: "diamond", stroke: "#6a1b9a", fill: "#f3e5f5", style: "solid", fontSize: 11 },
  action: { type: "rectangle", stroke: "#424242", fill: "#ffffff", style: "solid", fontSize: 11 },
  end: { type: "ellipse", stroke: "#616161", fill: "#eeeeee", style: "solid", fontSize: 11 },
};

/** The look of a shape as drawn: its kind's, with a change's mark as the stroke (thicker; dashed when removed or planned) and its heat as the fill. */
function lookOf(node: Shape): Look & { width: number } {
  const look = LOOKS[node.kind];
  // Heat darkens the fill; a diff mark is the stroke, so both show at once.
  const fill = node.heat !== undefined && node.heat > 0 ? heatColour(node.heat) : look.fill;
  const stroke = node.diff ? DIFF_STROKE[node.diff] : look.stroke;
  const style = node.diff === "removed" || node.diff === "planned" ? "dashed" : look.style;

  return { ...look, fill, stroke, style, width: node.diff ? 3 : 1 };
}

/** The stroke of a line by its kind, unless a change marks it: calls and messages blue, lifelines faint, a type-only import grey. */
function lineStroke(edge: Line): string {
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

/** The view a shape opens on the page (`customData.view`, read on a second tap): shape-keys.ts's, as a link; not an Excalidraw link, whose icon would clutter every shape. */
function viewLink(node: Shape): string | null {
  const view = opensView(node);

  return view === null ? null : `archdiff://view/${encodeURIComponent(view)}`;
}

/**
 * The proportions and distances of the orthogonal router: fractions of a
 * side or of a gap between columns, and scene pixels.
 */
const ROUTE = {
  /** The ports of a side spread from this far down it, over this much of its height. */
  portFrom: 0.15,
  portSpan: 0.7,
  /** How close a horizontal run may pass a shape it does not join, above or below. */
  clearance: 6,
  /** The margin kept around the shapes when finding the corridors between rows. */
  corridorMargin: 10,
  /** What a corridor's room keeps off the shapes on either side. */
  corridorSlack: 2,
  /** The corridor under the last row: how far below it, and how much room it has. */
  underLastRow: 12,
  underLastRoom: 40,
  /** The channels of a gap fill its middle: from this far across, over this much of it. */
  channelFrom: 0.2,
  channelSpan: 0.6,
  /** A detour leaves down the gap after its source's column, from this far across, its exits this many pixels apart, over at most this much of the gap. */
  detourFrom: 0.08,
  detourStep: 5,
  detourSpan: 0.1,
  /** Parallel lines of one corridor, of the lane below, of a backward gap, sit this far apart. */
  lineSpacing: 4,
  /** A full corridor costs as much as this distance: more than any corridor a row away. */
  fullCorridor: 1000,
  /** The lane below the shapes for the lines going back: this far below the lowest, the lines this far apart, in this many before they repeat. */
  backBelow: 24,
  backStep: 8,
  backLanes: 8,
  /** A line going back runs down its gap this far across (from the near side), in this many channels before they repeat. */
  backAcross: 0.85,
  backChannels: 4,
  /** The gap assumed past the last column and before the first. */
  outerGap: 40,
} as const;

/** A point of a route. */
export interface Point {
  x: number;
  y: number;
}

/** The columns of a placed diagram: shapes whose x-ranges overlap share a column; a column starts where a shape begins past every shape before it. */
function columnsOf(nodes: readonly Shape[]): { column: Map<string, number>; left: number[]; right: number[] } {
  const column = new Map<string, number>();
  const left: number[] = [];
  const right: number[] = [];
  let index = -1;

  for (const node of [...nodes].sort((a, b) => a.x - b.x)) {
    if (index < 0 || node.x >= right[index]! - 1) {
      index++;
      left.push(node.x);
      right.push(node.x + node.w);
    }

    right[index] = Math.max(right[index]!, node.x + node.w);
    column.set(node.id, index);
  }

  return { column, left, right };
}

/**
 * Orthogonal routes for the edges of a placed diagram: an edge leaves its
 * source on the right, runs along a vertical channel in the gap just before
 * the target's column, and enters the target on the left. When it spans
 * more than one column and a shape stands in its way, its horizontal run
 * goes along a corridor between the rows of the columns in between. An
 * edge going backwards (to the left, or within one column) leaves at the
 * bottom and comes around below the shapes. Edges sharing a gap take
 * channels a few pixels apart, by their order, so parallel runs stay
 * apart. Exports and the canvas share these routes; the sizes come from
 * `layout`.
 */
export function routeEdges(diagram: Diagram): Map<Line, Point[]> {
  // Shapes the user moved out of the layout's columns: the grid router around every shape (route-free.ts).
  if (diagram.freeform) return routeFree(diagram);
  const boxes = new Map(diagram.nodes.map((node) => [node.id, node]));
  const routes = new Map<Line, Point[]>();
  const lowest = Math.max(0, ...diagram.nodes.map((node) => node.y + node.h));
  const centreY = (node: Shape): number => node.y + node.h / 2;
  const usable = diagram.edges.filter((edge) => boxes.has(edge.from) && boxes.has(edge.to) && edge.from !== edge.to && !edge.route);
  const columns = columnsOf(diagram.nodes);

  // Ports: the edges leaving a shape spread down its right side in the order of their targets, the edges entering a
  // shape spread down its left side in the order of their sources, so no two lines share an end point.
  const outgoing = new Map<string, Line[]>();
  const incoming = new Map<string, Line[]>();

  for (const edge of usable) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }

  const portY = (node: Shape, index: number, count: number): number => {
    if (count <= 1) return centreY(node);
    const span = node.h * ROUTE.portSpan;

    return node.y + node.h * ROUTE.portFrom + (span * index) / (count - 1);
  };

  const outPort = new Map<Line, number>();
  const inPort = new Map<Line, number>();

  for (const [id, edges] of outgoing) {
    const sorted = [...edges].sort((a, b) => centreY(boxes.get(a.to)!) - centreY(boxes.get(b.to)!));
    sorted.forEach((edge, i) => outPort.set(edge, portY(boxes.get(id)!, i, sorted.length)));
  }

  for (const [id, edges] of incoming) {
    const sorted = [...edges].sort((a, b) => centreY(boxes.get(a.from)!) - centreY(boxes.get(b.from)!));
    sorted.forEach((edge, i) => inPort.set(edge, portY(boxes.get(id)!, i, sorted.length)));
  }

  // A shape (other than the edge's own two) standing on the horizontal run at `y` between `x1` and `x2`.
  const blocked = (edge: Line, y: number, x1: number, x2: number): boolean =>
    diagram.nodes.some((node) => node.id !== edge.from && node.id !== edge.to && node.x < x2 && node.x + node.w > x1 && node.y - ROUTE.clearance < y && node.y + node.h + ROUTE.clearance > y);

  // The free horizontal corridors between the rows of the columns `first`..`last`: the midpoints of the gaps between
  // the shapes' y-ranges, plus one below the last (not above the first: the lane's label sits there).
  const corridors = (first: number, last: number): { y: number; room: number }[] => {
    const spans = diagram.nodes
      .filter((node) => (columns.column.get(node.id) ?? -1) >= first && (columns.column.get(node.id) ?? -1) <= last)
      .map((node) => [node.y - ROUTE.corridorMargin, node.y + node.h + ROUTE.corridorMargin] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];

    for (const span of spans) {
      const last = merged[merged.length - 1];

      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push([span[0], span[1]]);
    }

    const free: { y: number; room: number }[] = [];

    for (let i = 0; i < merged.length; i++) {
      // `room`: how far from the corridor's centre a line may sit without touching a shape.
      if (i > 0) free.push({ y: (merged[i - 1]![1] + merged[i]![0]) / 2, room: Math.max(0, (merged[i]![0] - merged[i - 1]![1]) / 2 - ROUTE.corridorSlack) });

      if (i === merged.length - 1) free.push({ y: merged[i]![1] + ROUTE.underLastRow, room: ROUTE.underLastRoom });
    }

    return free;
  };

  // Channels: the vertical run of a forward edge sits in the gap just before the target's column; the edges of one
  // gap take distinct x positions spread over the middle of the gap, ordered by where they start, so their runs do
  // not overlap. A detour (the exit of an edge that must take a corridor) runs down the left tenth of the gap after
  // the source's column, and the edges of one corridor sit a few pixels apart.
  const byGap = new Map<number, Line[]>();
  const backward: Line[] = [];

  for (const edge of usable) {
    const from = columns.column.get(edge.from)!;
    const to = columns.column.get(edge.to)!;

    if (to > from) byGap.set(to, [...(byGap.get(to) ?? []), edge]);
    else backward.push(edge);
  }

  const detours = new Map<number, number>();
  const taken = new Map<number, number>();

  for (const [targetColumn, edges] of byGap) {
    const gapLeft = columns.right[targetColumn - 1]!;
    const width = columns.left[targetColumn]! - gapLeft;
    const sorted = [...edges].sort((a, b) => outPort.get(a)! - outPort.get(b)!);
    const n = sorted.length;

    sorted.forEach((edge, i) => {
      const from = boxes.get(edge.from)!;
      const to = boxes.get(edge.to)!;
      const sourceColumn = columns.column.get(edge.from)!;
      const startY = outPort.get(edge)!;
      const endY = inPort.get(edge)!;
      // The middle of the gap holds the channels; one edge runs down the centre.
      const channel = n === 1 ? gapLeft + width / 2 : gapLeft + width * ROUTE.channelFrom + (width * ROUTE.channelSpan * i) / (n - 1);
      const route: Point[] = [{ x: from.x + from.w, y: startY }];

      if (targetColumn > sourceColumn + 1 && blocked(edge, startY, from.x + from.w, channel)) {
        // Around the shapes in between: out into the gap after the source, along the nearest free corridor, into the channel.
        const exitLeft = columns.right[sourceColumn]!;
        const exitWidth = columns.left[sourceColumn + 1]! - exitLeft;
        const used = detours.get(sourceColumn) ?? 0;
        detours.set(sourceColumn, used + 1);
        const exitX = exitLeft + exitWidth * ROUTE.detourFrom + Math.min(exitWidth * ROUTE.detourSpan, used * ROUTE.detourStep);
        const wanted = (startY + endY) / 2;
        // The nearest corridor with room left: a full one costs as much as a corridor a row away.
        const cost = (corridor: { y: number; room: number }): number => Math.abs(corridor.y - wanted) + ((taken.get(Math.round(corridor.y)) ?? 0) * ROUTE.lineSpacing > corridor.room * 2 ? ROUTE.fullCorridor : 0);
        const corridor = corridors(sourceColumn + 1, targetColumn - 1).sort((a, b) => cost(a) - cost(b))[0] ?? { y: startY, room: 0 };
        const key = Math.round(corridor.y);
        const seen = taken.get(key) ?? 0;
        taken.set(key, seen + 1);
        // Lines of one corridor sit a few pixels apart, alternating sides of its centre, never past its room.
        const y = corridor.y + (seen % 2 === 0 ? 1 : -1) * Math.min(corridor.room, Math.ceil(seen / 2) * ROUTE.lineSpacing);
        route.push({ x: exitX, y: startY }, { x: exitX, y }, { x: channel, y }, { x: channel, y: endY });
      } else if (Math.abs(startY - endY) > 1) {
        route.push({ x: channel, y: startY }, { x: channel, y: endY });
      }

      route.push({ x: to.x, y: endY });
      routes.set(edge, route);
    });
  }

  // Backward or same column: out of the source's right into the gap after its column, down along a lane below
  // everything, back along it, up the gap before the target's column and into the target's left. Every vertical
  // run sits in a gap, so no shape is crossed; the lane below spreads the edges a few pixels apart.
  backward.forEach((edge, i) => {
    const from = boxes.get(edge.from)!;
    const to = boxes.get(edge.to)!;
    const sourceColumn = columns.column.get(edge.from)!;
    const targetColumn = columns.column.get(edge.to)!;
    const below = lowest + ROUTE.backBelow + (i % ROUTE.backLanes) * ROUTE.backStep;
    const exitGap = sourceColumn + 1 < columns.left.length ? columns.left[sourceColumn + 1]! - columns.right[sourceColumn]! : ROUTE.outerGap;
    const exitX = columns.right[sourceColumn]! + exitGap * ROUTE.backAcross - (i % ROUTE.backChannels) * ROUTE.lineSpacing;
    const entryGap = targetColumn > 0 ? columns.left[targetColumn]! - columns.right[targetColumn - 1]! : ROUTE.outerGap;
    const entryX = columns.left[targetColumn]! - entryGap * ROUTE.backAcross + (i % ROUTE.backChannels) * ROUTE.lineSpacing;
    const startY = outPort.get(edge)!;
    const endY = inPort.get(edge)!;
    routes.set(edge, [
      { x: from.x + from.w, y: startY },
      { x: exitX, y: startY },
      { x: exitX, y: below },
      { x: entryX, y: below },
      { x: entryX, y: endY },
      { x: to.x, y: endY },
    ]);
  });

  return routes;
}

export function toExcalidraw(diagram: Diagram): string {
  const elements: ExcalidrawElement[] = [];

  for (const group of diagram.groups) {
    const id = `lane:${group.id}`;
    elements.push({ ...base(id, "rectangle", group), backgroundColor: "#fafafa", strokeColor: "#bdbdbd", customData: { archdiff: "lane" } });
    elements.push({ ...text(`${id}:text`, null, { x: group.x + LANE_LABEL.dx, y: group.y + LANE_LABEL.dy, w: LANE_LABEL.w, h: LANE_LABEL.h }, group.label, LANE_LABEL.fontSize), textAlign: "left", verticalAlign: "top", customData: { archdiff: "label" } });
  }

  // A fragment is a frame like a lane: a dashed box with its label top left, not a shape to pick.
  for (const node of diagram.nodes) {
    if (node.kind !== "fragment") continue;
    const id = `fragment:${node.id}`;
    elements.push({ ...base(id, "rectangle", node), backgroundColor: LOOKS.fragment.fill, strokeColor: LOOKS.fragment.stroke, strokeStyle: LOOKS.fragment.style, customData: { archdiff: "fragment" } });
    elements.push({ ...text(`${id}:text`, null, { x: node.x + FRAGMENT_LABEL.dx, y: node.y + FRAGMENT_LABEL.dy, w: FRAGMENT_LABEL.w, h: FRAGMENT_LABEL.h }, node.label, FRAGMENT_LABEL.fontSize), textAlign: "left", verticalAlign: "top", customData: { archdiff: "label" } });
  }

  const centre = new Map<string, { x: number; y: number }>();

  for (const node of diagram.nodes) {
    if (node.kind === "fragment") continue;

    if (node.kind === "anchor") {
      // The foot of a lifeline: nothing to see, a point for the line to end at.
      elements.push({ ...base(node.id, "ellipse", node), opacity: 0, customData: { archdiff: "anchor" } });
      centre.set(node.id, { x: node.x + node.w / 2, y: node.y + node.h / 2 });
      continue;
    }

    const look = lookOf(node);
    // Only the label is bound; the arrows keep their own points (see below).
    const bound: ExcalidrawElement["boundElements"] = [{ id: `${node.id}:text`, type: "text" }];
    const customData: Record<string, string | number> = { archdiff: "node", kind: node.kind };

    if (node.ref?.file) customData["file"] = node.ref.file;

    if (node.ref?.line !== undefined) customData["line"] = node.ref.line;
    elements.push({ ...base(node.id, look.type, node), backgroundColor: look.fill, strokeColor: look.stroke, strokeStyle: look.style, strokeWidth: look.width, roundness: look.type === "rectangle" && node.kind !== "layer" ? { type: 3 } : null, boundElements: bound, link: null, customData: { ...customData, view: viewLink(node) ?? "" } });
    // A class box keeps its lines as written (fields and methods), left-aligned in a monospace face; a box of a function's
    // logic is wider and keeps the start of its statements; everything else is wrapped and centred.
    const logicBox = node.kind === "decision" || node.kind === "action" || node.kind === "end";
    const label = node.kind === "class" ? node.label : logicBox ? wrapLabel(node.label, LOGIC_LABEL.lines, node.kind === "end" ? LOGIC_LABEL.endWidth : LOGIC_LABEL.width, true) : wrapLabel(node.count !== undefined && node.kind === "layer" ? `${node.label} (${node.count})` : node.label);
    const { fontSize } = look;
    const height = textHeight(label.split("\n").length, fontSize);
    // On a fill darker than this, the label is white.
    const dark = node.heat !== undefined && node.heat > 0.55;
    const classText = node.kind === "class" ? { textAlign: "left", verticalAlign: "top", fontFamily: 3 } : {};
    const labelBox = { x: node.x + LABEL_INSET, y: node.kind === "class" ? node.y + LABEL_INSET : node.y + node.h / 2 - height / 2, w: node.w - 2 * LABEL_INSET, h: height };
    elements.push({ ...text(`${node.id}:text`, node.id, labelBox, label, fontSize), ...classText, ...(dark ? { strokeColor: "#ffffff" } : {}), customData: { archdiff: "label" } });
    centre.set(node.id, { x: node.x + node.w / 2, y: node.y + node.h / 2 });

    // Where the code leads on past the picture's depth: "◂ 3" what imports or calls the shape from beyond, "5 ▸" what it imports or calls there.
    for (const side of ["before", "after"] as const) {
      const count = node.beyond?.[side].count ?? 0;

      if (count === 0) continue;
      const box = { x: side === "before" ? node.x : node.x + node.w - BEYOND_LABEL.w, y: node.y + node.h + BEYOND_LABEL.gap, w: BEYOND_LABEL.w, h: BEYOND_LABEL.h };
      elements.push({ ...text(`beyond:${node.id}:${side}`, null, box, side === "before" ? `◂ ${count}` : `${count} ▸`, BEYOND_LABEL.fontSize), textAlign: side === "before" ? "left" : "right", verticalAlign: "top", strokeColor: BEYOND_LABEL.colour, customData: { archdiff: "beyond", node: node.id, side, count } });
    }
  }

  const boxes = new Map(diagram.nodes.map((node) => [node.id, node]));
  const routes = routeEdges(diagram);
  // The shapes a label keeps off (an invisible anchor and a fragment's frame are not in the way), and the labels placed so far.
  const obstacles: Box[] = diagram.nodes.filter((node) => node.kind !== "anchor" && node.kind !== "fragment");
  const labels: Box[] = [];

  for (const edge of diagram.edges) {
    const source = boxes.get(edge.from);
    const target = boxes.get(edge.to);

    if (!source || !target) continue;
    const id = lineElementId(edge, diagram.edges.indexOf(edge));
    const route = edge.route ?? routes.get(edge) ?? [centre.get(edge.from)!, centre.get(edge.to)!];
    const start = route[0]!;
    const finish = route[route.length - 1]!;
    const xs = route.map((point) => point.x);
    const ys = route.map((point) => point.y);
    elements.push({
      ...base(id, "arrow", { x: start.x, y: start.y, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }),
      strokeColor: lineStroke(edge),
      strokeStyle: edge.kind === "ref" || edge.kind === "lifeline" || edge.diff === "removed" || edge.diff === "planned" || edge.typeOnly ? "dashed" : "solid",
      strokeWidth: edge.diff ? 2 : 1,
      points: route.map((point) => [point.x - start.x, point.y - start.y]),
      // No binding: Excalidraw would pull every end to the centre of a side and the ports would collapse into one point.
      // A re-layout redraws the arrows when shapes move.
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: edge.kind === "lifeline" ? null : "arrow",
      elbowed: false,
      roundness: null,
      boundElements: edge.label ? [{ id: `${id}:text`, type: "text" }] : null,
      customData: { archdiff: "edge", kind: edge.kind, from: edge.from, to: edge.to },
    });

    // A message's label sits just above its line (beside the loop of a self-call); another line's on the line, clear of the shapes and the other labels.
    if (edge.label && edge.kind === "message") {
      const self = edge.from === edge.to;
      const labelX = self ? start.x + LINE_LABEL.selfDx : (start.x + finish.x) / 2 - LINE_LABEL.w / 2;
      const labelY = self ? start.y + LINE_LABEL.selfDy : Math.min(start.y, finish.y) - LINE_LABEL.above;
      elements.push({ ...text(`${id}:text`, id, { x: labelX, y: labelY, w: LINE_LABEL.w, h: LINE_LABEL.h }, edge.label, LINE_LABEL.fontSize), ...(self ? { textAlign: "left" } : {}), customData: { archdiff: "label" } });
    } else if (edge.label) {
      const spot = labelSpot(route, { w: Math.min(LINE_LABEL.w, textWidth(edge.label, LINE_LABEL.fontSize) + 4), h: LINE_LABEL.h }, obstacles, labels);
      labels.push(spot);
      elements.push({ ...text(`${id}:text`, id, spot, edge.label, LINE_LABEL.fontSize), customData: { archdiff: "label" } });
    }
  }

  return `${JSON.stringify({ type: "excalidraw", version: 2, source: diagram.stamp ? `archdiff — commit ${diagram.stamp.commit} (${diagram.stamp.date})` : "archdiff", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} }, null, 2)}\n`;
}
