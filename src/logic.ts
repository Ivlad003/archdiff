// The logic of the code as pictures: `logic` lists the functions by how
// much they branch (the ones with business rules in them), and
// `logic:<path>#<fn>` draws one function's body as a flowchart — a
// diamond per branch or loop with the condition as written, a box per
// run of statements, an ellipse per exit — and lists every path from the
// start to an exit as a rule: the conditions taken, the calls made, how
// it ends. The flowchart is read from the file on demand (extract/logic.ts,
// by picture.ts at the edge), not kept in the facts.
//
// With `changes` the body is held against what it was at the base
// (logic-diff.ts): the steps that are new or changed wear the marks of a
// review, the steps and the arrows that are gone are drawn where they
// hung, and the page lists what came and went — steps, and rules.
//
// Pure functions of the analysis and the fact read for the view. Entry
// points: `logicView`, `logicList`, `logicChanges`, `LogicBefore`.

import type { Analysis } from "./analyze.ts";
import type { PictureContent, Line, Shape, LogicChanges, LogicData, LogicRule, LogicStepChange } from "./diagram.ts";
import type { LogicEdge, LogicFact, LogicStep } from "./extract/logic.ts";
import { arrowKey, logicDelta, type LogicDelta } from "./logic-diff.ts";
import { moduleOf, type Declaration } from "./graph.ts";
import { lane, unplaced } from "./nodes.ts";
import { counted } from "./words.ts";

/** Rules listed in the table of a function, at most. */
const MAX_RULES = 64;

/** Functions the `logic` list draws, at most, the most branching first. */
const MAX_LISTED = 60;

/** The functions with branches in them, the most branching first; what the `logic` list draws and the views list names. */
export function logicList(analysis: Analysis): Declaration[] {
  return [...analysis.graph.nodes.values()].filter((node) => node.kind === "fn" && (node.branches ?? 0) > 0).sort((a, b) => (b.branches ?? 0) - (a.branches ?? 0) || (a.id < b.id ? -1 : 1));
}

/** The label of a function in prose: `Class.method` or `name`. */
function fnLabel(node: Declaration): string {
  return node.parent ? `${node.parent}.${node.name}` : node.name;
}

/**
 * Every path from the start to an exit, the branches taken on the way as
 * conditions and the calls as a list: the rules of the function. A loop is
 * walked once (its body, then on out of it and out of the loops around it),
 * so a path through it says what the body does, the branch back into the
 * loop included; a path that runs a `finally` after a `return` or a `throw`
 * ends with that exit. The list is cut at `MAX_RULES`.
 */
function rulesOf(fact: LogicFact): { rules: LogicRule[]; more: number } {
  const byId = new Map(fact.nodes.map((node) => [node.id, node]));
  const edgesFrom = new Map<string, LogicEdge[]>();

  for (const edge of fact.edges) edgesFrom.set(edge.from, [...(edgesFrom.get(edge.from) ?? []), edge]);
  const rules: LogicRule[] = [];
  let more = 0;
  let steps = 0;

  // `exit`: the `return` or `throw` the path passed on its way to the end through a `finally`; it is the rule's outcome.
  const walk = (id: string, conditions: string[], calls: string[], exit: LogicStep | null = null): void => {
    const node = byId.get(id);

    if (!node || steps++ > 20_000) return;
    const out = edgesFrom.get(id) ?? [];
    const isExit = node.kind === "return" || node.kind === "throw";

    if ((isExit && out.length === 0) || node.kind === "end") {
      const made = [...calls, ...(node.calls ?? []).filter((call) => !calls.includes(call))];
      // The end after a `finally` is the exit the path left by.
      const outcome = node.kind === "end" && exit ? exit : node;
      const kind: LogicRule["kind"] = outcome.kind === "throw" ? "throw" : outcome.kind === "return" ? "return" : "end";

      if (rules.length < MAX_RULES) rules.push({ conditions, calls: made, outcome: outcome.text, kind });
      else more++;

      return;
    }

    const made = node.kind === "action" || node.kind === "loop" || isExit ? [...calls, ...(node.calls ?? []).filter((call) => !calls.includes(call))] : calls;
    const leaving = isExit ? node : exit;

    for (const edge of out) {
      // The branch taken is a condition of the rule, the arrow back into a loop (`x > 0: no`, a `continue`) as much as any.
      const taken = node.kind === "decision" || node.kind === "loop" ? [...conditions, `${node.text}: ${edge.label ?? "then"}`] : conditions;

      // The only arrows that lead back are the ones into a loop's header: the loop is walked once, so the path carries on
      // after it instead.
      if (edge.back) leave(edge.to, taken, made, new Set(), leaving);
      else walk(edge.to, taken, made, leaving);
    }
  };

  // Out of a loop walked once: on along the arrows that leave it (`done`, a `for … else`; not the one into its body); an
  // arrow that leads back into a loop around it (an inner loop's `done` as the last step of the outer one's body) leaves
  // that loop in turn.
  const leave = (loop: string, conditions: string[], calls: string[], left: Set<string>, exit: LogicStep | null): void => {
    left.add(loop);

    for (const after of edgesFrom.get(loop) ?? []) {
      if (after.enters) continue;

      if (!after.back) walk(after.to, conditions, calls, exit);
      else if (!left.has(after.to)) leave(after.to, conditions, calls, left, exit);
    }
  };

  const start = fact.nodes.find((node) => node.kind === "start");

  if (start) walk(start.id, [], []);

  return { rules, more };
}

/** The resolved callee of a step: the first call of the function whose line falls in the step, by preference one with logic of its own. */
function calleeOf(analysis: Analysis, fnId: string, step: LogicStep): string | null {
  const calls = analysis.graph.calls.filter((call) => call.from === fnId && call.line >= step.line && call.line <= step.endLine && call.kind === "call");
  const branching = calls.find((call) => (analysis.graph.nodes.get(call.to)?.branches ?? 0) > 0);

  return (branching ?? calls[0])?.to ?? null;
}

/** The body of a function as the base of a change had it: its flowchart (null: the function was not there, or could not be read), and what the base is called. */
export interface LogicBefore {
  fact: LogicFact | null;
  since: string;
}

/** A step as a change lists it. */
function stepChange(step: LogicStep, more: Pick<LogicStepChange, "came" | "went"> = {}): LogicStepChange {
  return { kind: step.kind as LogicStepChange["kind"], text: step.text, line: step.line, ...more };
}

/** A rule as one line, to tell two rules apart. */
function ruleKey(rule: LogicRule): string {
  return `${rule.conditions.join(" \u2227 ")} \u21d2 ${rule.kind} ${rule.outcome} [${rule.calls.join(", ")}]`;
}

/**
 * What the change from `before` did to the logic `fact` has now: the steps and the rules that came and went, and the
 * marks for the picture (`delta`; null when the function is new, all of it added).
 */
export function logicChanges(fact: LogicFact, before: LogicBefore): { changes: LogicChanges; delta: LogicDelta | null } {
  const rules = rulesOf(fact).rules;

  if (!before.fact) {
    const steps = fact.nodes.filter((step) => step.kind !== "start" && step.kind !== "end");

    return { changes: { since: before.since, isNew: true, added: steps.map((step) => stepChange(step)), removed: [], changed: [], rulesAdded: rules, rulesRemoved: [] }, delta: null };
  }

  const delta = logicDelta(before.fact, fact);
  const had = rulesOf(before.fact).rules;
  const hadKeys = new Set(had.map(ruleKey));
  const hasKeys = new Set(rules.map(ruleKey));
  const byLine = (a: LogicStepChange, b: LogicStepChange): number => a.line - b.line;

  return {
    changes: {
      since: before.since,
      added: delta.added.map((step) => stepChange(step)).sort(byLine),
      removed: delta.removed.map((step) => stepChange(step)).sort(byLine),
      changed: delta.changed.map(({ step, came, went }) => stepChange(step, { came, went })).sort(byLine),
      rulesAdded: rules.filter((rule) => !hadKeys.has(ruleKey(rule))),
      rulesRemoved: had.filter((rule) => !hasKeys.has(ruleKey(rule))),
    },
    delta,
  };
}

/** How many of a change's steps and rules came, went and changed, in a line; that nothing did, when nothing did. */
function changesNote(changes: LogicChanges): string {
  if (changes.isNew) return `new since ${changes.since}: every step is added`;
  const steps = changes.added.length + changes.removed.length + changes.changed.length;

  if (steps === 0 && changes.rulesAdded.length === 0 && changes.rulesRemoved.length === 0) return `the logic is as it was at ${changes.since}`;

  return `since ${changes.since}: steps +${changes.added.length} \u2212${changes.removed.length} ~${changes.changed.length}, rules +${changes.rulesAdded.length} \u2212${changes.rulesRemoved.length}`;
}

/** One function's body as a flowchart; the `logic` list when `scope` is null. With `before`, held against the base's. */
export function logicView(analysis: Analysis, scope: string | null, fact: LogicFact | null | undefined, before?: LogicBefore): PictureContent {
  if (scope === null) return logicListView(analysis);
  const fn = analysis.graph.nodes.get(scope);

  if (!fn || fn.kind !== "fn") return unplaced(scope, [], [], [], { reason: `no function "${scope}"`, missing: true });

  if (fact === undefined) return unplaced(`Logic of ${fnLabel(fn)}`, [], [], [], { reason: "the logic is read from the function's file when the picture is drawn (archdiff diagram logic:<path>#<fn>, or the page)" });

  if (!fact) return unplaced(`Logic of ${fnLabel(fn)}`, [], [], [], { reason: `the body of ${fnLabel(fn)} could not be read: ${fn.module} is not TypeScript, JavaScript, Python, Go, Java or C#, or the function was not found at line ${fn.line}` });
  const nodes: Shape[] = fact.nodes.map((step) => {
    const kind: Shape["kind"] = step.kind === "start" ? "start" : step.kind === "decision" || step.kind === "loop" ? "decision" : step.kind === "action" ? "action" : "end";
    const node: Shape = { id: step.id, kind, label: step.kind === "loop" ? `↻ ${step.text}` : step.text, ref: { file: fn.module, line: step.line, endLine: step.endLine }, x: 0, y: 0, w: 0, h: 0 };

    if (step.kind === "throw") node.diff = "warning";
    // A step that calls a function of the repository links to it: a second tap opens that function's own logic.
    const callee = step.kind === "action" || step.kind === "return" ? calleeOf(analysis, scope, step) : null;

    if (callee) node.ref = { ...node.ref, id: callee };

    return node;
  });
  const edges: Line[] = fact.edges.map((edge) => (edge.label === undefined ? { from: edge.from, to: edge.to, kind: "flow" } : { from: edge.from, to: edge.to, kind: "flow", label: edge.label }));
  const held = before ? logicChanges(fact, before) : null;

  // The marks of the change: what is new and what reads otherwise on the head's steps; what is gone drawn where it hung.
  if (held) {
    const marks = new Map<string, Shape["diff"]>(held.delta ? [...held.delta.added.map((step): [string, Shape["diff"]] => [step.id, "added"]), ...held.delta.changed.map(({ step }): [string, Shape["diff"]] => [step.id, "changed"])] : fact.nodes.filter((step) => step.kind !== "start" && step.kind !== "end").map((step): [string, Shape["diff"]] => [step.id, "added"]));

    for (const node of nodes) {
      const mark = marks.get(node.id);

      if (mark) node.diff = mark;
    }

    for (const edge of edges) if (!held.delta || held.delta.arrowsAdded.has(arrowKey(edge))) edge.diff = "added";

    for (const step of held.delta?.removed ?? []) nodes.push({ id: step.id, kind: step.kind === "decision" || step.kind === "loop" ? "decision" : step.kind === "action" ? "action" : "end", label: step.kind === "loop" ? `\u21bb ${step.text}` : step.text, diff: "removed", x: 0, y: 0, w: 0, h: 0 });

    for (const edge of held.delta?.arrowsRemoved ?? []) edges.push({ from: edge.from, to: edge.to, kind: "flow", diff: "removed", ...(edge.label === undefined ? {} : { label: edge.label }) });
  }

  const decisions = fact.nodes.filter((step) => step.kind === "decision").length;
  const loops = fact.nodes.filter((step) => step.kind === "loop").length;
  const exits = fact.nodes.filter((step) => step.kind === "return" || step.kind === "throw").length;
  const { rules, more } = rulesOf(fact);
  const logic: LogicData = { fn: fnLabel(fn), module: fn.module, decisions, loops, exits, rules };

  if (fact.truncated) logic.truncated = true;

  if (more > 0) logic.moreRules = more;

  if (held) logic.changes = held.changes;
  const notes = [held ? changesNote(held.changes) : "", `${decisions} ${decisions === 1 ? "decision" : "decisions"}, ${loops} ${loops === 1 ? "loop" : "loops"}, ${exits} ${exits === 1 ? "exit" : "exits"}; ${rules.length}${more > 0 ? "+" : ""} ${rules.length === 1 && more === 0 ? "rule" : "rules"} (paths from the start to an exit), listed in the Markdown`, fact.truncated ? "the body is longer than the picture holds: the rest was left out" : ""].filter(Boolean);

  return unplaced(`Logic of ${fnLabel(fn)} (${fn.module})${held ? ` — changes since ${held.changes.since}` : ""}`, nodes, edges, [], { logic, reason: notes.join("; ") });
}

/** The functions with branches, one shape each in its module's lane, labelled with how much it branches; a tap opens its flowchart. */
function logicListView(analysis: Analysis): PictureContent {
  const all = logicList(analysis);

  if (all.length === 0) return unplaced("Logic", [], [], [], { reason: "no function with a branch in it: no if, switch, loop or try in any body" });
  const listed = all.slice(0, MAX_LISTED);
  const nodes: Shape[] = listed.map((fn) => ({ id: fn.id, kind: "action", label: `${fnLabel(fn)}\n${fn.branches} ${fn.branches === 1 ? "branch" : "branches"}`, ref: { id: fn.id, file: fn.module, line: fn.line, endLine: fn.endLine }, group: moduleOf(fn.id), x: 0, y: 0, w: 0, h: 0 }));
  const modules = [...new Set(listed.map((fn) => moduleOf(fn.id)))];
  const left = all.length - listed.length;

  return unplaced(`Logic: ${counted(all.length, "function")} with branches`, nodes, [], modules.map(lane), { reason: `the ${listed.length === 1 ? "one" : listed.length} most branching ${listed.length === 1 ? "function" : "functions"}${left > 0 ? `; ${left} more in the views list` : ""}; tap one for its flowchart and the rules it holds` });
}
