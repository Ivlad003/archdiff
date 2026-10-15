// The canvas of the page: one placed `Diagram` of `/api/diagram` drawn
// read-only with maxGraph at the positions the server computed. Shapes by
// kind, a lane per layer, colours by the mark of a diff; wheel zoom around
// the cursor, drag on the background to pan, fit to the window, and
// maxGraph's outline as the minimap. `BaseGraph` with the one plugin it
// needs (panning) and only the shapes drawn here keeps the bundle small.
//
// Place in the pipeline: the web page's renderer; it draws what the server
// laid out (src/diagram.ts) and reports clicks. Entry point: `Canvas`.

import {
  BaseGraph,
  Cell,
  ConnectorShape,
  CylinderShape,
  EdgeMarker,
  EdgeMarkerRegistry,
  EllipseShape,
  HexagonShape,
  InternalEvent,
  Outline,
  PanningHandler,
  Perimeter,
  PerimeterRegistry,
  RectangleShape,
  registerEntityRelationEdgeStyle,
  ShapeRegistry,
  SwimlaneShape,
  type CellStyle,
  type EventObject,
  type EventSource,
} from "@maxgraph/core";
import type { Diagram, DiagramEdge, DiagramNode } from "./api.ts";

interface Colour {
  stroke: string;
  fill: string;
}

/** Colours of the picture of a diff, as the Mermaid export paints it: added green, removed red (and dashed), changed orange. */
const DIFF_COLOUR: Record<NonNullable<DiagramNode["diff"]>, Colour> = {
  added: { stroke: "#2e7d32", fill: "#d4f8d4" },
  removed: { stroke: "#c62828", fill: "#f8d4d4" },
  changed: { stroke: "#ef6c00", fill: "#fff4c2" },
};

const DIFF_GLYPH: Record<NonNullable<DiagramNode["diff"]>, string> = { added: "+", removed: "−", changed: "~" };

/** The look of each kind of shape. */
const KIND_COLOUR: Record<DiagramNode["kind"], Colour> = {
  layer: { stroke: "#455a64", fill: "#eceff1" },
  module: { stroke: "#37474f", fill: "#ffffff" },
  fn: { stroke: "#1565c0", fill: "#e3f2fd" },
  external: { stroke: "#9e9e9e", fill: "#fafafa" },
  hole: { stroke: "#ef6c00", fill: "#fff3e0" },
  start: { stroke: "#2e7d32", fill: "#c8e6c9" },
};

/** The stroke of the picked shape and its edges. */
const SELECTED = "#6a1b9a";

/** More edges than this and they are drawn faint until a shape is picked. */
const CROWDED = 60;

/** Characters of a line of a label. */
const LINE = 24;

let registered = false;

/** Only what the canvas draws: `BaseGraph` registers nothing itself. */
function register(): void {
  if (registered) return;
  registered = true;
  ShapeRegistry.add("rectangle", RectangleShape);
  ShapeRegistry.add("ellipse", EllipseShape);
  ShapeRegistry.add("swimlane", SwimlaneShape);
  ShapeRegistry.add("connector", ConnectorShape);
  ShapeRegistry.add("cylinder", CylinderShape);
  ShapeRegistry.add("hexagon", HexagonShape);
  PerimeterRegistry.add("hexagonPerimeter", Perimeter.HexagonPerimeter);
  PerimeterRegistry.add("rectanglePerimeter", Perimeter.RectanglePerimeter);
  PerimeterRegistry.add("ellipsePerimeter", Perimeter.EllipsePerimeter);
  EdgeMarkerRegistry.add("classic", EdgeMarker.createArrow(2));
  EdgeMarkerRegistry.add("open", EdgeMarker.createOpenArrow(2));
  // Edges leave a shape on its right side and enter the next on its left as an S-curve, so they run between the rank columns instead of across shapes.
  registerEntityRelationEdgeStyle();
}

/** A long label in lines of at most `LINE` characters, broken after slashes and dots; three lines at most. */
export function wrapLabel(text: string, max = 3): string {
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    let line = "";

    for (const part of paragraph.split(/(?<=[./])/)) {
      if (line !== "" && line.length + part.length > LINE) {
        lines.push(line);
        line = "";
      }

      line += part;

      while (line.length > LINE) {
        lines.push(line.slice(0, LINE));
        line = line.slice(LINE);
      }
    }

    if (line !== "") lines.push(line);
  }

  if (lines.length <= max) return lines.join("\n");

  return [...lines.slice(0, max - 1), `…${lines.slice(max - 1).join("").slice(-(LINE - 1))}`].join("\n");
}

function labelOf(node: DiagramNode): string {
  if (node.kind === "start") return "";
  const glyph = node.diff ? `${DIFF_GLYPH[node.diff]} ` : "";
  const count = node.kind === "layer" && node.count !== undefined ? ` (${node.count})` : "";

  return `${glyph}${wrapLabel(node.label)}${count}`;
}

function nodeStyle(node: DiagramNode): CellStyle {
  const colour = node.diff ? DIFF_COLOUR[node.diff] : KIND_COLOUR[node.kind];
  const style: CellStyle = { strokeColor: colour.stroke, fillColor: colour.fill, fontColor: "#212121", fontSize: 11, strokeWidth: node.diff ? 2.5 : 1.5, rounded: true, whiteSpace: "wrap" };

  if (node.diff === "removed") style.dashed = true;

  switch (node.kind) {
    case "start":
      return { ...style, shape: "ellipse", perimeter: "ellipsePerimeter", strokeWidth: 2 };
    case "hole":
      return { ...style, shape: "hexagon", perimeter: "hexagonPerimeter", dashed: true, fontSize: 10 };
    case "external":
      return { ...style, shape: "cylinder", dashed: true, verticalAlign: "bottom", spacingBottom: 6 };
    case "layer":
      return { ...style, fontStyle: 1, fontSize: 13 };
    case "fn":
      return { ...style, arcSize: 40 };
    default:
      return style;
  }
}

function edgeStyle(edge: DiagramEdge): CellStyle {
  const colour = edge.diff === "added" ? "#2e7d32" : edge.diff === "removed" ? "#c62828" : edge.kind === "call" ? "#1565c0" : "#78909c";

  return { strokeColor: colour, fontColor: "#424242", fontSize: 10, labelBackgroundColor: "#ffffff", endArrow: edge.kind === "dependency" ? "open" : "classic", dashed: edge.kind === "ref" || edge.diff === "removed", strokeWidth: edge.diff ? 2 : 1.2, edgeStyle: "entityRelationEdgeStyle", segment: 24, rounded: true, exitX: 1, exitY: 0.5, entryX: 0, entryY: 0.5 };
}

/** What the canvas tells the page. */
export interface CanvasEvents {
  /** A click on a shape, or on the background (null). */
  select(node: DiagramNode | null): void;
  /** A double click on a shape: open its own view. */
  open(node: DiagramNode): void;
}

/** The read-only diagram canvas: draws one `Diagram`, tracks the picked shape, zooms and pans. */
export class Canvas {
  readonly graph: BaseGraph;
  private readonly container: HTMLElement;
  private readonly events: CanvasEvents;
  private diagram: Diagram = { view: "", title: "", nodes: [], edges: [], groups: [] };
  private readonly cells = new Map<string, Cell>();
  private readonly nodeOf = new Map<Cell, DiagramNode>();
  private readonly edgeCells: { cell: Cell; edge: DiagramEdge }[] = [];
  private selected: string | null = null;
  private downAt: { x: number; y: number } | null = null;

  constructor(container: HTMLElement, minimap: HTMLElement, events: CanvasEvents) {
    register();
    this.container = container;
    this.events = events;
    this.graph = new BaseGraph({ container, plugins: [PanningHandler] });
    const graph = this.graph;
    graph.setCellsMovable(false);
    graph.setCellsResizable(false);
    graph.setCellsEditable(false);
    graph.setCellsBendable(false);
    graph.setCellsDeletable(false);
    graph.setCellsSelectable(false);
    graph.setConnectable(false);
    graph.setPanning(true);
    const panning = graph.getPlugin<PanningHandler>("PanningHandler");

    if (panning) panning.useLeftButtonForPanning = true;
    graph.getStylesheet().getDefaultVertexStyle().fontFamily = "system-ui, sans-serif";
    graph.getStylesheet().getDefaultEdgeStyle().fontFamily = "system-ui, sans-serif";

    // A click picks the node under it; the end of a drag (panning) is no click.
    container.addEventListener("pointerdown", (event) => (this.downAt = { x: event.clientX, y: event.clientY }));
    graph.addListener(InternalEvent.CLICK, (_sender: EventSource, event: EventObject) => {
      const native = event.getProperty("event");

      if (native instanceof MouseEvent && this.downAt && Math.hypot(native.clientX - this.downAt.x, native.clientY - this.downAt.y) > 4) return;
      const cell = event.getProperty("cell");
      const node = cell instanceof Cell ? (this.nodeOf.get(cell) ?? null) : null;
      this.select(node?.id ?? null);
      this.events.select(node);
    });
    graph.addListener(InternalEvent.DOUBLE_CLICK, (_sender: EventSource, event: EventObject) => {
      const cell = event.getProperty("cell");
      const node = cell instanceof Cell ? this.nodeOf.get(cell) : undefined;

      if (node) this.events.open(node);
    });
    // The wheel zooms around the cursor; the events of one frame are folded into one zoom, so a fast wheel does not redraw dozens of times.
    let pending: { factor: number; x: number; y: number } | null = null;
    container.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const box = container.getBoundingClientRect();
        const factor = Math.exp(-event.deltaY * 0.0015);

        if (pending) {
          pending.factor *= factor;
        } else {
          pending = { factor, x: event.clientX - box.left, y: event.clientY - box.top };
          requestAnimationFrame(() => {
            if (pending) this.zoomAt(pending.factor, pending.x, pending.y);
            pending = null;
          });
        }
      },
      { passive: false },
    );
    new Outline(graph, minimap);
  }

  current(): Diagram {
    return this.diagram;
  }

  /** Draws a diagram from scratch: lanes first, then shapes, then edges. `keepView` leaves zoom and pan as they are. */
  show(diagram: Diagram, keepView = false): void {
    const graph = this.graph;
    this.diagram = diagram;
    this.cells.clear();
    this.nodeOf.clear();
    this.edgeCells.length = 0;
    this.selected = null;
    // A new root: `removeCells` honours `cellsDeletable`, which is off, so the model is cleared instead.
    graph.getDataModel().clear();
    const parent = graph.getDefaultParent();
    graph.batchUpdate(() => {
      for (const group of diagram.groups) {
        graph.insertVertex({
          parent,
          value: group.label,
          position: [group.x, group.y],
          size: [group.w, group.h],
          style: { shape: "swimlane", horizontal: false, startSize: 26, fillColor: "#eef2f4", swimlaneFillColor: "#ffffff", strokeColor: "#b0bec5", fontColor: "#37474f", fontStyle: 1, fontSize: 12 },
        });
      }

      for (const node of diagram.nodes) {
        const shape = graph.insertVertex({ parent, value: labelOf(node), position: [node.x, node.y], size: [node.w, node.h], style: this.styleOf(node) });
        this.nodeOf.set(shape, node);
        this.cells.set(node.id, shape);
      }

      for (const edge of diagram.edges) {
        const source = this.cells.get(edge.from);
        const target = this.cells.get(edge.to);

        if (!source || !target) continue;
        const cell = graph.insertEdge({ parent, value: edge.label ?? "", source, target, style: this.edgeStyleOf(edge) });
        this.edgeCells.push({ cell, edge });
      }
    });

    if (!keepView) this.fit();
  }

  select(id: string | null): void {
    this.selected = id !== null && this.cells.has(id) ? id : null;
    this.restyle();
  }

  /** The whole diagram in the window, never above its natural size. */
  fit(margin = 24): void {
    const view = this.graph.getView();
    const bounds = this.graph.getGraphBounds();
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    if (bounds.width === 0 || bounds.height === 0 || width === 0 || height === 0) return view.scaleAndTranslate(1, margin, margin);
    const scale = view.scale;
    const model = { x: bounds.x / scale - view.translate.x, y: bounds.y / scale - view.translate.y, w: bounds.width / scale, h: bounds.height / scale };
    const next = Math.max(0.05, Math.min(1, (width - 2 * margin) / model.w, (height - 2 * margin) / model.h));
    view.scaleAndTranslate(next, width / 2 / next - (model.x + model.w / 2), height / 2 / next - (model.y + model.h / 2));
  }

  zoomAt(factor: number, x = this.container.clientWidth / 2, y = this.container.clientHeight / 2): void {
    const view = this.graph.getView();
    const scale = view.scale;
    const next = Math.max(0.05, Math.min(4, scale * factor));

    if (next === scale) return;
    const px = x / scale - view.translate.x;
    const py = y / scale - view.translate.y;
    view.scaleAndTranslate(next, x / next - px, y / next - py);
  }

  private styleOf(node: DiagramNode): CellStyle {
    const style = nodeStyle(node);

    return node.id === this.selected ? { ...style, strokeColor: SELECTED, strokeWidth: 3.5 } : style;
  }

  /** With a shape selected its own edges are strong and the rest faint; a crowded diagram is faint until a shape is picked. */
  private edgeStyleOf(edge: DiagramEdge): CellStyle {
    const style = edgeStyle(edge);

    if (this.selected !== null) {
      if (edge.from === this.selected || edge.to === this.selected) return { ...style, strokeColor: SELECTED, strokeWidth: 2.5, dashed: false, opacity: 100 };

      return { ...style, opacity: 12, textOpacity: 12 };
    }

    return this.diagram.edges.length > CROWDED ? { ...style, opacity: 35 } : style;
  }

  private restyle(): void {
    const model = this.graph.getDataModel();
    this.graph.batchUpdate(() => {
      for (const node of this.diagram.nodes) {
        const shape = this.cells.get(node.id);

        if (shape) model.setStyle(shape, this.styleOf(node));
      }

      for (const { cell, edge } of this.edgeCells) model.setStyle(cell, this.edgeStyleOf(edge));
    });
  }
}
