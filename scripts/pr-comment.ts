// The body of the comment the GitHub Action (action.yml) keeps on a pull
// request, from two outputs: the Markdown of `archdiff review` and the JSON
// of `archdiff check`. The review's title and counts, the verdict of the
// check with its violations, the dependencies between layers the change
// added or removed, the Mermaid picture, and every change by kind, folded.
// A pull request that changed no module, function, import or call says so
// in one line instead of an empty picture. GitHub takes no comment over
// 65 536 characters: past it the picture stays and the lists are cut, each
// to the same number of its first items, with a count of what was left
// out; then the violations; a picture that does not fit by itself gives
// way to a line. Text in, text out: no git, no GitHub, no dependency, so
// the action runs it from its own checkout and the tests call it.
//
// Entry points: `commentBody`, `COMMENT_MARKER`, `COMMENT_LIMIT`, and the
// script itself, which action.yml runs:
// `node scripts/pr-comment.ts <review.md> <check.json> [--limit N]`.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The first line of the body, hidden when rendered: the action finds its own comment by it, to rewrite it on the next push. */
export const COMMENT_MARKER = "<!-- archdiff:pull-request-comment -->";

/** The longest body GitHub takes for a comment, in characters. */
export const COMMENT_LIMIT = 65_536;

/** One section of the review: its heading and the items of its list, without their dashes. */
interface Section {
  title: string;
  items: string[];
}

/** The review's Markdown, taken apart. */
interface Review {
  title: string;
  /** The paragraphs before the first section: the counts. */
  intro: string[];
  /** The fenced Mermaid block, fences included; null when the review drew none. */
  picture: string | null;
  /** What the review wrote where the picture would be: why there is none. */
  reason: string | null;
  /** The sections above the picture: the dependencies between layers that appeared and went. */
  pinned: Section[];
  /** The sections below it: the modules, functions, imports, calls and packages, by kind. */
  lists: Section[];
}

/**
 * The verdict of the check: no contract to check against, the code follows it, violations go against it, or an
 * output that is no report. `known` counts the violations the repository's baseline lists, which fail nothing;
 * `ruled` says a rule of archdiff.json is among the violations, not the layers alone.
 */
type Verdict = { kind: "none" | "unread" } | { kind: "ok"; known: number } | { kind: "against"; violations: string[]; known: number; ruled: boolean };

/** How much of a body is drawn: the items of each list, the violations, and whether the picture is. */
interface Cut {
  lists: number;
  violations: number;
  picture: boolean;
}

/**
 * The review's Markdown as its parts, by its structure and not by its words: the first heading is the title, the
 * first fenced block the picture (an italic line in its place the reason there is none), the sections before it
 * are pinned and the ones after it are the lists.
 */
function readReview(markdown: string): Review {
  const review: Review = { title: "", intro: [], picture: null, reason: null, pinned: [], lists: [] };
  let section: Section | null = null;
  let fence: string[] | null = null;

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (fence) {
      fence.push(line);

      if (line.trim() === "```") {
        review.picture ??= fence.join("\n");
        fence = null;
        section = null;
      }

      continue;
    }

    const heading = /^##+ (.+)$/.exec(line);

    if (line.startsWith("```")) fence = [line];
    else if (heading) {
      section = { title: heading[1]!.trim(), items: [] };
      (review.picture === null && review.reason === null ? review.pinned : review.lists).push(section);
    } else if (line.startsWith("# ") && review.title === "") review.title = line.slice(2).trim();
    else if (/^_.+_$/.test(line.trim()) && review.picture === null && review.reason === null) {
      review.reason = line.trim();
      section = null;
    } else if (line.trim() !== "" && !line.startsWith("<!--")) {
      if (section) section.items.push(line.replace(/^- /, ""));
      else review.intro.push(line);
    }
  }

  return review;
}

/** The verdict from the JSON of `archdiff check --json`; nothing at all is what `check` prints without a contract to check against. */
function readCheck(json: string): Verdict {
  if (json.trim() === "") return { kind: "none" };
  let report: unknown;

  try {
    report = JSON.parse(json);
  } catch {
    return { kind: "unread" };
  }

  if (report === null || typeof report !== "object" || !("ok" in report) || typeof report.ok !== "boolean") return { kind: "unread" };

  const violations: unknown[] = "violations" in report && Array.isArray(report.violations) ? report.violations : [];
  // A check with a baseline lists every violation and marks the ones the baseline knows: those fail nothing. A CLI from before the baseline marks none.
  const fresh = violations.filter((violation) => field(violation, "known") !== true);
  const known = violations.length - fresh.length;

  if (report.ok) return { kind: "ok", known };

  return { kind: "against", violations: fresh.map(violationLine), known, ruled: fresh.some((violation) => typeof field(violation, "rule") === "string" && field(violation, "rule") !== "layers") };
}

/** A field of a value read from JSON; undefined when the value is no object. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * One violation as a line: an import between layers with where it is written and the pair of layers the contract
 * lacks; what breaks a rule of archdiff.json in the check's own words, with the rule's name.
 */
function violationLine(violation: unknown): string {
  const text = (key: string): string | null => {
    const value = field(violation, key);

    return typeof value === "string" || typeof value === "number" ? String(value) : null;
  };
  const [from, to, fromLayer, toLayer, line, problem, rule] = [text("from"), text("to"), text("fromLayer"), text("toLayer"), text("line"), text("problem"), text("rule")];
  const place = from === null ? null : `\`${from}${line === null ? "" : `:${line}`}\`${to === null ? "" : ` imports \`${to}\``}`;

  if (place !== null && to !== null && fromLayer !== null && toLayer !== null) return `${place}: layer **${fromLayer}** → **${toLayer}** is not in ARCHITECTURE.md`;

  if (place !== null && problem !== null) return `${place}: ${problem}${rule === null || rule === "layers" ? "" : ` (rule \`${rule}\`)`}`;

  return `\`${JSON.stringify(violation)}\``;
}

/** The violations the baseline lists, in a line of their own: they are in the code and fail nothing. */
function knownLines(known: number): string[] {
  return known === 0 ? [] : ["", `_${spaced(known)} known ${known === 1 ? "violation" : "violations"} in the baseline ${known === 1 ? "does" : "do"} not fail the check._`];
}

/** A count as a reader reads it: 65 536. */
function spaced(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+$)/g, " ");
}

/** The first `keep` items of a list as Markdown, and a last item counting the rest when some are left out. */
function listed(items: readonly string[], keep: number): string[] {
  const shown = items.slice(0, keep).map((item) => `- ${item}`);

  return items.length > keep ? [...shown, `- … ${spaced(items.length - keep)} more not shown`] : shown;
}

/** The verdict of the check as Markdown: one line, and under it the violations when there are some. */
function verdictLines(verdict: Verdict, keep: number): string[] {
  switch (verdict.kind) {
    case "none":
      return ["_No ARCHITECTURE.md that names layers: nothing to check the code against (`archdiff intent --init` writes one from the code)._"];
    case "unread":
      return ["_The output of `archdiff check` could not be read: no verdict._"];
    case "ok":
      return ["**✔ No import between layers goes against ARCHITECTURE.md.**", ...knownLines(verdict.known)];
    case "against": {
      const count = verdict.violations.length;
      const headline = verdict.ruled ? `${spaced(count)} ${count === 1 ? "violation" : "violations"} of ARCHITECTURE.md and the rules of archdiff.json` : `${spaced(count)} ${count === 1 ? "import goes" : "imports go"} against ARCHITECTURE.md`;

      return [`**✘ ${headline}.**`, "", ...listed(verdict.violations, keep), ...knownLines(verdict.known)];
    }
  }
}

/** The body with as much of it as `cut` allows; `limit` only words the lines that say what was left out. */
function draw(review: Review, verdict: Verdict, cut: Cut, limit: number): string {
  const lines = [COMMENT_MARKER];
  /** Why something is left out, and where `what` ("it", "them all") can be read: at a comment's limit, in the job summary the action writes with more room. */
  const room = (what: string): string => (limit === COMMENT_LIMIT ? `a comment on GitHub holds ${spaced(COMMENT_LIMIT)} characters at most; the job summary has ${what}` : `the limit is ${spaced(limit)} characters`);

  // No picture, no section: one line says so, with the source files that changed in what a diff of the architecture does not show.
  if (review.picture === null && review.pinned.length === 0 && review.lists.length === 0) {
    const since = / since (.+)$/.exec(review.title)?.[1];
    const files = /^(\d+) source files? changed/.exec(review.intro[0] ?? "");
    const changed = files && files[1] !== "0" ? `; ${files[0]} in what the diff does not show (comments, code outside the declarations)` : "";
    lines.push(`**No architectural change${since ? ` since ${since}` : ""}**: no module, function, import or call was added, removed or changed${changed}.`, "", ...verdictLines(verdict, cut.violations));

    return `${lines.join("\n").trimEnd()}\n`;
  }

  lines.push(`## ${review.title || "Architecture changes"}`, "", ...verdictLines(verdict, cut.violations), "", ...review.intro, "");

  for (const section of review.pinned) lines.push(`### ${section.title}`, "", ...section.items.map((item) => `- ${item}`), "");

  if (review.picture !== null && cut.picture) lines.push(review.picture, "");
  else if (review.picture !== null) lines.push(`_The picture is left out (${spaced(review.picture.length)} characters of Mermaid): ${room("it")}._`, "");
  else if (review.reason !== null) lines.push(review.reason, "");

  const total = review.lists.reduce((sum, section) => sum + section.items.length, 0);
  const shown = review.lists.reduce((sum, section) => sum + Math.min(section.items.length, cut.lists), 0);

  if (shown > 0) {
    lines.push("<details>", `<summary>Every change, by kind (${spaced(total)})</summary>`, "");

    for (const section of review.lists) lines.push(`### ${section.title} (${spaced(section.items.length)})`, "", ...listed(section.items, cut.lists), "");
    lines.push("</details>", "");
  }

  // What was left out, counted: of all the changes when some are listed, kind by kind when none is.
  if (shown === 0 && total > 0) lines.push(`_The ${spaced(total)} changes are not listed (${review.lists.map((section) => `${section.title.charAt(0).toLowerCase()}${section.title.slice(1)} ${spaced(section.items.length)}`).join(", ")}): ${room("them all")}._`, "");
  else if (shown < total) lines.push(`_${spaced(total - shown)} of the ${spaced(total)} changes are not shown: ${room("them all")}._`, "");

  return `${lines.join("\n").trimEnd()}\n`;
}

/** The largest count up to `most` that `fits`, by halving; `fits(0)` holds. A body grows with its items, bar a line or two where a list is first cut, so what comes back fits and is within a step of the most that would. */
function largest(most: number, fits: (count: number) => boolean): number {
  let low = 0;
  let high = most;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (fits(middle)) low = middle;
    else high = middle - 1;
  }

  return low;
}

/**
 * The body of the comment from the Markdown of `archdiff review` and the JSON of `archdiff check --json` (empty
 * when there is no contract), at most `limit` characters long. What does not fit goes in this order: the lists of
 * the changes, each cut to the same number of its first items; then the violations; then, when the picture alone
 * is longer than the limit, the picture. What was left out is counted where it would stand.
 */
export function commentBody(reviewMarkdown: string, checkJson: string, limit: number = COMMENT_LIMIT): string {
  const review = readReview(reviewMarkdown);
  const verdict = readCheck(checkJson);
  const longest = Math.max(0, ...review.lists.map((section) => section.items.length));
  const violations = verdict.kind === "against" ? verdict.violations.length : 0;
  const body = (cut: Cut): string => draw(review, verdict, cut, limit);
  const fits = (cut: Cut): boolean => body(cut).length <= limit;

  for (const picture of [true, false]) {
    const whole: Cut = { lists: longest, violations, picture };

    if (fits(whole)) return body(whole);
    const noLists: Cut = { ...whole, lists: 0 };

    if (fits(noLists)) return body({ ...whole, lists: largest(longest, (lists) => fits({ ...whole, lists })) });

    if (fits({ ...noLists, violations: 0 })) return body({ ...noLists, violations: largest(violations, (count) => fits({ ...noLists, violations: count })) });
  }

  // A title and counts longer than the limit by themselves: no review writes them, but a body over the limit is never returned.
  return body({ lists: 0, violations: 0, picture: false }).slice(0, limit);
}

/** The script: the two files named, the body on stdout; a wrong call or a file that cannot be read is exit 2. */
function main(argv: readonly string[]): number {
  const files: string[] = [];
  let limit = COMMENT_LIMIT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--limit" || arg.startsWith("--limit=")) limit = Number(arg === "--limit" ? argv[++i] : arg.slice("--limit=".length));
    else files.push(arg);
  }

  if (files.length !== 2 || !Number.isInteger(limit) || limit < 1) {
    process.stderr.write("usage: node scripts/pr-comment.ts <review.md> <check.json> [--limit N]\n");

    return 2;
  }

  try {
    // A byte order mark, when a shell wrote the file with one, is no part of the text.
    const [review, check] = files.map((file) => readFileSync(file, "utf8").replace(/^﻿/, "")) as [string, string];
    process.stdout.write(commentBody(review, check, limit));

    return 0;
  } catch (error) {
    process.stderr.write(`pr-comment: ${error instanceof Error ? error.message : String(error)}\n`);

    return 2;
  }
}

/** Whether node was started on this file (the action's call) and not on one that imports it (a test). */
function isEntry(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) process.exitCode = main(process.argv.slice(2));
