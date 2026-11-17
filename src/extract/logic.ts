// The logic of one function as a flowchart: its body read statement by
// statement into a small control-flow graph — a decision per `if`, `switch`
// or `match`, a loop per `for` or `while` (labelled jumps to their loop),
// `try` as a decision between ok and error with its `finally` on every way
// out, an action per run of plain statements (two at most, so the
// shape stays readable), a terminal per `return` or `throw` — with the
// condition texts as the code writes them and the calls each action makes.
// The arrows into a loop's body and back into its header are marked as
// such (`enters`, `back`), so whoever walks the paths needs no labels to
// tell a loop's shape.
// Read on demand from the one file the view names (not at extraction: a
// graph per function would weigh more than the rest of the facts), for
// the `logic:<path>#<fn>` view (logic.ts), which draws it and lists the
// paths from the start to every exit as the rules of the function.
//
// TypeScript, JavaScript, Python and Go, over the control grammars of
// control.ts. Entry points: `readLogic`, `LogicFact`, `LogicStep`,
// `LogicEdge`.

import { GO_CONTROL, headerOf, PY_CONTROL, short, TS_CONTROL, unwrapped, type ControlGrammar } from "./control.ts";
import { collapse, grammarFor, withTree, type Grammar, type Node } from "./treesitter.ts";

/** One box of the flowchart. */
export interface LogicStep {
  id: string;
  /**
   * `start` and `end` frame the body; `decision` is a branch (an `if`, a
   * `switch`, a `try` between ok and error); `loop` a loop header; `action`
   * one or two plain statements; `return` and `throw` the exits.
   */
  kind: "start" | "end" | "decision" | "loop" | "action" | "return" | "throw";
  /** The condition, the statements or the exit as written, cut short, one statement per line. */
  text: string;
  line: number;
  endLine: number;
  /** The callees the statements name, as written (`saveOrder`, `this.repo.save`), for the links to their own logic. */
  calls?: string[];
}

/** One arrow: `label` is the branch taken (`yes`, `no`, a case value, `each`, `done`, `ok`, `error`). */
export interface LogicEdge {
  from: string;
  to: string;
  label?: string;
  /** From a loop's header into its body (`each`, `while`); every other arrow out of the header leaves the loop. */
  enters?: true;
  /** Back into a loop's header: the end of its body, a `continue`, an inner loop's `done` as the last step of the body. */
  back?: true;
}

export interface LogicFact {
  nodes: LogicStep[];
  edges: LogicEdge[];
  /** The body had more statements than a readable picture holds: the rest were left out. */
  truncated?: true;
}

/** More boxes than this, and the rest of the body is left out. */
const MAX_NODES = 160;

/** Statements merged into one action box, at most. */
const STATEMENTS_PER_ACTION = 2;

/** The length of one statement's text in a box. */
const STATEMENT_CHARS = 56;

/** The node types of one language's statements, beside the control grammar. */
interface LogicGrammar {
  lang: "ts" | "py" | "go";
  control: ControlGrammar;
  returns: ReadonlySet<string>;
  throws: ReadonlySet<string>;
  /** A plain statement that ends the path as a `throw` does: Go's `panic(…)`, `log.Fatal(…)`, `os.Exit(…)`. */
  throwCall?: RegExp;
  breaks: ReadonlySet<string>;
  continues: ReadonlySet<string>;
  blocks: ReadonlySet<string>;
  /** Statements that run a block under a header written before it (Python's `with x as y:`): the header is an action, the block follows. */
  wrappers: ReadonlySet<string>;
  /** Statements that are no step of the logic (a nested declaration, an import, an empty statement). */
  silent: ReadonlySet<string>;
  calls: ReadonlySet<string>;
  /** How a switch (`control.switches`, but Python's `match`) is written: its cases, and whether one that does not leave runs into the next. */
  cases: { of(node: Node): Node[]; fallThrough: boolean };
}

/** `case a:` and `default:` under the switch's body, each with its statements after the value: a case without `break` runs into the next. */
const TS_CASES: LogicGrammar["cases"] = { of: (node) => (node.childForFieldName("body")?.namedChildren ?? []).filter((clause) => clause.type === "switch_case" || clause.type === "switch_default"), fallThrough: true };

const TS_LOGIC: LogicGrammar = {
  lang: "ts",
  control: TS_CONTROL,
  returns: new Set(["return_statement"]),
  throws: new Set(["throw_statement"]),
  breaks: new Set(["break_statement"]),
  continues: new Set(["continue_statement"]),
  blocks: new Set(["statement_block"]),
  wrappers: new Set(),
  silent: new Set(["function_declaration", "generator_function_declaration", "class_declaration", "abstract_class_declaration", "import_statement", "export_statement", "empty_statement", "comment", "type_alias_declaration", "interface_declaration", "enum_declaration", "debugger_statement"]),
  calls: new Set(["call_expression", "new_expression"]),
  cases: TS_CASES,
};

const PY_LOGIC: LogicGrammar = {
  lang: "py",
  control: PY_CONTROL,
  returns: new Set(["return_statement"]),
  throws: new Set(["raise_statement"]),
  breaks: new Set(["break_statement"]),
  continues: new Set(["continue_statement"]),
  blocks: new Set(["block"]),
  wrappers: new Set(["with_statement"]),
  silent: new Set(["function_definition", "class_definition", "decorated_definition", "import_statement", "import_from_statement", "pass_statement", "comment", "global_statement", "nonlocal_statement"]),
  calls: new Set(["call"]),
  cases: TS_CASES,
};

/** Go: a block holds a statement list; the cases of a `switch`, a type switch and a `select` are its children, and none runs into the next. */
const GO_LOGIC: LogicGrammar = {
  lang: "go",
  control: GO_CONTROL,
  returns: new Set(["return_statement"]),
  throws: new Set(),
  throwCall: /^(panic|log\.(Fatal|Fatalf|Fatalln|Panic|Panicf)|os\.Exit)\(/,
  breaks: new Set(["break_statement"]),
  continues: new Set(["continue_statement"]),
  blocks: new Set(["block", "statement_list"]),
  wrappers: new Set(),
  silent: new Set(["type_declaration", "empty_statement", "comment"]),
  calls: new Set(["call_expression"]),
  cases: { of: (node) => node.namedChildren.filter((clause) => GO_CONTROL.cases.has(clause.type)), fallThrough: false },
};

/** What a case of a switch names (null: the default), and the statements it runs: the clause's children but what it names. */
function caseOf(clause: Node): { label: string | null; statements: Node[] } {
  // A value (`case "a":`), the types of a Go type switch (`case int, string:`), the channel operation of a `select`.
  const named = [clause.childForFieldName("value"), ...clause.childrenForFieldName("type"), clause.childForFieldName("communication")].filter((each) => each !== null);
  const ids = new Set(named.map((each) => each.id));

  return { label: named.length === 0 ? null : short(named.map((each) => each.text).join(", ")), statements: clause.namedChildren.filter((child) => !ids.has(child.id) && child.type !== "comment") };
}

/** A dangling arrow out of a built node, waiting for the next node to point at. */
interface Exit {
  from: string;
  label?: string;
  /** The arrow enters a loop's body (`LogicEdge.enters`). */
  enters?: true;
}

/** The loop (or switch) a `break` leaves and a `continue` returns to. */
interface Frame {
  kind: "loop" | "switch";
  /** The loop's header, for `continue`; null for a switch. */
  head: string | null;
  breaks: Exit[];
  /** `outer:` written before it: `break outer` and `continue outer` name it. */
  label: string | null;
  /** How many `finally` blocks were open around it: a jump out of a `try` inside it runs the ones opened since. */
  finallies: number;
}

/** The callees a statement names, as written, without those inside a nested function. */
function calleesIn(node: Node, grammar: LogicGrammar): string[] {
  const out: string[] = [];
  const stack = [node];

  while (stack.length > 0) {
    const at = stack.pop()!;

    if (at.id !== node.id && grammar.control.functions.has(at.type)) continue;

    if (grammar.calls.has(at.type)) {
      const callee = at.childForFieldName("function") ?? at.childForFieldName("constructor");
      const name = callee ? collapse(callee.text) : "";

      // An error being built (`new Error(…)`, `ValueError(…)`) is the exit's own text, not a call the rules list.
      if (name !== "" && !out.includes(name) && !/^(?:[A-Z]\w*)?(?:Error|Exception)$/.test(name)) out.push(name);
    }

    for (const child of at.namedChildren) stack.push(child);
  }

  return out.slice(0, 8);
}


/** The text of a statement on one line, cut short: `const order = make(id, total)`. */
function statementText(node: Node): string {
  const flat = collapse(node.text).replace(/;$/, "");

  return flat.length > STATEMENT_CHARS ? `${flat.slice(0, STATEMENT_CHARS - 1)}…` : flat;
}

/** Builds the flowchart of one body. */
class Builder {
  readonly nodes: LogicStep[] = [];
  readonly edges: LogicEdge[] = [];
  truncated = false;
  private readonly frames: Frame[] = [];
  private readonly grammar: LogicGrammar;
  /** The `finally` blocks of the `try` statements being read, outermost first: a path leaving through them runs them. */
  private finallies: Node[] = [];
  /** The paths that ran the `finally` blocks after a `return` or a `throw`: they end at the end of the body. */
  readonly afterExits: Exit[] = [];
  /** The label written before the statement being read (`outer: for …`), for the loop or switch it names. */
  private label: string | null = null;

  constructor(grammar: LogicGrammar) {
    this.grammar = grammar;
  }

  add(kind: LogicStep["kind"], text: string, node: Node, calls: string[] = []): LogicStep {
    const made: LogicStep = { id: `n${this.nodes.length}`, kind, text, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };

    if (calls.length > 0) made.calls = calls;
    this.nodes.push(made);

    return made;
  }

  /** The arrows from the open exits to `to`; `back`: `to` is the header of a loop the exits return into. */
  link(exits: readonly Exit[], to: string, back = false): void {
    for (const exit of exits) {
      const edge: LogicEdge = { from: exit.from, to };

      if (exit.label !== undefined) edge.label = exit.label;

      if (exit.enters) edge.enters = true;

      if (back) edge.back = true;
      this.edges.push(edge);
    }
  }

  /** The statements of a list in order; a list whose every path ended (a return) leaves nothing open. */
  statements(list: readonly Node[], open: Exit[]): Exit[] {
    let current = open;

    for (const node of list) {
      if (current.length === 0) break;

      if (this.nodes.length >= MAX_NODES) {
        this.truncated = true;
        break;
      }

      current = this.statement(node, current);
    }

    return current;
  }

  /** The statements of a block (or of a lone statement standing for one). */
  private body(node: Node | null): Node[] {
    if (!node) return [];

    return this.grammar.blocks.has(node.type) ? node.namedChildren : [node];
  }

  statement(node: Node, open: Exit[]): Exit[] {
    const { grammar } = this;
    const { control } = grammar;

    if (node.type === "labeled_statement") {
      const inner = node.childForFieldName("body") ?? node.namedChildren[node.namedChildren.length - 1];
      // The loop or switch right under the label takes it; a labelled block has no frame (its `break` ends nothing drawn).
      this.label = node.childForFieldName("label")?.text ?? (node.namedChildren.length > 1 ? node.namedChildren[0]!.text : null);
      const exits = inner ? this.statement(inner, open) : open;
      this.label = null;

      return exits;
    }

    // A statement under a label is the one the label names; the statements inside it are not.
    const label = this.label;
    this.label = null;

    if (grammar.blocks.has(node.type)) return this.statements(node.namedChildren, open);

    if (grammar.silent.has(node.type)) return open;

    if (control.ifs.has(node.type)) return this.branch(node, open);

    if (node.type === "match_statement") return this.matchOf(node, open);

    if (control.switches.has(node.type)) return this.switchOf(node, open, label);

    if (control.loops.has(node.type)) return this.loop(node, open, label);

    if (control.tries.has(node.type)) return this.tryOf(node, open);
    // A call that ends the program or unwinds the stack (Go's `panic(…)`) is an exit as a `throw` is.
    const throws = grammar.throws.has(node.type) || (grammar.throwCall !== undefined && node.type === "expression_statement" && grammar.throwCall.test(node.text));

    // An exit; the `finally` blocks around it run after it, innermost first, on the way to the end of the body (a
    // `finally` that returns on its own ends the path there).
    if (grammar.returns.has(node.type) || throws) {
      const made = this.add(throws ? "throw" : "return", statementText(node), node, calleesIn(node, grammar));
      this.link(open, made.id);

      if (this.finallies.length > 0) this.afterExits.push(...this.throughFinally([{ from: made.id }], 0));

      return [];
    }

    // `break` and `continue` (`break outer` the loop so labelled) leave through the `finally` blocks opened inside the loop.
    if (grammar.breaks.has(node.type) || grammar.continues.has(node.type)) {
      // The label a jump names: a field of the statement, or (Go) its one child.
      const named = node.childForFieldName("label")?.text ?? node.namedChildren.find((child) => child.type === "label_name")?.text ?? null;
      const isBreak = grammar.breaks.has(node.type);
      const frame = [...this.frames].reverse().find((each) => (named !== null ? each.label === named : isBreak || each.kind === "loop"));

      if (!frame) return [];
      const through = this.throughFinally(open, frame.finallies);

      if (isBreak) frame.breaks.push(...through);
      else if (frame.head) this.link(through, frame.head, true);

      return [];
    }

    // Python's `with x as y:` runs its block under the context: the header is an action, the block follows.
    if (grammar.wrappers.has(node.type)) {
      const body = node.childForFieldName("body");
      const header = collapse(node.text.slice(0, (body?.startIndex ?? node.endIndex) - node.startIndex)).replace(/:\s*$/, "");
      const made = this.add("action", short(header), node, calleesIn(node, grammar));
      this.link(open, made.id);

      return this.statements(this.body(body), [{ from: made.id }]);
    }

    return this.action(node, open);
  }

  /**
   * The paths `open` once they ran the `finally` blocks opened since `from` (`0`: all of them), innermost first: each
   * block is read again for these paths, outside its own `try`.
   */
  private throughFinally(open: Exit[], from: number): Exit[] {
    const saved = this.finallies;
    let current = open;

    for (let at = saved.length - 1; at >= from && current.length > 0; at--) {
      this.finallies = saved.slice(0, at);
      current = this.statements(this.body(saved[at]!), current);
    }

    this.finallies = saved;

    return current;
  }

  /** A plain statement: joined to the action box just before it when that box is the only way here and has room. */
  private action(node: Node, open: Exit[]): Exit[] {
    const text = statementText(node);
    const calls = calleesIn(node, this.grammar);
    const last = this.nodes[this.nodes.length - 1];
    const only = open.length === 1 ? open[0]! : null;

    if (last && only && only.from === last.id && only.label === undefined && last.kind === "action" && last.text.split("\n").length < STATEMENTS_PER_ACTION && !this.edges.some((edge) => edge.from === last.id)) {
      last.text = `${last.text}\n${text}`;
      last.endLine = node.endPosition.row + 1;

      if (calls.length > 0) last.calls = [...new Set([...(last.calls ?? []), ...calls])].slice(0, 8);

      return open;
    }

    const made = this.add("action", text, node, calls);
    this.link(open, made.id);

    return [{ from: made.id }];
  }

  /** An `if` (or an `elif`): yes into its branch, no into the alternatives, both open afterwards. */
  private branch(node: Node, open: Exit[]): Exit[] {
    const { control } = this.grammar;
    // Go's `if err := f(); err != nil`: the statement before the condition runs first.
    const initializer = node.childForFieldName("initializer");

    if (initializer) open = this.action(initializer, open);
    const decision = this.add("decision", headerOf(node), node, calleesIn(node.childForFieldName("condition") ?? node, this.grammar));
    this.link(open, decision.id);
    const consequence = node.childForFieldName(control.consequence);
    const exits = this.statements(this.body(consequence), [{ from: decision.id, label: "yes" }]);
    let pending: Exit[] = [{ from: decision.id, label: "no" }];
    // Go: `else` is followed by the other branch itself, a block or the next `if` of the chain.
    const bare = control.alternative === undefined ? null : node.childForFieldName(control.alternative);

    if (control.alternative !== undefined) return bare ? [...exits, ...this.statement(bare, pending)] : [...exits, ...pending];

    // TypeScript: one `else_clause` holding a block or an `if`; Python: `elif_clause`s then an `else_clause`.
    for (const alternative of node.namedChildren) {
      if (alternative.id === consequence?.id || alternative.id === node.childForFieldName("condition")?.id) continue;

      if (control.ifs.has(alternative.type)) {
        // Python's `elif`: a decision of its own, whose `no` goes on to the clauses after it (`else` among them: siblings).
        const elif = this.add("decision", headerOf(alternative), alternative, calleesIn(alternative.childForFieldName("condition") ?? alternative, this.grammar));
        this.link(pending, elif.id);
        exits.push(...this.statements(this.body(alternative.childForFieldName(control.consequence)), [{ from: elif.id, label: "yes" }]));
        pending = [{ from: elif.id, label: "no" }];
      } else if (control.elses.has(alternative.type)) {
        const inner = alternative.childForFieldName("body") ?? alternative.namedChildren[0] ?? null;
        exits.push(...(inner ? this.statement(inner, pending) : pending));
        pending = [];
      }
    }

    return [...exits, ...pending];
  }

  /**
   * A `switch`: the value is the decision, every case a labelled arrow; a case without `break` falls into the next
   * where the language lets it (Go's cases, a type switch's and a `select`'s never do).
   */
  private switchOf(node: Node, open: Exit[], label: string | null): Exit[] {
    const { cases } = this.grammar;
    const value = node.childForFieldName("value");
    // Go's `select` chooses among channel operations and `switch { … }` among conditions: no value to name.
    const head = node.type === "select_statement" ? "select" : `switch ${short(unwrapped(value?.text ?? ""))}`.trim();
    const decision = this.add("decision", head, node, value ? calleesIn(value, this.grammar) : cases.fallThrough ? calleesIn(node, this.grammar) : []);
    this.link(open, decision.id);
    const frame: Frame = { kind: "switch", head: null, breaks: [], label, finallies: this.finallies.length };
    this.frames.push(frame);
    let fall: Exit[] = [];
    const done: Exit[] = [];
    let hasDefault = false;

    for (const clause of cases.of(node)) {
      const { label, statements } = caseOf(clause);
      hasDefault = hasDefault || label === null;
      const entry: Exit[] = [...fall, { from: decision.id, label: label ?? "default" }];
      const exits = statements.length === 0 ? entry : this.statements(statements, entry);

      if (cases.fallThrough) fall = exits;
      else done.push(...exits);
    }

    this.frames.pop();

    return [...frame.breaks, ...fall, ...done, ...(hasDefault ? [] : [{ from: decision.id, label: "no match" }])];
  }

  /** Python's `match`: one arrow per case pattern (with its guard), no fall-through. */
  private matchOf(node: Node, open: Exit[]): Exit[] {
    const subject = node.childForFieldName("subject");
    const decision = this.add("decision", `match ${short(subject?.text ?? "")}`, node);
    this.link(open, decision.id);
    const exits: Exit[] = [];
    let hasDefault = false;

    for (const clause of node.namedChildren.flatMap((child) => (child.type === "block" ? child.namedChildren : [child]))) {
      if (clause.type !== "case_clause") continue;
      const patterns = clause.namedChildren.filter((child) => child.type === "case_pattern").map((child) => child.text);
      const guard = clause.namedChildren.find((child) => child.type === "guard");
      const label = short(`${patterns.join(" | ")}${guard ? ` ${guard.text}` : ""}`);
      hasDefault = hasDefault || patterns.includes("_");
      exits.push(...this.statements(this.body(clause.childForFieldName("consequence")), [{ from: decision.id, label }]));
    }

    return [...exits, ...(hasDefault ? [] : [{ from: decision.id, label: "no match" }])];
  }

  /** A loop: `each` (or `while`) into the body, whose end comes back; `done` carries on, as does every `break`. */
  private loop(node: Node, open: Exit[], label: string | null): Exit[] {
    // Go writes its loop's clause (`i := 0; i < n; i++`, `_, x := range xs`, a bare condition) as a child without a field; `for { … }` has none.
    const clause = this.grammar.lang === "go" ? (node.namedChildren.find((child) => child.id !== node.childForFieldName("body")?.id) ?? null) : undefined;
    const head = this.add("loop", headerOf(node), node, clause === null ? [] : calleesIn(clause ?? node.childForFieldName("right") ?? node.childForFieldName("condition") ?? node.childForFieldName("value") ?? node, this.grammar));
    this.link(open, head.id);
    const frame: Frame = { kind: "loop", head: head.id, breaks: [], label, finallies: this.finallies.length };
    this.frames.push(frame);
    // A loop over the elements of something, or one that runs while a condition holds (Go's `for cond`, `for { … }`).
    const inside = node.type === "while_statement" || node.type === "do_statement" || (clause !== undefined && clause?.type !== "range_clause" && clause?.type !== "for_clause") ? "while" : "each";
    const back = this.statements(this.body(node.childForFieldName("body")), [{ from: head.id, label: inside, enters: true }]);
    this.link(back, head.id, true);
    this.frames.pop();
    // Python's `for … else:` runs its block when the loop ends without a break.
    const orElse = node.namedChildren.find((child) => this.grammar.control.elses.has(child.type));
    const done = orElse ? this.statements(this.body(orElse.childForFieldName("body") ?? orElse.namedChildren[0] ?? null), [{ from: head.id, label: "done" }]) : [{ from: head.id, label: "done" }];

    return [...done, ...frame.breaks];
  }

  /**
   * A `try`: ok into the body, error into each handler, everything through `finally` — the paths that go on after the
   * `try`, and the ones that leave it inside by a `return`, a `throw`, a `break` or a `continue` (`throughFinally`).
   */
  private tryOf(node: Node, open: Exit[]): Exit[] {
    const decision = this.add("decision", "try", node);
    this.link(open, decision.id);
    const blockOf = (clause: Node): Node | null => clause.childForFieldName("body") ?? clause.namedChildren.find((child) => this.grammar.blocks.has(child.type)) ?? null;
    const finallyClause = node.namedChildren.find((clause) => clause.type === "finally_clause");
    const finallyBody = finallyClause ? blockOf(finallyClause) : null;

    // The body, the handlers and Python's `else` run inside the `try`: a path leaving them runs `finally` on the way.
    if (finallyBody) this.finallies = [...this.finallies, finallyBody];
    let bodyExits = this.statements(this.body(node.childForFieldName("body")), [{ from: decision.id, label: "ok" }]);
    const handlerExits: Exit[] = [];

    for (const clause of node.namedChildren) {
      if (clause.type === "catch_clause" || clause.type === "except_clause") {
        // The error bound: TypeScript's parameter, Python's `ValueError as e`.
        const named = clause.childForFieldName("parameter") ?? clause.namedChildren.find((child) => !this.grammar.blocks.has(child.type) && child.type !== "comment");
        handlerExits.push(...this.statements(this.body(blockOf(clause)), [{ from: decision.id, label: short(`error${named ? ` ${named.text}` : ""}`) }]));
      } else if (clause.type === "else_clause") {
        // Python: `else` runs when the body raised nothing, so it follows the body's exits only.
        bodyExits = this.statements(this.body(blockOf(clause)), bodyExits);
      }
    }

    if (finallyBody) this.finallies = this.finallies.slice(0, -1);
    const exits = [...bodyExits, ...handlerExits];

    return finallyBody ? this.statements(this.body(finallyBody), exits) : exits;
  }
}

/** The function-like nodes of a tree with the name each is bound to, for finding the one a graph node stands for. */
function functionNodes(root: Node, grammar: LogicGrammar): { node: Node; name: string | null; line: number }[] {
  const out: { node: Node; name: string | null; line: number }[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const at = stack.pop()!;

    if (grammar.control.functions.has(at.type)) {
      const own = at.childForFieldName("name")?.text ?? null;
      // `const f = () => …` and `f: () => …`: the binding names the function, and the declaration's line is the binding's
      // (as ts.ts records it); a named function or method, and a decorated Python def, start at their own line.
      const parent = at.parent;
      const holder = parent?.type === "variable_declarator" || parent?.type === "pair" || parent?.type === "public_field_definition" || parent?.type === "field_definition" ? parent : null;
      const bound = holder?.childForFieldName("name")?.text ?? holder?.childForFieldName("key")?.text ?? holder?.childForFieldName("property")?.text ?? null;
      out.push({ node: at, name: own ?? bound, line: (holder ?? at).startPosition.row + 1 });
    }

    for (const child of at.namedChildren) stack.push(child);
  }

  return out;
}

/**
 * The flowchart of the function `name` (a method as `Class.method`) declared
 * at `line` of the file `path` with the source `source`; null when the file
 * is of another language or the function is not found. The body's
 * statements become the nodes and arrows of `LogicFact`; an arrow function
 * with an expression body is one return.
 */
export async function readLogic(path: string, source: string, name: string, line: number): Promise<LogicFact | null> {
  let g: Grammar;

  try {
    g = grammarFor(path);
  } catch {
    return null;
  }

  const grammar = g === "python" ? PY_LOGIC : g === "typescript" || g === "tsx" || g === "javascript" ? TS_LOGIC : g === "go" ? GO_LOGIC : null;

  if (!grammar) return null;

  return withTree(g, source, (tree) => {
    const member = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
    const candidates = functionNodes(tree.rootNode, grammar);
    // The one at the declaration's line named like the graph node; else the first at that line; else the first so named.
    const found = candidates.find((candidate) => candidate.line === line && candidate.name === member) ?? candidates.find((candidate) => candidate.line === line) ?? candidates.find((candidate) => candidate.name === member);

    if (!found) return null;
    const builder = new Builder(grammar);
    const start = builder.add("start", "start", found.node);
    const body = found.node.childForFieldName("body");
    let exits: Exit[];

    if (!body) exits = [{ from: start.id }];
    else if (grammar.blocks.has(body.type)) exits = builder.statements(body.namedChildren, [{ from: start.id }]);
    else {
      // An arrow function whose body is an expression: it returns the expression.
      const made = builder.add("return", `return ${statementText(body)}`, body, calleesIn(body, grammar));
      builder.link([{ from: start.id }], made.id);
      exits = [];
    }

    // The paths that end the body, and the exits that ran a `finally` on the way out.
    if (exits.length > 0 || builder.afterExits.length > 0) {
      const end = builder.add("end", "end", found.node);
      builder.link([...exits, ...builder.afterExits], end.id);
    }

    const fact: LogicFact = { nodes: builder.nodes, edges: builder.edges };

    if (builder.truncated) fact.truncated = true;

    return fact;
  });
}
