// The picture of a view, drawn the one way every command draws it: the
// CLI's `diagram`, `review` and `compare`, and the page's scene, a shape's
// and a line's page, an export, a tag of the chat. A request names the
// view, the picture's options (options.ts) and the refs (a base, a head,
// heads). What the view needs from git or a file is read here — the
// commits of a timeline, the two analyses of a review, the heads of a
// comparison, a function's body for its logic, the review's diff for
// `changes` — then the view is drawn (viewOf), placed where the saved
// drawing puts its shapes (layout), stamped with the revision and written
// as Markdown. One picture per analysis and request: asking twice is a
// lookup.
//
// Sits at the edge, between the commands (cli.ts, server.ts) and the
// views. Entry points: `drawPicture`, `PictureRequest`, `Picture`,
// `Change`, `Refs`, `NO_REFS`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Analysis } from "./analyze.ts";
import { layout, type Diagram } from "./diagram.ts";
import { comparisonMarkdown, reviewMarkdown, type Compared, type GraphDiff } from "./diff.ts";
import { readLogic, type LogicFact } from "./extract/logic.ts";
import { mergeBase, revisionStamp } from "./git.ts";
import { positionsOf, readDrawing, type DrawingFile } from "./drawings.ts";
import { diagramMarkdown } from "./markdown.ts";
import type { PictureOptions } from "./options.ts";
import { compareBranches, history, review } from "./review.ts";
import { viewKey, type View } from "./view-keys.ts";
import { viewOf, type EdgeReads } from "./views.ts";

/**
 * The revisions a picture is drawn against: the base (null: the
 * merge-base with develop, main or master; for a comparison that branch
 * itself), the head (null: the working tree) and the heads of a
 * comparison (`WORKTREE` for the working tree).
 */
export interface Refs {
  base: string | null;
  head: string | null;
  heads: readonly string[];
}

export const NO_REFS: Refs = { base: null, head: null, heads: [] };

export interface PictureRequest {
  view: View;
  options: PictureOptions;
  refs: Refs;
}

/** What a review or a comparison found, beside its picture: the exit code of the CLI and the page's title read it. */
export type Change = { kind: "review"; diff: GraphDiff; contract: boolean } | { kind: "compare"; base: string; heads: readonly Compared[] };

export interface Picture {
  /** The placed diagram, stamped with the revision it was drawn from. */
  diagram: Diagram;
  /** Its Markdown page: a review's or a comparison's report for those, the picture's page for the rest. */
  markdown: string;
  /** The saved drawing of the view, when there is one: its shapes' places are the picture's. */
  drawing: DrawingFile | null;
  change?: Change;
}

/** The pictures drawn per analysis, by request: a new analysis (a changed file) starts afresh. */
const pictures = new WeakMap<Analysis, Map<string, Promise<Picture>>>();

/** The picture of a request on `analysis`; drawn once per analysis and request (a saved drawing changes the request). */
export function drawPicture(analysis: Analysis, request: PictureRequest): Promise<Picture> {
  const key = viewKey(request.view);
  const drawing = readDrawing(analysis.root, key);
  const memoKey = JSON.stringify([key, request.options, request.refs, drawing?.saved ?? null]);
  const known = pictures.get(analysis) ?? new Map<string, Promise<Picture>>();
  pictures.set(analysis, known);
  let picture = known.get(memoKey);

  if (!picture) {
    picture = draw(analysis, request, drawing);
    known.set(memoKey, picture);
    // A picture that could not be drawn (no git, a bad ref) is not kept: the next ask tries again.
    picture.catch(() => known.delete(memoKey));
  }

  return picture;
}

async function draw(analysis: Analysis, { view, options, refs }: PictureRequest, drawing: DrawingFile | null): Promise<Picture> {
  const { reads, change, notes } = await readAtTheEdge(analysis, view, options, refs);
  const content = viewOf(analysis, view, options, reads);
  // What the edge could not read for the picture (the changes outside git) is said after what the picture says itself.
  const said = notes.length > 0 ? { ...content, reason: [content.reason, ...notes].filter(Boolean).join("; ") } : content;
  const placed = layout(said, positionsOf(drawing?.elements ?? null));
  const stamp = revisionStamp(analysis.root);
  const diagram = stamp ? { ...placed, stamp } : placed;
  const markdown = change?.kind === "review" ? reviewMarkdown(change.diff, diagram, change.contract) : change?.kind === "compare" ? comparisonMarkdown(change.base, change.heads, diagram) : diagramMarkdown(diagram, analysis, options.mermaid);

  return change ? { diagram, markdown, drawing, change } : { diagram, markdown, drawing };
}

/**
 * What a view reads beside the analysis, by its kind: the commits of the
 * range for a timeline, the two analyses of a review, the heads of a
 * comparison, a function's body for its logic; and, with `changes` on any
 * other view, the review's diff to lay its marks over the picture. A view
 * that is a change (a timeline, a review, a comparison) fails when git
 * refuses; the changes laid over another view are only left out, with a
 * note saying why (`notes`), and the picture is drawn without them.
 */
async function readAtTheEdge(analysis: Analysis, view: View, options: PictureOptions, refs: Refs): Promise<{ reads: EdgeReads; change?: Change; notes: string[] }> {
  const { root } = analysis;

  if (view.kind === "timeline") {
    const head = refs.head ?? "HEAD";
    const base = refs.base ?? mergeBase(root, head);

    return { reads: { timeline: { rows: await history(root, base, head), base, head } }, notes: [] };
  }

  if (view.kind === "review") {
    const result = await review(root, refs.base, refs.head, analysis);

    return { reads: { review: { diff: result.diff, base: result.base.graph, head: result.head.graph } }, change: { kind: "review", diff: result.diff, contract: result.contract }, notes: [] };
  }

  if (view.kind === "compare") {
    const result = await compareBranches(root, refs.base, refs.heads.length > 0 ? refs.heads : ["WORKTREE"]);

    return { reads: { compare: result }, change: { kind: "compare", base: result.base, heads: result.heads }, notes: [] };
  }

  const reads: EdgeReads = {};
  const notes: string[] = [];

  if (view.kind === "logic" && view.subject !== null) reads.logic = await logicOf(analysis, view.subject);

  if (options.changes) {
    try {
      reads.diff = (await review(root, refs.base, refs.head, analysis)).diff;
    } catch (error) {
      notes.push(`⚠ the changes are not laid over: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { reads, notes };
}

/** The flowchart of a function, read from its file now; null when the file or the function cannot be read. */
async function logicOf(analysis: Analysis, id: string): Promise<LogicFact | null> {
  const node = analysis.graph.nodes.get(id);

  if (!node || node.kind !== "fn") return null;
  let source: string;

  try {
    source = readFileSync(join(analysis.root, node.module), "utf8");
  } catch {
    return null;
  }

  return readLogic(node.module, source, node.parent ? `${node.parent}.${node.name}` : node.name, node.line);
}
