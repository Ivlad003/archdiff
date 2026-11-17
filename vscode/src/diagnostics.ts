// The contract check as the editor's problems: what `archdiff check
// --json` prints, read into one finding per violation — the file and the
// line it is written at, and what is wrong as `archdiff check` words it.
// The report is archdiff's own (`checkJson` of src/violations.ts): every
// violation names the file it is in (`from`), its line, its rule, what is
// wrong in plain words (`problem`), and whether the repository's baseline
// lists it (`known`); an import between layers also names the file
// imported (`to`) and the two layers. A known violation fails no check and
// is a finding all the same, marked so: the editor shows it as a note, not
// as an error. An archdiff from before the rules prints the layers alone,
// which read as they did. A violation without a line is shown on the first
// line of its file, and one that names no file cannot be placed: it is
// counted, not shown. An empty output is no report: the repository has no
// rule and no ARCHITECTURE.md that names a layer, and archdiff said so on
// stderr.
//
// Pure. Entry points: `findingsOf`, `byFile`, `Finding`, `Findings`,
// `CONTRACT`.

/** The file the contract lives in, for the messages. */
export const CONTRACT = "ARCHITECTURE.md";

/** One problem to show: on a line of a file of the repository, with what the contract says of it. */
export interface Finding {
  /** The file, as archdiff names it: relative to the repository, with slashes. */
  file: string;
  /** The line of the import, from 1. */
  line: number;
  message: string;
  /** The repository's baseline lists it: it is in the code and fails no check. */
  known: boolean;
}

/** What a run of the check found: the findings, how many violations could not be placed, or why the output could not be read. */
export type Findings = { ok: true; findings: Finding[]; unplaced: number } | { ok: false; problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What is wrong with a violation: a reason of its own when it carries one; the layers an import crosses against the
 * arrows, with what to do about it; else what the check says of it in its own words (a rule of archdiff.json), with
 * the rule's name.
 */
function messageOf(violation: Record<string, unknown>): string {
  const { to, fromLayer, toLayer, reason, problem, rule } = violation;
  const imports = typeof to === "string" ? `imports ${to}: ` : "";

  if (typeof reason === "string" && reason !== "") return `${imports}${reason}`;

  if (typeof fromLayer === "string" && typeof toLayer === "string") return `${imports}layer ${fromLayer} → ${toLayer} is not in ${CONTRACT}. Add the arrow there if it is wanted, else move the import.`;

  if (typeof problem === "string" && problem !== "") return `${imports}${problem}${typeof rule === "string" && rule !== "" && rule !== "layers" ? ` (rule ${rule})` : ""}`;

  return `${imports}against ${CONTRACT}`;
}

/** The findings in the standard output of `archdiff check --json`. */
export function findingsOf(stdout: string): Findings {
  if (stdout.trim() === "") return { ok: true, findings: [], unplaced: 0 };
  let report: unknown;

  try {
    report = JSON.parse(stdout);
  } catch (error) {
    return { ok: false, problem: `archdiff check --json did not print JSON (${error instanceof Error ? error.message : String(error)})` };
  }

  if (!isRecord(report) || !Array.isArray(report["violations"])) return { ok: false, problem: "archdiff check --json printed no list of violations" };
  const findings: Finding[] = [];
  let unplaced = 0;

  for (const violation of report["violations"] as unknown[]) {
    if (!isRecord(violation) || typeof violation["from"] !== "string" || violation["from"] === "") {
      unplaced++;
      continue;
    }

    const line = violation["line"];
    // A violation of a whole file (no line) is shown on its first line.
    const known = violation["known"] === true;
    findings.push({ file: violation["from"], line: typeof line === "number" && Number.isInteger(line) && line >= 1 ? line : 1, message: `${messageOf(violation)}${known ? " Known: the baseline lists it, so it fails no check." : ""}`, known });
  }

  return { ok: true, findings, unplaced };
}

/** The findings of each file, in the order found. */
export function byFile(findings: readonly Finding[]): Map<string, Finding[]> {
  const files = new Map<string, Finding[]>();

  for (const finding of findings) files.set(finding.file, [...(files.get(finding.file) ?? []), finding]);

  return files;
}
