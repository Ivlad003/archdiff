// What `archdiff check` finds: the code held to its contract — the imports
// between layers that no arrow of ARCHITECTURE.md allows — and to the
// rules archdiff.json states beside it (rules.ts): a file of a layer named
// against its pattern, a module over a threshold of what metrics.ts
// measures, an import inside a cycle when the code may have none, an
// import that reaches a layer past the module it goes through, an import
// of what is forbidden. Each is a violation of one shape (the rule, the
// module, what it imports, the line), then held against the baseline: the
// new ones, which fail the check, the known ones, and the entries of the
// baseline that no longer occur. The report is written here once — as
// Markdown, as lines of text and as JSON — for the CLI, the page and the
// checks after an agent's run.
//
// Type-only imports are no violation of a rule, as they are none of the
// layers: nothing of them runs. Pure functions of the analysis: the
// baseline is read at the edge and handed in. Entry points: `checkCode`,
// `ContractCheck`, `checkMarkdown`, `checkSummary`, `checkJson`,
// `violationLine`, `LAYERS_RULE`.

import type { Analysis } from "./analyze.ts";
import { againstBaseline, type Baseline, type KnownViolation, type Violation } from "./baseline.ts";
import { CONFIG_FILE } from "./config.ts";
import { importCycles } from "./cycles.ts";
import type { ModuleMetrics } from "./diagram.ts";
import { matchesGlob } from "./glob.ts";
import type { Graph, Module } from "./graph.ts";
import { checkIntent, INTENT_FILE, judgesLayers, type IntentReport } from "./intent.ts";
import { metricsOf } from "./metrics.ts";
import type { CyclesRule, ForbiddenRule, Metric, NamingRule, Rule, ThresholdRule, ThroughRule } from "./rules.ts";
import { counted } from "./words.ts";

/** The rule of the contract's flowchart: an import between two layers needs an arrow between them. */
export const LAYERS_RULE = "layers";

/** The code checked against its contract and its rules: what was found, and how it stands against the baseline. */
export interface ContractCheck {
  /** The code against the contract's flowchart (what is planned, what is built beyond it); null when no contract names a layer. */
  report: IntentReport | null;
  /** How many rules of archdiff.json the code was held to. */
  rules: number;
  /** Every violation, new and known, in the order of the report: the layers', then each rule's. */
  violations: Violation[];
  /** The violations the baseline does not list: they fail the check. */
  fresh: Violation[];
  /** The violations the baseline lists. */
  known: Violation[];
  /** The entries of the baseline that no longer occur. */
  stale: KnownViolation[];
  /** The baseline's file when the violations were held against one. */
  baseline: string | null;
  ok: boolean;
}

/** The imports against the contract's layers, as violations of the rule `layers`. */
function layerViolations(report: IntentReport): Violation[] {
  return report.violations.map((violation) => ({ rule: LAYERS_RULE, ...violation, problem: `layer **${violation.fromLayer}** → **${violation.toLayer}** is not in the intent`, advice: `Add the arrow to ${INTENT_FILE} if it is wanted, else move the import.` }));
}

/** A file's name: its path's last segment. */
function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The modules of a layer whose name does not fit the rule's pattern: a glob of the name, or of the path when it has a slash, or a regular expression of the name. */
function namingViolations(rule: NamingRule, modules: readonly Module[]): Violation[] {
  const regex = rule.regex === null ? null : new RegExp(rule.regex);
  const fits = (path: string): boolean => (regex ? regex.test(fileName(path)) : matchesGlob(rule.pattern!.includes("/") ? path : fileName(path), rule.pattern!));

  return modules.filter((module) => module.layer === rule.layer && !fits(module.id)).map((module) => ({ rule: rule.name, from: module.id, line: 1, problem: `the files of layer **${rule.layer}** are named \`${rule.pattern ?? `/${rule.regex}/`}\``, advice: "Rename the file, or place it in the layer it belongs to." }));
}

/** What a rule calls each number of a module: where metrics.ts keeps it, and how a report says a value of it. */
const MEASURES: Record<Metric, { key: keyof ModuleMetrics; said: (value: string) => string }> = {
  fanIn: { key: "ca", said: (value) => `its fan-in (Ca) is ${value}` },
  fanOut: { key: "ce", said: (value) => `its fan-out (Ce) is ${value}` },
  instability: { key: "instability", said: (value) => `its instability is ${value}` },
  abstractness: { key: "abstractness", said: (value) => `its abstractness is ${value}` },
  distance: { key: "distance", said: (value) => `its distance from the main sequence is ${value}` },
  cohesion: { key: "cohesion", said: (value) => `its cohesion is ${value}` },
  lines: { key: "lines", said: (value) => `it has ${value} lines` },
};

/** The modules (of the rule's layer, when it names one) whose number is over the rule's `max` or under its `min`. */
function thresholdViolations(rule: ThresholdRule, rows: readonly ModuleMetrics[]): Violation[] {
  const { key, said } = MEASURES[rule.metric];
  const violations: Violation[] = [];

  for (const row of rows) {
    if (rule.layer !== null && row.layer !== rule.layer) continue;
    const value = row[key] as number;
    const shown = Number.isInteger(value) ? String(value) : value.toFixed(2);

    if (rule.max !== null && value > rule.max) violations.push({ rule: rule.name, from: row.id, line: 1, problem: `${said(shown)}, over the ${rule.max} allowed` });
    else if (rule.min !== null && value < rule.min) violations.push({ rule: rule.name, from: row.id, line: 1, problem: `${said(shown)}, under the ${rule.min} asked for` });
  }

  return violations;
}

/** The imports that count for a rule of imports: what runs (no type-only import), from one module to another thing. */
function runtimeImports(graph: Graph): Graph["deps"] {
  return graph.deps.filter((dep) => !dep.typeOnly && dep.from !== dep.to);
}

/**
 * With more import cycles than the rule allows, every import inside one, once per pair of modules: an import is
 * what a cycle is fixed at, and what stays the same violation while the cycle shrinks.
 */
function cycleViolations(rule: CyclesRule, graph: Graph): Violation[] {
  const cycles = importCycles(graph);

  if (cycles.length <= rule.max) return [];
  const cycleOf = new Map<string, number>();
  cycles.forEach((members, i) => members.forEach((member) => cycleOf.set(member, i)));
  const seen = new Set<string>();
  const violations: Violation[] = [];

  for (const dep of runtimeImports(graph)) {
    const cycle = cycleOf.get(dep.from);
    const pair = `${dep.from}\u0000${dep.to}`;

    if (cycle === undefined || cycleOf.get(dep.to) !== cycle || seen.has(pair)) continue;
    seen.add(pair);
    violations.push({ rule: rule.name, from: dep.from, to: dep.to, line: dep.line, problem: `inside an import cycle of ${counted(cycles[cycle]!.length, "module")}${rule.max > 0 ? ` (${counted(cycles.length, "cycle")}, ${rule.max} allowed)` : ""}`, advice: `\`archdiff diagram cycle:${dep.from}\` draws the cycle and the imports to cut.` });
  }

  return violations;
}

/** The imports that reach the rule's layer from another one (the rule's `from`, when it names one) past the modules it goes through: neither end is one of them. */
function throughViolations(rule: ThroughRule, graph: Graph): Violation[] {
  const gate = (id: string): boolean => rule.through.some((glob) => matchesGlob(id, glob));
  const violations: Violation[] = [];

  for (const dep of runtimeImports(graph)) {
    const fromLayer = graph.modules.get(dep.from)?.layer;

    if (graph.modules.get(dep.to)?.layer !== rule.to || fromLayer === undefined || fromLayer === rule.to || (rule.from !== null && fromLayer !== rule.from) || gate(dep.from) || gate(dep.to)) continue;
    violations.push({ rule: rule.name, from: dep.from, to: dep.to, line: dep.line, fromLayer, toLayer: rule.to, problem: `layer **${fromLayer}** reaches **${rule.to}** only through ${rule.through.map((glob) => `\`${glob}\``).join(", ")}` });
  }

  return violations;
}

/**
 * The imports of what the rule forbids — a module by its path or a glob, a package or a built-in by its ID
 * (`pkg:lodash`, `node:fs`) or its name — from the rule's layer, or from anywhere without one. A module the rule
 * names may import its own kind.
 */
function forbiddenViolations(rule: ForbiddenRule, graph: Graph): Violation[] {
  const named = (id: string): boolean => rule.imports.some((entry) => matchesGlob(id, entry) || graph.externals.get(id)?.name === entry);
  const violations: Violation[] = [];

  for (const dep of runtimeImports(graph)) {
    if ((rule.from !== null && graph.modules.get(dep.from)?.layer !== rule.from) || !named(dep.to) || named(dep.from)) continue;
    violations.push({ rule: rule.name, from: dep.from, to: dep.to, line: dep.line, problem: rule.from === null ? `\`${dep.to}\` is not to be imported` : `layer **${rule.from}** is not to import \`${dep.to}\`` });
  }

  return violations;
}

/** The layers a rule names, each with the field that names it. */
function layersNamed(rule: Rule): [field: string, layer: string | null][] {
  if (rule.kind === "naming" || rule.kind === "threshold") return [["layer", rule.layer]];

  if (rule.kind === "through") return [["from", rule.from], ["to", rule.to]];

  return rule.kind === "forbidden" ? [["from", rule.from]] : [];
}

/**
 * The violations of the rules of archdiff.json, rule by rule. A rule that names a layer the repository does not
 * have is a mistake of the configuration, not a rule that holds: it throws, naming the field and the layers.
 */
function ruleViolations(analysis: Analysis): Violation[] {
  const { graph, config, intent } = analysis;

  if (config.rules.length === 0) return [];
  const layers = new Set([...graph.layers, ...Object.keys(config.layers ?? {}), ...(intent?.layers.map((layer) => layer.name) ?? [])]);

  for (const rule of config.rules) for (const [field, layer] of layersNamed(rule)) if (layer !== null && !layers.has(layer)) throw new Error(`${CONFIG_FILE}: "${rule.at}.${field}": no layer "${layer}" (the layers: ${[...layers].sort().join(", ")})`);
  const modules = [...graph.modules.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  // The metrics are measured once, and only for a rule that reads them: the cohesion of every module is not free.
  const rows = config.rules.some((rule) => rule.kind === "threshold") ? metricsOf(analysis).modules : [];

  return config.rules.flatMap((rule) => (rule.kind === "naming" ? namingViolations(rule, modules) : rule.kind === "threshold" ? thresholdViolations(rule, rows) : rule.kind === "cycles" ? cycleViolations(rule, graph) : rule.kind === "through" ? throughViolations(rule, graph) : forbiddenViolations(rule, graph)));
}

/**
 * The code checked: against the layers of its contract and the rules of archdiff.json, then against `baseline`
 * (null: none, every violation is new). Null when nothing judges the code — no rule, and no ARCHITECTURE.md
 * that names a layer.
 */
export function checkCode(analysis: Analysis, baseline: Baseline | null): ContractCheck | null {
  const report = judgesLayers(analysis.intent) ? checkIntent(analysis, analysis.intent) : null;
  const rules = analysis.config.rules.length;

  if (report === null && rules === 0) return null;
  const violations = [...(report ? layerViolations(report) : []), ...ruleViolations(analysis)];
  const held = againstBaseline(violations, baseline);

  return { report, rules, violations, ...held, baseline: baseline?.file ?? null, ok: held.fresh.length === 0 };
}

/** Markdown's marks taken out of a sentence, for a line of plain text. */
function plain(markdown: string): string {
  return markdown.replace(/\*\*|`/g, "");
}

/** The rule a violation is of, said after it; nothing for the contract's own arrows, which the sentence names already. */
function ruleNote(violation: Violation, quote: string): string {
  return violation.rule === LAYERS_RULE ? "" : ` (rule ${quote}${violation.rule}${quote})`;
}

/** A violation in one line of plain text: `src/routes/health.ts:2 imports src/db/store.ts: layer routes → db is not in the intent`. */
export function violationLine(violation: Violation): string {
  return `${violation.from}:${violation.line}${violation.to === undefined ? "" : ` imports ${violation.to}`}: ${plain(violation.problem)}${ruleNote(violation, "")}`;
}

/** A violation as a bullet of the report; `advice`: with what to do about it. */
function violationBullet(violation: Violation, advice: boolean): string {
  return `- \`${violation.from}:${violation.line}\`${violation.to === undefined ? "" : ` imports \`${violation.to}\``}: ${violation.problem}${ruleNote(violation, "`")}.${advice && violation.advice ? ` ${violation.advice}` : ""}`;
}

/** What judged the code: the contract, by the name it has where the sentence is read, and the rules. */
function judges(check: ContractCheck, contract: string): string {
  return [check.report ? contract : null, check.rules > 0 ? `the rules of ${CONFIG_FILE}` : null].filter((part) => part !== null).join(" and ");
}

/**
 * The check in one sentence, without its full stop: "the code follows the intent", "2 new violations of the intent
 * and the rules of archdiff.json; 3 known violations in archdiff-baseline.json; 1 entry of archdiff-baseline.json
 * no longer occurs". `contract` is what the contract is called where the sentence is read (the intent,
 * ARCHITECTURE.md).
 */
export function checkSummary(check: ContractCheck, contract: string): string {
  const parts = [check.fresh.length === 0 ? `the code follows ${judges(check, contract)}` : `${counted(check.fresh.length, check.baseline === null ? "violation" : "new violation")} of ${judges(check, contract)}`];

  if (check.known.length > 0) parts.push(`${counted(check.known.length, "known violation")} in ${check.baseline}`);

  if (check.stale.length > 0) parts.push(`${counted(check.stale.length, "entry", "entries")} of ${check.baseline} no longer ${check.stale.length === 1 ? "occurs" : "occur"}`);

  return parts.join("; ");
}

/** The report of a check as Markdown: the violations that fail it, the known ones, what the baseline can drop, then the news of the contract. */
export function checkMarkdown(check: ContractCheck, root: string): string {
  const summary = checkSummary(check, "the intent");
  const lines = [`<!-- archdiff:generated — check -->`, `# Check: the code of ${root} against ${judges(check, INTENT_FILE)}`, "", `**${summary[0]!.toUpperCase()}${summary.slice(1)}.**`, ""];

  if (check.fresh.length > 0) lines.push(check.baseline === null ? "## Violations" : `## New violations (${check.fresh.length})`, "", ...check.fresh.map((violation) => violationBullet(violation, true)), "");

  if (check.known.length > 0) lines.push(`## Known violations (${check.known.length})`, "", `Listed in \`${check.baseline}\`: they do not fail the check.`, "", ...check.known.map((violation) => violationBullet(violation, false)), "");

  if (check.stale.length > 0) lines.push(`## Fixed since the baseline (${check.stale.length})`, "", `These entries of \`${check.baseline}\` no longer occur: remove them (\`archdiff check --baseline\` writes the file anew).`, "", ...check.stale.map((violation) => `- \`${violation.from}\`${violation.to === undefined ? "" : ` imports \`${violation.to}\``} — ${violation.rule}`), "");
  const report = check.report;

  if (report && report.planned.length > 0) lines.push(`## Planned, not built (${report.planned.length})`, "", ...report.planned.map((item) => `- \`${item}\``), "");

  if (report && report.plannedEdges.length > 0) lines.push(`## Planned imports and calls, not built (${report.plannedEdges.length})`, "", ...report.plannedEdges.map((item) => `- ${item}`), "");

  if (report && report.beyond.length > 0) lines.push(`## Built beyond the intent (${report.beyond.length})`, "", ...report.beyond.map((item) => `- \`${item}\` — name it in ${INTENT_FILE}, or it is a drift`), "");

  if (report && report.unintended.length > 0) lines.push(`## Imports the intent does not name (${report.unintended.length})`, "", ...report.unintended.map((item) => `- ${item}`), "");

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The check as JSON: the contract's report with `violations` — every violation the code has, each with its rule,
 * its place, what is wrong in plain words and whether the baseline knows it (an import between layers keeps
 * `fromLayer` and `toLayer`) — the baseline's entries that no longer occur (`stale`), the baseline's file, and
 * `ok`: whether no violation is new, which is the exit code.
 */
export function checkJson(check: ContractCheck): Record<string, unknown> {
  const known = new Set(check.known);
  const report = check.report ?? { planned: [], plannedEdges: [], beyond: [], unintended: [] };
  const violations = check.violations.map((violation) => {
    const { advice: _advice, problem, ...what } = violation;

    return { ...what, problem: plain(problem), known: known.has(violation) };
  });

  return { ...report, violations, ok: check.ok, stale: check.stale, baseline: check.baseline };
}
