// Control flow as facts, for the pictures that need it: the guard a call
// sits under (the innermost `if`, `else`, loop, `case`, `try`, `catch` or
// ternary — a sequence draws calls under one guard as a fragment), the
// states a file writes and reads as literals (`order.status = "paid"`,
// `case "paid":`, `status === "paid"` — the implicit state machines), and
// the machines a library declares (XState's `createMachine`,
// javascript-state-machine's `new StateMachine`, Python's
// `transitions.Machine`). TypeScript and JavaScript are read with
// tree-sitter queries; Python with a walk, its comparison node having no
// fields to query by.
//
// Shared by the TypeScript and Python frontends (source → FileFacts):
// `guardsOf` annotates every call fact, `collectStates` and
// `collectMachines` fill `FileFacts.states` and `FileFacts.machines`.
// Entry points: `guardsOf`, `collectTsStates`, `collectPyStates`,
// `collectTsMachines`, `collectPyMachines`, `enclosingDeclaration`,
// `TS_CONTROL`, `PY_CONTROL`.

import type { GuardFact, MachineFact, StateFact } from "./facts.ts";
import { query, startCol, type Grammar, type Language, type Node } from "./treesitter.ts";

/** The node types of one language's control flow, and which field of a branch holds its body. */
export interface ControlGrammar {
  ifs: ReadonlySet<string>;
  /** The field of an `if` that holds the taken branch; the other named child is the `else`. */
  consequence: string;
  elses: ReadonlySet<string>;
  loops: ReadonlySet<string>;
  cases: ReadonlySet<string>;
  tries: ReadonlySet<string>;
  catches: ReadonlySet<string>;
  ternaries: ReadonlySet<string>;
  /** The functions a declaration's body is found under, for `within`. */
  functions: ReadonlySet<string>;
  classes: ReadonlySet<string>;
}

export const TS_CONTROL: ControlGrammar = {
  ifs: new Set(["if_statement"]),
  consequence: "consequence",
  elses: new Set(["else_clause"]),
  loops: new Set(["for_statement", "for_in_statement", "while_statement", "do_statement"]),
  cases: new Set(["switch_case", "switch_default"]),
  tries: new Set(["try_statement"]),
  catches: new Set(["catch_clause", "finally_clause"]),
  ternaries: new Set(["ternary_expression"]),
  functions: new Set(["function_declaration", "generator_function_declaration", "method_definition", "arrow_function", "function_expression", "function", "generator_function"]),
  classes: new Set(["class_declaration", "abstract_class_declaration", "class"]),
};

export const PY_CONTROL: ControlGrammar = {
  ifs: new Set(["if_statement", "elif_clause"]),
  consequence: "consequence",
  elses: new Set(["else_clause"]),
  loops: new Set(["for_statement", "while_statement"]),
  cases: new Set(["case_clause"]),
  tries: new Set(["try_statement"]),
  catches: new Set(["except_clause", "finally_clause"]),
  ternaries: new Set(["conditional_expression"]),
  functions: new Set(["function_definition", "lambda"]),
  classes: new Set(["class_definition"]),
};

/** The text of a condition or a header on one line, cut at 60 characters. */
export function short(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();

  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/** The condition of a branch or loop, as the code writes it: `if (x > 1)` → `x > 1`, `for (const a of b)` → `const a of b`, Python's `if x > 1:` → `x > 1`. */
export function headerOf(node: Node): string {
  const condition = node.childForFieldName("condition") ?? node.childForFieldName("value");

  if (condition) return short(condition.text.replace(/^\(|\)$/g, ""));
  // A loop header without a condition field (`for (…)`, `for x in y:`): the text up to its body.
  const body = node.childForFieldName("body") ?? node.childForFieldName("consequence");
  const head = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;

  return short(head.replace(/^(for|while|do|if|elif|case|try|except|finally)\b/, "").replace(/[:{]\s*$/, "").replace(/^\s*\(|\)\s*$/g, ""));
}

/** How many branching statements a declaration holds: its ifs, cases (a switch or match as one), loops and tries, nested functions included. */
export function countBranches(node: Node, grammar: ControlGrammar): number {
  let count = 0;
  const stack = [node];

  while (stack.length > 0) {
    const at = stack.pop()!;

    // An `elif` is a branch of its own; a switch counts once (its cases are its branches), as does a try (its catches).
    if (grammar.ifs.has(at.type) || grammar.loops.has(at.type) || grammar.tries.has(at.type) || at.type === "switch_statement" || at.type === "match_statement") count++;

    for (const child of at.namedChildren) stack.push(child);
  }

  return count;
}

/**
 * The guards between a call and the body it belongs to, outermost first:
 * every `if` branch (an `else` is the alternative of an `if`; an `else if`
 * is its own `if`), loop, `case`, `try` or `catch` the call sits in, and
 * any ternary. Empty for a call at the body's top level. A guard's id is
 * the guarding statement's offset, so calls under one guard share it.
 */
export function guardsOf(node: Node, stop: Node, grammar: ControlGrammar): GuardFact[] {
  const chain: GuardFact[] = [];
  let child: Node = node;

  for (let at = node.parent; at && at.id !== stop.id; child = at, at = at.parent) {
    if (grammar.ifs.has(at.type)) {
      // Only the branches guard; the condition itself does not.
      const consequence = at.childForFieldName(grammar.consequence);

      if (consequence && consequence.id === child.id) chain.push({ kind: "if", text: headerOf(at), id: at.startIndex });
      else if (grammar.elses.has(child.type)) chain.push({ kind: "else", text: `not ${headerOf(at)}`, id: child.startIndex });
    } else if (grammar.loops.has(at.type)) {
      const body = at.childForFieldName("body");

      if (!body || body.id === child.id || body.startIndex <= node.startIndex) chain.push({ kind: "loop", text: headerOf(at), id: at.startIndex });
    } else if (grammar.cases.has(at.type)) {
      const value = at.childForFieldName("value") ?? at.namedChildren.find((candidate) => candidate.type === "case_pattern");

      if (!value || value.id !== child.id) chain.push({ kind: "case", text: value ? short(value.text) : "default", id: at.startIndex });
    } else if (grammar.tries.has(at.type)) {
      const body = at.childForFieldName("body");

      if (body && body.id === child.id) chain.push({ kind: "try", text: "try", id: at.startIndex });
    } else if (grammar.catches.has(at.type)) {
      chain.push({ kind: "catch", text: short(at.text.split(/[:{]/)[0] ?? "catch").replace(/^(catch|except|finally)\s*/, "") || at.type.replace(/_clause$/, ""), id: at.startIndex });
    } else if (grammar.ternaries.has(at.type)) {
      const condition = at.childForFieldName("condition");

      if (condition && condition.id !== child.id) chain.push({ kind: "ternary", text: headerOf(at), id: at.startIndex });
    }
  }

  return chain.reverse();
}

/** The declaration a node sits in, as `name` or `Class.method`; null at the top level. */
export function enclosingDeclaration(node: Node, grammar: ControlGrammar): string | null {
  const parts: string[] = [];

  for (let at = node.parent; at; at = at.parent) {
    if (grammar.functions.has(at.type)) {
      const name = at.childForFieldName("name")?.text ?? (at.parent?.type === "variable_declarator" ? at.parent.childForFieldName("name")?.text : at.parent?.type === "pair" ? at.parent.childForFieldName("key")?.text : undefined);

      if (name && parts.length === 0) parts.unshift(name);
    } else if (grammar.classes.has(at.type)) {
      const name = at.childForFieldName("name")?.text ?? (at.parent?.type === "variable_declarator" ? at.parent.childForFieldName("name")?.text : undefined);

      if (name && parts.length > 0) parts.unshift(name);

      break;
    }
  }

  return parts.length > 0 ? parts.join(".") : null;
}

/**
 * The subject a left-hand side names: an identifier is itself; `this.x`
 * and `self.x` are `this.x`; any other member is its last property
 * (`order.status` → `status`, as every order carries the same field).
 */
function subjectOf(node: Node): string | null {
  if (node.type === "identifier") return node.text;

  if (node.type === "member_expression" || node.type === "attribute") {
    const object = node.childForFieldName("object");
    const property = node.childForFieldName("property") ?? node.childForFieldName("attribute");

    if (!object || !property) return null;

    if (object.type === "this" || (object.type === "identifier" && (object.text === "self" || object.text === "this"))) return `this.${property.text}`;

    return property.text;
  }

  // `(order as Paid).status`: through the parentheses or the assertion.
  if (node.type === "parenthesized_expression" || node.type === "as_expression" || node.type === "non_null_expression") {
    const inner = node.namedChildren[0];

    return inner ? subjectOf(inner) : null;
  }

  return null;
}

/** A literal a state may be: a plain string, a number, a template without substitutions, an enum member `Status.Paid`; else null. */
function literalOf(node: Node): string | null {
  if (node.type === "string" || node.type === "template_string") {
    if (node.namedChildren.some((child) => child.type === "template_substitution" || child.type === "interpolation")) return null;

    return node.text.replace(/^[`'"]|[`'"]$/g, "").replace(/^[fFrRbBuU]+(['"])/, "$1").replace(/^['"]/, "");
  }

  if (node.type === "number" || node.type === "integer") return node.text;

  if (node.type === "member_expression" || node.type === "attribute") {
    const object = node.childForFieldName("object");
    const property = node.childForFieldName("property") ?? node.childForFieldName("attribute");

    // `Status.Paid`, `OrderState.NEW`: an enum member, named by a capitalised type.
    if (object?.type === "identifier" && /^[A-Z]/.test(object.text) && property) return `${object.text}.${property.text}`;
  }

  if (node.type === "parenthesized_expression" || node.type === "as_expression") {
    const inner = node.namedChildren[0];

    return inner ? literalOf(inner) : null;
  }

  return null;
}

/** The `subject == "literal"` comparisons (equality only) inside a condition, as `[subject, value]` pairs. */
function comparisonsIn(node: Node, grammar: "ts" | "py"): [string, string][] {
  const out: [string, string][] = [];
  const stack = [node];

  while (stack.length > 0) {
    const at = stack.pop()!;

    if (grammar === "ts" && at.type === "binary_expression") {
      const operator = at.childForFieldName("operator")?.text ?? at.children.find((child) => child.type === "===" || child.type === "==" )?.type;
      const left = at.childForFieldName("left");
      const right = at.childForFieldName("right");

      if ((operator === "===" || operator === "==") && left && right) {
        const pair = pairOf(left, right);

        if (pair) {
          out.push(pair);
          continue;
        }
      }
    }

    if (grammar === "py" && at.type === "comparison_operator") {
      const [left, operator, right] = [at.namedChildren[0], at.children.find((child) => child.type === "==" || child.type === "is"), at.namedChildren[1]];

      if (left && operator && right && at.namedChildren.length === 2) {
        const pair = pairOf(left, right);

        if (pair) {
          out.push(pair);
          continue;
        }
      }
    }

    for (const child of at.namedChildren) stack.push(child);
  }

  return out;
}

/** `subject == literal` either way round. */
function pairOf(a: Node, b: Node): [string, string] | null {
  const subject = subjectOf(a);
  const literal = literalOf(b);

  if (subject && literal !== null) return [subject, literal];
  const subjectB = subjectOf(b);
  const literalA = literalOf(a);

  return subjectB && literalA !== null ? [subjectB, literalA] : null;
}

/** The states an assignment to `subject` at `node` moves from: the values of the enclosing `case` (and the cases falling through into it) or `if` on the same subject; the nearest such guard wins. */
function underOf(node: Node, subject: string, lang: "ts" | "py", grammar: ControlGrammar): string[] | undefined {
  let child: Node = node;

  for (let at = node.parent; at; child = at, at = at.parent) {
    if (grammar.cases.has(at.type)) {
      // The cases of a switch sit in its body node; those of a Python match in a block.
      const parent = at.parent?.type === "switch_body" || at.parent?.type === "block" ? at.parent.parent : at.parent;
      const switched = parent ? (parent.childForFieldName("value") ?? parent.childForFieldName("subject")) : null;

      if (switched && subjectOf(switched) === subject) {
        const values: string[] = [];
        // The case's own value, and the values of the empty cases just before it (they fall through into it).
        for (let sibling: Node | null = at; sibling; sibling = sibling.previousNamedSibling) {
          const value = sibling.childForFieldName("value") ?? sibling.namedChildren.find((candidate) => candidate.type === "case_pattern");
          const literal = value ? literalOf(value.type === "case_pattern" ? (value.namedChildren[0] ?? value) : value) : null;

          if (literal !== null) values.unshift(literal);

          if (sibling.id !== at.id) break;
          const body = sibling.childForFieldName("body") ?? sibling.namedChildren.filter((candidate) => candidate.type !== "case_pattern" && candidate.id !== value?.id);

          if (Array.isArray(body) ? body.length > 0 && sibling.id !== at.id : body && sibling.id !== at.id) break;
          // Keep going only through cases without a body before this one.
          const previous = sibling.previousNamedSibling;

          if (!previous || !grammar.cases.has(previous.type)) break;
          const previousBody = previous.childForFieldName("body");

          if (previousBody && previousBody.namedChildren.length > 0) break;
        }

        return values.length > 0 ? values : undefined;
      }
    }

    if (grammar.ifs.has(at.type)) {
      const consequence = at.childForFieldName(grammar.consequence);
      const condition = at.childForFieldName("condition");

      if (consequence && consequence.id === child.id && condition) {
        const values = comparisonsIn(condition, lang).filter(([name]) => name === subject).map(([, value]) => value);

        if (values.length > 0) return [...new Set(values)];
      }
    }
  }

  return undefined;
}

/** The states query; a class field is `public_field_definition` with a `name` in the TypeScript grammars and `field_definition` with a `property` in the JavaScript one. */
function statesQuery(g: Grammar): string {
  return `
(assignment_expression left: (_) @target right: (_) @value) @assign
(variable_declarator name: (identifier) @name value: (_) @init) @declare
(${g === "javascript" ? "field_definition property:" : "public_field_definition name:"} (property_identifier) @field value: (_) @init) @field_init
(switch_statement value: (_) @subject body: (switch_body) @cases) @switch
(binary_expression left: (_) @left operator: ["===" "==" "!==" "!="] right: (_) @right) @compare
`;
}

/** The states of a TypeScript or JavaScript file, by tree-sitter query. */
export function collectTsStates(root: Node, language: Language, g: Grammar): StateFact[] {
  const out: StateFact[] = [];
  const states = query(language, g, "states", statesQuery(g));

  const push = (fact: StateFact): void => {
    out.push(fact);
  };

  for (const match of states.matches(root)) {
    const captures = new Map(match.captures.map((capture) => [capture.name, capture.node]));
    const at = (name: string): Node | undefined => captures.get(name);

    if (captures.has("assign")) {
      const subject = subjectOf(at("target")!);
      const value = literalOf(at("value")!);

      if (subject === null || value === null) continue;
      const node = at("assign")!;
      const fact: StateFact = { subject, kind: "assign", value, within: enclosingDeclaration(node, TS_CONTROL), line: node.startPosition.row + 1, col: startCol(node) };
      const under = underOf(node, subject, "ts", TS_CONTROL);

      if (under) fact.under = under;
      push(fact);
    } else if (captures.has("declare")) {
      // `let state = "idle"`: the initial state of a variable (a const is a constant, not a state).
      const declaration = at("declare")!.parent;

      if (!declaration || !declaration.children.some((child) => child.type === "let" || child.type === "var")) continue;
      const value = literalOf(at("init")!);

      if (value === null) continue;
      const node = at("declare")!;
      push({ subject: at("name")!.text, kind: "assign", value, within: enclosingDeclaration(node, TS_CONTROL), initial: true, line: node.startPosition.row + 1, col: startCol(node) });
    } else if (captures.has("field_init")) {
      const value = literalOf(at("init")!);

      if (value === null) continue;
      const node = at("field_init")!;
      push({ subject: `this.${at("field")!.text}`, kind: "assign", value, within: enclosingDeclaration(node, TS_CONTROL), initial: true, line: node.startPosition.row + 1, col: startCol(node) });
    } else if (captures.has("switch")) {
      const subject = subjectOf(at("subject")!);

      if (subject === null) continue;

      for (const caseNode of at("cases")!.namedChildren) {
        const value = caseNode.childForFieldName("value");
        const literal = value ? literalOf(value) : null;

        if (literal === null) continue;
        push({ subject, kind: "case", value: literal, within: enclosingDeclaration(caseNode, TS_CONTROL), line: caseNode.startPosition.row + 1, col: startCol(caseNode) });
      }
    } else if (captures.has("compare")) {
      const pair = pairOf(at("left")!, at("right")!);

      if (!pair) continue;
      const node = at("compare")!;
      push({ subject: pair[0], kind: "compare", value: pair[1], within: enclosingDeclaration(node, TS_CONTROL), line: node.startPosition.row + 1, col: startCol(node) });
    }
  }

  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

/** The states of a Python file: `self.state = "x"`, `if self.state == "x":`, `match self.state: case "x":`. */
export function collectPyStates(root: Node): StateFact[] {
  const out: StateFact[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      const subject = left ? subjectOf(left) : null;
      const value = right ? literalOf(right) : null;

      if (subject !== null && value !== null && !/^[A-Z_0-9]+$/.test(subject)) {
        const fact: StateFact = { subject, kind: "assign", value, within: enclosingDeclaration(node, PY_CONTROL), line: node.startPosition.row + 1, col: startCol(node) };
        const under = underOf(node, subject, "py", PY_CONTROL);

        if (under) fact.under = under;

        if (fact.within === "__init__" || (fact.within !== null && fact.within.endsWith(".__init__"))) fact.initial = true;
        out.push(fact);
      }
    } else if (node.type === "comparison_operator") {
      for (const [subject, value] of comparisonsIn(node, "py")) out.push({ subject, kind: "compare", value, within: enclosingDeclaration(node, PY_CONTROL), line: node.startPosition.row + 1, col: startCol(node) });

      continue;
    } else if (node.type === "match_statement") {
      const subjectNode = node.childForFieldName("subject");
      const subject = subjectNode ? subjectOf(subjectNode) : null;

      if (subject !== null) {
        for (const clause of node.namedChildren.filter((child) => child.type === "case_clause")) {
          for (const pattern of clause.namedChildren.filter((child) => child.type === "case_pattern")) {
            const literal = literalOf(pattern.namedChildren[0] ?? pattern);

            if (literal !== null) out.push({ subject, kind: "case", value: literal, within: enclosingDeclaration(clause, PY_CONTROL), line: clause.startPosition.row + 1, col: startCol(clause) });
          }
        }
      }
    }

    for (const child of node.namedChildren) stack.push(child);
  }

  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

/** The pairs of an object literal (TypeScript) as key → value node; a key may be a string. */
function pairsOf(object: Node): Map<string, Node> {
  const pairs = new Map<string, Node>();

  for (const child of object.namedChildren) {
    if (child.type !== "pair") continue;
    const key = child.childForFieldName("key");
    const value = child.childForFieldName("value");

    if (key && value) pairs.set(key.text.replace(/^['"]|['"]$/g, ""), value);
  }

  return pairs;
}

/** A transition target as XState writes it: `"loading"`, `"#light.green"`, `".child"`, `{ target: "x" }`, `[{ target: "x" }]`. */
function targetsOf(value: Node): string[] {
  const literal = literalOf(value);

  if (literal !== null) return [literal.replace(/^[#.].*\./, "").replace(/^[#.]/, "")];

  if (value.type === "object") {
    const target = pairsOf(value).get("target");

    return target ? targetsOf(target) : [];
  }

  if (value.type === "array") return value.namedChildren.flatMap(targetsOf);

  return [];
}

const TS_MACHINES_QUERY = `
(call_expression function: (_) @fn arguments: (arguments (object) @config)) @call
(new_expression constructor: (_) @fn arguments: (arguments (object) @config)) @call
`;

/** The machines of a TypeScript or JavaScript file: XState's `createMachine({…})`/`Machine({…})`, javascript-state-machine's `new StateMachine({…})`. */
export function collectTsMachines(root: Node, language: Language, g: Grammar): MachineFact[] {
  const out: MachineFact[] = [];
  const machines = query(language, g, "machines", TS_MACHINES_QUERY);

  for (const match of machines.matches(root)) {
    const captures = new Map(match.captures.map((capture) => [capture.name, capture.node]));
    const fn = captures.get("fn")!;
    const config = captures.get("config")!;
    const call = captures.get("call")!;
    const callee = fn.text.replace(/\s+/g, "");
    const member = callee.slice(callee.lastIndexOf(".") + 1);

    if (!/^(createMachine|Machine|StateMachine|createStateMachine|setup)$/.test(member) || member === "setup") continue;
    const pairs = pairsOf(config);
    const states = pairs.get("states");
    const transitions = pairs.get("transitions");

    if (!states && !transitions) continue;
    const named = pairs.get("id") ?? pairs.get("name");
    const declarator = call.parent?.type === "variable_declarator" ? call.parent : call.parent?.parent?.type === "variable_declarator" ? call.parent.parent : null;
    const name = (named ? literalOf(named) : null) ?? declarator?.childForFieldName("name")?.text ?? "machine";
    const fact: MachineFact = { name, library: member === "StateMachine" ? "javascript-state-machine" : "xstate", states: [], transitions: [], line: call.startPosition.row + 1, col: startCol(call) };
    const initial = pairs.get("initial") ?? pairs.get("init");
    const initialValue = initial ? literalOf(initial) : null;

    if (initialValue !== null) fact.initial = initialValue;

    if (states?.type === "object") {
      // XState: `states: { idle: { on: { FETCH: "loading" }, after: { 1000: "x" }, always: "y", invoke: { onDone: "z" } } }`.
      for (const [state, body] of pairsOf(states)) {
        fact.states.push(state);

        if (body.type !== "object") continue;
        const inner = pairsOf(body);
        const on = inner.get("on");

        if (on?.type === "object") for (const [event, target] of pairsOf(on)) for (const to of targetsOf(target)) fact.transitions.push({ from: state, to, event });
        const after = inner.get("after");

        if (after?.type === "object") for (const [delay, target] of pairsOf(after)) for (const to of targetsOf(target)) fact.transitions.push({ from: state, to, event: `after ${delay}` });
        const always = inner.get("always");

        if (always) for (const to of targetsOf(always)) fact.transitions.push({ from: state, to, event: "always" });
        const invoke = inner.get("invoke");

        if (invoke?.type === "object") for (const [key, target] of pairsOf(invoke)) if (key === "onDone" || key === "onError") for (const to of targetsOf(target)) fact.transitions.push({ from: state, to, event: key });
      }
    } else if (states?.type === "array") {
      for (const item of states.namedChildren) {
        const literal = literalOf(item);

        if (literal !== null) fact.states.push(literal);
      }
    }

    if (transitions?.type === "array") {
      // javascript-state-machine: `transitions: [{ name: "melt", from: "solid", to: "liquid" }]`, `from` may be a list or "*".
      for (const item of transitions.namedChildren) {
        if (item.type !== "object") continue;
        const entry = pairsOf(item);
        const event = entry.get("name") ?? entry.get("trigger");
        const from = entry.get("from") ?? entry.get("source");
        const to = entry.get("to") ?? entry.get("dest") ?? entry.get("target");

        if (!event || !from || !to) continue;
        const toValue = literalOf(to);
        const eventValue = literalOf(event);
        const froms = from.type === "array" ? from.namedChildren.map(literalOf).filter((value): value is string => value !== null) : [literalOf(from)].filter((value): value is string => value !== null);

        if (toValue === null || eventValue === null) continue;

        for (const source of froms) fact.transitions.push({ from: source, to: toValue, event: eventValue });
      }
    }

    for (const transition of fact.transitions) for (const state of [transition.from, transition.to]) if (state !== "*" && !fact.states.includes(state)) fact.states.push(state);

    if (fact.states.length > 0) out.push(fact);
  }

  return out;
}

/** The machines of a Python file: `Machine(states=[…], transitions=[…], initial=…)` of the `transitions` package, with `add_transition(trigger, source, dest)` calls folded in. */
export function collectPyMachines(root: Node): MachineFact[] {
  const out: MachineFact[] = [];
  const added: { from: string; to: string; event: string }[] = [];
  const stack = [root];

  const literals = (node: Node): string[] => (node.type === "list" || node.type === "tuple" ? node.namedChildren.map(literalOf).filter((value): value is string => value !== null) : [literalOf(node)].filter((value): value is string => value !== null));

  while (stack.length > 0) {
    const node = stack.pop()!;

    for (const child of node.namedChildren) stack.push(child);

    if (node.type !== "call") continue;
    const fn = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");

    if (!fn || !args) continue;
    const member = fn.text.slice(fn.text.lastIndexOf(".") + 1);

    if (member === "add_transition") {
      const [event, from, to] = args.namedChildren.filter((arg) => arg.type !== "comment").map((arg) => (arg.type === "keyword_argument" ? arg.childForFieldName("value") : arg));
      const eventValue = event ? literalOf(event) : null;
      const toValue = to ? literalOf(to) : null;

      if (eventValue !== null && toValue !== null && from) for (const source of literals(from)) added.push({ from: source, to: toValue, event: eventValue });

      continue;
    }

    if (!/Machine$/.test(member)) continue;
    const keywords = new Map<string, Node>();

    for (const arg of args.namedChildren) if (arg.type === "keyword_argument") keywords.set(arg.childForFieldName("name")?.text ?? "", arg.childForFieldName("value")!);
    const states = keywords.get("states");
    const transitions = keywords.get("transitions");

    if (!states && !transitions) continue;
    const assignment = node.parent?.type === "assignment" ? node.parent.childForFieldName("left") : null;
    const fact: MachineFact = { name: assignment ? (subjectOf(assignment) ?? "machine").replace(/^this\./, "") : "machine", library: "transitions", states: states ? literals(states) : [], transitions: [], line: node.startPosition.row + 1, col: startCol(node) };
    const initial = keywords.get("initial");
    const initialValue = initial ? literalOf(initial) : null;

    if (initialValue !== null) fact.initial = initialValue;

    if (transitions?.type === "list") {
      for (const item of transitions.namedChildren) {
        if (item.type === "dictionary") {
          const entry = new Map<string, Node>();

          for (const pair of item.namedChildren) if (pair.type === "pair") entry.set(literalOf(pair.childForFieldName("key")!) ?? "", pair.childForFieldName("value")!);
          const event = entry.get("trigger");
          const from = entry.get("source");
          const to = entry.get("dest");
          const eventValue = event ? literalOf(event) : null;
          const toValue = to ? literalOf(to) : null;

          if (eventValue !== null && toValue !== null && from) for (const source of literals(from)) fact.transitions.push({ from: source, to: toValue, event: eventValue });
        } else if (item.type === "list") {
          const [event, from, to] = item.namedChildren.map(literalOf);

          if (event && from && to) fact.transitions.push({ from, to, event });
        }
      }
    }

    out.push(fact);
  }

  if (added.length > 0) {
    const target = out[0] ?? { name: "machine", library: "transitions", states: [], transitions: [], line: 1, col: 1 };

    if (out.length === 0) out.push(target);
    target.transitions.push(...added);
  }

  for (const fact of out) for (const transition of fact.transitions) for (const state of [transition.from, transition.to]) if (state !== "*" && !fact.states.includes(state)) fact.states.push(state);

  return out;
}
