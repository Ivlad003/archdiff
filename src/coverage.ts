// The map of what the diagrams cannot show: per module, the imports that
// resolve to nothing, the calls archdiff could not follow and why, and the
// files whose syntax it could not parse. A pure function of the analysis
// that gives the same report for the same graph, as JSON and as Markdown.
//
// Sits after the graph, beside the views: Analysis → CoverageReport.
// Entry points: `coverageReport`, `CoverageReport`.

import type { Analysis } from "./analyze.ts";
import { moduleOf, type Gap } from "./graph.ts";

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
  /** Calls into the repository hidden by a blind spot (`dynamic`, `unknown-member`). */
  blind: number;
  /** Followed calls over followed plus blind, 0–1. */
  ratio: number;
  byReason: Partial<Record<Gap["reason"], number>>;
  unresolvedImports: number;
  parseErrors: string[];
  /** Modules with at least one blind call, unresolved import or syntax error, the most first. */
  modules: ModuleCoverage[];
  markdown: string;
}

const REASON_TEXT: Record<Gap["reason"], string> = {
  dynamic: "a callee archdiff cannot name (a computed or passed value): a blind spot",
  "unknown-member": "a known class or module without that member: a blind spot",
  "member-of-value": "a method of a local value whose type is not tracked (list.map, req.on): mostly built-ins",
  global: "a bare name the file neither declares nor imports (setTimeout, JSON.parse): a global",
  external: "a package or a Node built-in",
  "parse-error": "a syntax error in the file",
};

/** The reasons that hide a call into the repository's own code; the rest are calls out of it. */
const BLIND: ReadonlySet<Gap["reason"]> = new Set(["dynamic", "unknown-member"]);

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

    if (row.examples.length < 20 && BLIND.has(gap.reason)) row.examples.push({ callee: gap.callee, reason: gap.reason, line: gap.line });
  }

  for (const unresolved of graph.unresolvedImports) entry(unresolved.from).unresolvedImports.push({ specifier: unresolved.specifier, reason: unresolved.reason, line: unresolved.line });
  const gapCount = (row: ModuleCoverage): number => Object.entries(row.gaps).reduce((sum, [reason, n]) => sum + (BLIND.has(reason as Gap["reason"]) ? n : 0), 0) + row.unresolvedImports.length + (row.parseError ? 1 : 0);
  const modules = [...byModule.values()].filter((row) => gapCount(row) > 0).sort((a, b) => gapCount(b) - gapCount(a) || (a.module < b.module ? -1 : 1));
  const gaps = graph.gaps.filter((gap) => gap.reason !== "parse-error").length;
  const blind = graph.gaps.filter((gap) => BLIND.has(gap.reason)).length;
  const calls = graph.calls.filter((call) => call.kind === "call").length;
  const parseErrors = graph.gaps.filter((gap) => gap.reason === "parse-error").map((gap) => moduleOf(gap.from)).sort();
  const ratio = calls + blind === 0 ? 1 : calls / (calls + blind);
  const lines = [
    "# Coverage: what the diagrams cannot show",
    "",
    `${analysis.files.length} files. Calls into the repository: ${calls} followed, ${blind} blind (${Math.round(ratio * 100)}% followed). ${gaps - blind} calls go out of it (packages, built-ins, globals, methods of untyped values). ${graph.unresolvedImports.length} unresolved imports, ${parseErrors.length} files with syntax errors.`,
    "",
    "## Why calls were not followed",
    "",
  ];

  for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) lines.push(`- ${n} × ${reason}: ${REASON_TEXT[reason as Gap["reason"]]}`);

  if (Object.keys(byReason).length === 0) lines.push("- none");
  lines.push("", "## Modules with gaps", "");

  if (modules.length === 0) lines.push("None: every import and call was followed.");

  for (const row of modules) {
    const parts = Object.entries(row.gaps).map(([reason, n]) => `${n} ${reason}`);

    if (row.unresolvedImports.length > 0) parts.push(`${row.unresolvedImports.length} unresolved imports`);

    if (row.parseError) parts.push("syntax error");
    lines.push(`### ${row.module}`, "", `${row.layer}: ${row.calls} calls followed; ${parts.join(", ")}`, "");

    for (const example of row.examples.slice(0, 8)) lines.push(`- \`${example.callee}\` — ${example.reason} (${row.module}:${example.line})`);

    for (const unresolved of row.unresolvedImports.slice(0, 8)) lines.push(`- import \`${unresolved.specifier}\` — ${unresolved.reason} (${row.module}:${unresolved.line})`);
    lines.push("");
  }

  return { files: analysis.files.length, calls, gaps, blind, ratio, byReason, unresolvedImports: graph.unresolvedImports.length, parseErrors, modules, markdown: `${lines.join("\n").trimEnd()}\n` };
}
