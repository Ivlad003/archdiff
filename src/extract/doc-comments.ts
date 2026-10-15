// Documentation comments without their syntax. Frontends decide which comment
// documents what; this module only turns comment source into text, lines kept,
// so the brief rule (`src/brief.ts`) can find the first paragraph.

/**
 * A license or copyright notice: a comment that starts with one (`SPDX-…`,
 * `Copyright …`, `(c) 2024`, `© …`) or carries an SPDX identifier. A
 * comment that only mentions copyright is documentation.
 */
export function isLicense(text: string): boolean {
  // Strip leading comment markers and whitespace so the notice word is first.
  const body = text.replace(/^[\s/*!#]+/, "");

  return /^(?:SPDX-|copyright\b|\(c\)\s*\d|©)/i.test(body) || text.includes("SPDX-License-Identifier");
}

/** `/** … *\/`, `/*! … *\/` or `/* … *\/` without delimiters and the ` * ` that starts each line. */
export function blockCommentBody(text: string): string {
  // Drop the opening and closing delimiters, then from each line the leading
  // `*` gutter and one space (a `*/` at line start is not a gutter).
  return text
    .replace(/^\/\*[*!]?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*(?!\/) ?/, "").trimEnd())
    .join("\n");
}

/** Consecutive line comments (`//`, `///`, `//!`, `#`) as lines of text, one comment marker and one space removed from each. */
export function lineCommentsBody(lines: readonly string[], marker: RegExp): string {
  return lines.map((line) => line.trim().replace(marker, "").replace(/^ /, "").trimEnd()).join("\n");
}

/**
 * JSDoc text: the description before the first block tag (`@param`, `@returns`, …),
 * with inline `{@link x}` as `x` and `{@link x label}` / `{@link x|label}` as `label`.
 */
export function jsdocDescription(body: string): string {
  const lines: string[] = [];

  // The description ends at the first line that starts with a block tag.
  for (const line of body.split("\n")) {
    if (/^\s*@\w/.test(line)) break;
    lines.push(line);
  }

  // Inline links: `{@link target}`, `{@linkcode target label}` or
  // `{@linkplain target|label}`; keep the label when there is one.
  return lines.join("\n").replace(/\{@link(?:code|plain)?\s+([^\s|}]+)(?:\s*\|\s*|\s+)?([^}]*)\}/g, (_, target: string, label: string) => (label.trim() !== "" ? label.trim() : target));
}

/** Text of the whole comment, or null when it has none: an empty comment, only tags, a directive. */
export function nonEmpty(text: string): string | null {
  return text.trim() === "" ? null : text;
}
