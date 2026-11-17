// The baseline of a repository: the violations it is known to have, kept
// in a file that is committed, so an old repository adopts a contract
// without a red CI. `archdiff check --baseline` writes what the check
// finds now; from then on `check` fails on a violation that is not in the
// file, lists the known ones apart, and names the entries that no longer
// occur, so the file shrinks as the code is fixed.
//
// The file is `archdiff-baseline.json` at the root, beside archdiff.json
// and ARCHITECTURE.md (the contract it excuses, read in the same review),
// and not under `.archdiff/`, which holds the cache and is ignored by git;
// archdiff.json's `baseline` names another path. A violation is known by
// what it is — the rule, the module it is in, the module or package it
// imports — never by its line, which moves with every edit above it.
//
// Pure except `readBaseline`. Entry points: `Violation`, `KnownViolation`,
// `Baseline`, `violationKey`, `baselineText`, `parseBaseline`,
// `readBaseline`, `againstBaseline`, `BASELINE_FILE`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, isJsonString, parseJson, type JsonValue } from "./json.ts";

export const BASELINE_FILE = "archdiff-baseline.json";

/** One thing the check found: an import against the contract's layers (the rule `layers`), or what the code does against a rule of archdiff.json (the rule's name). */
export interface Violation {
  rule: string;
  /** The module the violation is in: the importer, the misnamed file, the module over a threshold. */
  from: string;
  /** The module or package imported, when the violation is an import. */
  to?: string;
  line: number;
  /** The layers of an import between layers. */
  fromLayer?: string;
  toLayer?: string;
  /** What is wrong, in Markdown, said after the place: "layer **routes** → **db** is not in the intent". */
  problem: string;
  /** What to do about it: a sentence for the report. */
  advice?: string;
}

/** A violation as the baseline keeps it: what it is, without its line or its words. */
export interface KnownViolation {
  rule: string;
  from: string;
  to?: string;
}

export interface Baseline {
  /** The file's path from the root, as the reports name it. */
  file: string;
  violations: KnownViolation[];
}

/** What a violation is: its rule, the module it is in and what that imports. Two of one key are one violation (an import written twice). */
export function violationKey(violation: KnownViolation): string {
  return `${violation.rule}\u0000${violation.from}\u0000${violation.to ?? ""}`;
}

/** The violations as the file lists them: one per key, by rule, then by module. */
function listed(violations: readonly KnownViolation[]): KnownViolation[] {
  const byKey = new Map<string, KnownViolation>();

  for (const violation of violations) if (!byKey.has(violationKey(violation))) byKey.set(violationKey(violation), violation.to === undefined ? { rule: violation.rule, from: violation.from } : { rule: violation.rule, from: violation.from, to: violation.to });

  return [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, violation]) => violation);
}

/**
 * The file of a baseline: the violations as `{ rule, from, to }`, sorted, one per line, so a fixed one is one line
 * less in a diff. It opens with archdiff's name, by which `--baseline` knows a file it may write over.
 */
export function baselineText(violations: readonly KnownViolation[]): string {
  const rows = listed(violations);
  const head = `{\n  "generator": "archdiff",\n  "note": "The known violations of the contract: archdiff check fails on any violation not listed here. Remove an entry when it is fixed; archdiff check --baseline writes the file anew.",\n  "violations": [`;

  return `${head}${rows.length === 0 ? "" : `\n${rows.map((row) => `    ${JSON.stringify(row)}`).join(",\n")}\n  `}]\n}\n`;
}

/** A baseline read from its text; throws naming `file` and the entry that is wrong. */
export function parseBaseline(text: string, file: string): Baseline {
  let parsed: JsonValue;

  try {
    parsed = parseJson(text);
  } catch (error) {
    throw new Error(`${file}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }

  if (!isJsonObject(parsed) || !Array.isArray(parsed["violations"])) throw new Error(`${file}: must be a JSON object with a list "violations" (archdiff check --baseline writes it)`);
  const violations = parsed["violations"].map((item, i): KnownViolation => {
    if (!isJsonObject(item) || !isJsonString(item["rule"]) || !isJsonString(item["from"]) || (item["to"] !== undefined && !isJsonString(item["to"]))) throw new Error(`${file}: "violations[${i}]" must be { "rule": "…", "from": "…" }, with "to" for an import`);

    return item["to"] === undefined ? { rule: item["rule"], from: item["from"] } : { rule: item["rule"], from: item["from"], to: item["to"] };
  });

  return { file, violations: listed(violations) };
}

/** The baseline of a repository at `file` (a path from the root), or null without the file. */
export function readBaseline(root: string, file: string): Baseline | null {
  const path = join(root, file);

  return existsSync(path) ? parseBaseline(readFileSync(path, "utf8"), file) : null;
}

/**
 * The violations held against the baseline: the new ones (which fail the check), the known ones, and the entries
 * of the baseline that no longer occur. Without a baseline every violation is new.
 */
export function againstBaseline(violations: readonly Violation[], baseline: Baseline | null): { fresh: Violation[]; known: Violation[]; stale: KnownViolation[] } {
  const kept = new Set((baseline?.violations ?? []).map(violationKey));
  const found = new Set(violations.map(violationKey));

  return { fresh: violations.filter((violation) => !kept.has(violationKey(violation))), known: violations.filter((violation) => kept.has(violationKey(violation))), stale: (baseline?.violations ?? []).filter((violation) => !found.has(violationKey(violation))) };
}
