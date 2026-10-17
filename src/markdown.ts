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

  // The matrix reads as a table: rows import columns.
  if (diagram.view === "matrix") {
    const layers = diagram.nodes.filter((node) => node.id.startsWith("row:")).map((node) => node.id.slice(4));
    const cell = new Map(diagram.nodes.filter((node) => node.id.startsWith("cell:")).map((node) => [node.id.slice(5), node]));
    lines.push(`| imports → | ${layers.join(" | ")} |`, `| --- | ${layers.map(() => "---").join(" | ")} |`);

    for (const from of layers) lines.push(`| **${from}** | ${layers.map((to) => (from === to ? "·" : cell.get(`${from}>${to}`)?.diff === "removed" ? `**${cell.get(`${from}>${to}`)!.label}** ⚠` : cell.get(`${from}>${to}`)?.label || "")).join(" | ")} |`);
    lines.push("", "A cell in bold with ⚠ is an import against the layer order (a lower layer importing a higher one).");

    return `${lines.join("\n").trimEnd()}\n`;
  }

  // A sequence reads as a numbered list: who calls what, in order, with the line of each call.
  if (diagram.sequence) {
    lines.push("## Messages", "");

    for (const [i, message] of diagram.sequence.messages.entries()) lines.push(`${i + 1}. \`${message.from}\` → \`${message.to}\`: **${message.label}()** — ${message.from}:${message.line}`);
    lines.push("", "## Participants", "", ...diagram.sequence.participants.map((module) => `- ${module}`), "");

    return `${lines.join("\n").trimEnd()}\n`;
  }
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

/** How many lines of a declaration's code the panel shows before cutting; the Code tab has the whole file. */
const CODE_LINES = 60;

/** The code of lines `from`..`to` of a file as a fenced block, cut at `CODE_LINES`; null when the source is not readable. */
function codeBlock(source: string | null, file: string, from: number, to: number): string | null {
  if (source === null) return null;
  const lines = source.split("\n").slice(from - 1, to);
  const fence = lines.some((line) => line.includes("```")) ? "````" : "```";
  const language = file.slice(file.lastIndexOf(".") + 1).replace(/^[cm]?(ts|js)x?$/, (match) => match);
  const shown = lines.slice(0, CODE_LINES);
  const cut = lines.length > CODE_LINES ? `\n… ${lines.length - CODE_LINES} more lines (the Code tab has the file)` : "";

  return `${fence}${language}\n${shown.join("\n")}\n${fence}${cut}`;
}

/** What a function calls and what it could not follow, as list lines. */
function callLines(id: string, analysis: Analysis): string[] {
  const { graph } = analysis;
  const lines: string[] = [];
  const calls = graph.calls.filter((call) => call.from === id);
  const gaps = graph.gaps.filter((gap) => gap.from === id && (gap.reason === "dynamic" || gap.reason === "unknown-member" || gap.reason === "interface"));

  for (const call of calls) lines.push(`- ${call.kind === "ref" ? "passes " : "calls "}\`${call.to}\` — line ${call.line}`);

  for (const gap of gaps) lines.push(`- cannot follow \`${gap.callee}\` (${gap.reason}) — line ${gap.line}`);

  return lines;
}

/**
 * The Markdown of one shape, for the panel beside the canvas. With
 * `readSource` (a file's text, or null), a module's declarations fold
 * open to their calls and their code.
 */
export function nodeMarkdown(node: DiagramNode, analysis: Analysis, readSource: (file: string) => string | null = () => null): string {
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
        const source = readSource(id);

        // Each declaration folds open to what it calls and its code; a class lists its members the same way.
        const describe = (declId: string, depth: number): void => {
          const found = graph.nodes.get(declId)!;
          const head = `${found.exported ? "export " : ""}${found.kind} <b>${found.name}</b>${found.signature ? ` <code>${found.signature.replace(/</g, "&lt;")}</code>` : ""} — line ${found.line}`;
          const body: string[] = [];

          if (found.doc) body.push(found.doc, "");
          const calls = callLines(declId, analysis);

          if (calls.length > 0) body.push(...calls, "");
          const members = [...graph.nodes.values()].filter((candidate) => candidate.module === id && candidate.parent === (found.parent ? `${found.parent}.${found.name}` : found.name));

          for (const member of members) body.push(`- ${member.kind} **${member.name}**${member.signature ? ` \`${member.signature}\`` : ""} — line ${member.line}`);

          if (members.length > 0) body.push("");
          const code = codeBlock(source, id, found.line, found.endLine);

          if (code) body.push(code);
          lines.push(`<details${depth > 0 ? ' class="member"' : ""}><summary>${head}</summary>`, "", ...body, "", "</details>");
        };

        for (const decl of module.decls) describe(decl, 0);
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
