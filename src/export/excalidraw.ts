// A Diagram as an Excalidraw scene (`.excalidraw`, JSON): lanes as
// rectangles behind the shapes, shapes as rectangles or ellipses with a
// bound text element, lines as arrows bound to their shapes. IDs and seeds
// derive from the archdiff IDs, so the same diagram gives the same file.

import type { Diagram, DiagramNode } from "../diagram.ts";

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

/** A stable 31-bit number from a string, for `seed` and `versionNonce`. */
function seed(text: string): number {
  let hash = 2166136261;

  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);

  return (hash >>> 0) % 2147483647 || 1;
}

const DIFF_STROKE = { added: "#2e7d32", removed: "#c62828", changed: "#ef6c00" } as const;

function base(id: string, type: string, x: number, y: number, width: number, height: number): ExcalidrawElement {
  return { id, type, x, y, width, height, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: seed(id), version: 1, versionNonce: seed(`${id}:v`), isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
}

function text(id: string, container: string, x: number, y: number, width: number, height: number, content: string, fontSize: number): ExcalidrawElement {
  return { ...base(id, "text", x, y, width, height), text: content, originalText: content, fontSize, fontFamily: 1, textAlign: "center", verticalAlign: "middle", containerId: container, lineHeight: 1.25, autoResize: true };
}

function shapeOf(node: DiagramNode): { type: string; fill: string; stroke: string; style: ExcalidrawElement["strokeStyle"]; width: number } {
  const stroke = node.diff ? DIFF_STROKE[node.diff] : node.kind === "fn" ? "#1565c0" : node.kind === "hole" ? "#ef6c00" : node.kind === "external" ? "#757575" : "#1e1e1e";
  const fill = node.kind === "layer" ? "#f5f5f5" : node.kind === "fn" ? "#e3f2fd" : node.kind === "hole" ? "#fff3e0" : node.kind === "start" ? "#c8e6c9" : "#ffffff";

  return { type: node.kind === "start" || node.kind === "external" ? "ellipse" : node.kind === "hole" ? "diamond" : "rectangle", fill, stroke, style: node.diff === "removed" || node.kind === "hole" ? "dashed" : "solid", width: node.diff ? 3 : 1 };
}

export function toExcalidraw(diagram: Diagram): string {
  const elements: ExcalidrawElement[] = [];

  for (const group of diagram.groups) {
    const id = `lane:${group.id}`;
    elements.push({ ...base(id, "rectangle", group.x, group.y, group.w, group.h), backgroundColor: "#fafafa", strokeColor: "#bdbdbd", boundElements: [{ id: `${id}:text`, type: "text" }] });
    elements.push({ ...text(`${id}:text`, id, group.x + 8, group.y + 4, 120, 20, group.label, 14), textAlign: "left", verticalAlign: "top", containerId: null });
  }

  const centre = new Map<string, { x: number; y: number }>();

  for (const node of diagram.nodes) {
    const look = shapeOf(node);
    const bound: ExcalidrawElement["boundElements"] = [{ id: `${node.id}:text`, type: "text" }];

    for (const edge of diagram.edges) if (edge.from === node.id || edge.to === node.id) bound.push({ id: `edge:${edge.from}->${edge.to}`, type: "arrow" });
    elements.push({ ...base(node.id, look.type, node.x, node.y, node.w, node.h), backgroundColor: look.fill, strokeColor: look.stroke, strokeStyle: look.style, strokeWidth: look.width, roundness: look.type === "rectangle" && node.kind !== "layer" ? { type: 3 } : null, boundElements: bound, link: node.ref?.file ? `${node.ref.file}${node.ref.line ? `:${node.ref.line}` : ""}` : null });
    elements.push(text(`${node.id}:text`, node.id, node.x + 6, node.y + node.h / 2 - 10, node.w - 12, 20, node.count !== undefined && node.kind === "layer" ? `${node.label} (${node.count})` : node.label, node.kind === "layer" ? 16 : 13));
    centre.set(node.id, { x: node.x + node.w / 2, y: node.y + node.h / 2 });
  }

  for (const edge of diagram.edges) {
    const from = centre.get(edge.from);
    const to = centre.get(edge.to);

    if (!from || !to) continue;
    const id = `edge:${edge.from}->${edge.to}`;
    const stroke = edge.diff === "added" ? "#2e7d32" : edge.diff === "removed" ? "#c62828" : edge.kind === "call" ? "#1565c0" : "#616161";
    elements.push({
      ...base(id, "arrow", from.x, from.y, to.x - from.x, to.y - from.y),
      strokeColor: stroke,
      strokeStyle: edge.kind === "ref" || edge.diff === "removed" ? "dashed" : "solid",
      strokeWidth: edge.diff ? 2 : 1,
      points: [
        [0, 0],
        [to.x - from.x, to.y - from.y],
      ],
      startBinding: { elementId: edge.from, focus: 0, gap: 4 },
      endBinding: { elementId: edge.to, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
      boundElements: edge.label ? [{ id: `${id}:text`, type: "text" }] : null,
    });

    if (edge.label) elements.push(text(`${id}:text`, id, (from.x + to.x) / 2 - 20, (from.y + to.y) / 2 - 10, 40, 20, edge.label, 12));
  }

  return `${JSON.stringify({ type: "excalidraw", version: 2, source: "archdiff", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} }, null, 2)}\n`;
}
