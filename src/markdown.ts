// A placed diagram as a Markdown page: the title, a Mermaid block of the
// picture, and the list of shapes with their code positions, so the same
// view reads in a terminal, a pull request or a wiki. Also the Markdown of
// one shape (the properties panel of the web page): what it is, where it
// is, what it calls and what calls it.
//
// Pure: Diagram + Analysis → text, byte-stable for the same inputs.
// Entry points: `diagramMarkdown`, `nodeMarkdown`.

import type { Analysis } from "./analyze.ts";
import type { Diagram, DiagramEdge, DiagramNode } from "./diagram.ts";
import { farFromMainSequence, type Metrics } from "./diagram.ts";
import { toMermaid, type MermaidStyle } from "./export/mermaid.ts";
import { moduleOf } from "./graph.ts";

function position(node: DiagramNode): string {
  if (!node.ref?.file) return "";

  return node.ref.line !== undefined ? `${node.ref.file}:${node.ref.line}` : node.ref.file;
}

/** The page of a diagram: title, Mermaid, the shapes by lane. */
export function diagramMarkdown(diagram: Diagram, analysis: Analysis, mermaid: MermaidStyle = "auto"): string {
  const lines = [`<!-- archdiff:generated — view ${diagram.view}${diagram.stamp ? ` — commit ${diagram.stamp.commit} (${diagram.stamp.date})` : ""} -->`, `# ${diagram.title}`, ""];

  if (diagram.question) lines.push(`_${diagram.question[0]!.toUpperCase()}${diagram.question.slice(1)}._`, "");

  if (diagram.reason) lines.push(`_${diagram.reason}_`, "");
  lines.push(`${diagram.nodes.length} shapes, ${diagram.edges.length} lines; ${analysis.files.length} files analysed.`, "", "```mermaid", toMermaid(diagram, mermaid).trimEnd(), "```", "");

  // The matrix reads as a table: rows import columns.
  if (diagram.view === "matrix" || diagram.view.startsWith("matrix:")) {
    const rows = diagram.nodes.filter((node) => node.id.startsWith("row:"));
    const ids = rows.map((node) => node.id.slice(4));
    const name = new Map(rows.map((node) => [node.id.slice(4), node.label]));
    const cell = new Map(diagram.nodes.filter((node) => node.id.startsWith("cell:")).map((node) => [node.id.slice(5), node]));
    lines.push(`| imports → | ${ids.map((id) => name.get(id)).join(" | ")} |`, `| --- | ${ids.map(() => "---").join(" | ")} |`);

    for (const from of ids) lines.push(`| **${name.get(from)}** | ${ids.map((to) => (from === to ? "·" : cell.get(`${from}>${to}`)?.diff === "removed" ? `**${cell.get(`${from}>${to}`)!.label}** ⚠` : cell.get(`${from}>${to}`)?.label || "")).join(" | ")} |`);
    lines.push("", diagram.view === "matrix" ? "A cell in bold with ⚠ is an import against the layer order (a lower layer importing a higher one)." : "A cell in bold with ⚠ is an import against the order of the rows (a module importing one placed above it).");

    return `${lines.join("\n").trimEnd()}\n`;
  }

  // The metrics read as tables: the layers, then the modules, the farthest from the main sequence first.
  if (diagram.metrics) {
    lines.push(...metricsMarkdown(diagram.metrics));

    return `${lines.join("\n").trimEnd()}\n`;
  }

  // Classes read box by box: fields, methods, what each extends or implements.
  if (diagram.classes) {
    for (const box of diagram.classes.boxes) {
      const node = diagram.nodes.find((candidate) => candidate.id === box.id);
      lines.push(`## ${box.kind === "class" ? "" : `«${box.kind}» `}${box.name}${node?.ref?.file ? ` — ${node.ref.file}:${node.ref.line}` : ""}`, "");

      for (const relation of diagram.classes.relations.filter((candidate) => candidate.from === box.id)) lines.push(`- ${relation.kind} \`${relation.to}\``);

      for (const field of box.fields) lines.push(`- field \`${field}\``);

      for (const method of box.methods) lines.push(`- method \`${method}\``);

      if (box.fields.length + box.methods.length === 0) lines.push("- (empty)");
      lines.push("");
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  // A machine reads as its states and a table of transitions.
  if (diagram.machine) {
    const machine = diagram.machine;
    lines.push("## States", "", ...machine.states.map((state) => `- **${state.name}**${state.name === machine.initial ? " (initial)" : ""}${state.assigned ? "" : state.declared ? " — declared by the type, never set" : " — read, never set"}`), "", "## Transitions", "", "| from | by | to | where |", "| --- | --- | --- | --- |");

    for (const transition of machine.transitions) lines.push(`| ${transition.from === "*" ? "any state" : transition.from} | ${transition.event ?? transition.fn ?? ""} | ${transition.to} | ${machine.module}:${transition.line} |`);
    lines.push("");

    return `${lines.join("\n").trimEnd()}\n`;
  }

  // A sequence reads as a numbered list: who calls what, in order, with the line of each call; a fragment is named before its calls.
  if (diagram.sequence) {
    lines.push("## Messages", "");
    const fragments = diagram.sequence.fragments ?? [];

    for (const [i, message] of diagram.sequence.messages.entries()) {
      for (const fragment of fragments) if (fragment.first === i) lines.push(`- _${fragment.kind} [${fragment.label}]_ — messages ${fragment.first + 1}–${fragment.last + 1}`);
      lines.push(`${i + 1}. \`${message.from}\` → \`${message.to}\`: **${message.label}()**${(message.times ?? 1) > 1 ? ` ×${message.times}` : ""} — ${message.from}:${message.line}`);
    }

    lines.push("", "## Participants", "", ...diagram.sequence.participants.map((module) => `- ${module}`), "");

    return `${lines.join("\n").trimEnd()}\n`;
  }
  const byGroup = new Map<string, DiagramNode[]>();

  for (const node of diagram.nodes) byGroup.set(node.group ?? "", [...(byGroup.get(node.group ?? "") ?? []), node]);

  for (const [group, nodes] of [...byGroup].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (group !== "") lines.push(`## ${group}`, "");

    for (const node of nodes) {
      const where = position(node);
      const mark = node.diff && node.diff !== "warning" ? ` (${node.diff})` : "";
      const detail = node.kind === "hole" ? ` — not followed: ${node.reason ?? ""}` : node.signature ? ` \`${node.signature}\`` : node.count !== undefined && node.kind === "layer" ? ` — ${node.count} modules` : "";
      // The further lines of a label are what the overlays found (no tests, ⛁ a store, N calls in); a class lists its members elsewhere.
      const [first, ...rest] = node.label.split("\n");
      const found = node.kind === "class" || rest.length === 0 ? "" : ` — ${rest.join(" · ")}`;
      lines.push(`- **${first}**${mark}${found}${detail}${where ? ` — ${where}` : ""}`);
    }

    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** The metrics as Markdown tables: the modules (the farthest from the main sequence first) and the layers. */
export function metricsMarkdown(metrics: Metrics): string[] {
  const lines: string[] = [];

  if (metrics.layers.length > 0) {
    lines.push("## Layers", "", "| layer | modules | Ca | Ce | I | A | D |", "| --- | --- | --- | --- | --- | --- | --- |");

    for (const layer of metrics.layers) lines.push(`| **${layer.name}** | ${layer.modules} | ${layer.ca} | ${layer.ce} | ${layer.instability.toFixed(2)} | ${layer.abstractness.toFixed(2)} | ${layer.distance.toFixed(2)} |`);
    lines.push("");
  }

  lines.push("## Modules", "", "| module | layer | Ca | Ce | I | A | D | cohesion | fns | lines |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const row of metrics.modules) lines.push(`| ${row.id} | ${row.layer} | ${row.ca} | ${row.ce} | ${row.instability.toFixed(2)} | ${row.abstractness.toFixed(2)} | ${farFromMainSequence(row) ? `**${row.distance.toFixed(2)}** ⚠` : row.distance.toFixed(2)} | ${row.cohesion < 0.3 && row.fns > 2 ? `**${row.cohesion.toFixed(2)}** ⚠` : row.cohesion.toFixed(2)} | ${row.fns} | ${row.lines} |`);
  lines.push("", "Ca: modules that import it; Ce: modules it imports; I = Ce / (Ca + Ce), 0 stable, 1 unstable; A: types and interfaces among its declarations; D = |A + I − 1|, the distance from the main sequence (⚠ at 0.7 when the module is coupled at all: concrete and depended upon, or abstract and depending on everything); cohesion: 1 when its functions form one group by calls, shared callees and shared types, 0 when each stands alone.");

  return lines;
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

/** The modules a shape stands for: a module itself, a layer's modules, a folded directory's, a function's own module; none for an external. */
function modulesBehind(node: DiagramNode, analysis: Analysis): string[] {
  const { graph } = analysis;
  const id = node.ref?.id ?? node.id;

  if (node.kind === "layer") return [...graph.modules.values()].filter((module) => module.layer === node.id).map((module) => module.id);

  if (node.kind === "more" || node.kind === "package") {
    const members = (node as DiagramNode & { members?: string[] }).members;

    if (members && members.length > 0) return members.map(moduleOf);
    const directory = id.startsWith("dir:") ? `${id.slice(4)}/` : null;

    return directory ? [...graph.modules.keys()].filter((module) => module.startsWith(directory)) : [];
  }

  if (node.kind === "external" || node.kind === "hole" || node.kind === "start" || node.kind === "event") return [];

  return [moduleOf(id)];
}

/** The label of a shape for prose: its first line. */
function nameOf(node: DiagramNode): string {
  return node.label.split("\n")[0]!;
}

/**
 * The page of a line: what it joins, what it stands for and every import or
 * call behind it with its `file:line`, so a tap on an arrow says where it
 * leads and why it is there.
 */
export function edgeMarkdown(edge: DiagramEdge, diagram: Diagram, analysis: Analysis): string {
  const { graph } = analysis;
  const from = diagram.nodes.find((node) => node.id === edge.from);
  const to = diagram.nodes.find((node) => node.id === edge.to);

  if (!from || !to) return `# ${edge.from} → ${edge.to}\n\nThe line's ends are not in this view.\n`;
  const lines = [`# ${nameOf(from)} → ${nameOf(to)}`, ""];
  const what = edge.kind === "dependency" ? "imports" : edge.kind === "call" ? "calls" : edge.kind === "ref" ? "passes as a value (may call)" : edge.kind === "message" ? `message${edge.label ? ` ${edge.label}` : ""}` : "lifeline";
  lines.push(`${nameOf(from)} ${what} ${nameOf(to)}${edge.count !== undefined && edge.count > 1 ? ` — ${edge.count} lines behind this one` : ""}${edge.diff ? ` (${edge.diff})` : ""}.`, "");
  const whereFrom = position(from);
  const whereTo = position(to);
  lines.push("## Ends", "", `- from: **${nameOf(from)}** (${from.kind})${whereFrom ? ` — ${whereFrom}` : ""}`, `- to: **${nameOf(to)}** (${to.kind})${whereTo ? ` — ${whereTo}` : ""}`, "");

  // Imports behind the line: every dependency from the source's modules to the target's modules (or to its package).
  const sources = new Set(modulesBehind(from, analysis));
  const targets = new Set(modulesBehind(to, analysis));
  const targetIds = to.kind === "external" ? new Set([to.id]) : targets;
  const imports = graph.deps.filter((dep) => sources.has(dep.from) && targetIds.has(dep.to));

  if (imports.length > 0 && (edge.kind === "dependency" || from.kind !== "fn")) {
    lines.push(`## Imports (${imports.length})`, "");

    for (const dep of imports.slice(0, 60)) lines.push(`- \`${dep.from}:${dep.line}\` → ${dep.to}${dep.typeOnly ? " (types only)" : ""}${dep.reexport ? " (re-export)" : ""}`);

    if (imports.length > 60) lines.push(`- … ${imports.length - 60} more`);
    lines.push("");
  }

  // Calls behind the line: between the two functions, or between the modules behind the two shapes.
  const fromId = from.ref?.id ?? from.id;
  const toId = to.ref?.id ?? to.id;
  const calls = graph.calls.filter((call) =>
    from.kind === "fn" || from.kind === "class" || to.kind === "fn" || to.kind === "class"
      ? (from.kind === "fn" || from.kind === "class" ? call.from === fromId : sources.has(moduleOf(call.from))) && (to.kind === "fn" || to.kind === "class" ? call.to === toId : targets.has(moduleOf(call.to)))
      : sources.has(moduleOf(call.from)) && targets.has(moduleOf(call.to)) && moduleOf(call.from) !== moduleOf(call.to),
  );

  if (calls.length > 0) {
    lines.push(`## Calls (${calls.length})`, "");

    for (const call of calls.slice(0, 60)) lines.push(`- ${call.kind === "ref" ? "(as a value) " : ""}${call.from} → ${call.to} — \`${moduleOf(call.from)}:${call.line}\``);

    if (calls.length > 60) lines.push(`- … ${calls.length - 60} more`);
    lines.push("");
  }

  if (imports.length === 0 && calls.length === 0) lines.push("Nothing in the graph lies behind this line by name: the view drew it from its own data (a sequence, a matrix cell, a declared dependency).", "");

  return `${lines.join("\n").trimEnd()}\n`;
}
