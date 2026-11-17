// What a change did to the logic of one function: the flowchart of its
// body at the base held against the one it has now. The two are read as a
// reader would read them — a condition, a statement, an exit, by what it
// says — and matched in the order the code writes them: the longest run of
// statements both have, in that order. Between two matched ones a statement
// gone and a statement come of one kind that read alike are one statement,
// rewritten.
//
// The match is by statement and not by box, because a box of the picture
// holds up to two statements: one statement added shifts the pairing of
// every box after it, and a diff of boxes would call them all changed. So
// a box is new when none of its statements was there, changed when some
// were not (or some of the base's are gone from it), and an arrow is new
// or gone only between statements that were, and are, in different boxes.
//
// Pure: two LogicFacts in, the marks out. logic.ts lays them over the
// picture and lists them. Entry points: `logicDelta`, `LogicDelta`,
// `StepDelta`, `GONE`, `arrowKey`.

import type { LogicEdge, LogicFact, LogicStep } from "./extract/logic.ts";

/** The prefix of the id a step of the base gets in the head's picture, where it is drawn as gone. */
export const GONE = "gone:";

/** How alike two statements have to read to be one statement rewritten, as the share of their words both have. */
const ALIKE = 0.5;

/** A step of the head that the change touched: what of it is new, and what it had that is gone. */
export interface StepDelta {
  step: LogicStep;
  /** The statements (a condition, an exit, a line of an action) it has that the base had not. */
  came: string[];
  /** The statements the base had in its place that are gone. */
  went: string[];
}

export interface LogicDelta {
  /** The head's steps none of whose statements was there. */
  added: LogicStep[];
  /** The head's steps that kept some of what they said. */
  changed: StepDelta[];
  /** The base's steps of which nothing is left, their ids prefixed with `GONE` for the picture. */
  removed: LogicStep[];
  /** The head's arrows the base had not, as `arrowKey` writes them. */
  arrowsAdded: Set<string>;
  /** The base's arrows the head has not, between the picture's ids (a gone step's with its prefix). */
  arrowsRemoved: LogicEdge[];
}

/** An arrow as a key: its two ends and the branch it is. */
export function arrowKey(edge: { from: string; to: string; label?: string }): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.label ?? ""}`;
}

/** One statement of a step: a condition, an exit, or one line of an action. */
interface Said {
  step: LogicStep;
  text: string;
  key: string;
}

/** The statements of a flowchart in the order the code writes them; the start and the end say nothing. */
function saidBy(fact: LogicFact): Said[] {
  const steps = fact.nodes.map((step, index) => ({ step, index })).filter(({ step }) => step.kind !== "start" && step.kind !== "end");
  steps.sort((a, b) => a.step.line - b.step.line || a.index - b.index);

  return steps.flatMap(({ step }) => (step.kind === "action" ? step.text.split("\n") : [step.text]).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line !== "").map((text) => ({ step, text, key: `${step.kind}\u0000${text}` })));
}

/** How alike two statements read, 0 to 1: the share of their words and signs both have. */
function alike(one: string, other: string): number {
  const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  const left = words(one);
  const right = words(other);

  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map<string, number>();

  for (const word of left) counts.set(word, (counts.get(word) ?? 0) + 1);
  let both = 0;

  for (const word of right) {
    const had = counts.get(word) ?? 0;

    if (had > 0) {
      both++;
      counts.set(word, had - 1);
    }
  }

  return (2 * both) / (left.length + right.length);
}

/**
 * The statements of `base` and `head` matched: for each of the base's the index of the head's it is (−1: gone), the
 * same the other way, and which matches are rewritings (the statement reads otherwise now).
 */
function matched(base: readonly Said[], head: readonly Said[]): { toHead: number[]; toBase: number[]; rewritten: Set<number> } {
  const rows = base.length;
  const cols = head.length;
  // The longest run both have in order, from the end, so that the walk from the start prefers the earliest match.
  const run: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));

  for (let i = rows - 1; i >= 0; i--) for (let j = cols - 1; j >= 0; j--) run[i]![j] = base[i]!.key === head[j]!.key ? run[i + 1]![j + 1]! + 1 : Math.max(run[i + 1]![j]!, run[i]![j + 1]!);
  const toHead = new Array<number>(rows).fill(-1);
  const toBase = new Array<number>(cols).fill(-1);
  const rewritten = new Set<number>();
  let gone: number[] = [];
  let come: number[] = [];

  // Between two statements both have: a statement gone and one come, of one kind and reading alike, are one rewritten.
  const closeGap = (): void => {
    for (const i of gone) {
      const at = come.findIndex((j) => head[j]!.step.kind === base[i]!.step.kind && alike(base[i]!.text, head[j]!.text) >= ALIKE);

      if (at === -1) continue;
      const [j] = come.splice(at, 1) as [number];
      toHead[i] = j;
      toBase[j] = i;
      rewritten.add(j);
    }

    gone = [];
    come = [];
  };

  let i = 0;
  let j = 0;

  while (i < rows && j < cols) {
    if (base[i]!.key === head[j]!.key) {
      closeGap();
      toHead[i] = j;
      toBase[j] = i;
      i++;
      j++;
    } else if (run[i + 1]![j]! >= run[i]![j + 1]!) gone.push(i++);
    else come.push(j++);
  }

  while (i < rows) gone.push(i++);

  while (j < cols) come.push(j++);
  closeGap();

  return { toHead, toBase, rewritten };
}

/** What the change from `before` to `after` did to the steps and the arrows of a function's logic. */
export function logicDelta(before: LogicFact, after: LogicFact): LogicDelta {
  const base = saidBy(before);
  const head = saidBy(after);
  const { toHead, toBase, rewritten } = matched(base, head);
  const baseOf = new Map<string, number[]>();
  const headOf = new Map<string, number[]>();

  base.forEach((said, index) => baseOf.set(said.step.id, [...(baseOf.get(said.step.id) ?? []), index]));
  head.forEach((said, index) => headOf.set(said.step.id, [...(headOf.get(said.step.id) ?? []), index]));
  const deltas = new Map<string, StepDelta>();
  const deltaOf = (step: LogicStep): StepDelta => {
    const known = deltas.get(step.id) ?? { step, came: [], went: [] };
    deltas.set(step.id, known);

    return known;
  };
  const added: LogicStep[] = [];

  for (const step of after.nodes) {
    const said = headOf.get(step.id) ?? [];

    if (said.length === 0) continue;

    if (said.every((index) => toBase[index] === -1)) {
      added.push(step);
      continue;
    }

    for (const index of said) {
      if (toBase[index] === -1) deltaOf(step).came.push(head[index]!.text);
      else if (rewritten.has(index)) {
        deltaOf(step).came.push(head[index]!.text);
        deltaOf(step).went.push(base[toBase[index]!]!.text);
      }
    }
  }

  const removed: LogicStep[] = [];

  for (const step of before.nodes) {
    const said = baseOf.get(step.id) ?? [];
    const left = said.filter((index) => toHead[index] !== -1);

    if (said.length === 0) continue;

    if (left.length === 0) {
      removed.push({ ...step, id: `${GONE}${step.id}` });
      continue;
    }

    // A statement gone from a step that lives on: gone from the step of the head that holds the rest of it.
    const heir = head[toHead[left[0]!]!]!.step;

    for (const index of said) if (toHead[index] === -1) deltaOf(heir).went.push(base[index]!.text);
  }

  // The ends of an arrow, each as the other side has it: an arrow leaves a step after its last statement and enters it
  // before its first. A step of which nothing is on the other side has no end there.
  const frame = (from: LogicFact, to: LogicFact, kind: "start" | "end"): [string, string] | null => {
    const one = from.nodes.find((step) => step.kind === kind);
    const other = to.nodes.find((step) => step.kind === kind);

    return one && other ? [one.id, other.id] : null;
  };
  const across = (ofStep: Map<string, number[]>, to: readonly number[], other: readonly Said[], frames: ReadonlyMap<string, string>) => (id: string, end: "from" | "to"): string | undefined => {
    const said = (ofStep.get(id) ?? []).filter((index) => to[index] !== -1);
    const index = end === "from" ? said.at(-1) : said[0];

    return index === undefined ? frames.get(id) : other[to[index]!]!.step.id;
  };
  const framesToHead = new Map([frame(before, after, "start"), frame(before, after, "end")].filter((pair): pair is [string, string] => pair !== null));
  const framesToBase = new Map([...framesToHead].map(([one, other]) => [other, one]));
  const inHead = across(baseOf, toHead, head, framesToHead);
  const inBase = across(headOf, toBase, base, framesToBase);
  const headArrows = new Set(after.edges.map(arrowKey));
  const baseArrows = new Set(before.edges.map(arrowKey));
  const arrowsAdded = new Set<string>();

  for (const edge of after.edges) {
    const from = inBase(edge.from, "from");
    const to = inBase(edge.to, "to");

    // Between two statements one step of the base held: no arrow then, and none new now — the box was only cut in two.
    if (from !== undefined && to !== undefined && from === to && edge.from !== edge.to) continue;

    if (from === undefined || to === undefined || !baseArrows.has(arrowKey({ ...edge, from, to }))) arrowsAdded.add(arrowKey(edge));
  }

  const arrowsRemoved: LogicEdge[] = [];

  for (const edge of before.edges) {
    const from = inHead(edge.from, "from");
    const to = inHead(edge.to, "to");

    if (from !== undefined && to !== undefined && from === to && edge.from !== edge.to) continue;
    const drawn = { ...edge, from: from ?? `${GONE}${edge.from}`, to: to ?? `${GONE}${edge.to}` };

    if (from === undefined || to === undefined || !headArrows.has(arrowKey(drawn))) arrowsRemoved.push(drawn);
  }

  return { added, changed: [...deltas.values()].filter((delta) => delta.came.length > 0 || delta.went.length > 0), removed, arrowsAdded, arrowsRemoved };
}
