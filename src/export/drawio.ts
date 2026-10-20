// A Diagram as a draw.io (diagrams.net) file: an uncompressed
// `<mxfile><diagram><mxGraphModel>` with lanes as swimlanes and shapes at
// the laid-out positions, each cell an `<object>` carrying the archdiff ID
// and kind, so a drawing opened in draw.io keeps the link to the code.
// Byte-stable for the same placed diagram.
//
// Entry point: `toDrawio` (export/index.ts).

import type { Diagram, Shape } from "../diagram.ts";
import { routeEdges } from "./excalidraw.ts";
import { lineStroke, lookOf } from "../looks.ts";
import { escapeXmlAttribute } from "./xml.ts";

/** How draw.io draws each kind's outline and text; the colours and the line of the stroke are every drawing's (looks.ts). */
const OUTLINES: Record<Shape["kind"], string> = {
  layer: "rounded=0;whiteSpace=wrap;html=1;fontStyle=1;",
  module: "rounded=1;whiteSpace=wrap;html=1;",
  fn: "rounded=1;whiteSpace=wrap;html=1;arcSize=50;",
  external: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;",
  hole: "shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;",
  start: "ellipse;whiteSpace=wrap;html=1;",
  more: "rounded=1;whiteSpace=wrap;html=1;fontColor=#616161;",
  participant: "rounded=0;whiteSpace=wrap;html=1;fontStyle=1;",
  anchor: "shape=ellipse;",
  event: "ellipse;whiteSpace=wrap;html=1;",
  cell: "rounded=0;whiteSpace=wrap;html=1;fontSize=10;",
  package: "rounded=0;whiteSpace=wrap;html=1;fontStyle=1;",
  class: "rounded=0;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacingLeft=6;fontFamily=Courier New;fontSize=10;",
  state: "rounded=1;whiteSpace=wrap;html=1;arcSize=30;",
  machine: "rounded=1;whiteSpace=wrap;html=1;arcSize=15;fontStyle=1;",
  fragment: "rounded=0;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacingLeft=6;fontSize=11;",
  decision: "rhombus;whiteSpace=wrap;html=1;fontSize=11;",
  action: "rounded=0;whiteSpace=wrap;html=1;fontSize=11;",
  end: "ellipse;whiteSpace=wrap;html=1;fontSize=11;",
};

/** A shape's style: its kind's outline, then its look — the fill (heat darkens it), the stroke (a change's mark colours and thickens it), dashed or dotted as the look says. */
function style(node: Shape): string {
  // The foot of a lifeline is drawn invisible, whatever its look.
  if (node.kind === "anchor") return `${OUTLINES.anchor}fillColor=none;strokeColor=none;`;
  const look = lookOf(node);
  const line = look.style === "dashed" ? "dashed=1;" : look.style === "dotted" ? "dashed=1;dashPattern=1 3;" : "";

  return `${OUTLINES[node.kind]}fillColor=${look.fill === "transparent" ? "none" : look.fill};strokeColor=${look.stroke};${line}${look.width > 1 ? `strokeWidth=${look.width};` : ""}`;
}

export function toDrawio(diagram: Diagram): string {
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  let next = 2;
  const cellOf = new Map<string, number>();

  for (const group of diagram.groups) {
    const id = next++;
    cellOf.set(`lane:${group.id}`, id);
    cells.push(
      `<object label="${escapeXmlAttribute(group.label)}" archdiff_kind="lane" archdiff_id="${escapeXmlAttribute(group.id)}" id="${id}"><mxCell style="swimlane;horizontal=0;html=1;startSize=24;fillColor=#fafafa;strokeColor=#bdbdbd;" vertex="1" parent="1"><mxGeometry x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" as="geometry"/></mxCell></object>`,
    );
  }

  for (const node of diagram.nodes) {
    const id = next++;
    cellOf.set(node.id, id);
    const lane = node.group !== undefined ? cellOf.get(`lane:${node.group}`) : undefined;
    const group = lane !== undefined ? diagram.groups.find((candidate) => candidate.id === node.group)! : null;
    // Inside a swimlane, geometry is relative to the lane.
    const x = group ? node.x - group.x : node.x;
    const y = group ? node.y - group.y : node.y;
    const attributes = [`label="${escapeXmlAttribute(node.label)}"`, `archdiff_kind="${node.kind}"`, `archdiff_id="${escapeXmlAttribute(node.id)}"`];

    if (node.ref?.file) attributes.push(`archdiff_file="${escapeXmlAttribute(node.ref.file)}"`);

    if (node.ref?.line !== undefined) attributes.push(`archdiff_line="${node.ref.line}"`);

    if (node.diff) attributes.push(`archdiff_diff="${node.diff}"`);
    cells.push(`<object ${attributes.join(" ")} id="${id}"><mxCell style="${style(node)}" vertex="1" parent="${lane ?? 1}"><mxGeometry x="${x}" y="${y}" width="${node.w}" height="${node.h}" as="geometry"/></mxCell></object>`);
  }

  const routes = routeEdges(diagram);

  for (const edge of diagram.edges) {
    const from = cellOf.get(edge.from);
    const to = cellOf.get(edge.to);

    if (from === undefined || to === undefined) continue;
    const id = next++;
    const dashed = edge.kind === "ref" || edge.kind === "lifeline" || edge.diff === "removed" || edge.diff === "planned" || edge.typeOnly ? "dashed=1;" : "";
    const colour = `strokeColor=${lineStroke(edge)};${edge.diff ? "strokeWidth=2;" : ""}`;
    // The bends of the route (without its two ends, which the cells give) as waypoints, so draw.io draws the same path.
    const bends = (edge.route ?? routes.get(edge) ?? []).slice(1, -1);
    const points = bends.length > 0 ? `<Array as="points">${bends.map((point) => `<mxPoint x="${Math.round(point.x)}" y="${Math.round(point.y)}"/>`).join("")}</Array>` : "";
    cells.push(
      `<object label="${escapeXmlAttribute(edge.label ?? "")}" archdiff_kind="${edge.kind}" id="${id}"><mxCell style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;${dashed}${colour}" edge="1" parent="1" source="${from}" target="${to}"><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell></object>`,
    );
  }

  return `<mxfile host="archdiff" type="device"${diagram.stamp ? ` agent="archdiff commit ${escapeXmlAttribute(diagram.stamp.commit)}" modified="${escapeXmlAttribute(diagram.stamp.date)}"` : ""}><diagram name="${escapeXmlAttribute(diagram.title)}" id="archdiff-${escapeXmlAttribute(diagram.view)}"><mxGraphModel archdiff_view="${escapeXmlAttribute(diagram.view)}" grid="1" gridSize="10" page="1" pageWidth="1654" pageHeight="1169"><root>${cells.join("")}</root></mxGraphModel></diagram></mxfile>\n`;
}
