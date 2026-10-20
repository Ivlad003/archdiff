// What a change is, read from git: the working tree (or a ref) against a
// base revision, several heads against one base, and every commit of a
// range — each as analyses of the revisions without a checkout. Git names
// the files that differ and gives their content at a revision; an analysis
// of a revision is the current one with those files replaced, so only the
// changed files are parsed twice. The diff of two graphs is diff.ts's,
// pure; here is only the reading.
//
// Sits at the edge, between the commands (and picture.ts) and diff.ts.
// Entry points: `review`, `compareBranches`, `history`, `analysisAt`,
// `ReviewResult`, `ComparisonResult`.

import { analyze, analyzeRevisions, type Analysis } from "./analyze.ts";
import { loadConfig, type Config } from "./config.ts";
import { graphDiff, historyRow, markContract, type Compared, type GraphDiff, type HistoryRow } from "./diff.ts";
import { changedFiles, commitOf, commitsBetween, defaultBase, forkPoint, mergeBase, treeAt as filesAt } from "./git.ts";
import { INTENT_FILE, judgesLayers } from "./intent.ts";
import type { Graph } from "./graph.ts";

/** A revision as overrides of the working tree: its source files, and its contract, which its analysis is held to. */
function treeAt(root: string, ref: string): Map<string, string | null> {
  return filesAt(root, ref, [INTENT_FILE]);
}

/** The analyses of the revisions, their files parsed in one batch. */
async function analysesAt(root: string, refs: readonly string[], config: Config): Promise<Analysis[]> {
  const analyses: Analysis[] = [];

  for await (const analysis of analyzeRevisions(root, refs.map((ref) => treeAt(root, ref)), config)) analyses.push(analysis);

  return analyses;
}

/** The analysis of a revision (a branch, a tag, a commit) without a checkout: the working tree with the revision's files laid over it; a ref git does not know is refused by name. */
export async function analysisAt(root: string, ref: string): Promise<Analysis> {
  if (commitOf(root, ref) === null) throw new Error(`no branch, tag or commit "${ref}" (archdiff branches lists the branches)`);

  return analyze(root, { overrides: treeAt(root, ref), config: loadConfig(root) });
}

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
  /** The graph of where each head left the base (its merge-base), by head: what a head removed was there. */
  forks: Map<string, Graph>;
}

/**
 * The head (a ref, or the working tree when null) against the base, and
 * the diff between them. `base` null: the merge-base with develop, main
 * or master. `current`, when given, is the working tree's analysis
 * already made, so a review of the working tree does not read it twice.
 */
export async function review(root: string, base: string | null, headRef: string | null = null, current: Analysis | null = null): Promise<ReviewResult> {
  return reviewUncached(root, base, headRef, current);
}

/** The reviews made on one analysis, by base and head: one page load asks for the same review from the views list and from the picture. */
const reviews = new WeakMap<Analysis, Map<string, Promise<ReviewResult>>>();

/** The review of `headRef` against `base` on `current` (the working tree's analysis), made once per analysis and refs; a review that failed (no git, a bad ref) is not kept. */
export function reviewOf(current: Analysis, base: string | null, headRef: string | null = null): Promise<ReviewResult> {
  const key = `${base ?? ""}\u0000${headRef ?? ""}`;
  const known = reviews.get(current) ?? new Map<string, Promise<ReviewResult>>();
  reviews.set(current, known);
  let result = known.get(key);

  if (!result) {
    result = reviewUncached(current.root, base, headRef, current);
    result.catch(() => known.delete(key));
    known.set(key, result);
  }

  return result;
}

async function reviewUncached(root: string, base: string | null, headRef: string | null, current: Analysis | null): Promise<ReviewResult> {
  const ref = base ?? mergeBase(root, headRef ?? "HEAD");
  const config = loadConfig(root);
  // The head's and the base's files are parsed in one batch; the working tree is the analysis already made.
  const analyses = await analysesAt(root, headRef === null ? [ref] : [headRef, ref], config);
  const head = headRef === null ? (current ?? (await analyze(root, { config }))) : analyses[0]!;
  const baseAnalysis = analyses[analyses.length - 1]!;
  const changed = changedFiles(root, ref, headRef);
  // A contract that names no layer judges nothing: the review is as without one.
  const contract = judgesLayers(head.intent) ? head.intent : null;
  const diff = markContract(graphDiff(baseAnalysis.graph, head.graph, headRef === null ? ref : `${ref}..${headRef}`, [...changed.base.keys()]), contract, head.graph);

  return { head, base: baseAnalysis, diff, contract: contract !== null };
}

/**
 * Several heads (branches, tags, commits, or the working tree as
 * `WORKTREE`) against one base (`base` null: develop, main or master,
 * else the merge-base): each head's own diff — from where it left the
 * base (their merge-base) to the head, as its pull request would show it,
 * so what landed on the base since is not read as the head's doing —
 * marked against its contract, and the graphs a picture of them all is
 * drawn from. A head named twice is compared once; a ref git does not
 * know is refused by name.
 */
export async function compareBranches(root: string, base: string | null, heads: readonly string[]): Promise<ComparisonResult> {
  const baseRef = base ?? defaultBase(root) ?? mergeBase(root);
  const unique = [...new Set(heads)];

  /** The commit of every ref: a ref git does not know is refused; heads and fork points at one commit share its analysis. */
  const commitOfRef = new Map<string, string>();

  for (const ref of [baseRef, ...unique]) {
    const commit = ref === "WORKTREE" ? "WORKTREE" : commitOf(root, ref);

    if (commit === null) throw new Error(`no branch, tag or commit "${ref}" (archdiff branches lists the branches)`);
    commitOfRef.set(ref, commit);
  }

  const config = loadConfig(root);
  // Where each head left the base; the base itself when the two share no commit.
  const since = new Map(unique.map((head) => [head, forkPoint(root, baseRef, head === "WORKTREE" ? "HEAD" : head) ?? commitOfRef.get(baseRef)!]));
  // Every commit analysed once — the base, the fork points, the heads — their files parsed in one batch.
  const commits = [...new Set([...commitOfRef.values(), ...since.values()])].filter((commit) => commit !== "WORKTREE");
  const analyses = await analysesAt(root, commits, config);
  const at = new Map(commits.map((commit, i) => [commit, analyses[i]!]));
  const worktree = commitOfRef.has("WORKTREE") ? await analyze(root, { config }) : null;
  const compared: Compared[] = [];
  const graphs = new Map<string, Graph>();
  const forks = new Map<string, Graph>();

  for (const head of unique) {
    const left = since.get(head)!;
    const from = at.get(left)!.graph;
    forks.set(head, from);
    const analysis = head === "WORKTREE" ? worktree! : at.get(commitOfRef.get(head)!)!;
    const { graph } = analysis;
    graphs.set(head, graph);
    const changed = head === "WORKTREE" ? [...changedFiles(root, left).base.keys()] : [...changedFiles(root, left, head).base.keys()];
    const contract = judgesLayers(analysis.intent) ? analysis.intent : null;
    compared.push({ head, since: left, diff: markContract(graphDiff(from, graph, `${left}..${head}`, changed), contract, graph), contract: contract !== null });
  }

  return { base: baseRef, heads: compared, baseGraph: at.get(commitOfRef.get(baseRef)!)!.graph, graphs, forks };
}

/** The architectural diff of every commit from `base` to `head`, one analysis per commit (the fact cache makes each cheap). */
export async function history(root: string, base: string, head: string): Promise<HistoryRow[]> {
  const commits = commitsBetween(root, base, head);
  const config = loadConfig(root);
  // The base's and every commit's tree, their files parsed together; then one analysis per commit, each against the one before.
  const trees = [treeAt(root, base), ...commits.map((commit) => treeAt(root, commit.sha))];
  const rows: HistoryRow[] = [];
  let previous: Graph | null = null;

  for await (const { graph } of analyzeRevisions(root, trees, config)) {
    if (previous) rows.push(historyRow(commits[rows.length]!, graphDiff(previous, graph, commits[rows.length]!.sha, [])));
    previous = graph;
  }

  return rows;
}
