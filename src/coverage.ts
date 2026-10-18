// The map of what the diagrams cannot show: per module, the imports that
// resolve to nothing, the calls archdiff could not follow and why, the
// files whose syntax it could not parse, and the constructs it reads but
// does not follow (an `eval`, a computed import). A pure function of the
// analysis that gives the same report for the same graph, as JSON and as
// Markdown.
//
// Sits after the graph, beside the views: Analysis → CoverageReport.
// Entry points: `coverageReport`, `CoverageReport`.

import type { Analysis } from "./analyze.ts";
import { BLIND_SPOT_REASONS, GAP_REASONS, isBlindSpot, moduleOf, type Gap } from "./graph.ts";
import { counted } from "./words.ts";

/** Constructs read but not followed the Markdown lists, at most; the JSON has every one. */
const MAX_UNSUPPORTED = 40;

export interface ModuleCoverage {
  module: string;
  layer: string;
  /** Calls followed to a function of the repository. */
  calls: number;
  /** Calls not followed, by reason. */
  gaps: Partial<Record<Gap["reason"], number>>;
  /** The callees not followed, with the reason and the line, at most 20. */
  examples: { callee: string; reason: Gap["reason"]; line: number }[];
  unresolvedImports: { specifier: string; reason: string; line: number }[];
  parseError: boolean;
}

export interface CoverageReport {
  files: number;
  calls: number;
  gaps: number;
  /** Calls into the repository hidden by a blind spot (`dynamic`, `unknown-member`, `interface`, `unresolved`). */
  blind: number;
  /** Followed calls over followed plus blind, 0–1. */
  ratio: number;
  byReason: Partial<Record<Gap["reason"], number>>;
  unresolvedImports: number;
  parseErrors: string[];
  /** Source files left out of the analysis (too large), with the reason. */
  skipped: { path: string; reason: string }[];
  /** The constructs a frontend read but does not follow (an `eval`, a computed import, a decorator that may replace a function), by module and line. */
  unsupported: { module: string; line: number; text: string; reason: string }[];
  /** Modules with at least one blind call, unresolved import or syntax error, the most first. */
  modules: ModuleCoverage[];
  markdown: string;
}

/** What the diagrams cannot show, by module: the blind spots by reason with examples, the unresolved imports, the syntax errors, the files left out, and the share of calls into the repository that were followed. */
export function coverageReport(analysis: Analysis): CoverageReport {
  const { graph } = analysis;
  const byModule = new Map<string, ModuleCoverage>();

  const entry = (module: string): ModuleCoverage => {
    let found = byModule.get(module);

    if (!found) {
      found = { module, layer: graph.modules.get(module)?.layer ?? "", calls: 0, gaps: {}, examples: [], unresolvedImports: [], parseError: false };
      byModule.set(module, found);
    }

    return found;
  };

  for (const call of graph.calls) if (call.kind === "call") entry(moduleOf(call.from)).calls++;
  const byReason: CoverageReport["byReason"] = {};

  for (const gap of graph.gaps) {
    const row = entry(moduleOf(gap.from));

    if (gap.reason === "parse-error") {
      row.parseError = true;
      continue;
    }

    row.gaps[gap.reason] = (row.gaps[gap.reason] ?? 0) + 1;
    byReason[gap.reason] = (byReason[gap.reason] ?? 0) + 1;

    if (row.examples.length < 20 && isBlindSpot(gap)) row.examples.push({ callee: gap.callee, reason: gap.reason, line: gap.line });
  }

  for (const unresolved of graph.unresolvedImports) entry(unresolved.from).unresolvedImports.push({ specifier: unresolved.specifier, reason: unresolved.reason, line: unresolved.line });
  const gapCount = (row: ModuleCoverage): number => Object.entries(row.gaps).reduce((sum, [reason, n]) => sum + (BLIND_SPOT_REASONS.has(reason as Gap["reason"]) ? n : 0), 0) + row.unresolvedImports.length + (row.parseError ? 1 : 0);
  const modules = [...byModule.values()].filter((row) => gapCount(row) > 0).sort((a, b) => gapCount(b) - gapCount(a) || (a.module < b.module ? -1 : 1));
  const gaps = graph.gaps.filter((gap) => gap.reason !== "parse-error").length;
  const blind = graph.gaps.filter(isBlindSpot).length;
  const calls = graph.calls.filter((call) => call.kind === "call").length;
  const parseErrors = graph.gaps.filter((gap) => gap.reason === "parse-error").map((gap) => moduleOf(gap.from)).sort();
  const ratio = calls + blind === 0 ? 1 : calls / (calls + blind);
  // A call of a function of the caller's own body stays inside the caller: neither followed nor going out.
  const local = graph.gaps.filter((gap) => gap.reason === "local").length;
  const unsupported = [...analysis.facts.values()].flatMap((file) => file.unsupported.map((fact) => ({ module: file.path, line: fact.line, text: fact.text, reason: fact.reason }))).sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : a.line - b.line));
  const lines = [
    "<!-- archdiff:generated — coverage -->",
    "# Coverage: what the diagrams cannot show",
    "",
    `${analysis.files.length} files. Calls into the repository: ${calls} followed, ${blind} blind (${Math.round(ratio * 100)}% followed). ${gaps - blind - local} calls go out of it (packages, built-ins, globals, methods of untyped values)${local > 0 ? `, ${local} stay in their function (a nested function, a local arrow)` : ""}. ${graph.unresolvedImports.length} unresolved imports, ${parseErrors.length} files with syntax errors${unsupported.length > 0 ? `, ${counted(unsupported.length, "construct")} read but not followed` : ""}.`,
    "",
    "## Why calls were not followed",
    "",
  ];

  for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) lines.push(`- ${n} × ${reason}: ${GAP_REASONS[reason as Gap["reason"]].text}`);

  if (Object.keys(byReason).length === 0) lines.push("- none");
  lines.push("", "## Modules with gaps", "");

  // The calls out of the repository above are no gaps of a module: "none" here is of blind spots, unresolved imports, syntax errors.
  if (modules.length === 0) lines.push("None: no blind spot, no unresolved import, no syntax error.", "");

  for (const row of modules) {
    const parts = Object.entries(row.gaps).map(([reason, n]) => `${n} ${reason}`);

    if (row.unresolvedImports.length > 0) parts.push(`${row.unresolvedImports.length} unresolved imports`);

    if (row.parseError) parts.push("syntax error");
    lines.push(`### ${row.module}`, "", `${row.layer}: ${row.calls} calls followed; ${parts.join(", ")}`, "");

    for (const example of row.examples.slice(0, 8)) lines.push(`- \`${example.callee}\` — ${example.reason} (${row.module}:${example.line})`);

    for (const unresolved of row.unresolvedImports.slice(0, 8)) lines.push(`- import \`${unresolved.specifier}\` — ${unresolved.reason} (${row.module}:${unresolved.line})`);
    lines.push("");
  }

  // What a frontend read and could not follow, so a picture without it is not read as proof there is none.
  if (unsupported.length > 0) {
    lines.push("## Constructs read but not followed", "");

    for (const fact of unsupported.slice(0, MAX_UNSUPPORTED)) lines.push(`- \`${fact.text.replace(/\s+/g, " ").slice(0, 60)}\` — ${fact.reason} (${fact.module}:${fact.line})`);

    if (unsupported.length > MAX_UNSUPPORTED) lines.push(`- … ${unsupported.length - MAX_UNSUPPORTED} more`);
    lines.push("");
  }

  // After the modules' own sections, so none of them reads as a file not analysed.
  if (analysis.skipped.length > 0) {
    lines.push("## Files not analysed", "");

    for (const file of analysis.skipped) lines.push(`- ${file.path} — ${file.reason}`);
    lines.push("");
  }

  return { files: analysis.files.length, calls, gaps, blind, ratio, byReason, unresolvedImports: graph.unresolvedImports.length, parseErrors, skipped: analysis.skipped, unsupported, modules, markdown: `${lines.join("\n").trimEnd()}\n` };
}
