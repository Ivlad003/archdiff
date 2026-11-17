// The board of the uncommitted changes: what the working tree changes
// against the last commit, as a reviewer reads it. The changed modules are
// grouped by what they are part of — the layer, then the directory — each
// group counted (its modules, functions, imports and calls added, removed
// and changed) and the groups put in reading order: the modules execution
// starts from first, then what they import and call, step by step. The
// board's picture draws every group as a lane; a group's own picture opens
// its modules to the functions the change touched and what they call
// outside; the pages list the walk, and a group's page ends with the text
// of its diff. Pure functions of a review's diff and its two graphs:
// picture.ts reads the diff, the entry points and the text from git.
//
// Pipeline: GraphDiff + two graphs → Board → Diagram + Markdown. Entry
// points: `boardOf`, `boardDiagram`, `groupDiagram`, `boardMarkdown`,
// `groupMarkdown`, `groupKey`; the types of a board (`Board`, `BoardGroup`,
// `BoardModule`) are diagram.ts's, which the page bundles.

import type { Board, BoardGroup, BoardMark, BoardModule, Counts, Diagram, Lane, Line, PictureContent, Shape } from "./diagram.ts";
import { changeSections, reviewFindings, shortCommits, type GraphDiff } from "./diff.ts";
import { toMermaid } from "./export/mermaid.ts";
import { moduleOf, type Graph } from "./graph.ts";
import { greedyOrder } from "./order.ts";
import { counted } from "./words.ts";

export type { Board, BoardGroup, BoardMark, BoardModule, Counts } from "./diagram.ts";

/** The view of a group's own picture. */
export function groupKey(id: string): string {
  return `changes:${id}`;
}

function directoryOf(module: string): string {
  const slash = module.lastIndexOf("/");

  return slash === -1 ? "" : module.slice(0, slash);
}

/** The group a module is part of: its layer, then its directory. */
function groupIdOf(module: string, layer: string): string {
  return `${layer}:${directoryOf(module) || "."}`;
}

function groupLabel(layer: string, directory: string): string {
  return `${layer} · ${directory === "" ? "(root)" : `${directory}/`}`;
}

/**
 * How many imports or calls each module is from the nearest of `entries`, the modules execution starts from: the
 * order a change is read in — where it starts, then what that reaches, breadth first.
 */
function readingRanks(graph: Graph, entries: Iterable<string>): Map<string, number> {
  const next = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    if (from !== to && graph.modules.has(from) && graph.modules.has(to)) next.set(from, (next.get(from) ?? new Set<string>()).add(to));
  };

  for (const dep of graph.deps) if (!dep.typeOnly) link(dep.from, dep.to);

  for (const call of graph.calls) link(moduleOf(call.from), moduleOf(call.to));
  const ranks = new Map<string, number>();
  let frontier = [...new Set(entries)].filter((module) => graph.modules.has(module)).sort();

  for (const module of frontier) ranks.set(module, 0);

  for (let rank = 1; frontier.length > 0; rank++) {
    const reached: string[] = [];

    for (const module of frontier) {
      for (const to of [...(next.get(module) ?? [])].sort()) {
        if (ranks.has(to)) continue;
        ranks.set(to, rank);
        reached.push(to);
      }
    }

    frontier = reached;
  }

  return ranks;
}

/** The layers of both graphs with the importers before what they import (order.ts): where two groups are as near an entry point, the upper layer is read first. */
function layersDown(base: Graph, head: Graph): string[] {
  const counts = new Map<string, number>();

  for (const graph of [base, head]) {
    for (const dep of graph.deps) {
      const from = graph.modules.get(dep.from)?.layer;
      const to = graph.modules.get(dep.to)?.layer;

      if (from && to && from !== to && !dep.typeOnly) counts.set(`${from}\u0000${to}`, (counts.get(`${from}\u0000${to}`) ?? 0) + 1);
    }
  }

  return greedyOrder([...new Set([...head.layers, ...base.layers])], counts);
}

/** `+1 −2 ~3`, the zeros left out; empty when all are zero. */
function signed(counts: { added: number; removed: number; changed?: number }): string {
  return [counts.added > 0 ? `+${counts.added}` : "", counts.removed > 0 ? `−${counts.removed}` : "", (counts.changed ?? 0) > 0 ? `~${counts.changed}` : ""].filter(Boolean).join(" ");
}

/** What a group's change comes to, in words: `modules +1 ~1 · functions +2 · imports +1`. */
function groupCounts(group: BoardGroup): string {
  const modules: Counts = { added: group.modules.filter((module) => module.mark === "added").length, removed: group.modules.filter((module) => module.mark === "removed").length, changed: group.modules.filter((module) => module.mark === "changed").length };

  return [
    ["modules", signed(modules)],
    ["functions", signed(group.functions)],
    ["imports", signed(group.imports)],
    ["calls", signed(group.calls)],
  ]
    .filter(([, count]) => count !== "")
    .map(([what, count]) => `${what} ${count}`)
    .join(" · ");
}

/**
 * The board of a diff: every module the change touched — added, removed, with a declaration added, removed or
 * changed, or a changed file with none of those (its text alone) — in the group of its layer and directory, and the
 * groups in reading order: by the nearest of their modules to an entry point (`entries` of the head, `baseEntries`
 * for a module the change removed), then by layer — the importers before what they import — and directory. `others`:
 * the files changed that are no source.
 */
export function boardOf(diff: GraphDiff, base: Graph, head: Graph, entries: readonly string[], baseEntries: readonly string[] = [], others: readonly { status: string; path: string }[] = []): Board {
  const marks = new Map<string, BoardMark>();

  for (const file of diff.changedFiles) if (head.modules.has(file) || base.modules.has(file)) marks.set(file, "changed");

  for (const change of [...diff.nodesChanged, ...diff.nodesAdded, ...diff.nodesRemoved]) marks.set(change.module, "changed");

  for (const id of diff.modulesAdded) marks.set(id, "added");

  for (const id of diff.modulesRemoved) marks.set(id, "removed");
  const headRanks = readingRanks(head, entries);
  const baseRanks = readingRanks(base, baseEntries);
  // An entry point as the code has it now; a module the change removed, as it was.
  const isEntry = (id: string): boolean => (head.modules.has(id) ? entries.includes(id) : baseEntries.includes(id));
  const layers = layersDown(base, head);
  const groups = new Map<string, BoardGroup>();

  for (const [id, mark] of marks) {
    const module = head.modules.get(id) ?? base.modules.get(id);

    if (!module) continue;
    const groupId = groupIdOf(id, module.layer);
    const group = groups.get(groupId) ?? { id: groupId, key: groupKey(groupId), layer: module.layer, directory: directoryOf(id), label: groupLabel(module.layer, directoryOf(id)), modules: [], functions: { added: 0, removed: 0, changed: 0 }, imports: { added: 0, removed: 0 }, calls: { added: 0, removed: 0 } };
    groups.set(groupId, group);
    const functions: Counts = { added: diff.nodesAdded.filter((change) => change.module === id).length, removed: diff.nodesRemoved.filter((change) => change.module === id).length, changed: diff.nodesChanged.filter((change) => change.module === id).length };
    group.modules.push({ id, mark, functions, entry: isEntry(id), rank: headRanks.get(id) ?? baseRanks.get(id) ?? null });
    group.functions.added += functions.added;
    group.functions.removed += functions.removed;
    group.functions.changed += functions.changed;
  }

  const far = Number.MAX_SAFE_INTEGER;
  const byRank = (a: BoardModule, b: BoardModule): number => (a.rank ?? far) - (b.rank ?? far) || (a.id < b.id ? -1 : 1);

  for (const group of groups.values()) {
    const own = new Set(group.modules.map((module) => module.id));
    const touches = (edge: { from: string; to: string }): boolean => own.has(moduleOf(edge.from)) || own.has(moduleOf(edge.to));
    group.modules.sort(byRank);
    group.imports = { added: diff.depsAdded.filter(touches).length, removed: diff.depsRemoved.filter(touches).length };
    group.calls = { added: diff.callsAdded.filter(touches).length, removed: diff.callsRemoved.filter(touches).length };
  }

  const nearest = (group: BoardGroup): number => Math.min(...group.modules.map((module) => module.rank ?? far));
  const ordered = [...groups.values()].sort((a, b) => nearest(a) - nearest(b) || layers.indexOf(a.layer) - layers.indexOf(b.layer) || (a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0));

  return { base: shortCommits(diff.base), groups: ordered, files: diff.changedFiles.length, others: [...others] };
}

/** The label of a changed module's shape: its path, then what the change did in it. */
function moduleLabel(module: BoardModule, name: string): string {
  const did = signed(module.functions);

  return `${name}\n${module.mark === "added" ? "added" : module.mark === "removed" ? "removed" : did === "" ? "edited" : ""}${did === "" ? "" : `${module.mark === "changed" ? "" : " · "}${did} fn`}`;
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/**
 * The board as a picture: a lane per group in reading order, labelled with what the change comes to there; in it the
 * group's modules, marked, in reading order; the imports the change added and removed, marked; and, for context, the
 * modules at the other ends of those imports in lanes of their own, with the unchanged imports among all of them.
 */
export function boardDiagram(board: Board, diff: GraphDiff, base: Graph, head: Graph): PictureContent {
  const nodes: Shape[] = [];
  const lanes: Lane[] = [];
  const drawn = new Set<string>();

  for (const group of board.groups) {
    lanes.push({ id: group.id, label: `${group.label} — ${groupCounts(group) || "edited"}`, kind: "lane", x: 0, y: 0, w: 0, h: 0 });

    for (const module of group.modules) {
      nodes.push({ id: module.id, kind: "module", label: moduleLabel(module, module.id), ref: { id: module.id, file: module.id, line: 1 }, group: group.id, diff: module.mark, x: 0, y: 0, w: 0, h: 0 });
      drawn.add(module.id);
    }
  }

  const edges: Line[] = [...diff.depsAdded.map((dep): Line => ({ from: dep.from, to: dep.to, kind: "dependency", diff: "added" })), ...diff.depsRemoved.map((dep): Line => ({ from: dep.from, to: dep.to, kind: "dependency", diff: "removed" }))];
  const changedGroups = new Set(board.groups.map((group) => group.id));
  const context = new Map<string, Lane>();

  // The other ends of the changed imports: a module in the lane of its own group, a package beside the lanes.
  for (const end of [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))].sort()) {
    if (drawn.has(end)) continue;
    const module = head.modules.get(end) ?? base.modules.get(end);
    const external = head.externals.get(end) ?? base.externals.get(end);

    if (module) {
      const groupId = groupIdOf(end, module.layer);

      if (!changedGroups.has(groupId) && !context.has(groupId)) context.set(groupId, { id: groupId, label: `${groupLabel(module.layer, directoryOf(end))} — unchanged, for context`, kind: "lane", x: 0, y: 0, w: 0, h: 0 });
      nodes.push({ id: end, kind: "module", label: end, ref: { id: end, file: end, line: 1 }, group: groupId, x: 0, y: 0, w: 0, h: 0 });
    } else if (external) {
      const node: Shape = { id: end, kind: "external", label: external.kind === "builtin" ? external.id : external.name, x: 0, y: 0, w: 0, h: 0 };

      if (diff.externalsAdded.includes(end)) node.diff = "added";
      else if (diff.externalsRemoved.includes(end)) node.diff = "removed";
      nodes.push(node);
    } else continue;

    drawn.add(end);
  }

  // The imports the change left alone, among what is drawn: how the groups hang together.
  const seen = new Set(edges.map((edge) => edgeKey(edge.from, edge.to)));

  for (const dep of head.deps) {
    if (dep.typeOnly || !drawn.has(dep.from) || !drawn.has(dep.to) || dep.from === dep.to || seen.has(edgeKey(dep.from, dep.to))) continue;
    seen.add(edgeKey(dep.from, dep.to));
    edges.push({ from: dep.from, to: dep.to, kind: "dependency" });
  }

  const changed = board.groups.reduce((sum, group) => sum + group.modules.length, 0);
  const picture: PictureContent = { title: `Uncommitted changes: ${counted(changed, "module")} in ${counted(board.groups.length, "group")}`, nodes, edges: edges.filter((edge) => drawn.has(edge.from) && drawn.has(edge.to)), groups: [...lanes, ...context.values()] };

  if (nodes.length === 0) picture.reason = board.files > 0 || board.others.length > 0 ? `the working tree changes no module, function, import or call against ${board.base} (${counted(board.files + board.others.length, "file")} changed in what the picture does not show)` : `the working tree is as ${board.base} has it: nothing to walk`;
  else picture.reason = "the lanes are in reading order: the entry points first, then what they import and call; the keys . and , step through the groups";

  return picture;
}

/** A declaration's name as its module writes it: `placeOrder`, `OrderService.place`. */
function nameIn(id: string): string {
  return id.slice(moduleOf(id).length + 1);
}

/**
 * One group's own picture: a lane per changed module of the group, holding the module and the declarations the
 * change added, changed and removed in it (and those at an end of a call it added or removed); the imports and the
 * calls the change added and removed, marked — a call to or from another module landing on that module, labelled
 * with the function — and the unchanged calls among the declarations drawn, for the flow. The modules outside the
 * group sit in the lanes of their layers.
 */
export function groupDiagram(board: Board, group: BoardGroup, diff: GraphDiff, base: Graph, head: Graph): PictureContent {
  const own = new Set(group.modules.map((module) => module.id));
  const laneOf = (module: string): string => `inside:${module}`;
  const nodes: Shape[] = [];
  const shapes = new Map<string, Shape>();
  const lanes: Lane[] = [];
  const add = (shape: Shape): void => {
    if (shapes.has(shape.id)) return;
    shapes.set(shape.id, shape);
    nodes.push(shape);
  };

  /** The shape of a declaration of a group's module: the head's, or what is left of one the change removed. */
  const declaration = (id: string, mark?: BoardMark): void => {
    const module = moduleOf(id);
    const node = head.nodes.get(id) ?? base.nodes.get(id);

    if (!node || shapes.has(id)) return;
    const shape: Shape = { id, kind: "fn", label: mark === "removed" ? `${nameIn(id)}\nremoved` : nameIn(id), group: laneOf(module), x: 0, y: 0, w: 0, h: 0 };

    // A declaration the change removed has no line of the code as it is now: its module's picture is where it was.
    if (mark === "removed") Object.assign(shape, { ref: { id }, opens: `module:${module}` });
    else shape.ref = { id, file: node.module, line: node.line, endLine: node.endLine };

    if (mark !== "removed" && node.signature) shape.signature = node.signature;

    if (mark) shape.diff = mark;
    add(shape);
  };

  for (const module of group.modules) {
    lanes.push({ id: laneOf(module.id), label: `${module.id} — ${module.mark}${module.entry ? ", an entry point" : ""}`, kind: "lane", x: 0, y: 0, w: 0, h: 0 });
    add({ id: module.id, kind: "module", label: moduleLabel(module, module.id.slice(module.id.lastIndexOf("/") + 1)), ref: { id: module.id, file: module.id, line: 1 }, group: laneOf(module.id), diff: module.mark, x: 0, y: 0, w: 0, h: 0 });
  }

  for (const change of diff.nodesAdded) if (own.has(change.module)) declaration(change.id, "added");

  for (const change of diff.nodesChanged) if (own.has(change.module)) declaration(change.id, "changed");

  for (const change of diff.nodesRemoved) if (own.has(change.module)) declaration(change.id, "removed");

  /** The shape a line lands on: a declaration of the group as itself, anything else as its module (or package), drawn in its layer. */
  const end = (id: string): string | null => {
    const module = moduleOf(id);

    if (own.has(module)) {
      if (id !== module) declaration(id);

      return shapes.has(id) ? id : module;
    }

    if (shapes.has(module)) return module;
    const known = head.modules.get(module) ?? base.modules.get(module);
    const external = head.externals.get(id) ?? base.externals.get(id);

    if (known) add({ id: module, kind: "module", label: module, ref: { id: module, file: module, line: 1 }, group: known.layer, x: 0, y: 0, w: 0, h: 0 });
    else if (external) add({ id, kind: "external", label: external.kind === "builtin" ? external.id : external.name, x: 0, y: 0, w: 0, h: 0 });
    else return null;

    return known ? module : id;
  };

  const edges: Line[] = [];
  const lines = new Map<string, Line>();
  /** One line per pair of shapes, kind and mark; a call to or from outside the group says which functions it stands for. */
  const draw = (from: string, to: string, kind: Line["kind"], mark: "added" | "removed" | undefined, says?: string): void => {
    const a = end(from);
    const b = end(to);

    if (a === null || b === null || a === b) return;
    const key = `${edgeKey(a, b)}\u0000${kind}\u0000${mark ?? ""}`;
    const known = lines.get(key);

    if (known) {
      if (says !== undefined && !(known.label ?? "").split(", ").includes(says)) known.label = known.label ? `${known.label}, ${says}` : says;

      return;
    }

    const line: Line = { from: a, to: b, kind };

    if (mark) line.diff = mark;

    if (says !== undefined) line.label = says;
    lines.set(key, line);
    edges.push(line);
  };
  const touches = (edge: { from: string; to: string }): boolean => own.has(moduleOf(edge.from)) || own.has(moduleOf(edge.to));
  /** What a call's line says when one of its ends is drawn as a module: the function at that end. */
  const said = (call: { from: string; to: string }): string | undefined => (!own.has(moduleOf(call.to)) && call.to.includes("#") ? `${nameIn(call.to)}()` : !own.has(moduleOf(call.from)) && call.from.includes("#") ? `from ${nameIn(call.from)}` : undefined);

  for (const dep of diff.depsAdded) if (touches(dep)) draw(dep.from, dep.to, "dependency", "added");

  for (const dep of diff.depsRemoved) if (touches(dep)) draw(dep.from, dep.to, "dependency", "removed");

  for (const call of diff.callsAdded) if (touches(call)) draw(call.from, call.to, "call", "added", said(call));

  for (const call of diff.callsRemoved) if (touches(call)) draw(call.from, call.to, "call", "removed", said(call));

  // The calls the change left alone, among the declarations it drew: the flow the changed ones stand in.
  for (const call of head.calls) {
    if (call.from === call.to || !shapes.has(call.from) || !shapes.has(call.to) || call.from === moduleOf(call.from) || call.to === moduleOf(call.to)) continue;

    if (!lines.has(`${edgeKey(call.from, call.to)}\u0000${call.kind}\u0000added`)) draw(call.from, call.to, call.kind, undefined);
  }

  const layers = [...new Set([...head.layers, ...base.layers])];
  const used = new Set(nodes.map((node) => node.group));
  // The marked shapes first: a big group folds its context, not its news.
  nodes.sort((a, b) => Number(b.diff !== undefined) - Number(a.diff !== undefined));
  const step = board.groups.indexOf(group) + 1;

  return { title: `Changes in ${group.label} — step ${step} of ${board.groups.length}`, nodes, edges, groups: [...lanes, ...layers.filter((layer) => used.has(layer)).map((layer): Lane => ({ id: layer, label: `${layer} — outside the group`, kind: "lane", x: 0, y: 0, w: 0, h: 0 }))], reason: `${groupCounts(group) || "edited"}; the diff is on the Markdown tab; the keys . and , step through the groups` };
}

/** The part of a diff that is of the modules given: their declarations, and the imports and calls with an end in them. */
function diffOf(diff: GraphDiff, modules: ReadonlySet<string>): GraphDiff {
  const own = (change: { module: string }): boolean => modules.has(change.module);
  const touches = (edge: { from: string; to: string }): boolean => modules.has(moduleOf(edge.from)) || modules.has(moduleOf(edge.to));

  return {
    ...diff,
    changedFiles: diff.changedFiles.filter((file) => modules.has(file)),
    modulesAdded: diff.modulesAdded.filter((id) => modules.has(id)),
    modulesRemoved: diff.modulesRemoved.filter((id) => modules.has(id)),
    nodesAdded: diff.nodesAdded.filter(own),
    nodesRemoved: diff.nodesRemoved.filter(own),
    nodesChanged: diff.nodesChanged.filter(own),
    depsAdded: diff.depsAdded.filter(touches),
    depsRemoved: diff.depsRemoved.filter(touches),
    callsAdded: diff.callsAdded.filter(touches),
    callsRemoved: diff.callsRemoved.filter(touches),
    layerEdgesAdded: [],
    layerEdgesRemoved: [],
    externalsAdded: [],
    externalsRemoved: [],
  };
}

/** The picture as a Mermaid block, or the reason it is empty. */
function pictureBlock(diagram: Diagram): string[] {
  return diagram.nodes.length > 0 ? ["```mermaid", toMermaid(diagram).trimEnd(), "```", ""] : [`_${diagram.reason ?? "nothing to draw"}_`, ""];
}

/** What git's letter for a changed path says. */
const STATUS: Readonly<Record<string, string>> = { A: "added", M: "modified", D: "deleted", R: "renamed", "?": "not tracked yet" };

/**
 * The board's page: what the change comes to, the new dependencies between layers (against the contract, when the
 * head has one), the walk — every group in reading order with its modules — the picture, and the files changed
 * that are no source.
 */
export function boardMarkdown(board: Board, diagram: Diagram, diff: GraphDiff, contract: boolean): string {
  const lines = [`<!-- archdiff:generated — uncommitted changes against ${board.base} -->`, `# Uncommitted changes against ${board.base}`, ""];
  lines.push(`${counted(board.files, "source file")} changed; modules +${diff.modulesAdded.length} −${diff.modulesRemoved.length}; functions +${diff.nodesAdded.length} −${diff.nodesRemoved.length} ~${diff.nodesChanged.length}; imports +${diff.depsAdded.length} −${diff.depsRemoved.length}; calls +${diff.callsAdded.length} −${diff.callsRemoved.length}.`, "");

  if (diff.layerEdgesAdded.length > 0) {
    lines.push(reviewFindings(diff, contract).length > 0 ? "## ⚠ New dependencies between layers" : "## New dependencies between layers", "");

    for (const edge of diff.layerEdgesAdded) lines.push(`- **${edge.from} → ${edge.to}**${contract ? (edge.against ? " — against ARCHITECTURE.md" : " — allowed by ARCHITECTURE.md") : ""}`);
    lines.push("");
  }

  if (board.groups.length > 0) {
    lines.push("## The walk", "", "_The groups in the order a reviewer reads them: the entry points first, then what they import and call. `.` and `,` step through them._", "");

    for (const [i, group] of board.groups.entries()) {
      lines.push(`${i + 1}. ${group.label} — ${groupCounts(group) || "edited"}`);

      for (const module of group.modules) lines.push(`   - **${module.id}** — ${module.mark}${signed(module.functions) === "" ? "" : `, functions ${signed(module.functions)}`}${module.entry ? ", an entry point" : ""}`);
    }

    lines.push("");
  }

  lines.push(...pictureBlock(diagram));

  if (board.others.length > 0) lines.push("## Other files changed", "", ...board.others.map((file) => `- \`${file.path}\` — ${STATUS[file.status] ?? file.status}`), "");

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * A group's page: where it stands in the walk, what the change comes to in it, its picture, every change by kind,
 * and the diff of its files as text. `subject` names a group the board does not hold (any more): the page says so.
 */
export function groupMarkdown(board: Board, group: BoardGroup | null, subject: string, diagram: Diagram, diff: GraphDiff, text: ReadonlyMap<string, string>): string {
  if (!group) return `<!-- archdiff:generated — uncommitted changes in ${subject} -->\n# Changes in ${subject}\n\n_${diagram.reason ?? "nothing changes here"}_\n`;
  const step = board.groups.indexOf(group) + 1;
  const lines = [`<!-- archdiff:generated — uncommitted changes in ${group.id} against ${board.base} -->`, `# Changes in ${group.label}`, "", `_Step ${step} of ${board.groups.length} of the uncommitted changes against ${board.base}._ ${groupCounts(group) || "Edited, with no declaration, import or call changed"}.`, ""];

  for (const module of group.modules) lines.push(`- **${module.id}** — ${module.mark}${signed(module.functions) === "" ? "" : `, functions ${signed(module.functions)}`}${module.entry ? ", an entry point" : ""}`);
  lines.push("", ...pictureBlock(diagram), ...changeSections(diffOf(diff, new Set(group.modules.map((module) => module.id))), "##"));
  const files = group.modules.filter((module) => text.has(module.id));

  if (files.length > 0) {
    lines.push("## The diff", "");

    for (const module of files) lines.push(`### ${module.id}`, "", "````diff", text.get(module.id)!, "````", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
