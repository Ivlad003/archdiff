// What `archdiff check` finds: the code held to its contract — the imports
// between layers that no arrow of ARCHITECTURE.md allows — each a
// violation of one shape (the rule, the module, what it imports, the
// line), then held against the baseline: the new ones, which fail the
// check, the known ones, and the entries of the baseline that no longer
// occur. The report is written here once — as Markdown, as lines of text
// and as JSON — for the CLI, the page and the checks after an agent's run.
//
// Pure functions of the analysis: the baseline is read at the edge and
// handed in. Entry points: `checkCode`, `ContractCheck`, `checkMarkdown`,
// `checkSummary`, `checkJson`, `violationLine`, `LAYERS_RULE`.

import type { Analysis } from "./analyze.ts";
import { againstBaseline, type Baseline, type KnownViolation, type Violation } from "./baseline.ts";
import { checkIntent, INTENT_FILE, judgesLayers, type IntentReport } from "./intent.ts";
import { counted } from "./words.ts";

/** The rule of the contract's flowchart: an import between two layers needs an arrow between them. */
export const LAYERS_RULE = "layers";

/** The code checked against its contract: what was found, and how it stands against the baseline. */
export interface ContractCheck {
  /** The code against the contract's flowchart (what is planned, what is built beyond it); null when no contract names a layer. */
  report: IntentReport | null;
  /** Every violation, new and known, in the order of the report. */
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

/**
 * The code checked: against the layers of its contract, then against `baseline` (null: none, every violation is
 * new). Null when nothing judges the code — no ARCHITECTURE.md, or one that names no layer.
 */
export function checkCode(analysis: Analysis, baseline: Baseline | null): ContractCheck | null {
  const report = judgesLayers(analysis.intent) ? checkIntent(analysis, analysis.intent) : null;

  if (report === null) return null;
  const violations = layerViolations(report);
  const held = againstBaseline(violations, baseline);

  return { report, violations, ...held, baseline: baseline?.file ?? null, ok: held.fresh.length === 0 };
}

/** Markdown's marks taken out of a sentence, for a line of plain text. */
function plain(markdown: string): string {
  return markdown.replace(/\*\*|`/g, "");
}

/** A violation in one line of plain text: `src/routes/health.ts:2 imports src/db/store.ts: layer routes → db is not in the intent`. */
export function violationLine(violation: Violation): string {
  return `${violation.from}:${violation.line}${violation.to === undefined ? "" : ` imports ${violation.to}`}: ${plain(violation.problem)}`;
}

/** A violation as a bullet of the report; `advice`: with what to do about it. */
function violationBullet(violation: Violation, advice: boolean): string {
  return `- \`${violation.from}:${violation.line}\`${violation.to === undefined ? "" : ` imports \`${violation.to}\``}: ${violation.problem}.${advice && violation.advice ? ` ${violation.advice}` : ""}`;
}

/**
 * The check in one sentence, without its full stop: "the code follows the intent", "2 new violations of the intent;
 * 3 known violations in archdiff-baseline.json; 1 entry of archdiff-baseline.json no longer occurs". `contract` is
 * what the contract is called where the sentence is read (the intent, ARCHITECTURE.md).
 */
export function checkSummary(check: ContractCheck, contract: string): string {
  const parts = [check.fresh.length === 0 ? `the code follows ${contract}` : `${counted(check.fresh.length, check.baseline === null ? "violation" : "new violation")} of ${contract}`];

  if (check.known.length > 0) parts.push(`${counted(check.known.length, "known violation")} in ${check.baseline}`);

  if (check.stale.length > 0) parts.push(`${counted(check.stale.length, "entry", "entries")} of ${check.baseline} no longer ${check.stale.length === 1 ? "occurs" : "occur"}`);

  return parts.join("; ");
}

/** The report of a check as Markdown: the violations that fail it, the known ones, what the baseline can drop, then the news of the contract. */
export function checkMarkdown(check: ContractCheck, root: string): string {
  const summary = checkSummary(check, "the intent");
  const lines = [`<!-- archdiff:generated — check -->`, `# Check: the code of ${root} against ${INTENT_FILE}`, "", `**${summary[0]!.toUpperCase()}${summary.slice(1)}.**`, ""];

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
