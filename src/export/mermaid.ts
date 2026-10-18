// A Diagram as a Mermaid flowchart: lanes as subgraphs, shapes by kind,
// imports as solid arrows, calls as thick ones, references dotted; the
// marks of a diff as classes. Text only, byte-stable for the same diagram,
// so it pastes into a pull request comment or a Markdown file. A type asked
// for that does not fit the picture (a gitGraph of no timeline, a state
// diagram of no machine) is not drawn empty: the picture is written as its
// own type, with a comment saying why.
//
// Entry points: `toMermaid`, `mermaidStyleFor`, `mermaidMismatch`,
// `MERMAID_STYLES`.

import type { Diagram, Line, Shape } from "../diagram.ts";

/** A Mermaid-safe node ID: letters, digits and underscores, unique per diagram. */
function mermaidIds(nodes: readonly Shape[]): Map<string, string> {
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

/** A label as Mermaid quotes it; an empty one is a space, since Mermaid refuses `[""]` (an empty cell, a machine's start). */
function label(text: string): string {
  return text === "" ? '" "' : `"${text.replace(/"/g, "#quot;").replace(/\n/g, "<br/>")}"`;
}

function shape(node: Shape, id: string): string {
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
    case "participant":
    case "cell":
      return `${id}[${text}]`;
    case "package":
      return `${id}[[${text}]]`;
    case "anchor":
      return `${id}(( ))`;
    case "event":
      return `${id}((${text}))`;
    case "class":
      return `${id}[${label(node.label.split("\n")[0] ?? node.label)}]`;
    case "state":
    case "machine":
      return `${id}([${text}])`;
    case "fragment":
      return `${id}[${text}]`;
    case "decision":
      return node.label.startsWith("↻ ") ? `${id}{{${text}}}` : `${id}{${text}}`;
    case "action":
      return `${id}[${text}]`;
    case "end":
      return `${id}([${text}])`;
  }
}

/** The revision line of an export, when the diagram carries one. */
function stampLines(diagram: Diagram): string[] {
  return diagram.stamp ? [`%% commit ${diagram.stamp.commit} (${diagram.stamp.date})`] : [];
}

/** A sequence view as Mermaid's own sequenceDiagram: participants in order, one message per call. */
function sequenceMermaid(diagram: Diagram): string {
  const sequence = diagram.sequence!;
  const ids = new Map(sequence.participants.map((module, i) => [module, `P${i}`]));
  const lines = [`%% archdiff:generated — view ${diagram.view}`, ...stampLines(diagram)];

  if (diagram.reason) lines.push(`%% ${diagram.reason}`);
  lines.push("sequenceDiagram");

  for (const module of sequence.participants) lines.push(`  participant ${ids.get(module)} as ${module.replace(/[:;]/g, " ")}`);

  const fragments = sequence.fragments ?? [];

  for (const [i, message] of sequence.messages.entries()) {
    // A fragment opens before its first message (opt or loop, labelled) and closes after its last; outer ones first.
    for (const fragment of fragments) if (fragment.first === i) lines.push(`  ${"  ".repeat(fragment.level)}${fragment.kind} ${fragment.label.replace(/[:;]/g, " ")}`);
    lines.push(`  ${ids.get(message.from)}->>${ids.get(message.to)}: ${i + 1}. ${message.label}()${(message.times ?? 1) > 1 ? ` ×${message.times}` : ""}`);

    for (const fragment of [...fragments].reverse()) if (fragment.last === i) lines.push(`  ${"  ".repeat(fragment.level)}end`);
  }

  return `${lines.join("\n")}\n`;
}

/** A machine view as Mermaid's stateDiagram-v2: the start mark to the initial state, every transition labelled with its event or function. */
function stateMermaid(diagram: Diagram): string {
  const machine = diagram.machine!;
  const ids = new Map<string, string>();
  const taken = new Set<string>();

  for (const name of [...machine.states.map((state) => state.name), "*"]) {
    const base = `s_${name.replace(/[^A-Za-z0-9_]/g, "_")}` || "s_any";
    let candidate = name === "*" ? "s_any" : base;

    for (let n = 2; taken.has(candidate); n++) candidate = `${base}_${n}`;
    taken.add(candidate);
    ids.set(name, candidate);
  }

  const lines = [`%% archdiff:generated — view ${diagram.view}`, ...stampLines(diagram)];

  if (diagram.reason) lines.push(`%% ${diagram.reason}`);
  lines.push("stateDiagram-v2");

  for (const state of machine.states) lines.push(`  state "${state.name.replace(/"/g, "'")}${state.assigned ? "" : " (never set)"}" as ${ids.get(state.name)}`);

  // The pseudo-state of the transitions from any state, by the ID it was given (a state named "any" may hold `s_any`).
  if (machine.transitions.some((transition) => transition.from === "*")) lines.push(`  state "any state" as ${ids.get("*")}`);

  if (machine.initial !== null) lines.push(`  [*] --> ${ids.get(machine.initial)}`);

  for (const transition of machine.transitions) lines.push(`  ${ids.get(transition.from)} --> ${ids.get(transition.to)}${transition.event ?? transition.fn ? `: ${(transition.event ?? transition.fn ?? "").replace(/[:;]/g, " ")}` : ""}`);

  return `${lines.join("\n")}\n`;
}

/** A class view as Mermaid's classDiagram: a box per class with its fields and methods; inheritance and realisation arrows, an association for a field's class (`has`), a dependency for the calls between classes (`uses`). */
function classMermaid(diagram: Diagram): string {
  const classes = diagram.classes!;
  const ids = mermaidIds(diagram.nodes);
  const lines = [`%% archdiff:generated — view ${diagram.view}`, ...stampLines(diagram)];

  if (diagram.reason) lines.push(`%% ${diagram.reason}`);
  lines.push("classDiagram");

  for (const box of classes.boxes) {
    const id = ids.get(box.id) ?? box.name;
    lines.push(`  class ${id}["${box.name.replace(/"/g, "'")}"] {`);

    if (box.kind !== "class") lines.push(`    <<${box.kind}>>`);

    for (const field of box.fields) lines.push(`    ${field.replace(/[{}]/g, "")}`);

    for (const method of box.methods) lines.push(`    ${method.replace(/[{}]/g, "").replace(/→/g, "returns")}`);
    lines.push("  }");
  }

  for (const relation of classes.relations) {
    const from = ids.get(relation.from);
    const to = ids.get(relation.to);

    if (!from || !to) continue;

    if (relation.kind === "extends") lines.push(`  ${to} <|-- ${from}`);
    else if (relation.kind === "implements") lines.push(`  ${to} <|.. ${from}`);
    else lines.push(relation.kind === "has" ? `  ${from} --> ${to} : has` : `  ${from} ..> ${to} : uses`);
  }

  return `${lines.join("\n")}\n`;
}

import { MERMAID_ONLY_FOR, type MermaidStyle } from "../options.ts";
import { parseView } from "../view-keys.ts";

export { MERMAID_STYLES, type MermaidStyle } from "../options.ts";

function c4Mermaid(diagram: Diagram): string {
  const ids = mermaidIds(diagram.nodes);
  const lines = [`%% archdiff:generated — view ${diagram.view}`, ...stampLines(diagram), "C4Context", `  title ${diagram.title.replace(/\n/g, " ")}`];
  const byGroup = new Map<string | undefined, Shape[]>();

  for (const node of diagram.nodes) byGroup.set(node.group, [...(byGroup.get(node.group) ?? []), node]);

  const container = (node: Shape, indent: string): string => {
    const id = ids.get(node.id)!;
    const name = node.label.split("\n")[0]!.replace(/"/g, "'");
    const tech = node.kind === "external" ? "package" : node.kind;
    const description = node.count !== undefined ? `${node.count} ${node.kind === "layer" ? "modules" : "inside"}` : "";

    return node.kind === "external" ? `${indent}System_Ext(${id}, "${name}", "${description}")` : `${indent}Container(${id}, "${name}", "${tech}", "${description}")`;
  };

  for (const group of diagram.groups) {
    const members = byGroup.get(group.id);

    if (!members) continue;
    lines.push(`  System_Boundary(${ids.get(group.id) ?? group.id.replace(/[^A-Za-z0-9_]/g, "_")}, "${group.label}") {`, ...members.map((node) => container(node, "    ")), "  }");
  }

  for (const node of diagram.nodes) if (node.group === undefined || !diagram.groups.some((group) => group.id === node.group)) lines.push(container(node, "  "));

  for (const edge of diagram.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);

    if (from && to) lines.push(`  Rel(${from}, ${to}, "${(edge.label ?? edge.kind).replace(/"/g, "'")}")`);
  }

  return `${lines.join("\n")}\n`;
}

/** The metrics as a quadrant chart: instability across, abstractness up; the main sequence runs from top left to bottom right. */
function metricsQuadrant(diagram: Diagram): string {
  // An axis's words are quoted: Mermaid reads a bare parenthesis as syntax.
  const lines = [`%% archdiff:generated — view ${diagram.view}`, ...stampLines(diagram), "quadrantChart", `  title ${diagram.title.replace(/\n/g, " ")}`, '  x-axis "stable (depended upon)" --> "unstable (depends on others)"', "  y-axis concrete --> abstract", "  quadrant-1 zone of uselessness", "  quadrant-2 main sequence", "  quadrant-3 zone of pain", "  quadrant-4 main sequence"];

  for (const row of diagram.metrics!.modules.slice(0, 60)) lines.push(`  "${row.id.replace(/"/g, "'")}": [${(0.03 + 0.94 * row.instability).toFixed(2)}, ${(0.03 + 0.94 * row.abstractness).toFixed(2)}]`);

  return `${lines.join("\n")}\n`;
}

/** Hotspots as a quadrant chart: lines across, calls in up; the big and called sit top right. */
function quadrantMermaid(diagram: Diagram): string {
  if (diagram.metrics) return metricsQuadrant(diagram);
  const lines = [`%% archdiff:generated — view ${diagram.view}`, ...stampLines(diagram), "quadrantChart", `  title ${diagram.title.replace(/\n/g, " ")}`, "  x-axis small --> large", "  y-axis few calls in --> many calls in", "  quadrant-1 big and central", "  quadrant-2 small but central", "  quadrant-3 small and quiet", "  quadrant-4 big but quiet"];
  const sizes = diagram.nodes.map((node) => node.w);
  const maxSize = Math.max(1, ...sizes);
  const minSize = Math.min(...sizes, maxSize);

  for (const node of diagram.nodes.slice(0, 60)) {
    const x = maxSize === minSize ? 0.5 : (node.w - minSize) / (maxSize - minSize);
    const y = node.heat ?? 0;
    lines.push(`  "${node.label.split("\n")[0]!.replace(/"/g, "'")}": [${(0.05 + 0.9 * x).toFixed(2)}, ${(0.05 + 0.9 * y).toFixed(2)}]`);
  }

  return `${lines.join("\n")}\n`;
}

/** The layers (or any lanes) as a pie of their module counts. */
function pieMermaid(diagram: Diagram): string {
  const lines = [`%% archdiff:generated — view ${diagram.view}`, ...stampLines(diagram), "pie showData", `  title ${diagram.title.replace(/\n/g, " ")}`];
  const counted = diagram.nodes.filter((node) => node.count !== undefined);

  for (const node of counted.length > 0 ? counted : diagram.nodes) lines.push(`  "${node.label.split("\n")[0]!.replace(/"/g, "'")}" : ${node.count ?? 1}`);

  return `${lines.join("\n")}\n`;
}

/**
 * The branches as a gitGraph: the base's commits in order, each branch opened where its first commit leaves from —
 * a commit of the base, of the branch it was started on, or the base's earlier commits — its commits after it.
 */
function branchesGitgraph(diagram: Diagram): string {
  const base = diagram.groups[0]?.id ?? "main";
  // `mainBranchName`: the base is the graph's first branch, whatever its name.
  const lines = [`%% archdiff:generated — view ${diagram.view}`, ...stampLines(diagram), `%%{init: { "gitGraph": { "mainBranchName": "${base}" } } }%%`, "gitGraph"];
  const inLane = (lane: string): Shape[] => diagram.nodes.filter((node) => node.group === lane).sort((a, b) => a.x - b.x);
  // The lane each branch leaves from, by the shape its first line comes out of.
  const leaves = new Map<string, string[]>();

  for (const lane of diagram.groups.slice(1)) {
    const first = inLane(lane.id)[0];
    const from = first ? diagram.edges.find((edge) => edge.to === first.id)?.from : undefined;

    if (from) leaves.set(from, [...(leaves.get(from) ?? []), lane.id]);
  }

  const commit = (node: Shape): string => (node.kind === "more" ? `  commit id: "${node.label.replace(/"/g, "'")} (${node.group})" type: HIGHLIGHT` : `  commit id: "${node.label.split("\n").slice(0, 2).join(" ").replace(/"/g, "'")}"`);
  // A lane's commits, and after each one the branches that leave from it, each checked out and closed again.
  const walk = (lane: string): void => {
    for (const node of inLane(lane)) {
      lines.push(commit(node));

      for (const branch of leaves.get(node.id) ?? []) {
        lines.push(`  branch ${JSON.stringify(branch)}`, `  checkout ${JSON.stringify(branch)}`);
        walk(branch);
        lines.push(`  checkout ${JSON.stringify(lane)}`);
      }
    }
  };

  walk(base);

  return `${lines.join("\n")}\n`;
}

/** The timeline as a gitGraph: one commit per bar, tagged with the couplings it added or removed. */
function gitgraphMermaid(diagram: Diagram): string {
  if (diagram.view === "branches") return branchesGitgraph(diagram);
  // The reason first (a range of no commit says so, not an empty graph alone).
  const lines = [`%% archdiff:generated — view ${diagram.view}`, ...stampLines(diagram), ...(diagram.reason ? [`%% ${diagram.reason}`] : []), "gitGraph"];

  for (const node of diagram.nodes.filter((candidate) => candidate.id.startsWith("commit:"))) {
    const [head, subject] = node.label.split("\n");
    const bar = diagram.nodes.find((candidate) => candidate.id === `bar:${node.id.slice(7)}`);
    const tag = bar?.diff === "removed" ? "coupling added" : bar?.diff === "added" ? "coupling removed" : null;
    lines.push(`  commit id: "${(head ?? node.id).split(" ")[0]} ${(subject ?? "").replace(/"/g, "'")}"${tag ? ` tag: "${tag}"` : ""}${bar?.diff === "removed" ? " type: REVERSE" : ""}`);
  }

  return `${lines.join("\n")}\n`;
}

/** The shapes as a mindmap under their lanes: a directory or layer tree at a glance. */
function mindmapMermaid(diagram: Diagram): string {
  // Every node by an ID with its text quoted: a bare `[slug]` or `{ type }` in a path or a statement is a mindmap shape.
  let next = 0;
  const node = (text: string): string => `n${next++}["${text === "" ? " " : text.replace(/"/g, "'")}"]`;
  const lines = [`%% archdiff:generated — view ${diagram.view}`, ...stampLines(diagram), "mindmap", `  root(("${diagram.title.split("\n")[0]!.replace(/"/g, "'")}"))`];
  const byGroup = new Map<string | undefined, Shape[]>();

  for (const shape of diagram.nodes) byGroup.set(shape.group, [...(byGroup.get(shape.group) ?? []), shape]);

  for (const [group, members] of byGroup) {
    if (group !== undefined) lines.push(`    ${node(group)}`);

    for (const member of members) lines.push(`${group !== undefined ? "      " : "    "}${node(member.label.split("\n")[0]!)}`);
  }

  return `${lines.join("\n")}\n`;
}

/** The Mermaid type that suits a view best when `auto`: a sequence or class view has its own; the timeline is a gitGraph; the rest a flowchart. */
export function mermaidStyleFor(diagram: Diagram, style: MermaidStyle): Exclude<MermaidStyle, "auto"> {
  if (style !== "auto") return style;

  if (diagram.view === "timeline" || diagram.view === "branches") return "gitgraph";

  if (diagram.metrics) return "quadrant";

  if (diagram.machine) return "state";

  return "flowchart";
}

/** Why a Mermaid type asked for does not fit a picture, or null when it does: a gitGraph draws the commits of the timeline, a state diagram a machine. */
export function mermaidMismatch(diagram: Diagram, style: MermaidStyle): string | null {
  const only = MERMAID_ONLY_FOR[style];

  return only && !only.kinds.includes(parseView(diagram.view)?.kind ?? "") ? `${style} draws ${only.what}` : null;
}

/** The text with a Mermaid comment after its first line (the generated mark). */
function withNote(text: string, note: string): string {
  const at = text.indexOf("\n");

  return `${text.slice(0, at + 1)}%% ${note}\n${text.slice(at + 1)}`;
}

export function toMermaid(diagram: Diagram, style: MermaidStyle = "auto"): string {
  const mismatch = mermaidMismatch(diagram, style);

  if (mismatch) return withNote(toMermaid(diagram, "auto"), `--mermaid ${style}: ${mismatch}, so the picture is written as its own type`);

  // A flowchart asked for is a flowchart, whatever type the view has of its own.
  if (style === "flowchart") return flowchartMermaid(diagram);

  if (diagram.sequence) return sequenceMermaid(diagram);

  if (diagram.classes) return classMermaid(diagram);

  if (diagram.machine) return stateMermaid(diagram);
  const chosen = mermaidStyleFor(diagram, style);

  if (chosen === "c4") return c4Mermaid(diagram);

  if (chosen === "quadrant") return quadrantMermaid(diagram);

  if (chosen === "pie") return pieMermaid(diagram);

  if (chosen === "gitgraph") return gitgraphMermaid(diagram);

  if (chosen === "mindmap") return mindmapMermaid(diagram);

  return flowchartMermaid(diagram);
}

/** The picture as a flowchart: lanes as subgraphs, shapes by kind, the lines by kind, the marks as classes. */
/** How a marked line is drawn: the colours of the marked shapes' classes. */
const LINK_STYLES: Record<NonNullable<Line["diff"]>, string> = {
  added: "stroke:#2e7d32,stroke-width:3px",
  removed: "stroke:#c62828,stroke-width:3px",
  changed: "stroke:#ef6c00,stroke-width:3px",
  warning: "stroke:#ef6c00,stroke-width:3px",
  planned: "stroke:#1565c0,stroke-width:3px",
};

function flowchartMermaid(diagram: Diagram): string {
  // The feet of a sequence's lifelines and its frames are no shapes of a flowchart; its participants and messages are.
  const nodes = diagram.nodes.filter((node) => node.kind !== "anchor" && node.kind !== "fragment");
  const ids = mermaidIds(nodes);
  const lines = [`%% archdiff:generated — view ${diagram.view}`, ...stampLines(diagram)];

  if (diagram.reason) lines.push(`%% ${diagram.reason}`);
  // A function's logic reads top down, as flowcharts do; the rest left to right, as the canvas draws them.
  lines.push(`flowchart ${diagram.direction === "down" || diagram.logic ? "TB" : "LR"}`);
  const byGroup = new Map<string | undefined, Shape[]>();

  for (const node of nodes) byGroup.set(node.group, [...(byGroup.get(node.group) ?? []), node]);

  for (const group of diagram.groups) {
    const members = byGroup.get(group.id);

    if (!members) continue;
    lines.push(`  subgraph ${label(group.label)}`);

    for (const node of members) lines.push(`    ${shape(node, ids.get(node.id)!)}`);
    lines.push("  end");
  }

  for (const node of nodes) if (node.group === undefined || !diagram.groups.some((group) => group.id === node.group)) lines.push(`  ${shape(node, ids.get(node.id)!)}`);

  // The marked lines by their place among the links written: `linkStyle` colours a link by its index.
  const markedLinks = new Map<NonNullable<Line["diff"]>, number[]>();
  let link = 0;

  for (const edge of diagram.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);

    if (!from || !to || edge.kind === "lifeline") continue;
    const arrow = edge.kind === "ref" || edge.typeOnly || edge.diff === "removed" ? "-.->" : edge.kind === "call" || edge.kind === "message" ? "==>" : "-->";
    const text = edge.label ? `|${label(edge.label)}|` : "";
    lines.push(`  ${from} ${arrow}${text} ${to}`);

    if (edge.diff) markedLinks.set(edge.diff, [...(markedLinks.get(edge.diff) ?? []), link]);
    link++;
  }

  for (const [mark, links] of markedLinks) lines.push(`  linkStyle ${links.join(",")} ${LINK_STYLES[mark]}`);

  const marked = nodes.filter((node) => node.diff);

  if (marked.length > 0) {
    lines.push("  classDef added stroke:#2e7d32,stroke-width:3px", "  classDef removed stroke:#c62828,stroke-width:3px,stroke-dasharray:5 5", "  classDef changed stroke:#ef6c00,stroke-width:3px", "  classDef warning stroke:#ef6c00,stroke-width:3px", "  classDef planned stroke:#1565c0,stroke-width:3px,stroke-dasharray:5 5");

    for (const mark of ["added", "removed", "changed", "warning", "planned"] as const) {
      const members = marked.filter((node) => node.diff === mark).map((node) => ids.get(node.id)!);

      if (members.length > 0) lines.push(`  class ${members.join(",")} ${mark}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
