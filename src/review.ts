// What a change is, read from git: the working tree (or a ref) against a
// base revision, several heads against one base, and every commit of a
// range — each as analyses of the revisions without a checkout. Git names
// the files that differ and gives their content at a revision; an analysis
// of a revision is the current one with those files replaced, so only the
// changed files are parsed twice. The diff of two graphs is diff.ts's,
// pure; here is only the reading.
//
// Sits at the edge, between the commands (and picture.ts) and diff.ts.
// Entry points: `review`, `compareBranches`, `history`, `ReviewResult`,
// `ComparisonResult`.

import { analyze, type Analysis } from "./analyze.ts";
import { loadConfig } from "./config.ts";
import { graphDiff, markContract, type Compared, type GraphDiff, type HistoryRow } from "./diff.ts";
import { changedFiles, commitsBetween, defaultBase, mergeBase, treeAt } from "./git.ts";
import type { Graph } from "./graph.ts";

export interface ReviewResult {
  /** The head has a contract (ARCHITECTURE.md): a new layer dependency is a finding only when it goes against it. */
  contract: boolean;
  head: Analysis;
  base: Analysis;
  diff: GraphDiff;
}

export interface ComparisonResult {
  base: string;
  heads: Compared[];
  /** The graph of the base and of every head, for the picture of the comparison. */
  baseGraph: Graph;
  graphs: Map<string, Graph>;
}

/**
 * The head (a ref, or the working tree when null) against the base, and
 * the diff between them. `base` null: the merge-base with the main
 * branch. `current`, when given, is the working tree's analysis already
 * made, so a review of the working tree does not read it twice.
 */
export async function review(root: string, base: string | null, headRef: string | null = null, current: Analysis | null = null): Promise<ReviewResult> {
  const ref = base ?? mergeBase(root);
  const config = loadConfig(root);
  const head = headRef === null ? (current ?? (await analyze(root, { config }))) : await analyze(root, { overrides: treeAt(root, headRef), config });
  const baseAnalysis = await analyze(root, { overrides: treeAt(root, ref), config });
  const changed = changedFiles(root, ref, headRef);
  const diff = markContract(graphDiff(baseAnalysis.graph, head.graph, headRef === null ? ref : `${ref}..${headRef}`, [...changed.base.keys()]), head.intent, head.graph);

  return { head, base: baseAnalysis, diff, contract: head.intent !== null };
}

/**
 * Several heads (branches, tags, commits, or the working tree as
 * `WORKTREE`) against one base (`base` null: develop, main or master,
 * else the merge-base): each head's own diff, marked against its
 * contract, and the graphs a picture of them all is drawn from.
 */
export async function compareBranches(root: string, base: string | null, heads: readonly string[]): Promise<ComparisonResult> {
  const baseRef = base ?? defaultBase(root) ?? mergeBase(root);
  const config = loadConfig(root);
  const baseGraph = (await analyze(root, { overrides: treeAt(root, baseRef), config })).graph;
  const compared: Compared[] = [];
  const graphs = new Map<string, Graph>();

  for (const head of heads) {
    const analysis = head === "WORKTREE" ? await analyze(root, { config }) : await analyze(root, { overrides: treeAt(root, head), config });
    const { graph } = analysis;
    graphs.set(head, graph);
    const changed = head === "WORKTREE" ? [...changedFiles(root, baseRef).base.keys()] : [...changedFiles(root, baseRef, head).base.keys()];
    compared.push({ head, diff: markContract(graphDiff(baseGraph, graph, `${baseRef}..${head}`, changed), analysis.intent, graph), contract: analysis.intent !== null });
  }

  return { base: baseRef, heads: compared, baseGraph, graphs };
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
