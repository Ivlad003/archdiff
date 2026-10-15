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

/** Characters of a line of a label inside a shape. */
const LINE = 22;

/** A label in lines of at most `LINE` characters, broken after slashes and dots, three lines at most; the end of a path says the most, so the start is cut. */
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

  return [`…${lines.slice(0, lines.length - max + 1).join("").slice(-(LINE - 1))}`, ...lines.slice(lines.length - max + 1)].join("\n");
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

function text(id: string, container: string | null, x: number, y: number, width: number, height: number, content: string, fontSize: number): ExcalidrawElement {
  const lines = content.split("\n").length;

  return { ...base(id, "text", x, y, width, Math.max(height, lines * fontSize * 1.25)), text: content, originalText: content, fontSize, fontFamily: 1, textAlign: "center", verticalAlign: "middle", containerId: container, lineHeight: 1.25, autoResize: true };
}

function shapeOf(node: DiagramNode): { type: string; fill: string; stroke: string; style: ExcalidrawElement["strokeStyle"]; width: number } {
  const stroke = node.diff ? DIFF_STROKE[node.diff] : node.kind === "fn" ? "#1565c0" : node.kind === "hole" ? "#ef6c00" : node.kind === "external" || node.kind === "more" ? "#757575" : "#1e1e1e";
  const fill = node.kind === "layer" ? "#f5f5f5" : node.kind === "fn" ? "#e3f2fd" : node.kind === "hole" ? "#fff3e0" : node.kind === "start" ? "#c8e6c9" : node.kind === "more" ? "#f5f5f5" : "#ffffff";

  return { type: node.kind === "start" || node.kind === "external" ? "ellipse" : node.kind === "hole" ? "diamond" : "rectangle", fill, stroke, style: node.diff === "removed" || node.kind === "hole" ? "dashed" : node.kind === "more" ? "dotted" : "solid", width: node.diff ? 3 : 1 };
}

/** The view a shape opens on the page (`customData.view`, read by the page on a second tap); not an Excalidraw link, whose icon would clutter every shape. */
function viewLink(node: DiagramNode): string | null {
  const id = node.ref?.id ?? node.id;

  switch (node.kind) {
    case "layer":
      return `archdiff://view/${encodeURIComponent(`layer:${id}`)}`;
    case "module":
      return `archdiff://view/${encodeURIComponent(`module:${id}`)}`;
    case "fn":
      return `archdiff://view/${encodeURIComponent(`calls:${id}`)}`;
    default:
      return null;
  }
}

export function toExcalidraw(diagram: Diagram): string {
  const elements: ExcalidrawElement[] = [];

  for (const group of diagram.groups) {
    const id = `lane:${group.id}`;
    elements.push({ ...base(id, "rectangle", group.x, group.y, group.w, group.h), backgroundColor: "#fafafa", strokeColor: "#bdbdbd", customData: { archdiff: "lane" } });
    elements.push({ ...text(`${id}:text`, null, group.x + 8, group.y + 4, 120, 20, group.label, 14), textAlign: "left", verticalAlign: "top", customData: { archdiff: "label" } });
  }

  const centre = new Map<string, { x: number; y: number }>();

  for (const node of diagram.nodes) {
    const look = shapeOf(node);
    const bound: ExcalidrawElement["boundElements"] = [{ id: `${node.id}:text`, type: "text" }];

    for (const edge of diagram.edges) if (edge.from === node.id || edge.to === node.id) bound.push({ id: `edge:${edge.from}->${edge.to}`, type: "arrow" });
    const customData: Record<string, string | number> = { archdiff: "node", kind: node.kind };

    if (node.ref?.file) customData["file"] = node.ref.file;

    if (node.ref?.line !== undefined) customData["line"] = node.ref.line;
    elements.push({ ...base(node.id, look.type, node.x, node.y, node.w, node.h), backgroundColor: look.fill, strokeColor: look.stroke, strokeStyle: look.style, strokeWidth: look.width, roundness: look.type === "rectangle" && node.kind !== "layer" ? { type: 3 } : null, boundElements: bound, link: null, customData: { ...customData, view: viewLink(node) ?? "" } });
    const label = wrapLabel(node.count !== undefined && node.kind === "layer" ? `${node.label} (${node.count})` : node.label);
    const fontSize = node.kind === "layer" ? 15 : 12;
    const lines = label.split("\n").length;
    elements.push({ ...text(`${node.id}:text`, node.id, node.x + 6, node.y + node.h / 2 - (lines * fontSize * 1.25) / 2, node.w - 12, lines * fontSize * 1.25, label, fontSize), customData: { archdiff: "label" } });
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
      customData: { archdiff: "edge", kind: edge.kind },
    });

    if (edge.label) elements.push({ ...text(`${id}:text`, id, (from.x + to.x) / 2 - 20, (from.y + to.y) / 2 - 10, 40, 20, edge.label, 12), customData: { archdiff: "label" } });
  }

  return `${JSON.stringify({ type: "excalidraw", version: 2, source: "archdiff", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} }, null, 2)}\n`;
}
