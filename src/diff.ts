// The architectural diff of a change (`archdiff review`): the working tree
// against a base revision, without a checkout. Git names the files that
// differ and gives their base content; the base analysis is the head one
// with those files replaced, so only the changed files are parsed twice.
// The diff is a pure function of the two graphs: modules, functions,
// imports and calls added, removed or changed (by fingerprint or
// signature), the layer dependencies that appeared, and the picture of it.
//
// Pipeline: root + base ref → changed files + base content (git) →
// two analyses → GraphDiff → Diagram + Markdown. Entry points: `review`,
// `graphDiff`, `diffDiagram`, `reviewMarkdown`, `mergeBase`, `changedFiles`.

import { spawnSync } from "node:child_process";
import { analyze, type Analysis } from "./analyze.ts";
import type { Diagram, DiagramEdge, DiagramNode } from "./diagram.ts";
import { layout } from "./diagram.ts";
import { toMermaid } from "./export/mermaid.ts";
import { isSourceFile } from "./files.ts";
import { moduleOf, type Graph, type GraphNode } from "./graph.ts";

export interface NodeChange {
  id: string;
  kind: GraphNode["kind"];
  module: string;
  line: number;
  /** `changed`: what differs. */
  what?: ("body" | "signature" | "exported")[];
}

export interface EdgeChange {
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

export interface ReviewResult {
  head: Analysis;
  base: Analysis;
  diff: GraphDiff;
  diagram: Diagram;
}

function git(root: string, args: string[]): { ok: true; out: string } | { ok: false; error: string } {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

  if (result.error) return { ok: false, error: `git: ${result.error.message}` };

  if (result.status !== 0) return { ok: false, error: result.stderr.trim() || `git ${args[0]} failed` };

  return { ok: true, out: result.stdout };
}

/** A ref that is not an option: git must never read `--x` as one. */
function assertRef(ref: string): void {
  if (ref.startsWith("-") || ref === "") throw new Error(`not a git ref: "${ref}"`);
}

/** The merge-base of HEAD with the main branch (origin/HEAD, main, master, origin/main, origin/master), or HEAD when none is found. */
export function mergeBase(root: string): string {
  for (const candidate of ["origin/HEAD", "main", "master", "origin/main", "origin/master"]) {
    const exists = git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);

    if (!exists.ok) continue;
    const base = git(root, ["merge-base", "HEAD", candidate]);

    if (base.ok) {
      const sha = base.out.trim();
      const head = git(root, ["rev-parse", "HEAD"]);

      // On the main branch itself the merge-base is HEAD: the change is then the working tree against HEAD.
      return head.ok && head.out.trim() === sha ? "HEAD" : candidate;
    }
  }

  return "HEAD";
}

/** The source files that differ between `base` and the working tree (tracked changes and untracked files), with the base content of each (null when the base lacks it). */
export function changedFiles(root: string, base: string): Map<string, string | null> {
  assertRef(base);
  const diff = git(root, ["diff", "--name-status", "-z", "-M", base, "--"]);

  if (!diff.ok) throw new Error(diff.error);
  const changed = new Map<string, string | null>();
  const parts = diff.out.split("\0").filter((part) => part !== "");

  for (let i = 0; i < parts.length; ) {
    const status = parts[i]!;
    const first = parts[i + 1];

    if (first === undefined) break;

    if (status.startsWith("R") || status.startsWith("C")) {
      const second = parts[i + 2]!;
      changed.set(first, "base");
      changed.set(second, status.startsWith("R") ? null : "base");
      i += 3;
    } else {
      changed.set(first, status === "A" ? null : "base");
      i += 2;
    }
  }

  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);

  if (untracked.ok) for (const path of untracked.out.split("\0")) if (path !== "" && !changed.has(path)) changed.set(path, null);
  const overrides = new Map<string, string | null>();

  for (const [path, marker] of changed) {
    if (!isSourceFile(path)) continue;

    if (marker === null) {
      // Added since the base: the base does not have it.
      overrides.set(path, null);
      continue;
    }

    const content = git(root, ["show", `${base}:${path}`]);
    overrides.set(path, content.ok ? content.out : null);
  }

  return overrides;
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function edgeOf(key: string): EdgeChange {
  const [from, to] = key.split("\u0000") as [string, string];

  return { from, to };
}

function nodeChange(node: GraphNode): NodeChange {
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
 * where that import changed, and the imports themselves marked.
 */
export function diffDiagram(diff: GraphDiff, base: Graph, head: Graph): Diagram {
  const marks = new Map<string, DiagramNode["diff"]>();

  for (const id of diff.modulesAdded) marks.set(id, "added");

  for (const id of diff.modulesRemoved) marks.set(id, "removed");

  for (const change of [...diff.nodesChanged, ...diff.nodesAdded, ...diff.nodesRemoved]) if (!marks.has(change.module)) marks.set(change.module, "changed");
  const edges: DiagramEdge[] = [];
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

  const nodes: DiagramNode[] = [];

  for (const id of [...touched].sort()) {
    const module = head.modules.get(id) ?? base.modules.get(id);
    const external = head.externals.get(id) ?? base.externals.get(id);

    if (module) {
      const node: DiagramNode = { id, kind: "module", label: id, ref: { id, file: id, line: 1 }, group: module.layer, x: 0, y: 0, w: 0, h: 0 };
      const mark = marks.get(id);

      if (mark) node.diff = mark;
      nodes.push(node);
    } else if (external) {
      const node: DiagramNode = { id, kind: "external", label: external.kind === "builtin" ? `node:${external.name}` : external.name, x: 0, y: 0, w: 0, h: 0 };

      if (diff.externalsAdded.includes(id)) node.diff = "added";
      else if (diff.externalsRemoved.includes(id)) node.diff = "removed";
      nodes.push(node);
    }
  }

  const layers = [...new Set([...head.layers, ...base.layers])].sort();
  const used = new Set(nodes.map((node) => node.group));
  const groups = layers.filter((layer) => used.has(layer)).map((layer) => ({ id: layer, label: layer, kind: "lane" as const, x: 0, y: 0, w: 0, h: 0 }));
  const diagram: Diagram = { view: `review:${diff.base}`, title: `Changes since ${diff.base}`, nodes, edges, groups };

  if (nodes.length === 0) diagram.reason = "no module, function, import or call changed";

  return diagram;
}

/** Analyses the working tree and the base, and diffs them. `base` null: the merge-base with the main branch. */
export async function review(root: string, base: string | null): Promise<ReviewResult> {
  const ref = base ?? mergeBase(root);
  const overrides = changedFiles(root, ref);
  const head = await analyze(root);
  const baseAnalysis = await analyze(root, { overrides, config: head.config });
  const diff = graphDiff(baseAnalysis.graph, head.graph, ref, [...overrides.keys()]);
  const diagram = layout(diffDiagram(diff, baseAnalysis.graph, head.graph));

  return { head, base: baseAnalysis, diff, diagram };
}

function fnLabel(change: NodeChange): string {
  return `${change.kind} \`${change.id.slice(change.module.length + 1)}\` — ${change.module}:${change.line}`;
}

/** The review as Markdown: the summary, the Mermaid picture, every change by kind. */
export function reviewMarkdown(result: ReviewResult): string {
  const { diff, diagram } = result;
  const lines = [`# Architecture changes since ${diff.base}`, ""];
  const counts = [
    `${diff.changedFiles.length} source files changed`,
    `modules +${diff.modulesAdded.length} −${diff.modulesRemoved.length}`,
    `functions +${diff.nodesAdded.length} −${diff.nodesRemoved.length} ~${diff.nodesChanged.length}`,
    `imports +${diff.depsAdded.length} −${diff.depsRemoved.length}`,
    `calls +${diff.callsAdded.length} −${diff.callsRemoved.length}`,
    `packages +${diff.externalsAdded.length} −${diff.externalsRemoved.length}`,
  ];
  lines.push(counts.join("; ") + ".", "");

  if (diff.layerEdgesAdded.length > 0) {
    lines.push("## ⚠ New dependencies between layers", "");

    for (const edge of diff.layerEdgesAdded) lines.push(`- **${edge.from} → ${edge.to}**`);
    lines.push("");
  }

  if (diff.layerEdgesRemoved.length > 0) {
    lines.push("## Layer dependencies removed", "");

    for (const edge of diff.layerEdgesRemoved) lines.push(`- ${edge.from} → ${edge.to}`);
    lines.push("");
  }

  if (diagram.nodes.length > 0) lines.push("```mermaid", toMermaid(diagram).trimEnd(), "```", "");
  else lines.push(`_${diagram.reason}_`, "");

  const section = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`## ${title}`, "", ...items.map((item) => `- ${item}`), "");
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

  return `${lines.join("\n").trimEnd()}\n`;
}

export { moduleOf };
