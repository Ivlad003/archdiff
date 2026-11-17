// The contract check as the editor's problems: what `archdiff check
// --json` prints, read into one finding per violation — the file and the
// line of the import, and the contract's reason as `archdiff check` words
// it. The report is archdiff's own (`IntentReport` of src/intent.ts): the
// violations each name the importing file (`from`), the line of the import,
// the file imported (`to`) and the two layers. A violation that carries a
// reason of its own (a rule of a newer archdiff) is shown with that reason;
// one without a line is shown on the first line of its file, and one that
// names no file cannot be placed: it is counted, not shown. An empty
// output is no report: the repository has no ARCHITECTURE.md, or the
// contract names no layer, and archdiff said so on stderr.
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
}

/** What a run of the check found: the findings, how many violations could not be placed, or why the output could not be read. */
export type Findings = { ok: true; findings: Finding[]; unplaced: number } | { ok: false; problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The contract's reason for a violation: its own when it carries one, else the layers the import crosses against the arrows. */
function messageOf(violation: Record<string, unknown>): string {
  const { to, fromLayer, toLayer, reason } = violation;
  const imports = typeof to === "string" ? `imports ${to}: ` : "";

  if (typeof reason === "string" && reason !== "") return `${imports}${reason}`;

  if (typeof fromLayer !== "string" || typeof toLayer !== "string") return `${imports}against ${CONTRACT}`;

  return `${imports}layer ${fromLayer} → ${toLayer} is not in ${CONTRACT}. Add the arrow there if it is wanted, else move the import.`;
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
    findings.push({ file: violation["from"], line: typeof line === "number" && Number.isInteger(line) && line >= 1 ? line : 1, message: messageOf(violation) });
  }

  return { ok: true, findings, unplaced };
}

/** The findings of each file, in the order found. */
export function byFile(findings: readonly Finding[]): Map<string, Finding[]> {
  const files = new Map<string, Finding[]>();

  for (const finding of findings) files.set(finding.file, [...(files.get(finding.file) ?? []), finding]);

  return files;
}
