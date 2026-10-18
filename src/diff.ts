// The architectural diff of a change, as a pure function of two graphs:
// the modules, functions, imports and calls added, removed or changed (by
// fingerprint or signature), the layer dependencies that appeared, marked
// against the contract (ARCHITECTURE.md); the pictures of a review and of a
// comparison of several heads; the review's marks laid over any picture;
// and the Markdown of a review, a comparison and a history. The analyses
// of the base and the heads are read by review.ts, at the edge.
//
// Pipeline: two graphs → GraphDiff → Diagram + Markdown. Entry points:
// `graphDiff`, `diffDiagram`, `compareDiagram`, `markContract`,
// `reviewFindings`, `reviewMarkdown`, `comparisonMarkdown`,
// `historyMarkdown`, `overlayDiff`, `onlyChanged`.

import type { Commit } from "./git.ts";
import type { Diagram, Line, Shape, DiffMark, PictureContent } from "./diagram.ts";
import { toMermaid } from "./export/mermaid.ts";
import { moduleOf, type Graph, type Declaration } from "./graph.ts";
import { allowedLayerPairs, type Intent } from "./intent.ts";
import { standsFor } from "./shape-keys.ts";
import { counted } from "./words.ts";

export interface NodeChange {
  id: string;
  kind: Declaration["kind"];
  module: string;
  line: number;
  /** `changed`: what differs. */
  what?: ("body" | "signature" | "exported")[];
}

export interface EdgeChange {
  /** A layer dependency the contract (ARCHITECTURE.md) does not allow; absent without a contract, or when it allows it. */
  against?: true;
  from: string;
  to: string;
}

export interface GraphDiff {
  base: string;
  changedFiles: string[];
  modulesAdded: string[];
  modulesRemoved: string[];
  nodesAdded: NodeChange[];
  nodesRemoved: NodeChange[];
  nodesChanged: NodeChange[];
  depsAdded: EdgeChange[];
  depsRemoved: EdgeChange[];
  callsAdded: EdgeChange[];
  callsRemoved: EdgeChange[];
  /** Layer → layer imports the base did not have: a new coupling between layers. */
  layerEdgesAdded: EdgeChange[];
  layerEdgesRemoved: EdgeChange[];
  externalsAdded: string[];
  externalsRemoved: string[];
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function edgeOf(key: string): EdgeChange {
  const [from, to] = key.split("\u0000") as [string, string];

  return { from, to };
}

function nodeChange(node: Declaration): NodeChange {
  return { id: node.id, kind: node.kind, module: node.module, line: node.line };
}

/** The layer → layer imports of a graph (runtime ones), as keys. */
function layerEdges(graph: Graph): Set<string> {
  const keys = new Set<string>();

  for (const dep of graph.deps) {
    const from = graph.modules.get(dep.from)?.layer;
    const to = graph.modules.get(dep.to)?.layer;

    if (from && to && from !== to && !dep.typeOnly) keys.add(edgeKey(from, to));
  }

  return keys;
}

/** What differs between two graphs, sorted by ID. */
export function graphDiff(base: Graph, head: Graph, baseRef: string, changed: readonly string[]): GraphDiff {
  const sortIds = (ids: Iterable<string>): string[] => [...ids].sort();
  const sortEdges = (keys: Iterable<string>): EdgeChange[] => sortIds(keys).map(edgeOf);
  const modulesAdded = sortIds([...head.modules.keys()].filter((id) => !base.modules.has(id)));
  const modulesRemoved = sortIds([...base.modules.keys()].filter((id) => !head.modules.has(id)));
  const nodesAdded: NodeChange[] = [];
  const nodesChanged: NodeChange[] = [];

  for (const node of head.nodes.values()) {
    const before = base.nodes.get(node.id);

    if (!before) {
      nodesAdded.push(nodeChange(node));
      continue;
    }

    const what: NonNullable<NodeChange["what"]> = [];

    if (before.fingerprint !== node.fingerprint) what.push("body");

    if (before.signature !== node.signature) what.push("signature");

    if (before.exported !== node.exported) what.push("exported");

    if (what.length > 0) nodesChanged.push({ ...nodeChange(node), what });
  }

  const nodesRemoved = [...base.nodes.values()].filter((node) => !head.nodes.has(node.id)).map(nodeChange);
  const byId = (a: NodeChange, b: NodeChange): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const depKeys = (graph: Graph): Set<string> => new Set(graph.deps.filter((dep) => !dep.typeOnly).map((dep) => edgeKey(dep.from, dep.to)));
  const callKeys = (graph: Graph): Set<string> => new Set(graph.calls.map((call) => edgeKey(call.from, call.to)));
  const baseDeps = depKeys(base);
  const headDeps = depKeys(head);
  const baseCalls = callKeys(base);
  const headCalls = callKeys(head);
  const baseLayers = layerEdges(base);
  const headLayers = layerEdges(head);

  return {
    base: baseRef,
    changedFiles: sortIds(changed),
    modulesAdded,
    modulesRemoved,
    nodesAdded: nodesAdded.sort(byId),
    nodesRemoved: nodesRemoved.sort(byId),
    nodesChanged: nodesChanged.sort(byId),
    depsAdded: sortEdges([...headDeps].filter((key) => !baseDeps.has(key))),
    depsRemoved: sortEdges([...baseDeps].filter((key) => !headDeps.has(key))),
    callsAdded: sortEdges([...headCalls].filter((key) => !baseCalls.has(key))),
    callsRemoved: sortEdges([...baseCalls].filter((key) => !headCalls.has(key))),
    layerEdgesAdded: sortEdges([...headLayers].filter((key) => !baseLayers.has(key))),
    layerEdgesRemoved: sortEdges([...baseLayers].filter((key) => !headLayers.has(key))),
    externalsAdded: sortIds([...head.externals.keys()].filter((id) => !base.externals.has(id))),
    externalsRemoved: sortIds([...base.externals.keys()].filter((id) => !head.externals.has(id))),
  };
}

/**
 * The picture of a diff at module level: the modules added, removed or
 * with a changed function, the modules they import or are imported by
 * where that import changed, and the imports themselves marked. The
 * marked shapes come first, so a big change folds its context, not its
 * news.
 */
export function diffDiagram(diff: GraphDiff, base: Graph, head: Graph): PictureContent {
  const marks = new Map<string, Shape["diff"]>();

  for (const id of diff.modulesAdded) marks.set(id, "added");

  for (const id of diff.modulesRemoved) marks.set(id, "removed");

  for (const change of [...diff.nodesChanged, ...diff.nodesAdded, ...diff.nodesRemoved]) if (!marks.has(change.module)) marks.set(change.module, "changed");
  const edges: Line[] = [];
  const touched = new Set(marks.keys());

  for (const dep of diff.depsAdded) {
    edges.push({ from: dep.from, to: dep.to, kind: "dependency", diff: "added" });
    touched.add(dep.from);
    touched.add(dep.to);
  }

  for (const dep of diff.depsRemoved) {
    edges.push({ from: dep.from, to: dep.to, kind: "dependency", diff: "removed" });
    touched.add(dep.from);
    touched.add(dep.to);
  }

  // Unchanged imports between touched modules, as context.
  const seen = new Set(edges.map((edge) => edgeKey(edge.from, edge.to)));

  for (const dep of head.deps) {
    if (dep.typeOnly || !touched.has(dep.from) || !touched.has(dep.to) || seen.has(edgeKey(dep.from, dep.to))) continue;
    seen.add(edgeKey(dep.from, dep.to));
    edges.push({ from: dep.from, to: dep.to, kind: "dependency" });
  }

  const nodes: Shape[] = [];

  for (const id of [...touched].sort()) {
    const module = head.modules.get(id) ?? base.modules.get(id);
    const external = head.externals.get(id) ?? base.externals.get(id);

    if (module) {
      const node: Shape = { id, kind: "module", label: id, ref: { id, file: id, line: 1 }, group: module.layer, x: 0, y: 0, w: 0, h: 0 };
      const mark = marks.get(id);

      if (mark) node.diff = mark;
      nodes.push(node);
    } else if (external) {
      const node: Shape = { id, kind: "external", label: external.kind === "builtin" ? external.id : external.name, x: 0, y: 0, w: 0, h: 0 };

      if (diff.externalsAdded.includes(id)) node.diff = "added";
      else if (diff.externalsRemoved.includes(id)) node.diff = "removed";
      nodes.push(node);
    }
  }

  nodes.sort((a, b) => Number(b.diff !== undefined) - Number(a.diff !== undefined));
  const layers = [...new Set([...head.layers, ...base.layers])].sort();
  const used = new Set(nodes.map((node) => node.group));
  const groups = layers.filter((layer) => used.has(layer)).map((layer) => ({ id: layer, label: layer, kind: "lane" as const, x: 0, y: 0, w: 0, h: 0 }));
  const picture: PictureContent = { title: `Changes since ${shortCommits(diff.base)}`, nodes, edges, groups };

  if (nodes.length === 0) picture.reason = "no module, function, import or call changed";

  return picture;
}

/** The new layer dependencies the contract forbids, marked; a diff without a contract is left as it is. */
export function markContract(diff: GraphDiff, intent: Intent | null, graph: Graph): GraphDiff {
  if (!intent) return diff;
  const { layers, allowed } = allowedLayerPairs(intent, graph);

  return { ...diff, layerEdgesAdded: diff.layerEdgesAdded.map((edge) => (layers.has(edge.from) && layers.has(edge.to) && !allowed.has(`${edge.from}\u0000${edge.to}`) ? { ...edge, against: true } : edge)) };
}

/** The findings of a review: with a contract, the new layer dependencies it forbids; without one, every new layer dependency. */
export function reviewFindings(diff: GraphDiff, contract: boolean): EdgeChange[] {
  return contract ? diff.layerEdgesAdded.filter((edge) => edge.against) : diff.layerEdgesAdded;
}

/** How the architecture moved at one commit of a range. */
export interface HistoryRow {
  commit: Commit;
  modulesAdded: number;
  modulesRemoved: number;
  fnsChanged: number;
  depsAdded: number;
  depsRemoved: number;
  layerEdgesAdded: { from: string; to: string }[];
  layerEdgesRemoved: { from: string; to: string }[];
  externalsAdded: string[];
}

/** The history as a Markdown table: one row per commit, the layer couplings it added or removed named. */
export function historyMarkdown(rows: HistoryRow[], base: string, head: string): string {
  const lines = [`<!-- archdiff:generated — history ${base}..${head} -->`, `# Architecture drift from ${base} to ${head}`, ""];

  if (rows.length === 0) {
    lines.push("_no commits in the range_");

    return `${lines.join("\n")}\n`;
  }

  lines.push("| commit | date | author | modules | functions | imports | layer couplings | packages |", "| --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const row of rows) {
    const couplings = [...row.layerEdgesAdded.map((edge) => `+${edge.from}→${edge.to}`), ...row.layerEdgesRemoved.map((edge) => `−${edge.from}→${edge.to}`)].join(" ") || "";
    lines.push(`| \`${row.commit.short}\` ${row.commit.subject.replace(/\|/g, "\\|")} | ${row.commit.date} | ${row.commit.author} | +${row.modulesAdded} −${row.modulesRemoved} | ~${row.fnsChanged} | +${row.depsAdded} −${row.depsRemoved} | ${couplings} | ${row.externalsAdded.map((id) => id.replace(/^pkg:/, "")).join(", ")} |`);
  }

  return `${lines.join("\n")}\n`;
}

function fnLabel(change: NodeChange): string {
  return `${change.kind} \`${change.id.slice(change.module.length + 1)}\` — ${change.module}:${change.line}`;
}

/**
 * The review as Markdown: the summary, the Mermaid picture, every change by kind; `contract`: the head has
 * ARCHITECTURE.md. A commit's own change (`commit`) is headed by the commit, not by its base.
 */
export function reviewMarkdown(diff: GraphDiff, diagram: Diagram, contract: boolean, commit: { short: string; subject: string } | null = null): string {
  const lines = commit ? [`<!-- archdiff:generated — commit ${commit.short} -->`, `# Architecture changes of commit ${commit.short}: ${commit.subject}`, ""] : [`<!-- archdiff:generated — review since ${shortCommits(diff.base)} -->`, `# Architecture changes since ${shortCommits(diff.base)}`, ""];
  const counts = [
    `${diff.changedFiles.length === 1 ? "1 source file" : `${diff.changedFiles.length} source files`} changed`,
    `modules +${diff.modulesAdded.length} −${diff.modulesRemoved.length}`,
    `functions +${diff.nodesAdded.length} −${diff.nodesRemoved.length} ~${diff.nodesChanged.length}`,
    `imports +${diff.depsAdded.length} −${diff.depsRemoved.length}`,
    `calls +${diff.callsAdded.length} −${diff.callsRemoved.length}`,
    `packages +${diff.externalsAdded.length} −${diff.externalsRemoved.length}`,
  ];
  lines.push(counts.join("; ") + ".", "");

  if (diff.layerEdgesAdded.length > 0) {
    const findings = reviewFindings(diff, contract);
    lines.push(findings.length > 0 ? "## ⚠ New dependencies between layers" : "## New dependencies between layers", "");

    for (const edge of diff.layerEdgesAdded) lines.push(`- **${edge.from} → ${edge.to}**${contract ? (edge.against ? " — against ARCHITECTURE.md" : " — allowed by ARCHITECTURE.md") : ""}`);
    lines.push("");
  }

  if (diff.layerEdgesRemoved.length > 0) {
    lines.push("## Layer dependencies removed", "");

    for (const edge of diff.layerEdgesRemoved) lines.push(`- ${edge.from} → ${edge.to}`);
    lines.push("");
  }

  if (diagram.nodes.length > 0) lines.push("```mermaid", toMermaid(diagram).trimEnd(), "```", "");
  else lines.push(`_${diagram.reason}_`, "");
  lines.push(...changeSections(diff, "##"));

  return `${lines.join("\n").trimEnd()}\n`;
}

/** What a diff changed, a section of `level` (`##`, `###`) each, the empty ones left out: modules, functions, imports, calls, packages. */
function changeSections(diff: GraphDiff, level: string): string[] {
  const lines: string[] = [];
  const section = (title: string, items: string[]): void => {
    if (items.length > 0) lines.push(`${level} ${title}`, "", ...items.map((item) => `- ${item}`), "");
  };

  section("Modules added", diff.modulesAdded);
  section("Modules removed", diff.modulesRemoved);
  section("Functions added", diff.nodesAdded.map(fnLabel));
  section("Functions removed", diff.nodesRemoved.map(fnLabel));
  section(
    "Functions changed",
    diff.nodesChanged.map((change) => `${fnLabel(change)} (${(change.what ?? []).join(", ")})`),
  );
  section("Imports added", diff.depsAdded.map((edge) => `${edge.from} → ${edge.to}`));
  section("Imports removed", diff.depsRemoved.map((edge) => `${edge.from} → ${edge.to}`));
  section("Calls added", diff.callsAdded.map((edge) => `${edge.from} → ${edge.to}`));
  section("Calls removed", diff.callsRemoved.map((edge) => `${edge.from} → ${edge.to}`));
  section("Packages added", diff.externalsAdded);
  section("Packages removed", diff.externalsRemoved);

  return lines;
}

/** The modules a diff touched and how, as the picture of a comparison marks them: added or removed, else changed (a function added, removed or changed in it). */
function touchedModules(diff: GraphDiff): Map<string, DiffMark> {
  const touched = new Map<string, DiffMark>();

  for (const change of [...diff.nodesChanged, ...diff.nodesAdded, ...diff.nodesRemoved]) touched.set(change.module, "changed");

  // Added or removed outranks changed.
  for (const id of diff.modulesAdded) touched.set(id, "added");

  for (const id of diff.modulesRemoved) touched.set(id, "removed");

  return touched;
}

/**
 * What a change did to one module, for the module's page: in a review, what the change did; in a comparison, what
 * each head did — the module added or removed, its functions, its imports, the calls into it or out of it.
 */
export function moduleChangeMarkdown(id: string, heads: readonly { head: string; diff: GraphDiff }[], comparison: boolean): string {
  const lines = [comparison ? "## In this comparison" : "## In this change", ""];

  for (const { head, diff } of heads) {
    const own = (change: { module: string }): boolean => change.module === id;
    const touches = (edge: { from: string; to: string }): boolean => moduleOf(edge.from) === id || moduleOf(edge.to) === id;
    const items = [
      ...(diff.modulesAdded.includes(id) ? ["the module added"] : []),
      ...(diff.modulesRemoved.includes(id) ? ["the module removed"] : []),
      ...diff.nodesAdded.filter(own).map((change) => `added ${fnLabel(change)}`),
      ...diff.nodesRemoved.filter(own).map((change) => `removed ${fnLabel(change)}`),
      ...diff.nodesChanged.filter(own).map((change) => `changed ${fnLabel(change)} (${(change.what ?? []).join(", ")})`),
      ...diff.depsAdded.filter(touches).map((edge) => `import added: ${edge.from} → ${edge.to}`),
      ...diff.depsRemoved.filter(touches).map((edge) => `import removed: ${edge.from} → ${edge.to}`),
      ...diff.callsAdded.filter(touches).map((edge) => `call added: ${edge.from} → ${edge.to}`),
      ...diff.callsRemoved.filter(touches).map((edge) => `call removed: ${edge.from} → ${edge.to}`),
    ];

    if (comparison) lines.push(`### ${head === "WORKTREE" ? "working tree" : head}`, "");
    lines.push(...(items.length > 0 ? items.map((item) => `- ${item}`) : ["- nothing"]), "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** One head of a comparison against the base: where it left the base, its diff since, and whether it has a contract. */
export interface Compared {
  /** The head has a contract: only the layer dependencies against it are findings. */
  contract: boolean;
  head: string;
  /** The commit the head left the base at (their merge-base, the base's own commit when they share none): its diff starts there. */
  since: string;
  diff: GraphDiff;
}

/**
 * The picture of a comparison: the modules any head touched, in their layers, labelled with what each head did to
 * them; the imports any head added or removed, labelled with the head. A module is looked up in the base, then where
 * each head left it (what a head removed was there), then in the heads.
 */
export function compareDiagram(base: string, heads: readonly Compared[], baseGraph: Graph, graphs: ReadonlyMap<string, Graph>, forks: ReadonlyMap<string, Graph> = new Map()): PictureContent {
  const everyGraph = [baseGraph, ...forks.values(), ...graphs.values()];
  const findModule = (id: string) => everyGraph.map((graph) => graph.modules.get(id)).find((candidate) => candidate !== undefined);
  const findExternal = (id: string) => everyGraph.map((graph) => graph.externals.get(id)).find((candidate) => candidate !== undefined);
  // What each head did to each module it touched.
  const marks = new Map<string, Map<string, DiffMark>>();

  for (const { head, diff } of heads) for (const [module, what] of touchedModules(diff)) marks.set(module, (marks.get(module) ?? new Map<string, DiffMark>()).set(head, what));

  const glyph: Record<DiffMark, string> = { added: "+", removed: "−", changed: "~", warning: "!", planned: "○" };
  const nodes: Shape[] = [];
  const everyHead = heads.length;

  for (const [id, own] of [...marks].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const module = findModule(id);

    if (!module) continue;
    const parts = [...own].map(([head, what]) => `${glyph[what]} ${head === "WORKTREE" ? "working tree" : head}`);
    const kinds = new Set(own.values());
    // The shape's own colour: what every head agrees on; a mixed picture is "changed".
    const colour: DiffMark = kinds.size === 1 ? [...kinds][0]! : "changed";
    const node: Shape = { id, kind: "module", label: `${id}\n${parts.join("  ")}`, ref: { id, file: id, line: 1 }, group: module.layer, diff: colour, count: own.size, x: 0, y: 0, w: 0, h: 0 };

    // "Every head" only when every head did the same: one that removed the module and one that changed it say so apart.
    if (own.size === everyHead && everyHead > 1 && kinds.size === 1) node.label = `${id}\n${glyph[colour]} every head`;
    nodes.push(node);
  }

  const edges: Line[] = [];
  const seen = new Map<string, Line>();

  for (const { head, diff } of heads) {
    for (const [list, what] of [
      [diff.depsAdded, "added"],
      [diff.depsRemoved, "removed"],
    ] as const) {
      for (const edge of list) {
        const key = `${edge.from}\u0000${edge.to}\u0000${what}`;
        const known = seen.get(key);
        const name = head === "WORKTREE" ? "working tree" : head;

        if (known) known.label = `${known.label}, ${name}`;
        else {
          const drawn: Line = { from: edge.from, to: edge.to, kind: "dependency", diff: what, label: name };
          seen.set(key, drawn);
          edges.push(drawn);
        }
      }
    }
  }

  const ids = new Set(nodes.map((node) => node.id));

  for (const edge of edges) {
    for (const end of [edge.from, edge.to]) {
      if (ids.has(end)) continue;
      const module = findModule(end);
      const external = findExternal(end);

      if (module) nodes.push({ id: end, kind: "module", label: end, ref: { id: end, file: end, line: 1 }, group: module.layer, x: 0, y: 0, w: 0, h: 0 });
      else if (external) nodes.push({ id: end, kind: "external", label: external.kind === "builtin" ? external.id : external.name, x: 0, y: 0, w: 0, h: 0 });
      ids.add(end);
    }
  }

  const layers = [...new Set(everyGraph.flatMap((graph) => graph.layers))].sort();
  const used = new Set(nodes.map((node) => node.group));
  const groups = layers.filter((layer) => used.has(layer)).map((layer) => ({ id: layer, label: layer, kind: "lane" as const, x: 0, y: 0, w: 0, h: 0 }));
  const picture: PictureContent = { title: headsAgainst(heads.length, base), nodes, edges, groups };

  if (nodes.length === 0) picture.reason = "no head changed a module, function, import or call against the base";

  return picture;
}

/** The comparison as Markdown: a table of the heads, the picture, and each head's own review. */
export function comparisonMarkdown(base: string, heads: readonly Compared[], diagram: Diagram): string {
  const lines = [`<!-- archdiff:generated — compare ${base} .. ${heads.map((head) => head.head).join(", ")} -->`, `# ${headsAgainst(heads.length, base)}`, "", `_Each head from where it left ${base} (their merge-base, the commit under "since"): what the head did, not what ${base} did since._`, "", "| head | since | files | modules | functions | imports | calls | layer couplings |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];

  for (const { head, since, diff, contract } of heads) {
    const couplings = diff.layerEdgesAdded.map((edge) => `${edge.against || !contract ? "⚠ " : ""}+${edge.from}→${edge.to}`).concat(diff.layerEdgesRemoved.map((edge) => `−${edge.from}→${edge.to}`)).join(" ");
    lines.push(`| ${head === "WORKTREE" ? "working tree" : head} | ${since.slice(0, 7)} | ${diff.changedFiles.length} | +${diff.modulesAdded.length} −${diff.modulesRemoved.length} | +${diff.nodesAdded.length} −${diff.nodesRemoved.length} ~${diff.nodesChanged.length} | +${diff.depsAdded.length} −${diff.depsRemoved.length} | +${diff.callsAdded.length} −${diff.callsRemoved.length} | ${couplings} |`);
  }

  lines.push("");

  if (diagram.nodes.length > 0) lines.push("```mermaid", toMermaid(diagram).trimEnd(), "```", "");
  else lines.push(`_${diagram.reason}_`, "");

  // What every head shares and what only one has: the shape of the divergence, the modules as the picture marks them.
  const touched = new Map<string, string[]>();

  for (const { head, diff } of heads) for (const id of touchedModules(diff).keys()) touched.set(id, [...(touched.get(id) ?? []), head]);
  const shared = [...touched].filter(([, by]) => by.length === heads.length).map(([id]) => id);
  const only = [...touched].filter(([, by]) => by.length === 1);

  if (heads.length > 1) {
    lines.push("## Touched by every head", "", ...(shared.length > 0 ? shared.map((id) => `- ${id}`) : ["- none"]), "", "## Touched by one head only", "");

    for (const [id, by] of only) lines.push(`- ${id} — ${by[0] === "WORKTREE" ? "working tree" : by[0]}`);

    if (only.length === 0) lines.push("- none");
    lines.push("");
  }

  // Each head's own review: its layer dependencies, then everything it changed, as a review lists it; or that it changed nothing.
  for (const { head, diff, contract } of heads) {
    lines.push(`## ${head === "WORKTREE" ? "working tree" : head}`, "");
    const own: string[] = [];

    if (diff.layerEdgesAdded.length > 0) own.push("### New dependencies between layers", "", ...diff.layerEdgesAdded.map((edge) => `- **${edge.from} → ${edge.to}**${contract ? (edge.against ? " — against ARCHITECTURE.md" : " — allowed by ARCHITECTURE.md") : ""}`), "");

    if (diff.layerEdgesRemoved.length > 0) own.push("### Layer dependencies removed", "", ...diff.layerEdgesRemoved.map((edge) => `- ${edge.from} → ${edge.to}`), "");
    own.push(...changeSections(diff, "###"));
    lines.push(...(own.length > 0 ? own : [`_No module, function, import, call or package changed${diff.changedFiles.length > 0 ? `: ${diff.changedFiles.length === 1 ? "1 source file" : `${diff.changedFiles.length} source files`} changed in what the picture does not show (comments, code outside the declarations)` : ""}._`, ""]));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** A range or a ref as a reader reads it: every full commit hash in it cut to its first seven characters. */
function shortCommits(text: string): string {
  return text.replace(/\b[0-9a-f]{40}\b/g, (sha) => sha.slice(0, 7));
}

/** The title of a comparison: how many heads against which base. */
function headsAgainst(count: number, base: string): string {
  return `${count} ${count === 1 ? "head" : "heads"} against ${base}`;
}

/**
 * The marks of a review laid over any diagram: a module or function the
 * change added, removed or changed keeps the view's own picture and gets
 * the mark's colour, so the structure and the change are seen together.
 * Removed things are not in the head's graph, so they cannot be drawn;
 * they are counted in the reason.
 */
export function overlayDiff(diagram: Diagram, diff: GraphDiff): Diagram {
  const marks = new Map<string, DiffMark>();

  for (const id of diff.modulesAdded) marks.set(id, "added");

  for (const change of diff.nodesAdded) marks.set(change.id, "added");

  for (const change of diff.nodesChanged) marks.set(change.id, "changed");

  for (const change of [...diff.nodesChanged, ...diff.nodesAdded]) if (!marks.has(change.module)) marks.set(change.module, "changed");
  const added = new Set(diff.depsAdded.map((edge) => `${edge.from}\u0000${edge.to}`));
  const calls = new Set(diff.callsAdded.map((edge) => `${edge.from}\u0000${edge.to}`));
  let marked = 0;
  const nodes = diagram.nodes.map((node) => {
    const id = standsFor(node);
    const mark = marks.get(id) ?? (node.kind === "layer" ? undefined : marks.get(node.id));

    if (!mark) return node;
    marked++;

    return { ...node, diff: mark };
  });
  const edges = diagram.edges.map((edge) => {
    const key = `${edge.from}\u0000${edge.to}`;

    return added.has(key) || calls.has(key) ? { ...edge, diff: "added" as const } : edge;
  });
  const removed = diff.modulesRemoved.length + diff.nodesRemoved.length;
  // A commit is named by its first seven characters, as git shows it; a branch or a range as written.
  const since = shortCommits(diff.base);
  const reason = `${marked} ${marked === 1 ? "shape" : "shapes"} changed since ${since}${removed > 0 ? `; ${removed} removed (not drawn)` : ""}${diagram.reason ? `; ${diagram.reason}` : ""}`;

  return { ...diagram, nodes, edges, reason, title: `${diagram.title} — changes since ${since}` };
}

/**
 * Only the change: of a diagram with the review's marks, the marked shapes
 * and their neighbours (the shapes at the other ends of their lines) stay,
 * with the lines among them; the rest of the picture goes, lanes included.
 */
export function onlyChanged(diagram: Diagram): Diagram {
  const marked = new Set(diagram.nodes.filter((node) => node.diff).map((node) => node.id));

  if (marked.size === 0) return { ...diagram, nodes: [], edges: [], groups: [], reason: [diagram.reason, "nothing changed in this picture"].filter(Boolean).join("; ") };
  const keep = new Set(marked);

  for (const edge of diagram.edges) {
    if (marked.has(edge.from)) keep.add(edge.to);

    if (marked.has(edge.to)) keep.add(edge.from);
  }

  const nodes = diagram.nodes.filter((node) => keep.has(node.id));
  const edges = diagram.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to));
  const groups = diagram.groups.filter((group) => nodes.some((node) => node.group === group.id));
  const gone = diagram.nodes.length - nodes.length;

  return { ...diagram, nodes, edges, groups, reason: [diagram.reason, `only the ${counted(marked.size, "changed shape")} and their neighbours; ${gone} ${gone === 1 ? "other" : "others"} left out`].filter(Boolean).join("; ") };
}
