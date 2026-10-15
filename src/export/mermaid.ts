// A Diagram as a Mermaid flowchart: lanes as subgraphs, shapes by kind,
// imports as solid arrows, calls as thick ones, references dotted; the
// marks of a diff as classes. Text only, byte-stable for the same diagram,
// so it pastes into a pull request comment or a Markdown file.

import type { Diagram, DiagramNode } from "../diagram.ts";

/** A Mermaid-safe node ID: letters, digits and underscores, unique per diagram. */
function mermaidIds(nodes: readonly DiagramNode[]): Map<string, string> {
  const ids = new Map<string, string>();
  const taken = new Set<string>();

  for (const node of nodes) {
    const base = node.id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "") || "n";
    let candidate = base;

    for (let n = 2; taken.has(candidate); n++) candidate = `${base}_${n}`;
    taken.add(candidate);
    ids.set(node.id, candidate);
  }

  return ids;
}

function label(text: string): string {
  return `"${text.replace(/"/g, "#quot;").replace(/\n/g, "<br/>")}"`;
}

function shape(node: DiagramNode, id: string): string {
  const text = label(node.count !== undefined && node.kind === "layer" ? `${node.label} (${node.count})` : node.label);

  switch (node.kind) {
    case "layer":
      return `${id}[[${text}]]`;
    case "external":
      return `${id}[(${text})]`;
    case "hole":
      return `${id}{{${text}}}`;
    case "start":
      return `${id}((${text}))`;
    case "fn":
      return `${id}(${text})`;
    case "module":
      return `${id}[${text}]`;
    case "more":
      return `${id}[/${text}/]`;
  }
}

export function toMermaid(diagram: Diagram): string {
  const ids = mermaidIds(diagram.nodes);
  const lines = [`%% archdiff:generated — view ${diagram.view}`, `flowchart ${diagram.direction === "down" ? "TB" : "LR"}`];
  const byGroup = new Map<string | undefined, DiagramNode[]>();

  for (const node of diagram.nodes) byGroup.set(node.group, [...(byGroup.get(node.group) ?? []), node]);

  for (const group of diagram.groups) {
    const members = byGroup.get(group.id);

    if (!members) continue;
    lines.push(`  subgraph ${label(group.label)}`);

    for (const node of members) lines.push(`    ${shape(node, ids.get(node.id)!)}`);
    lines.push("  end");
  }

  for (const node of diagram.nodes) if (node.group === undefined || !diagram.groups.some((group) => group.id === node.group)) lines.push(`  ${shape(node, ids.get(node.id)!)}`);

  for (const edge of diagram.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);

    if (!from || !to) continue;
    const arrow = edge.kind === "ref" ? "-.->" : edge.kind === "call" ? "==>" : "-->";
    const text = edge.label ? `|${label(edge.label)}|` : "";
    lines.push(`  ${from} ${arrow}${text} ${to}`);
  }

  const marked = diagram.nodes.filter((node) => node.diff);

  if (marked.length > 0) {
    lines.push("  classDef added stroke:#2e7d32,stroke-width:3px", "  classDef removed stroke:#c62828,stroke-width:3px,stroke-dasharray:5 5", "  classDef changed stroke:#ef6c00,stroke-width:3px");

    for (const mark of ["added", "removed", "changed"] as const) {
      const members = marked.filter((node) => node.diff === mark).map((node) => ids.get(node.id)!);

      if (members.length > 0) lines.push(`  class ${members.join(",")} ${mark}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
