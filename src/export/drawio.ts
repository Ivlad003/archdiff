// A Diagram as a draw.io (diagrams.net) file: an uncompressed
// `<mxfile><diagram><mxGraphModel>` with lanes as swimlanes and shapes at
// the laid-out positions, each cell an `<object>` carrying the archdiff ID
// and kind, so a drawing opened in draw.io keeps the link to the code.
// Byte-stable for the same placed diagram.

import type { Diagram, DiagramNode } from "../diagram.ts";
import { routeEdges } from "./excalidraw.ts";
import { heatColour } from "./colour.ts";

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#xa;");
}

const DIFF_STROKE = { added: "#2e7d32", removed: "#c62828", changed: "#ef6c00", warning: "#ef6c00", planned: "#1565c0" } as const;

function style(node: DiagramNode): string {
  const base: Record<DiagramNode["kind"], string> = {
    layer: "rounded=0;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;fontStyle=1;",
    module: "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#1f1f1f;",
    fn: "rounded=1;whiteSpace=wrap;html=1;arcSize=50;fillColor=#e3f2fd;strokeColor=#1565c0;",
    external: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;fillColor=#fafafa;strokeColor=#9e9e9e;",
    hole: "shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;dashed=1;fillColor=#fff3e0;strokeColor=#ef6c00;",
    start: "ellipse;whiteSpace=wrap;html=1;fillColor=#c8e6c9;strokeColor=#2e7d32;",
    more: "rounded=1;whiteSpace=wrap;html=1;dashed=1;dashPattern=1 3;fillColor=#f5f5f5;strokeColor=#9e9e9e;fontColor=#616161;",
    participant: "rounded=0;whiteSpace=wrap;html=1;fillColor=#eceff1;strokeColor=#455a64;fontStyle=1;",
    anchor: "shape=ellipse;fillColor=none;strokeColor=none;",
    event: "ellipse;whiteSpace=wrap;html=1;fillColor=#fff8e1;strokeColor=#f9a825;",
    cell: "rounded=0;whiteSpace=wrap;html=1;fillColor=#fafafa;strokeColor=#9e9e9e;fontSize=10;",
    package: "rounded=0;whiteSpace=wrap;html=1;fillColor=#e8eaf6;strokeColor=#3949ab;fontStyle=1;",
    class: "rounded=0;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacingLeft=6;fontFamily=Courier New;fontSize=10;fillColor=#fff8e1;strokeColor=#4e342e;",
    state: "rounded=1;whiteSpace=wrap;html=1;arcSize=30;fillColor=#e8f5e9;strokeColor=#2e7d32;",
    fragment: "rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=none;strokeColor=#9e9e9e;align=left;verticalAlign=top;spacingLeft=6;fontSize=11;",
  };
  // The heat of a shape darkens its fill (a hotspot's calls in, a matrix cell's count).
  const heat = node.heat !== undefined && node.heat > 0 ? `fillColor=${heatColour(node.heat)};` : "";
  const mark = node.diff ? `strokeColor=${DIFF_STROKE[node.diff]};strokeWidth=3;${node.diff === "removed" || node.diff === "planned" ? "dashed=1;" : ""}` : "";

  return base[node.kind] + heat + mark;
}


export function toDrawio(diagram: Diagram): string {
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  let next = 2;
  const cellOf = new Map<string, number>();

  for (const group of diagram.groups) {
    const id = next++;
    cellOf.set(`lane:${group.id}`, id);
    cells.push(
      `<object label="${escape(group.label)}" archdiff_kind="lane" archdiff_id="${escape(group.id)}" id="${id}"><mxCell style="swimlane;horizontal=0;html=1;startSize=24;fillColor=#fafafa;strokeColor=#bdbdbd;" vertex="1" parent="1"><mxGeometry x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" as="geometry"/></mxCell></object>`,
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
    const attributes = [`label="${escape(node.label)}"`, `archdiff_kind="${node.kind}"`, `archdiff_id="${escape(node.id)}"`];

    if (node.ref?.file) attributes.push(`archdiff_file="${escape(node.ref.file)}"`);

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
    const colour = edge.diff === "added" ? "strokeColor=#2e7d32;strokeWidth=2;" : edge.diff === "removed" ? "strokeColor=#c62828;strokeWidth=2;" : edge.diff === "warning" || edge.diff === "changed" ? "strokeColor=#ef6c00;strokeWidth=2;" : edge.diff === "planned" ? "strokeColor=#1565c0;strokeWidth=2;" : edge.kind === "call" || edge.kind === "message" ? "strokeColor=#1565c0;" : edge.kind === "lifeline" ? "strokeColor=#b0bec5;endArrow=none;" : "strokeColor=#616161;";
    // The bends of the route (without its two ends, which the cells give) as waypoints, so draw.io draws the same path.
    const bends = (edge.route ?? routes.get(edge) ?? []).slice(1, -1);
    const points = bends.length > 0 ? `<Array as="points">${bends.map((point) => `<mxPoint x="${Math.round(point.x)}" y="${Math.round(point.y)}"/>`).join("")}</Array>` : "";
    cells.push(
      `<object label="${escape(edge.label ?? "")}" archdiff_kind="${edge.kind}" id="${id}"><mxCell style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;${dashed}${colour}" edge="1" parent="1" source="${from}" target="${to}"><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell></object>`,
    );
  }

  return `<mxfile host="archdiff" type="device"${diagram.stamp ? ` agent="archdiff commit ${escape(diagram.stamp.commit)}" modified="${escape(diagram.stamp.date)}"` : ""}><diagram name="${escape(diagram.title)}" id="archdiff-${escape(diagram.view)}"><mxGraphModel archdiff_view="${escape(diagram.view)}" grid="1" gridSize="10" page="1" pageWidth="1654" pageHeight="1169"><root>${cells.join("")}</root></mxGraphModel></diagram></mxfile>\n`;
}
