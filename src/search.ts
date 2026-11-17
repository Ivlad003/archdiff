// A search of the code and of a change, for the Chat tab's `/grep` and
// `/diff`, the CLI's `grep` and the agent's tools: every line of the
// analysed files that has a text, with its file and line; or every line a
// change added or removed that has it. The text is taken as it is typed —
// a capital in it makes the case count — or, written between slashes
// (`/save\w+/i`), as a regular expression.
//
// The code is the analysis's files, read from the disk or from a head's
// revision; the change is git's diff of two revisions, without context.
// Sits at the edge, beside review.ts. Entry points: `searchCode`,
// `searchChange`, `foundMarkdown`, `matcherOf`, `Found`, `Match`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Analysis } from "./analyze.ts";
import { changedLines, fileAt } from "./git.ts";
import { ok, wrong, type Result } from "./result.ts";
import { counted } from "./words.ts";

/** One line found: where it is and what it says; in a change, whether the change added it (its line is the head's) or removed it (the base's). */
export interface Match {
  file: string;
  line: number;
  text: string;
  sign?: "+" | "-";
}

export interface Found {
  matches: Match[];
  /** Lines found past the ones listed. */
  more: number;
  /** How many files hold the lines found, the unlisted ones counted. */
  files: number;
}

/** Lines listed, at most; the rest are counted. */
const LISTED = 200;

/** A line's text as it is listed: without the space around it, cut at a width a list reads at. */
function shown(text: string): string {
  const line = text.trim();

  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** What tells whether a line has the pattern: `/re/flags` a regular expression, anything else the text itself, the case counting when it holds a capital. */
export function matcherOf(pattern: string): Result<(line: string) => boolean> {
  if (pattern.trim() === "") return wrong("a search needs a text, or a regular expression between slashes");
  const written = pattern.match(/^\/(.+)\/([a-z]*)$/s);

  if (written) {
    try {
      const expression = new RegExp(written[1]!, written[2]!.replace(/[gy]/g, ""));

      return ok((line) => expression.test(line));
    } catch (error) {
      return wrong(`not a regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (/\p{Lu}/u.test(pattern)) return ok((line) => line.includes(pattern));
  const lowered = pattern.toLowerCase();

  return ok((line) => line.toLowerCase().includes(lowered));
}

/** The lines kept of all the lines found: the first `LISTED`, the rest counted, and the files they are in. */
function found(all: readonly Match[]): Found {
  return { matches: all.slice(0, LISTED), more: Math.max(0, all.length - LISTED), files: new Set(all.map((match) => match.file)).size };
}

/** Every line of the analysed files that has the pattern; `ref` null reads the working tree, a ref that revision's files. */
export function searchCode(analysis: Analysis, pattern: string, ref: string | null = null): Result<Found> {
  const has = matcherOf(pattern);

  if (!has.ok) return has;
  const all: Match[] = [];

  for (const file of analysis.files) {
    let text: string | null;

    try {
      text = ref === null ? readFileSync(join(analysis.root, file), "utf8") : fileAt(analysis.root, ref, file);
    } catch {
      // A file gone since the analysis: nothing of it to find.
      continue;
    }

    (text ?? "").split(/\r?\n/).forEach((line, index) => {
      if (has.value(line)) all.push({ file, line: index + 1, text: shown(line) });
    });
  }

  return ok(found(all));
}

/** Every line the change from `base` to `head` (null: the working tree) added or removed that has the pattern. Throws git's words when it refuses. */
export function searchChange(root: string, base: string, head: string | null, pattern: string): Result<Found> {
  const has = matcherOf(pattern);

  if (!has.ok) return has;

  return ok(found(changedLines(root, base, head).filter((line) => has.value(line.text)).map((line) => ({ file: line.file, line: line.line, text: shown(line.text), sign: line.sign }))));
}

/** What was found as a page: a line that counts, then a line each — its `file:line`, which a reader opens, and its text; `where` names what was searched. */
export function foundMarkdown(result: Found, pattern: string, where: string): string {
  const total = result.matches.length + result.more;
  const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

  if (total === 0) return `No line of ${where} has ${code(pattern)}.`;
  const lines = [`**${counted(total, "line")}** of ${where}, in ${counted(result.files, "file")}, ${total === 1 ? "has" : "have"} ${code(pattern)}:`, ""];

  for (const match of result.matches) lines.push(`- \`${match.file}:${match.line}\` ${match.sign ? `**${match.sign === "+" ? "+" : "−"}** ` : "— "}${code(match.text)}`);

  if (result.more > 0) lines.push(`- … ${counted(result.more, "more line", "more lines")}`);

  return lines.join("\n");
}
