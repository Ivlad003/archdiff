// A placed diagram as a Markdown page: the title, a Mermaid block of the
// picture, and the list of shapes with their code positions, so the same
// view reads in a terminal, a pull request or a wiki. Also the Markdown of
// one shape (the properties panel of the web page): what it is, where it
// is, what it calls and what calls it.
//
// Pure: Diagram + Analysis → text, byte-stable for the same inputs.
// Entry points: `diagramMarkdown`, `nodeMarkdown`.

import type { Analysis } from "./analyze.ts";
import type { Diagram, DiagramNode } from "./diagram.ts";
import { toMermaid } from "./export/mermaid.ts";
import { moduleOf } from "./graph.ts";

function position(node: DiagramNode): string {
  if (!node.ref?.file) return "";

  return node.ref.line !== undefined ? `${node.ref.file}:${node.ref.line}` : node.ref.file;
}

/** The page of a diagram: title, Mermaid, the shapes by lane. */
export function diagramMarkdown(diagram: Diagram, analysis: Analysis): string {
  const lines = [`<!-- archdiff:generated — view ${diagram.view} -->`, `# ${diagram.title}`, ""];

  if (diagram.reason) lines.push(`_${diagram.reason}_`, "");
  lines.push(`${diagram.nodes.length} shapes, ${diagram.edges.length} lines; ${analysis.files.length} files analysed.`, "", "```mermaid", toMermaid(diagram).trimEnd(), "```", "");
  const byGroup = new Map<string, DiagramNode[]>();

  for (const node of diagram.nodes) byGroup.set(node.group ?? "", [...(byGroup.get(node.group ?? "") ?? []), node]);

  for (const [group, nodes] of [...byGroup].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (group !== "") lines.push(`## ${group}`, "");

    for (const node of nodes) {
      const where = position(node);
      const mark = node.diff ? ` (${node.diff})` : "";
      const detail = node.kind === "hole" ? ` — not followed: ${node.reason ?? ""}` : node.signature ? ` \`${node.signature}\`` : node.count !== undefined && node.kind === "layer" ? ` — ${node.count} modules` : "";
      lines.push(`- **${node.label.replace(/\n.*/s, "")}**${mark}${detail}${where ? ` — ${where}` : ""}`);
    }

    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** The Markdown of one shape, for the panel beside the canvas. */
export function nodeMarkdown(node: DiagramNode, analysis: Analysis): string {
  const { graph } = analysis;
  const lines = [`# ${node.label.replace(/\n.*/s, "")}`, ""];
  const where = position(node);

  if (where) lines.push(`${node.kind} — ${where}`, "");

  if (node.signature) lines.push("```ts", node.signature, "```", "");

  if (node.doc) lines.push(node.doc, "");

  if (node.kind === "hole") lines.push(`Not followed: ${node.reason ?? "unknown"}.`, "");
  const id = node.ref?.id ?? node.id;

  if (node.kind === "fn") {
    const calls = graph.calls.filter((call) => call.from === id);
    const callers = graph.calls.filter((call) => call.to === id);

    if (calls.length > 0) {
      lines.push("## Calls", "");

      for (const call of calls) lines.push(`- ${call.kind === "ref" ? "(as a value) " : ""}${call.to} — ${moduleOf(call.from)}:${call.line}`);
      lines.push("");
    }

    if (callers.length > 0) {
      lines.push("## Called by", "");

      for (const call of callers) lines.push(`- ${call.kind === "ref" ? "(as a value) " : ""}${call.from} — ${moduleOf(call.from)}:${call.line}`);
      lines.push("");
    }

    const gaps = graph.gaps.filter((gap) => gap.from === id);

    if (gaps.length > 0) {
      lines.push("## Not followed", "");

      for (const gap of gaps) lines.push(`- \`${gap.callee}\` — ${gap.reason} (line ${gap.line})`);
      lines.push("");
    }
  }

  if (node.kind === "module") {
    const module = graph.modules.get(id);

    if (module) {
      lines.push(`Layer ${module.layer}, ${module.lines} lines.`, "");

      if (module.decls.length > 0) {
        lines.push("## Declarations", "");

        for (const decl of module.decls) {
          const found = graph.nodes.get(decl)!;
          lines.push(`- ${found.exported ? "export " : ""}${found.kind} **${found.name}**${found.signature ? ` \`${found.signature}\`` : ""} — line ${found.line}`);
        }

        lines.push("");
      }

      const imports = graph.deps.filter((dep) => dep.from === id);
      const importers = graph.deps.filter((dep) => dep.to === id);

      if (imports.length > 0) {
        lines.push("## Imports", "");

        for (const dep of imports) lines.push(`- ${dep.to}${dep.typeOnly ? " (types only)" : ""}${dep.reexport ? " (re-exported)" : ""} — line ${dep.line}`);
        lines.push("");
      }

      if (importers.length > 0) {
        lines.push("## Imported by", "");

        for (const dep of importers) lines.push(`- ${dep.from}${dep.typeOnly ? " (types only)" : ""} — line ${dep.line}`);
        lines.push("");
      }
    }
  }

  if (node.kind === "layer") {
    const members = [...graph.modules.values()].filter((module) => module.layer === id).map((module) => module.id);
    lines.push(`${members.length} modules.`, "", "## Modules", "");

    for (const member of members) lines.push(`- ${member}`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
