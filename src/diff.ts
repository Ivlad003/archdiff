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
import { loadConfig } from "./config.ts";
import type { Diagram, DiagramEdge, DiagramNode, DiffMark } from "./diagram.ts";
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

  if (result.status !== 0) {
    // The first line of what git said, not its usage text; the usual causes named plainly.
    const text = result.stderr.trim();

    if (/not a git repository/i.test(text)) return { ok: false, error: `${root} is not a git repository` };

    if (/bad revision 'HEAD'|ambiguous argument 'HEAD'/.test(text)) return { ok: false, error: `${root} has no commits yet` };

    if (/unknown revision|bad revision|ambiguous argument/.test(text)) return { ok: false, error: text.split("\n")[0] ?? text };

    return { ok: false, error: text.split("\n")[0] || `git ${args[0]} failed` };
  }

  return { ok: true, out: result.stdout };
}

/** A ref that is not an option: git must never read `--x` as one. */
function assertRef(ref: string): void {
  if (ref.startsWith("-") || ref === "") throw new Error(`not a git ref: "${ref}"`);
}

/**
 * The merge-base commit of HEAD with the main branch (origin/HEAD, main,
 * master, origin/main, origin/master): the commit the change started from,
 * so commits that landed on main since are not read as this change. On the
 * main branch itself, or without any such branch, HEAD: the change is then
 * the working tree. Throws with a hint when the repository is shallow and
 * no base can be found.
 */
export function mergeBase(root: string): string {
  for (const candidate of ["origin/HEAD", "main", "master", "origin/main", "origin/master"]) {
    const exists = git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);

    if (!exists.ok) continue;
    const base = git(root, ["merge-base", "HEAD", candidate]);

    if (base.ok) return base.out.trim();
  }

  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]);

  if (shallow.ok && shallow.out.trim() === "true") throw new Error("no merge-base with the main branch in a shallow clone: fetch more history (git fetch --unshallow, or fetch-depth: 0 in CI) or pass --base <ref>");

  return "HEAD";
}

/** A revision's content of a file, as `analyze` overrides: null when the revision lacks it. */
function contentAt(root: string, ref: string, path: string): string | null {
  const content = git(root, ["show", `${ref}:${path}`]);

  return content.ok ? content.out : null;
}

/**
 * The source files that differ between `base` and `head` (a ref, or the
 * working tree when null: tracked changes and untracked files), as the
 * overrides of each side's analysis: the base's content, and the head's
 * when it is a ref. Null drops the file on that side.
 */
export function changedFiles(root: string, base: string, head: string | null = null): { base: Map<string, string | null>; head: Map<string, string | null> } {
  assertRef(base);

  if (head !== null) assertRef(head);
  const diff = git(root, head === null ? ["diff", "--name-status", "-z", "-M", base, "--"] : ["diff", "--name-status", "-z", "-M", base, head, "--"]);

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

  if (head === null) {
    const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);

    if (untracked.ok) for (const path of untracked.out.split("\0")) if (path !== "" && !changed.has(path)) changed.set(path, null);
  }

  const baseSide = new Map<string, string | null>();
  const headSide = new Map<string, string | null>();

  for (const [path, marker] of changed) {
    if (!isSourceFile(path)) continue;
    // Added since the base: the base does not have it.
    baseSide.set(path, marker === null ? null : contentAt(root, base, path));

    if (head !== null) headSide.set(path, contentAt(root, head, path));
  }

  // A head ref: every source file the working tree has but the head does not (or the reverse) must be read from the head too,
  // else the head analysis would mix the working tree in. The diff lists them already when they differ from the base.
  return { base: baseSide, head: headSide };
}

/** The whole tree of a ref as overrides against the working tree: files that differ get the ref's content, files the ref lacks null, files only the ref has their content. */
export function treeAt(root: string, ref: string): Map<string, string | null> {
  assertRef(ref);
  const diff = git(root, ["diff", "--name-status", "-z", "-M", ref, "--"]);

  if (!diff.ok) throw new Error(diff.error);
  const overrides = new Map<string, string | null>();
  const parts = diff.out.split("\0").filter((part) => part !== "");

  for (let i = 0; i < parts.length; ) {
    const status = parts[i]!;
    const paths = status.startsWith("R") || status.startsWith("C") ? [parts[i + 1]!, parts[i + 2]!] : [parts[i + 1]!];
    i += 1 + paths.length;

    for (const path of paths) if (path && isSourceFile(path)) overrides.set(path, contentAt(root, ref, path));
  }

  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);

  if (untracked.ok) for (const path of untracked.out.split("\0")) if (path !== "" && isSourceFile(path) && !overrides.has(path)) overrides.set(path, null);

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

/** Analyses the head (a ref, or the working tree when null) and the base, and diffs them. `base` null: the merge-base with the main branch. */
export async function review(root: string, base: string | null, headRef: string | null = null): Promise<ReviewResult> {
  const ref = base ?? mergeBase(root);
  const config = loadConfig(root);
  const head = headRef === null ? await analyze(root, { config }) : await analyze(root, { overrides: treeAt(root, headRef), config });
  const baseAnalysis = await analyze(root, { overrides: treeAt(root, ref), config });
  const changed = changedFiles(root, ref, headRef);
  const diff = graphDiff(baseAnalysis.graph, head.graph, headRef === null ? ref : `${ref}..${headRef}`, [...changed.base.keys()]);
  const diagram = layout(diffDiagram(diff, baseAnalysis.graph, head.graph));

  return { head, base: baseAnalysis, diff, diagram };
}

/** One commit of a range, as `git log` lists it. */
export interface Commit {
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

/** The commits from `base` (excluded) to `head`, oldest first. */
export function commitsBetween(root: string, base: string, head: string): Commit[] {
  assertRef(base);
  assertRef(head);
  const log = git(root, ["log", "--reverse", "--format=%H%x00%h%x00%an%x00%ad%x00%s", "--date=short", `${base}..${head}`]);

  if (!log.ok) throw new Error(log.error);

  return log.out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha, short, author, date, subject] = line.split("\0") as [string, string, string, string, string];

      return { sha, short, author, date, subject };
    });
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

/** The architectural diff of every commit from `base` to `head`, one analysis per commit (the fact cache makes each cheap). */
export async function history(root: string, base: string, head: string): Promise<HistoryRow[]> {
  const commits = commitsBetween(root, base, head);
  const config = loadConfig(root);
  let previous = (await analyze(root, { overrides: treeAt(root, base), config })).graph;
  const rows: HistoryRow[] = [];

  for (const commit of commits) {
    const current = (await analyze(root, { overrides: treeAt(root, commit.sha), config })).graph;
    const diff = graphDiff(previous, current, commit.sha, []);
    rows.push({ commit, modulesAdded: diff.modulesAdded.length, modulesRemoved: diff.modulesRemoved.length, fnsChanged: diff.nodesAdded.length + diff.nodesRemoved.length + diff.nodesChanged.length, depsAdded: diff.depsAdded.length, depsRemoved: diff.depsRemoved.length, layerEdgesAdded: diff.layerEdgesAdded, layerEdgesRemoved: diff.layerEdgesRemoved, externalsAdded: diff.externalsAdded });
    previous = current;
  }

  return rows;
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

/** The commits that touched a file, newest first, for the history of a shape. */
export function fileHistory(root: string, path: string, limit = 30): Commit[] {
  const log = git(root, ["log", `-${limit}`, "--format=%H%x00%h%x00%an%x00%ad%x00%s", "--date=short", "--", path]);

  if (!log.ok) return [];

  return log.out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha, short, author, date, subject] = line.split("\0") as [string, string, string, string, string];

      return { sha, short, author, date, subject };
    });
}

function fnLabel(change: NodeChange): string {
  return `${change.kind} \`${change.id.slice(change.module.length + 1)}\` — ${change.module}:${change.line}`;
}

/** The review as Markdown: the summary, the Mermaid picture, every change by kind. */
export function reviewMarkdown(result: ReviewResult): string {
  const { diff, diagram } = result;
  const lines = [`<!-- archdiff:generated — review since ${diff.base} -->`, `# Architecture changes since ${diff.base}`, ""];
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

/** A branch of the repository, local or remote. */
export interface Branch {
  name: string;
  sha: string;
  date: string;
  subject: string;
  remote: boolean;
  current: boolean;
}

/** Every branch, local then remote (HEAD pointers left out), newest commit first, with the current one marked. */
export function listBranches(root: string): { current: string | null; branches: Branch[] } {
  const current = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = current.ok && current.out.trim() !== "HEAD" ? current.out.trim() : null;
  const log = git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%00%(objectname:short)%00%(committerdate:short)%00%(subject)", "refs/heads", "refs/remotes"]);

  if (!log.ok) throw new Error(log.error);
  const branches: Branch[] = [];

  for (const line of log.out.split("\n")) {
    if (line === "") continue;
    const [name, sha, date, subject] = line.split("\0") as [string, string, string, string];

    if (name.endsWith("/HEAD")) continue;
    branches.push({ name, sha, date, subject, remote: !git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).ok, current: name === head });
  }

  return { current: head, branches };
}

/** The base branch a comparison starts from: develop, main or master, local or on origin, whichever exists first; null when none. */
export function defaultBase(root: string): string | null {
  for (const candidate of ["develop", "main", "master", "origin/develop", "origin/main", "origin/master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]).ok) return candidate;
  }

  return null;
}

/** One head of a comparison against the base: its diff and the graph it was computed on. */
export interface Compared {
  head: string;
  diff: GraphDiff;
}

export interface ComparisonResult {
  base: string;
  heads: Compared[];
  diagram: Diagram;
}

/**
 * Several heads (branches, tags, commits, or the working tree as `WORKTREE`)
 * against one base: each head's own diff, and one picture of them all —
 * every module a head added, removed or changed, marked with the heads
 * that did; a change only one head made and one every head made read
 * differently at a glance.
 */
export async function compareBranches(root: string, base: string | null, heads: readonly string[]): Promise<ComparisonResult> {
  const baseRef = base ?? defaultBase(root) ?? mergeBase(root);
  const config = loadConfig(root);
  const baseGraph = (await analyze(root, { overrides: treeAt(root, baseRef), config })).graph;
  const compared: Compared[] = [];
  const graphs = new Map<string, Graph>();

  for (const head of heads) {
    const graph = (head === "WORKTREE" ? await analyze(root, { config }) : await analyze(root, { overrides: treeAt(root, head), config })).graph;
    graphs.set(head, graph);
    const changed = head === "WORKTREE" ? [...changedFiles(root, baseRef).base.keys()] : [...changedFiles(root, baseRef, head).base.keys()];
    compared.push({ head, diff: graphDiff(baseGraph, graph, `${baseRef}..${head}`, changed) });
  }

  return { base: baseRef, heads: compared, diagram: layout(compareDiagram(baseRef, compared, baseGraph, graphs)) };
}

/** The picture of a comparison: the modules any head touched, in their layers, labelled with what each head did to them; the imports any head added or removed, labelled with the head. */
export function compareDiagram(base: string, heads: readonly Compared[], baseGraph: Graph, graphs: ReadonlyMap<string, Graph>): Diagram {
  const marks = new Map<string, Map<string, DiffMark>>();

  const mark = (module: string, head: string, what: DiffMark): void => {
    const own = marks.get(module) ?? new Map<string, DiffMark>();

    // Added or removed outranks changed for the same head.
    if (own.get(head) !== "added" && own.get(head) !== "removed") own.set(head, what);
    marks.set(module, own);
  };

  for (const { head, diff } of heads) {
    for (const id of diff.modulesAdded) mark(id, head, "added");

    for (const id of diff.modulesRemoved) mark(id, head, "removed");

    for (const change of [...diff.nodesChanged, ...diff.nodesAdded, ...diff.nodesRemoved]) mark(change.module, head, "changed");
  }

  const glyph: Record<DiffMark, string> = { added: "+", removed: "−", changed: "~" };
  const nodes: DiagramNode[] = [];
  const everyHead = heads.length;

  for (const [id, own] of [...marks].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const module = baseGraph.modules.get(id) ?? [...graphs.values()].map((graph) => graph.modules.get(id)).find((candidate) => candidate !== undefined);

    if (!module) continue;
    const parts = [...own].map(([head, what]) => `${glyph[what]} ${head === "WORKTREE" ? "working tree" : head}`);
    const kinds = new Set(own.values());
    // The shape's own colour: what every head agrees on; a mixed picture is "changed".
    const colour: DiffMark = kinds.size === 1 ? [...kinds][0]! : "changed";
    const node: DiagramNode = { id, kind: "module", label: `${id}\n${parts.join("  ")}`, ref: { id, file: id, line: 1 }, group: module.layer, diff: colour, count: own.size, x: 0, y: 0, w: 0, h: 0 };

    if (own.size === everyHead && everyHead > 1) node.label = `${id}\n${glyph[colour]} every head`;
    nodes.push(node);
  }

  const edges: DiagramEdge[] = [];
  const seen = new Map<string, DiagramEdge>();

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
          const drawn: DiagramEdge = { from: edge.from, to: edge.to, kind: "dependency", diff: what, label: name };
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
      const module = baseGraph.modules.get(end) ?? [...graphs.values()].map((graph) => graph.modules.get(end)).find((candidate) => candidate !== undefined);
      const external = baseGraph.externals.get(end) ?? [...graphs.values()].map((graph) => graph.externals.get(end)).find((candidate) => candidate !== undefined);

      if (module) nodes.push({ id: end, kind: "module", label: end, ref: { id: end, file: end, line: 1 }, group: module.layer, x: 0, y: 0, w: 0, h: 0 });
      else if (external) nodes.push({ id: end, kind: "external", label: external.kind === "builtin" ? `node:${external.name}` : external.name, x: 0, y: 0, w: 0, h: 0 });
      ids.add(end);
    }
  }

  const layers = [...new Set([...baseGraph.layers, ...[...graphs.values()].flatMap((graph) => graph.layers)])].sort();
  const used = new Set(nodes.map((node) => node.group));
  const groups = layers.filter((layer) => used.has(layer)).map((layer) => ({ id: layer, label: layer, kind: "lane" as const, x: 0, y: 0, w: 0, h: 0 }));
  const diagram: Diagram = { view: `compare:${base}..${heads.map((head) => head.head).join(",")}`, title: `${heads.length} heads against ${base}`, nodes, edges, groups };

  if (nodes.length === 0) diagram.reason = "no head changed a module, function, import or call against the base";

  return diagram;
}

/** The comparison as Markdown: a table of the heads, the picture, and each head's own review. */
export function comparisonMarkdown(result: ComparisonResult): string {
  const lines = [`<!-- archdiff:generated — compare ${result.base} .. ${result.heads.map((head) => head.head).join(", ")} -->`, `# ${result.heads.length} heads against ${result.base}`, "", "| head | files | modules | functions | imports | calls | layer couplings |", "| --- | --- | --- | --- | --- | --- | --- |"];

  for (const { head, diff } of result.heads) {
    const couplings = diff.layerEdgesAdded.map((edge) => `⚠ +${edge.from}→${edge.to}`).concat(diff.layerEdgesRemoved.map((edge) => `−${edge.from}→${edge.to}`)).join(" ");
    lines.push(`| ${head === "WORKTREE" ? "working tree" : head} | ${diff.changedFiles.length} | +${diff.modulesAdded.length} −${diff.modulesRemoved.length} | +${diff.nodesAdded.length} −${diff.nodesRemoved.length} ~${diff.nodesChanged.length} | +${diff.depsAdded.length} −${diff.depsRemoved.length} | +${diff.callsAdded.length} −${diff.callsRemoved.length} | ${couplings} |`);
  }

  lines.push("");

  if (result.diagram.nodes.length > 0) lines.push("```mermaid", toMermaid(result.diagram).trimEnd(), "```", "");
  else lines.push(`_${result.diagram.reason}_`, "");

  // What every head shares and what only one has: the shape of the divergence.
  const touched = new Map<string, string[]>();

  for (const { head, diff } of result.heads) for (const id of new Set([...diff.modulesAdded, ...diff.modulesRemoved, ...diff.nodesChanged.map((change) => change.module), ...diff.nodesAdded.map((change) => change.module)])) touched.set(id, [...(touched.get(id) ?? []), head]);
  const shared = [...touched].filter(([, by]) => by.length === result.heads.length).map(([id]) => id);
  const only = [...touched].filter(([, by]) => by.length === 1);

  if (result.heads.length > 1) {
    lines.push("## Touched by every head", "", ...(shared.length > 0 ? shared.map((id) => `- ${id}`) : ["- none"]), "", "## Touched by one head only", "");

    for (const [id, by] of only) lines.push(`- ${id} — ${by[0] === "WORKTREE" ? "working tree" : by[0]}`);

    if (only.length === 0) lines.push("- none");
    lines.push("");
  }

  for (const { head, diff } of result.heads) {
    lines.push(`## ${head === "WORKTREE" ? "working tree" : head}`, "");
    const section = (title: string, items: string[]): void => {
      if (items.length > 0) lines.push(`### ${title}`, "", ...items.map((item) => `- ${item}`), "");
    };
    section("New dependencies between layers", diff.layerEdgesAdded.map((edge) => `**${edge.from} → ${edge.to}**`));
    section("Modules added", diff.modulesAdded);
    section("Modules removed", diff.modulesRemoved);
    section("Functions changed", diff.nodesChanged.map(fnLabel));
    section("Imports added", diff.depsAdded.map((edge) => `${edge.from} → ${edge.to}`));
    section("Imports removed", diff.depsRemoved.map((edge) => `${edge.from} → ${edge.to}`));
  }

  return `${lines.join("\n").trimEnd()}\n`;
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
    const id = node.ref?.id ?? node.id;
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
  const reason = `${marked} shapes changed since ${diff.base}${removed > 0 ? `; ${removed} removed (not drawn)` : ""}${diagram.reason ? `; ${diagram.reason}` : ""}`;

  return { ...diagram, nodes, edges, reason, title: `${diagram.title} — changes since ${diff.base}` };
}
