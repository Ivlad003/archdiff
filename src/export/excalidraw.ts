// A Diagram as an Excalidraw scene (`.excalidraw`, JSON): lanes as
// rectangles behind the shapes, shapes as rectangles or ellipses with a
// bound text element, lines as arrows bound to their shapes. IDs and seeds
// derive from the archdiff IDs, so the same diagram gives the same file.

import type { Diagram, DiagramEdge, DiagramNode } from "../diagram.ts";
import { heatColour } from "./colour.ts";
import { routeFree } from "./route-free.ts";

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

/** A stable 31-bit number from a string, for `seed` and `versionNonce`. */
function seed(text: string): number {
  let hash = 2166136261;

  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);

  return (hash >>> 0) % 2147483647 || 1;
}

const DIFF_STROKE = { added: "#2e7d32", removed: "#c62828", changed: "#ef6c00", warning: "#ef6c00", planned: "#1565c0" } as const;

function base(id: string, type: string, x: number, y: number, width: number, height: number): ExcalidrawElement {
  return { id, type, x, y, width, height, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: seed(id), version: 1, versionNonce: seed(`${id}:v`), isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
}

function text(id: string, container: string | null, x: number, y: number, width: number, height: number, content: string, fontSize: number): ExcalidrawElement {
  const lines = content.split("\n").length;

  return { ...base(id, "text", x, y, width, Math.max(height, lines * fontSize * 1.25)), text: content, originalText: content, fontSize, fontFamily: 1, textAlign: "center", verticalAlign: "middle", containerId: container, lineHeight: 1.25, autoResize: true };
}

function shapeOf(node: DiagramNode): { type: string; fill: string; stroke: string; style: ExcalidrawElement["strokeStyle"]; width: number } {
  const stroke = node.diff ? DIFF_STROKE[node.diff] : node.kind === "fn" ? "#1565c0" : node.kind === "hole" ? "#ef6c00" : node.kind === "event" ? "#f9a825" : node.kind === "package" ? "#3949ab" : node.kind === "class" ? "#4e342e" : node.kind === "state" ? "#2e7d32" : node.kind === "fragment" ? "#9e9e9e" : node.kind === "decision" ? "#6a1b9a" : node.kind === "action" ? "#424242" : node.kind === "end" ? "#616161" : node.kind === "external" || node.kind === "more" || node.kind === "cell" ? "#757575" : "#1e1e1e";
  const plain = node.kind === "layer" || node.kind === "participant" || node.kind === "more" || node.kind === "cell" ? "#f5f5f5" : node.kind === "fn" ? "#e3f2fd" : node.kind === "hole" ? "#fff3e0" : node.kind === "start" ? "#c8e6c9" : node.kind === "event" ? "#fff8e1" : node.kind === "package" ? "#e8eaf6" : node.kind === "class" ? "#fff8e1" : node.kind === "state" ? "#e8f5e9" : node.kind === "fragment" ? "transparent" : node.kind === "decision" ? "#f3e5f5" : node.kind === "end" ? "#eeeeee" : "#ffffff";
  // Heat darkens the fill; a diff mark is the stroke, so both show at once.
  const fill = node.heat !== undefined && node.heat > 0 ? heatColour(node.heat) : plain;

  return { type: node.kind === "start" || node.kind === "external" || node.kind === "event" || node.kind === "end" ? "ellipse" : node.kind === "hole" || node.kind === "decision" ? "diamond" : "rectangle", fill, stroke, style: node.diff === "removed" || node.diff === "planned" || node.kind === "hole" || node.kind === "fragment" ? "dashed" : node.kind === "more" ? "dotted" : "solid", width: node.diff ? 3 : 1 };
}

/** The view a shape opens on the page (`customData.view`, read by the page on a second tap); not an Excalidraw link, whose icon would clutter every shape. */
function viewLink(node: DiagramNode): string | null {
  const id = node.ref?.id ?? node.id;

  if (node.kind === "more") return node.ref?.id ? `archdiff://view/${encodeURIComponent(node.ref.id)}` : null;

  switch (node.kind) {
    case "layer":
      return `archdiff://view/${encodeURIComponent(`layer:${id}`)}`;
    case "module":
      return `archdiff://view/${encodeURIComponent(`module:${id}`)}`;
    case "fn":
      return `archdiff://view/${encodeURIComponent(`calls:${id}`)}`;
    case "class":
      return `archdiff://view/${encodeURIComponent(`inside:${id.slice(0, id.indexOf("#"))}`)}`;
    case "participant":
      return `archdiff://view/${encodeURIComponent(`inside:${id}`)}`;
    case "state":
      return node.ref?.id?.startsWith("machine:") ? `archdiff://view/${encodeURIComponent(node.ref.id)}` : null;
    case "action":
      // A step of a function's logic that calls one function of the repository opens that function's logic; a function of the logic list, its own.
      return node.ref?.id?.includes("#") ? `archdiff://view/${encodeURIComponent(`logic:${node.ref.id}`)}` : null;
    default:
      return null;
  }
}

/** A point of a route. */
export interface Point {
  x: number;
  y: number;
}

/** The columns of a placed diagram: shapes whose x-ranges overlap share a column; a column starts where a shape begins past every shape before it. */
function columnsOf(nodes: readonly DiagramNode[]): { column: Map<string, number>; left: number[]; right: number[] } {
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
export function routeEdges(diagram: Diagram): Map<DiagramEdge, Point[]> {
  // Shapes the user moved out of the layout's columns: the grid router around every shape (route-free.ts).
  if (diagram.freeform) return routeFree(diagram);
  const boxes = new Map(diagram.nodes.map((node) => [node.id, node]));
  const routes = new Map<DiagramEdge, Point[]>();
  const lowest = Math.max(0, ...diagram.nodes.map((node) => node.y + node.h));
  const centreY = (node: DiagramNode): number => node.y + node.h / 2;
  const usable = diagram.edges.filter((edge) => boxes.has(edge.from) && boxes.has(edge.to) && edge.from !== edge.to && !edge.route);
  const columns = columnsOf(diagram.nodes);

  // Ports: the edges leaving a shape spread down its right side in the order of their targets, the edges entering a
  // shape spread down its left side in the order of their sources, so no two lines share an end point.
  const outgoing = new Map<string, DiagramEdge[]>();
  const incoming = new Map<string, DiagramEdge[]>();

  for (const edge of usable) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }

  const portY = (node: DiagramNode, index: number, count: number): number => {
    if (count <= 1) return centreY(node);
    const span = node.h * 0.7;

    return node.y + node.h * 0.15 + (span * index) / (count - 1);
  };

  const outPort = new Map<DiagramEdge, number>();
  const inPort = new Map<DiagramEdge, number>();

  for (const [id, edges] of outgoing) {
    const sorted = [...edges].sort((a, b) => centreY(boxes.get(a.to)!) - centreY(boxes.get(b.to)!));
    sorted.forEach((edge, i) => outPort.set(edge, portY(boxes.get(id)!, i, sorted.length)));
  }

  for (const [id, edges] of incoming) {
    const sorted = [...edges].sort((a, b) => centreY(boxes.get(a.from)!) - centreY(boxes.get(b.from)!));
    sorted.forEach((edge, i) => inPort.set(edge, portY(boxes.get(id)!, i, sorted.length)));
  }

  // A shape (other than the edge's own two) standing on the horizontal run at `y` between `x1` and `x2`.
  const blocked = (edge: DiagramEdge, y: number, x1: number, x2: number): boolean =>
    diagram.nodes.some((node) => node.id !== edge.from && node.id !== edge.to && node.x < x2 && node.x + node.w > x1 && node.y - 6 < y && node.y + node.h + 6 > y);

  // The free horizontal corridors between the rows of the columns `first`..`last`: the midpoints of the gaps between
  // the shapes' y-ranges, plus one below the last (not above the first: the lane's label sits there).
  const corridors = (first: number, last: number): { y: number; room: number }[] => {
    const spans = diagram.nodes
      .filter((node) => (columns.column.get(node.id) ?? -1) >= first && (columns.column.get(node.id) ?? -1) <= last)
      .map((node) => [node.y - 10, node.y + node.h + 10] as [number, number])
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
      if (i > 0) free.push({ y: (merged[i - 1]![1] + merged[i]![0]) / 2, room: Math.max(0, (merged[i]![0] - merged[i - 1]![1]) / 2 - 2) });

      if (i === merged.length - 1) free.push({ y: merged[i]![1] + 12, room: 40 });
    }

    return free;
  };

  // Channels: the vertical run of a forward edge sits in the gap just before the target's column; the edges of one
  // gap take distinct x positions spread over the middle of the gap, ordered by where they start, so their runs do
  // not overlap. A detour (the exit of an edge that must take a corridor) runs down the left tenth of the gap after
  // the source's column, and the edges of one corridor sit a few pixels apart.
  const byGap = new Map<number, DiagramEdge[]>();
  const backward: DiagramEdge[] = [];

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
      // The middle 60% of the gap holds the channels; one edge runs down the centre.
      const channel = n === 1 ? gapLeft + width / 2 : gapLeft + width * 0.2 + (width * 0.6 * i) / (n - 1);
      const route: Point[] = [{ x: from.x + from.w, y: startY }];

      if (targetColumn > sourceColumn + 1 && blocked(edge, startY, from.x + from.w, channel)) {
        // Around the shapes in between: out into the gap after the source, along the nearest free corridor, into the channel.
        const exitLeft = columns.right[sourceColumn]!;
        const exitWidth = columns.left[sourceColumn + 1]! - exitLeft;
        const used = detours.get(sourceColumn) ?? 0;
        detours.set(sourceColumn, used + 1);
        const exitX = exitLeft + exitWidth * 0.08 + Math.min(exitWidth * 0.1, used * 5);
        const wanted = (startY + endY) / 2;
        // The nearest corridor with room left: a full one costs as much as a corridor a row away.
        const cost = (corridor: { y: number; room: number }): number => Math.abs(corridor.y - wanted) + ((taken.get(Math.round(corridor.y)) ?? 0) * 4 > corridor.room * 2 ? 1000 : 0);
        const corridor = corridors(sourceColumn + 1, targetColumn - 1).sort((a, b) => cost(a) - cost(b))[0] ?? { y: startY, room: 0 };
        const key = Math.round(corridor.y);
        const seen = taken.get(key) ?? 0;
        taken.set(key, seen + 1);
        // Lines of one corridor sit 4 px apart, alternating sides of its centre, never past its room.
        const y = corridor.y + (seen % 2 === 0 ? 1 : -1) * Math.min(corridor.room, Math.ceil(seen / 2) * 4);
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
    const below = lowest + 24 + (i % 8) * 8;
    const exitGap = sourceColumn + 1 < columns.left.length ? columns.left[sourceColumn + 1]! - columns.right[sourceColumn]! : 40;
    const exitX = columns.right[sourceColumn]! + exitGap * 0.85 - (i % 4) * 4;
    const entryGap = targetColumn > 0 ? columns.left[targetColumn]! - columns.right[targetColumn - 1]! : 40;
    const entryX = columns.left[targetColumn]! - entryGap * 0.85 + (i % 4) * 4;
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
    elements.push({ ...base(id, "rectangle", group.x, group.y, group.w, group.h), backgroundColor: "#fafafa", strokeColor: "#bdbdbd", customData: { archdiff: "lane" } });
    elements.push({ ...text(`${id}:text`, null, group.x + 8, group.y + 4, 120, 20, group.label, 14), textAlign: "left", verticalAlign: "top", customData: { archdiff: "label" } });
  }

  // A fragment is a frame like a lane: a dashed box with its label top left, not a shape to pick.
  for (const node of diagram.nodes) {
    if (node.kind !== "fragment") continue;
    const id = `fragment:${node.id}`;
    elements.push({ ...base(id, "rectangle", node.x, node.y, node.w, node.h), backgroundColor: "transparent", strokeColor: "#9e9e9e", strokeStyle: "dashed", customData: { archdiff: "fragment" } });
    elements.push({ ...text(`${id}:text`, null, node.x + 8, node.y + 2, 200, 18, node.label, 12), textAlign: "left", verticalAlign: "top", customData: { archdiff: "label" } });
  }

  const centre = new Map<string, { x: number; y: number }>();

  for (const node of diagram.nodes) {
    if (node.kind === "fragment") continue;

    if (node.kind === "anchor") {
      // The foot of a lifeline: nothing to see, a point for the line to end at.
      elements.push({ ...base(node.id, "ellipse", node.x, node.y, node.w, node.h), opacity: 0, customData: { archdiff: "anchor" } });
      centre.set(node.id, { x: node.x + node.w / 2, y: node.y + node.h / 2 });
      continue;
    }

    const look = shapeOf(node);
    // Only the label is bound; the arrows keep their own points (see below).
    const bound: ExcalidrawElement["boundElements"] = [{ id: `${node.id}:text`, type: "text" }];
    const customData: Record<string, string | number> = { archdiff: "node", kind: node.kind };

    if (node.ref?.file) customData["file"] = node.ref.file;

    if (node.ref?.line !== undefined) customData["line"] = node.ref.line;
    elements.push({ ...base(node.id, look.type, node.x, node.y, node.w, node.h), backgroundColor: look.fill, strokeColor: look.stroke, strokeStyle: look.style, strokeWidth: look.width, roundness: look.type === "rectangle" && node.kind !== "layer" ? { type: 3 } : null, boundElements: bound, link: null, customData: { ...customData, view: viewLink(node) ?? "" } });
    // A class box keeps its lines as written (fields and methods), left-aligned in a monospace face; a box of a function's
    // logic is wider and keeps the start of its statements; everything else is wrapped and centred.
    const logicBox = node.kind === "decision" || node.kind === "action" || node.kind === "end";
    const label = node.kind === "class" ? node.label : logicBox ? wrapLabel(node.label, 4, node.kind === "end" ? 24 : 32, true) : wrapLabel(node.count !== undefined && node.kind === "layer" ? `${node.label} (${node.count})` : node.label);
    const fontSize = node.kind === "layer" ? 15 : node.kind === "cell" ? 10 : node.kind === "class" || logicBox ? 11 : 12;
    const lines = label.split("\n").length;
    const dark = node.heat !== undefined && node.heat > 0.55;
    const classText = node.kind === "class" ? { textAlign: "left", verticalAlign: "top", fontFamily: 3 } : {};
    elements.push({ ...text(`${node.id}:text`, node.id, node.x + 8, node.kind === "class" ? node.y + 8 : node.y + node.h / 2 - (lines * fontSize * 1.25) / 2, node.w - 16, lines * fontSize * 1.25, label, fontSize), ...classText, ...(dark ? { strokeColor: "#ffffff" } : {}), customData: { archdiff: "label" } });
    centre.set(node.id, { x: node.x + node.w / 2, y: node.y + node.h / 2 });
  }

  const boxes = new Map(diagram.nodes.map((node) => [node.id, node]));
  const routes = routeEdges(diagram);

  for (const edge of diagram.edges) {
    const source = boxes.get(edge.from);
    const target = boxes.get(edge.to);

    if (!source || !target) continue;
    const id = `edge:${edge.from}->${edge.to}${edge.kind === "message" ? `:${diagram.edges.indexOf(edge)}` : ""}`;
    const stroke = edge.diff === "added" ? "#2e7d32" : edge.diff === "removed" ? "#c62828" : edge.diff === "warning" || edge.diff === "changed" ? "#ef6c00" : edge.diff === "planned" || edge.kind === "call" || edge.kind === "message" ? "#1565c0" : edge.kind === "lifeline" ? "#b0bec5" : edge.kind === "flow" ? "#424242" : edge.typeOnly ? "#9e9e9e" : "#616161";
    const route = edge.route ?? routes.get(edge) ?? [centre.get(edge.from)!, centre.get(edge.to)!];
    const start = route[0]!;
    const finish = route[route.length - 1]!;
    const xs = route.map((point) => point.x);
    const ys = route.map((point) => point.y);
    elements.push({
      ...base(id, "arrow", start.x, start.y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)),
      strokeColor: stroke,
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

    // A message's label sits just above its line (beside the loop of a self-call); another edge's label at the middle of the line.
    if (edge.label) {
      const self = edge.kind === "message" && edge.from === edge.to;
      const labelX = self ? start.x + 80 : (start.x + finish.x) / 2 - 60;
      const labelY = edge.kind === "message" ? (self ? start.y + 4 : Math.min(start.y, finish.y) - 18) : (start.y + finish.y) / 2 - 10;
      elements.push({ ...text(`${id}:text`, id, labelX, labelY, 120, 16, edge.label, 12), ...(self ? { textAlign: "left" } : {}), customData: { archdiff: "label" } });
    }
  }

  return `${JSON.stringify({ type: "excalidraw", version: 2, source: diagram.stamp ? `archdiff — commit ${diagram.stamp.commit} (${diagram.stamp.date})` : "archdiff", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} }, null, 2)}\n`;
}
