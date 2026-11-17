// Guided tours: a tour is a list of steps through the pictures of a
// repository — each the link of a view with its options (what the page's
// address says after the `#`), the shapes selected there and a note in
// Markdown — kept as one JSON file per tour beside the drawings
// (`.archdiff/tours/<name>.json`), or under the directory archdiff.json
// names as `"tours"`: one the repository commits, since `.archdiff/` is
// usually ignored. The page records a tour step by step and plays it
// (`tour=<name>&step=N` in its link); `archdiff tour <name>` writes it as
// Markdown, every step with its note and its picture as Mermaid.
//
// A step's link is read as the page reads it, but for the options it
// leaves out: those are the built-in ones here and on the page alike (a
// link with `tour=` takes no remembered default), so a tour plays the
// same in every browser and in the terminal.
//
// Sits at the edge: root + name ↔ Tour, and a tour drawn through
// picture.ts. Entry points: `Tour`, `TourStep`, `toursDirectory`,
// `isTourName`, `parseTour`, `listTours`, `loadTour`, `readTour`, `writeTour`,
// `removeTour`, `stepRequest`, `tourMarkdown`, `TOURS_DIRECTORY`.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze, type Analysis } from "./analyze.ts";
import { CACHE_DIRECTORY } from "./cache.ts";
import type { Config } from "./config.ts";
import { toMermaid } from "./export/mermaid.ts";
import { isJsonObject, isJsonString, parseJson, type JsonValue } from "./json.ts";
import { readEachPictureOption } from "./options.ts";
import { drawPicture, type PictureRequest } from "./picture.ts";
import { ok, wrong, type Result } from "./result.ts";
import { analysisAt } from "./review.ts";
import { drawnAtHead, parseView } from "./view-keys.ts";

export const TOUR_FORMAT = 1;

/** Where the tours are kept unless archdiff.json names another directory. */
export const TOURS_DIRECTORY = `${CACHE_DIRECTORY}/tours`;

/** How many steps a tour holds, how long a step's link and its note may be: a file the page writes is a file a reader can open. */
const LIMITS = { steps: 200, link: 4000, note: 20_000, select: 200 } as const;

/** One step of a tour. */
export interface TourStep {
  /** The link of the step's picture: the page's address after the `#`, without the tour's own `tour=` and `step=`. */
  link: string;
  /** The shapes selected at the step, by the IDs the picture gives them. */
  select: string[];
  /** The shapes are a way to follow in their order: the lines from each to the next are lit. */
  path?: true;
  /** What the step says, in Markdown. */
  note: string;
}

export interface Tour {
  format: typeof TOUR_FORMAT;
  name: string;
  /** What the tour is called on the page and at the head of its Markdown; its name when the author gave none. */
  title: string;
  steps: TourStep[];
  /** ISO time of the save, for the reader; not compared. */
  saved: string;
}

/** The directory of the tours, from the root: archdiff.json's `"tours"`, else beside the drawings. */
export function toursDirectory(config: Config): string {
  return config.tours ?? TOURS_DIRECTORY;
}

/** A tour's name is its file's: letters, digits, dots, dashes and underscores, starting with a letter or a digit. */
export function isTourName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name);
}

/** A step's link without the tour's own parameters and the leading `#`: what the step is of, whatever tour holds it. */
function ownLink(link: string): string {
  const params = new URLSearchParams(link.replace(/^#/, ""));
  params.delete("tour");
  params.delete("step");

  return params.toString();
}

/** Validates a tour as the page sends it or a file holds it (`title` and `steps`); throws naming the field. */
export function parseTour(value: JsonValue, name: string): Tour {
  if (!isTourName(name)) throw new Error(`tour: "${name}" is no name of a tour (letters, digits, . - _; a letter or a digit first)`);

  if (!isJsonObject(value)) throw new Error("tour: must be an object with its steps");
  const title = value["title"];

  if (title !== undefined && !isJsonString(title)) throw new Error('tour: "title" must be a string');
  const steps = value["steps"];

  if (!Array.isArray(steps) || steps.length > LIMITS.steps) throw new Error(`tour: "steps" must be a list of at most ${LIMITS.steps} steps`);

  return {
    format: TOUR_FORMAT,
    name,
    title: (title ?? "").trim().slice(0, 200) || name,
    steps: steps.map((step, i): TourStep => {
      if (!isJsonObject(step) || !isJsonString(step["link"]) || step["link"].length > LIMITS.link) throw new Error(`tour: step ${i + 1} needs a "link" (a view's link with its options)`);
      const link = ownLink(step["link"]);

      if (parseView(new URLSearchParams(link).get("view") ?? "") === null) throw new Error(`tour: the link of step ${i + 1} names no view (view=<key>)`);
      const select = step["select"] ?? [];
      const note = step["note"] ?? "";

      if (!Array.isArray(select) || !select.every(isJsonString) || select.length > LIMITS.select) throw new Error(`tour: "select" of step ${i + 1} must be a list of shape IDs`);

      if (!isJsonString(note) || note.length > LIMITS.note) throw new Error(`tour: "note" of step ${i + 1} must be text of at most ${LIMITS.note} characters`);

      if (step["path"] !== undefined && typeof step["path"] !== "boolean") throw new Error(`tour: "path" of step ${i + 1} must be true or false`);

      return step["path"] === true ? { link, select: [...select], path: true, note } : { link, select: [...select], note };
    }),
    saved: new Date().toISOString(),
  };
}

function tourFile(directory: string, name: string): string {
  return `${directory}/${name}.json`;
}

/**
 * The tour of a name, or why there is none: no file of that name (404), or a file that does not read as a tour — one
 * written by hand with a step that names no view, another format — with what is wrong in it.
 */
export function loadTour(root: string, directory: string, name: string): Result<Tour> {
  const relative = tourFile(directory, name);
  const file = join(root, relative);

  if (!isTourName(name) || !existsSync(file)) return wrong(`no tour "${name}"`, 404);

  try {
    const parsed = parseJson(readFileSync(file, "utf8"));

    if (!isJsonObject(parsed) || parsed["format"] !== TOUR_FORMAT) throw new Error(`"format" must be ${TOUR_FORMAT}`);
    const tour = parseTour(parsed, name);

    return ok({ ...tour, saved: isJsonString(parsed["saved"]) ? parsed["saved"] : tour.saved });
  } catch (error) {
    return wrong(`${relative} does not read as a tour: ${error instanceof Error ? error.message.replace(/^tour: /, "") : String(error)}`);
  }
}

/** The tour of a name, or null: no such file, or one that does not read as a tour (`loadTour` says why). */
export function readTour(root: string, directory: string, name: string): Tour | null {
  const tour = loadTour(root, directory, name);

  return tour.ok ? tour.value : null;
}

/** The tours of the directory by name: each with its title and how many steps it has. */
export function listTours(root: string, directory: string): { name: string; title: string; steps: number }[] {
  const full = join(root, directory);

  if (!existsSync(full)) return [];

  return readdirSync(full)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readTour(root, directory, file.slice(0, -".json".length)))
    .filter((tour): tour is Tour => tour !== null)
    .map((tour) => ({ name: tour.name, title: tour.title, steps: tour.steps.length }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Writes the tour atomically; returns its path relative to the root. */
export function writeTour(root: string, directory: string, tour: Tour): string {
  const relative = tourFile(directory, tour.name);
  const file = join(root, relative);
  mkdirSync(join(root, directory), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(tour, null, 2)}\n`);
  renameSync(temporary, file);

  return relative;
}

/** Removes a tour's file; false when there was none of that name. */
export function removeTour(root: string, directory: string, name: string): boolean {
  const file = join(root, tourFile(directory, name));

  if (!isTourName(name) || !existsSync(file)) return false;
  rmSync(file);

  return true;
}

/**
 * The picture a step's link names, as the page asks for it: the view, the options the link gives over the built-in
 * ones (a value the options table refuses is left out, as the page leaves it out), and the refs (`base`, else
 * `defaultBase`; `head`, `heads`, `at`).
 */
export function stepRequest(step: TourStep, defaultBase: string | null = null): Result<PictureRequest> {
  const params = new URLSearchParams(step.link);
  const view = parseView(params.get("view") ?? "");

  if (!view) return wrong(`unknown view "${params.get("view") ?? ""}"`);

  return ok({ view, options: readEachPictureOption((name) => params.get(name)).options, refs: { base: params.get("base") || defaultBase, head: params.get("head") || null, heads: (params.get("heads") ?? "").split(",").filter((head) => head !== ""), at: params.get("at") || null } });
}

/**
 * The tour as Markdown: its title, then every step — its picture's title, its note, the picture as Mermaid and the
 * shapes it selects — drawn on the code each step's link names (the working tree, or its head). A step whose picture
 * cannot be drawn (a view the code no longer has, a ref git does not know) says so in its place.
 */
export async function tourMarkdown(root: string, tour: Tour, file: string): Promise<string> {
  const analyses = new Map<string, Promise<Analysis>>();
  const analysisOf = (head: string | null): Promise<Analysis> => {
    const known = analyses.get(head ?? "") ?? (head === null ? analyze(root) : analysisAt(root, head));
    analyses.set(head ?? "", known);

    return known;
  };
  const lines = [`<!-- archdiff:generated — tour ${tour.name} -->`, `# ${tour.title}`, "", `_A guided tour of ${tour.steps.length === 1 ? "1 step" : `${tour.steps.length} steps`} (\`${file}\`); on the page it opens with \`#tour=${tour.name}&step=1\`._`, ""];

  for (const [i, step] of tour.steps.entries()) {
    const request = stepRequest(step);

    try {
      if (!request.ok) throw new Error(request.problem.message);
      const { view, options, refs } = request.value;
      const { diagram } = await drawPicture(await analysisOf(drawnAtHead(view.kind) ? refs.head : null), request.value);

      if (diagram.missing) throw new Error(diagram.reason ?? "its subject is not in the code");
      lines.push(`## ${i + 1}. ${diagram.title}`, "", ...(step.note.trim() === "" ? [] : [step.note.trim(), ""]));
      lines.push(...(diagram.nodes.length > 0 ? ["```mermaid", toMermaid(diagram, options.mermaid).trimEnd(), "```", ""] : [`_${diagram.reason ?? "nothing to draw"}_`, ""]));
      const picked = step.select.map((id) => diagram.nodes.find((node) => node.id === id)?.label.split("\n")[0] ?? id);

      if (picked.length > 0) lines.push(step.path && picked.length > 1 ? `The way: ${picked.map((label) => `**${label}**`).join(" → ")}.` : `Picked: ${picked.map((label) => `**${label}**`).join(", ")}.`, "");
    } catch (error) {
      lines.push(`## ${i + 1}. ${new URLSearchParams(step.link).get("view") ?? "?"}`, "", ...(step.note.trim() === "" ? [] : [step.note.trim(), ""]), `_The picture of this step could not be drawn: ${error instanceof Error ? error.message : String(error)}_`, "");
    }

    lines.push(`\`${step.link}\``, "");
  }

  if (tour.steps.length === 0) lines.push("_No steps yet: on the page, **add step** keeps the picture shown with a note._", "");

  return `${lines.join("\n").trimEnd()}\n`;
}
