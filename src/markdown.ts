// A placed diagram as a Markdown page: the title, a Mermaid block of the
// picture, and the list of shapes with their code positions, so the same
// view reads in a terminal, a pull request or a wiki. Also the Markdown of
// one shape (the properties panel of the web page): what it is, where it
// is, what it calls and what calls it.
//
// Pure: Diagram + Analysis → text, byte-stable for the same inputs.
// Entry points: `diagramMarkdown`, `nodeMarkdown`, `edgeMarkdown`,
// `metricsMarkdown`, `commitMarkdown`.

import type { Analysis } from "./analyze.ts";
import { parseApiId, participantLabel, API_LABELS, API_SHORT } from "./apis.ts";
import type { CommitInfo } from "./git.ts";
import type { Diagram, Line, Shape } from "./diagram.ts";
import { farFromMainSequence, type Metrics } from "./diagram.ts";
import { toMermaid, type MermaidStyle } from "./export/mermaid.ts";
import { isBlindSpot, moduleOf } from "./graph.ts";
import { standsFor } from "./shape-keys.ts";
import { parseView } from "./view-keys.ts";
import { counted } from "./words.ts";

function position(node: Shape): string {
  if (!node.ref?.file) return "";

  return node.ref.line !== undefined ? `${node.ref.file}:${node.ref.line}` : node.ref.file;
}

/** The page of a diagram: title, Mermaid, the shapes by lane. */
export function diagramMarkdown(diagram: Diagram, analysis: Analysis, mermaid: MermaidStyle = "auto"): string {
  const lines = [`<!-- archdiff:generated — view ${diagram.view}${diagram.stamp ? ` — commit ${diagram.stamp.commit} (${diagram.stamp.date})` : ""} -->`, `# ${diagram.title}`, ""];

  if (diagram.question) lines.push(`_${diagram.question[0]!.toUpperCase()}${diagram.question.slice(1)}._`, "");

  if (diagram.reason) lines.push(`_${diagram.reason}_`, "");
  lines.push(`${diagram.nodes.length} ${diagram.nodes.length === 1 ? "shape" : "shapes"}, ${diagram.edges.length} ${diagram.edges.length === 1 ? "line" : "lines"}; ${analysis.files.length} ${analysis.files.length === 1 ? "file" : "files"} analysed.`, "", "```mermaid", toMermaid(diagram, mermaid).trimEnd(), "```", "");

  // The matrix reads as a table: rows import columns.
  if (diagram.matrix) {
    const { rows, cells, scope } = diagram.matrix;
    const cell = new Map(cells.map((entry) => [`${entry.from}\u0000${entry.to}`, entry]));
    lines.push(`| imports → | ${rows.map((row) => row.label).join(" | ")} |`, `| --- | ${rows.map(() => "---").join(" | ")} |`);

    for (const from of rows) {
      const row = rows.map((to) => {
        const entry = cell.get(`${from.id}\u0000${to.id}`);

        return from.id === to.id ? "·" : !entry ? "" : entry.against ? `**${entry.count}** ⚠` : String(entry.count);
      });
      lines.push(`| **${from.label}** | ${row.join(" | ")} |`);
    }

    lines.push("", scope === null ? "A cell in bold with ⚠ is an import against the layer order (a lower layer importing a higher one)." : "A cell in bold with ⚠ is an import against the order of the rows (a module importing one placed above it).");

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

  // A function's logic reads as its rules: every path from the start to an exit, the conditions taken, the calls made, how it ends.
  if (diagram.logic) {
    const logic = diagram.logic;
    lines.push("## Rules: every path from the start to an exit", "", `${counted(logic.decisions, "decision")}, ${counted(logic.loops, "loop")}, ${counted(logic.exits, "exit")} in \`${logic.module}\`.${logic.truncated ? " The body is longer than the picture holds." : ""}`, "", "| when | calls | ends with |", "| --- | --- | --- |");

    for (const rule of logic.rules) lines.push(`| ${rule.conditions.length === 0 ? "always" : rule.conditions.map((condition) => `\`${condition.replace(/\|/g, "\\|")}\``).join(" and ")} | ${rule.calls.map((call) => `\`${call.replace(/\|/g, "\\|")}\``).join(", ")} | ${rule.kind === "end" ? "the end of the body" : `**${rule.outcome.replace(/\|/g, "\\|")}**`} |`);

    if (logic.moreRules) lines.push("", `… ${counted(logic.moreRules, "more rule", "more rules")}`);
    lines.push("", "A condition reads `condition: branch`; `each` and `done` are a loop's body and its end; `ok` and `error` a try's.");

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
      lines.push(`${i + 1}. \`${message.from}\` → \`${participantLabel(message.to)}\`: **${message.label}${diagram.sequence.kind === "messages" ? "" : "()"}**${(message.times ?? 1) > 1 ? ` ×${message.times}` : ""} — ${message.from}:${message.line}`);
    }

    lines.push("", "## Participants", "", ...diagram.sequence.participants.map((module) => `- ${participantLabel(module)}`), "");

    return `${lines.join("\n").trimEnd()}\n`;
  }
  const byGroup = new Map<string, Shape[]>();

  for (const node of diagram.nodes) byGroup.set(node.group ?? "", [...(byGroup.get(node.group ?? "") ?? []), node]);

  for (const [group, nodes] of [...byGroup].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (group !== "") lines.push(`## ${diagram.groups.find((lane) => lane.id === group)?.label ?? group}`, "");

    for (const node of nodes) {
      const where = position(node);
      // A change's mark; a cell's colour (a bar of the timeline, a cell of the matrix) is no change of it.
      const mark = node.diff && node.diff !== "warning" && node.kind !== "cell" ? ` (${node.diff})` : "";
      const detail = node.kind === "hole" ? ` — not followed: ${node.reason ?? ""}` : node.signature ? ` \`${node.signature}\`` : node.count !== undefined && node.kind === "layer" ? ` — ${node.count} modules` : "";
      // The further lines of a label are what the overlays found (no tests, ⛁ a store, N calls in); a class lists its members elsewhere.
      const [first, ...rest] = node.label.split("\n");
      const found = node.kind === "class" || rest.length === 0 ? "" : ` — ${rest.join(" · ")}`;
      // Where the code leads on past the picture's depth, as the canvas counts it under the shape.
      const beyond = node.beyond ? ` — beyond the picture: ${[node.beyond.before.count > 0 ? `◂ ${node.beyond.before.count} before` : "", node.beyond.after.count > 0 ? `${node.beyond.after.count} after ▸` : ""].filter(Boolean).join(", ")}` : "";
      lines.push(`- **${first}**${mark}${found}${detail}${where ? ` — ${where}` : ""}${beyond}`);

      // A folded shape: what it stands for, every one, since the picture shows them as one.
      for (const member of node.members ?? []) lines.push(`  - ${member}`);
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

/**
 * The neighbours a shape's picture leaves out (`Shape.beyond`), as a section of its page: where the code leads past
 * the depth drawn — what imports or calls it from beyond the picture, and what it imports or calls there.
 */
function beyondSection(node: Shape): string[] {
  if (!node.beyond) return [];
  const fn = node.kind === "fn";
  const lines = ["## Beyond this picture", ""];

  for (const side of ["before", "after"] as const) {
    const { count, ids } = node.beyond[side];

    if (count === 0) continue;
    const what = side === "before" ? `the ${fn ? "functions that call" : "modules that import"} it` : `the ${fn ? "functions it calls" : "modules it imports"}`;
    lines.push(`${side === "before" ? `◂ ${count} before it` : `${count} after it ▸`}: ${what}, not drawn here.`, "");
    // A call from a module's top level comes from the module itself.
    lines.push(...ids.map((other) => `- ${other}${fn && !other.includes("#") ? " (its top level)" : ""}`), ...(count > ids.length ? [`- … ${count - ids.length} more`] : []), "");
  }

  lines.push("_Focus (the right-click menu) draws everything joined to it; depth + takes the picture one step further._", "");

  return lines;
}

/** What a function calls and what it could not follow, as list lines. */
function callLines(id: string, analysis: Analysis): string[] {
  const { graph } = analysis;
  const lines: string[] = [];
  const calls = graph.calls.filter((call) => call.from === id);
  const gaps = graph.gaps.filter((gap) => gap.from === id && isBlindSpot(gap));

  for (const call of calls) lines.push(`- ${call.kind === "ref" ? "passes " : "calls "}\`${call.to}\` — line ${call.line}`);

  for (const api of graph.apiCalls) if (api.from === id) lines.push(`- calls ${API_SHORT[api.api]} \`${api.family}.${api.operation}\` — line ${api.line}`);

  for (const gap of gaps) lines.push(`- cannot follow \`${gap.callee}\` (${gap.reason}) — line ${gap.line}`);

  return lines;
}

/**
 * The Markdown of one shape, for the panel beside the canvas. With
 * `readSource` (a file's text, or null), a module's declarations fold
 * open to their calls and their code.
 */
export function nodeMarkdown(node: Shape, analysis: Analysis, readSource: (file: string) => string | null = () => null): string {
  const { graph } = analysis;
  const lines = [`# ${node.label.replace(/\n.*/s, "")}`, ""];
  const where = position(node);

  if (where) lines.push(`${node.kind} — ${where}`, "");

  if (node.signature) lines.push("```ts", node.signature, "```", "");

  if (node.doc) lines.push(node.doc, "");

  if (node.kind === "hole") lines.push(`Not followed: ${node.reason ?? "unknown"}.`, "");
  const id = standsFor(node);

  if (node.kind === "fn") {
    lines.push(...beyondSection(node));
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

    const operations = graph.apiCalls.filter((call) => call.from === id);

    if (operations.length > 0) {
      lines.push("## Operations of external APIs", "");

      for (const call of operations) lines.push(`- ${API_SHORT[call.api]} \`${call.family}.${call.operation}\` — line ${call.line}`);
      lines.push("");
    }

    const gaps = graph.gaps.filter((gap) => gap.from === id && gap.reason !== "api");

    if (gaps.length > 0) {
      lines.push("## Not followed", "");

      for (const gap of gaps) lines.push(`- \`${gap.callee}\` — ${gap.reason} (line ${gap.line})`);
      lines.push("");
    }
  }

  // A family or an operation of an external API: what it is, and who calls it.
  const api = node.kind === "external" ? parseApiId(node.id) : null;

  if (api) {
    const calls = graph.apiCalls.filter((call) => call.api === api.api && call.family === api.family && (api.operation === null || call.operation === api.operation));

    lines.push(api.operation === null ? `Family ${api.family} of the ${API_LABELS[api.api]}: ${counted(new Set(calls.map((call) => call.operation)).size, "operation")} called.` : `Operation ${api.operation} of ${api.family}, ${API_LABELS[api.api]}.`, "");

    if (calls.length > 0) {
      lines.push("## Called by", "");

      for (const call of calls) lines.push(`- ${call.from}${api.operation === null ? ` — ${call.operation}` : ""} — ${moduleOf(call.from)}:${call.line}`);
      lines.push("");
    }
  }

  if (node.kind === "module") {
    const module = graph.modules.get(id);

    if (module) {
      lines.push(`Layer ${module.layer}, ${module.lines} lines.`, "", ...beyondSection(node));

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

        for (const dep of imports) lines.push(`- ${dep.to}${dep.typeOnly ? " (types only)" : ""}${dep.url ? " (loaded by URL)" : ""}${dep.reexport ? " (re-exported)" : ""} — line ${dep.line}`);
        lines.push("");
      }

      if (importers.length > 0) {
        lines.push("## Imported by", "");

        for (const dep of importers) lines.push(`- ${dep.from}${dep.typeOnly ? " (types only)" : ""}${dep.url ? " (loaded by URL)" : ""} — line ${dep.line}`);
        lines.push("");
      }
    }
  }

  if (node.kind === "layer") {
    const members = [...graph.modules.values()].filter((module) => module.layer === id).map((module) => module.id);
    lines.push(`${counted(members.length, "module")}.`, "", "## Modules", "");

    for (const member of members) lines.push(`- ${member}`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** The modules a shape stands for: a module itself, a layer's modules, a folded directory's, a function's own module; none for an external. */
function modulesBehind(node: Shape, analysis: Analysis): string[] {
  const { graph } = analysis;
  const id = standsFor(node);

  if (node.kind === "layer") return [...graph.modules.values()].filter((module) => module.layer === node.id).map((module) => module.id);

  // A folded tail and a package stand for the modules of the view they open: a directory's, or one module's.
  if (node.kind === "more" || node.kind === "package") {
    const view = node.opens === undefined ? null : parseView(node.opens);

    if (view?.kind === "dir") return [...graph.modules.keys()].filter((module) => module.startsWith(`${view.subject}/`));

    return view?.kind === "module" ? [view.subject] : [];
  }

  if (node.kind === "external" || node.kind === "hole" || node.kind === "start" || node.kind === "event") return [];

  return [moduleOf(id)];
}

/** The label of a shape for prose: its first line. */
function nameOf(node: Shape): string {
  return node.label.split("\n")[0]!;
}

/**
 * The page of a line: what it joins, what it stands for and every import or
 * call behind it with its `file:line`, so a tap on an arrow says where it
 * leads and why it is there.
 */
export function edgeMarkdown(edge: Line, diagram: Diagram, analysis: Analysis): string {
  const { graph } = analysis;
  const from = diagram.nodes.find((node) => node.id === edge.from);
  const to = diagram.nodes.find((node) => node.id === edge.to);

  if (!from || !to) return `# ${edge.from} → ${edge.to}\n\nThe line's ends are not in this view.\n`;
  const lines = [`# ${nameOf(from)} → ${nameOf(to)}`, ""];
  const what = edge.kind === "dependency" ? (edge.loads ? "loads by URL (a worker, a child process, a hook)" : "imports") : edge.kind === "call" ? "calls" : edge.kind === "ref" ? "passes as a value (may call)" : edge.kind === "message" ? `message${edge.label ? ` ${edge.label}` : ""}` : "lifeline";
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

    for (const dep of imports.slice(0, 60)) lines.push(`- \`${dep.from}:${dep.line}\` → ${dep.to}${dep.typeOnly ? " (types only)" : ""}${dep.url ? " (loaded by URL)" : ""}${dep.reexport ? " (re-export)" : ""}`);

    if (imports.length > 60) lines.push(`- … ${imports.length - 60} more`);
    lines.push("");
  }

  // Calls behind the line: between the two functions, or between the modules behind the two shapes.
  const fromId = standsFor(from);
  const toId = standsFor(to);
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

/** The words of a file's status in a commit, as `git show --name-status` gives it. */
const FILE_STATUS: Readonly<Record<string, string>> = { A: "added", M: "modified", D: "deleted", T: "type changed" };

/** The page of one commit (a shape of the branches or the timeline): who made it and when, its message, the files it touched. */
export function commitMarkdown(commit: CommitInfo, files: readonly { status: string; path: string }[]): string {
  const lines = [`# ${commit.short} ${commit.subject}`, "", `${commit.author}, ${commit.date} · \`${commit.sha}\``, ""];

  if (commit.body) lines.push(commit.body, "");
  lines.push(`## Files (${files.length})`, "");

  for (const file of files) lines.push(`- ${FILE_STATUS[file.status] ?? file.status} ${file.path}`);
  lines.push("", `A second tap opens what it did to the architecture (\`commit:${commit.short}\`).`);

  return `${lines.join("\n")}\n`;
}
