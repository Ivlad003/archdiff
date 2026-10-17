// A Diagram as an ArchiMate model in the Open Exchange File Format (XML),
// which Archi imports (File → Import → Open Exchange XML). Layers and
// modules are Application Components, functions Application Functions,
// packages and built-ins System Software, holes Application Functions with
// the reason in their documentation; imports are Dependency relationships,
// calls Triggering, references Association. One view holds every element
// at its laid-out place, lanes as Group nodes. Byte-stable for the same
// placed diagram.

import type { Diagram, DiagramEdge, DiagramNode } from "../diagram.ts";

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** An XML ID: `id-` and the archdiff ID with every other character encoded. */
function xmlId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9]/g, (char) => `_${char.charCodeAt(0).toString(16)}`)}`;
}

function elementType(node: DiagramNode): string {
  switch (node.kind) {
    case "layer":
    case "module":
      return "ApplicationComponent";
    case "fn":
    case "hole":
      return "ApplicationFunction";
    case "external":
      return "SystemSoftware";
    case "start":
      return "ApplicationEvent";
    case "more":
      return "Grouping";
    case "participant":
    case "package":
      return "ApplicationComponent";
    case "anchor":
      return "Junction";
    case "event":
      return "ApplicationEvent";
    case "cell":
      return "Grouping";
    case "class":
      return "DataObject";
    case "state":
      return "ApplicationEvent";
    case "fragment":
      return "Grouping";
  }
}

function relationType(edge: DiagramEdge): string {
  return edge.kind === "dependency" ? "Serving" : edge.kind === "call" || edge.kind === "message" ? "Triggering" : "Association";
}

const DIFF_FILL = { added: { r: 200, g: 230, b: 201 }, removed: { r: 255, g: 205, b: 210 }, changed: { r: 255, g: 224, b: 178 }, warning: { r: 255, g: 224, b: 178 }, planned: { r: 187, g: 222, b: 251 } } as const;

export function toArchimate(diagram: Diagram): string {
  const elements: string[] = [];
  const relationships: string[] = [];
  const viewNodes: string[] = [];
  const viewEdges: string[] = [];

  for (const node of diagram.nodes) {
    if (node.kind === "anchor") continue;
    const id = xmlId("id", node.id);
    const documentation = [node.ref?.file ? `${node.ref.file}${node.ref.line ? `:${node.ref.line}` : ""}` : "", node.signature ?? "", node.reason ? `not followed: ${node.reason}` : "", node.doc ?? ""].filter((part) => part !== "").join("\n");
    elements.push(`    <element identifier="${id}" xsi:type="${elementType(node)}"><name xml:lang="en">${escape(node.label.replace(/\n.*/s, ""))}</name>${documentation ? `<documentation xml:lang="en">${escape(documentation)}</documentation>` : ""}</element>`);
    const fill = node.diff ? DIFF_FILL[node.diff] : null;
    viewNodes.push(`      <node identifier="${xmlId("node", node.id)}" elementRef="${id}" xsi:type="Element" x="${Math.round(node.x)}" y="${Math.round(node.y)}" w="${Math.round(node.w)}" h="${Math.round(node.h)}">${fill ? `<style><fillColor r="${fill.r}" g="${fill.g}" b="${fill.b}"/></style>` : ""}</node>`);
  }

  // Lanes become Group nodes drawn behind the elements (listed first, so Archi draws them first).
  const groupNodes = diagram.groups.map((group) => `      <node identifier="${xmlId("lane", group.id)}" xsi:type="Container" x="${Math.round(group.x)}" y="${Math.round(group.y)}" w="${Math.round(group.w)}" h="${Math.round(group.h)}"><label xml:lang="en">${escape(group.label)}</label><style><fillColor r="250" g="250" b="250"/></style></node>`);
  const known = new Set(diagram.nodes.map((node) => node.id));

  for (const [index, edge] of diagram.edges.entries()) {
    // Lifelines are drawing, not architecture; a sequence's messages are numbered so two calls between the same pair stay apart.
    if (!known.has(edge.from) || !known.has(edge.to) || edge.kind === "lifeline") continue;
    const id = xmlId("rel", `${edge.from}->${edge.to}:${edge.kind}${edge.kind === "message" ? `:${index}` : ""}`);
    relationships.push(`    <relationship identifier="${id}" source="${xmlId("id", edge.from)}" target="${xmlId("id", edge.to)}" xsi:type="${relationType(edge)}">${edge.label ? `<name xml:lang="en">${escape(edge.label)}</name>` : ""}</relationship>`);
    const colour = edge.diff === "added" ? '<style><lineColor r="46" g="125" b="50"/></style>' : edge.diff === "removed" ? '<style><lineColor r="198" g="40" b="40"/></style>' : edge.diff === "planned" ? '<style><lineColor r="21" g="101" b="192"/></style>' : edge.diff === "warning" || edge.diff === "changed" ? '<style><lineColor r="239" g="108" b="0"/></style>' : "";
    viewEdges.push(`      <connection identifier="${xmlId("conn", `${edge.from}->${edge.to}:${edge.kind}${edge.kind === "message" ? `:${index}` : ""}`)}" relationshipRef="${id}" xsi:type="Relationship" source="${xmlId("node", edge.from)}" target="${xmlId("node", edge.to)}">${colour}</connection>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.opengroup.org/xsd/archimate/3.0/ http://www.opengroup.org/xsd/archimate/3.1/archimate3_Diagram.xsd" identifier="${xmlId("model", diagram.view)}">
  <name xml:lang="en">${escape(diagram.title)}</name>${diagram.stamp ? `\n  <documentation xml:lang="en">archdiff, commit ${escape(diagram.stamp.commit)} (${escape(diagram.stamp.date)})</documentation>` : ""}
  <documentation xml:lang="en">Generated by archdiff from the code: view ${escape(diagram.view)}.</documentation>
  <elements>
${elements.join("\n")}
  </elements>
  <relationships>
${relationships.join("\n")}
  </relationships>
  <views>
    <diagrams>
      <view identifier="${xmlId("view", diagram.view)}" xsi:type="Diagram">
        <name xml:lang="en">${escape(diagram.title)}</name>
${[...groupNodes, ...viewNodes, ...viewEdges].map((line) => `  ${line}`).join("\n")}
      </view>
    </diagrams>
  </views>
</model>
`;
}
