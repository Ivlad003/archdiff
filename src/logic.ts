// The logic of the code as pictures: `logic` lists the functions by how
// much they branch (the ones with business rules in them), and
// `logic:<path>#<fn>` draws one function's body as a flowchart — a
// diamond per branch or loop with the condition as written, a box per
// run of statements, an ellipse per exit — and lists every path from the
// start to an exit as a rule: the conditions taken, the calls made, how
// it ends. The flowchart is read from the file on demand (extract/logic.ts,
// by picture.ts at the edge), not kept in the facts.
//
// Pure functions of the analysis and the fact read for the view. Entry
// points: `logicView`, `logicList`.

import type { Analysis } from "./analyze.ts";
import type { PictureContent, Line, Shape, LogicData, LogicRule } from "./diagram.ts";
import type { LogicFact, LogicStep } from "./extract/logic.ts";
import { moduleOf, type Declaration } from "./graph.ts";
import { lane, unplaced } from "./nodes.ts";

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
 * walked once (its body, then what follows), so a path through it says what
 * the body does; the list is cut at `MAX_RULES`.
 */
function rulesOf(fact: LogicFact): { rules: LogicRule[]; more: number } {
  const byId = new Map(fact.nodes.map((node) => [node.id, node]));
  const edgesFrom = new Map<string, { to: string; label?: string }[]>();

  for (const edge of fact.edges) edgesFrom.set(edge.from, [...(edgesFrom.get(edge.from) ?? []), edge]);
  const rules: LogicRule[] = [];
  let more = 0;
  let steps = 0;

  const walk = (id: string, onPath: Set<string>, conditions: string[], calls: string[]): void => {
    const node = byId.get(id);

    if (!node || steps++ > 20_000) return;

    if (node.kind === "return" || node.kind === "throw" || node.kind === "end") {
      const made = [...calls, ...(node.calls ?? []).filter((call) => !calls.includes(call))];

      if (rules.length < MAX_RULES) rules.push({ conditions, calls: made, outcome: node.text, kind: node.kind });
      else more++;

      return;
    }

    const made = node.kind === "action" || node.kind === "loop" ? [...calls, ...(node.calls ?? []).filter((call) => !calls.includes(call))] : calls;

    for (const edge of edgesFrom.get(id) ?? []) {
      const target = byId.get(edge.to);

      if (!target) continue;

      // A back edge into a loop already on the path: the loop is walked once, so carry on after it instead.
      if (onPath.has(edge.to)) {
        if (target.kind === "loop") for (const after of edgesFrom.get(edge.to) ?? []) if (after.label !== "each" && after.label !== "while" && !onPath.has(after.to)) walk(after.to, new Set([...onPath, after.to]), conditions, made);

        continue;
      }

      const condition = node.kind === "decision" || node.kind === "loop" ? [`${node.text}: ${edge.label ?? "then"}`] : [];
      walk(edge.to, new Set([...onPath, edge.to]), [...conditions, ...condition], made);
    }
  };

  const start = fact.nodes.find((node) => node.kind === "start");

  if (start) walk(start.id, new Set([start.id]), [], []);

  return { rules, more };
}

/** The resolved callee of a step: the first call of the function whose line falls in the step, by preference one with logic of its own. */
function calleeOf(analysis: Analysis, fnId: string, step: LogicStep): string | null {
  const calls = analysis.graph.calls.filter((call) => call.from === fnId && call.line >= step.line && call.line <= step.endLine && call.kind === "call");
  const branching = calls.find((call) => (analysis.graph.nodes.get(call.to)?.branches ?? 0) > 0);

  return (branching ?? calls[0])?.to ?? null;
}

/** One function's body as a flowchart; the `logic` list when `scope` is null. */
export function logicView(analysis: Analysis, scope: string | null, fact: LogicFact | null | undefined): PictureContent {
  if (scope === null) return logicListView(analysis);
  const fn = analysis.graph.nodes.get(scope);

  if (!fn || fn.kind !== "fn") return unplaced(scope, [], [], [], { reason: `no function "${scope}"`, missing: true });

  if (fact === undefined) return unplaced(`Logic of ${fnLabel(fn)}`, [], [], [], { reason: "the logic is read from the function's file when the picture is drawn (archdiff diagram logic:<path>#<fn>, or the page)" });

  if (!fact) return unplaced(`Logic of ${fnLabel(fn)}`, [], [], [], { reason: `the body of ${fnLabel(fn)} could not be read: ${fn.module} is not TypeScript, JavaScript or Python, or the function was not found at line ${fn.line}` });
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
  const decisions = fact.nodes.filter((step) => step.kind === "decision").length;
  const loops = fact.nodes.filter((step) => step.kind === "loop").length;
  const exits = fact.nodes.filter((step) => step.kind === "return" || step.kind === "throw").length;
  const { rules, more } = rulesOf(fact);
  const logic: LogicData = { fn: fnLabel(fn), module: fn.module, decisions, loops, exits, rules };

  if (fact.truncated) logic.truncated = true;

  if (more > 0) logic.moreRules = more;
  const notes = [`${decisions} ${decisions === 1 ? "decision" : "decisions"}, ${loops} ${loops === 1 ? "loop" : "loops"}, ${exits} ${exits === 1 ? "exit" : "exits"}; ${rules.length}${more > 0 ? "+" : ""} rules (paths from the start to an exit), listed in the Markdown`, fact.truncated ? "the body is longer than the picture holds: the rest was left out" : ""].filter(Boolean);

  return unplaced(`Logic of ${fnLabel(fn)} (${fn.module})`, nodes, edges, [], { logic, reason: notes.join("; ") });
}

/** The functions with branches, one shape each in its module's lane, labelled with how much it branches; a tap opens its flowchart. */
function logicListView(analysis: Analysis): PictureContent {
  const all = logicList(analysis);

  if (all.length === 0) return unplaced("Logic", [], [], [], { reason: "no function with a branch in it: no if, switch, loop or try in any body" });
  const listed = all.slice(0, MAX_LISTED);
  const nodes: Shape[] = listed.map((fn) => ({ id: fn.id, kind: "action", label: `${fnLabel(fn)}\n${fn.branches} ${fn.branches === 1 ? "branch" : "branches"}`, ref: { id: fn.id, file: fn.module, line: fn.line, endLine: fn.endLine }, group: moduleOf(fn.id), x: 0, y: 0, w: 0, h: 0 }));
  const modules = [...new Set(listed.map((fn) => moduleOf(fn.id)))];
  const left = all.length - listed.length;

  return unplaced(`Logic: ${all.length} functions with branches`, nodes, [], modules.map(lane), { reason: `the ${listed.length} most branching functions${left > 0 ? `; ${left} more in the views list` : ""}; tap one for its flowchart and the rules it holds` });
}
