// The options of a picture — how deep, how many shapes, which lines,
// hubs, packages, opened modules, hidden lanes, overlays, the review's
// marks, the Mermaid type, lanes as rows or columns, type-only imports —
// described once, as a table. The three readers derive from it: the CLI's
// flags (`--depth 2`, `--no-hubs`, `--overlay tests,heat`), the API's
// query (`depth=2&hubs=0&overlay=tests,heat`) and the page's link (the
// same query in the hash); the writer makes the query the page and the
// exports use; `--help` prints the table. One description, so the three
// cannot drift (a shape's page once took the default options while the
// picture had the page's).
//
// Free of Node and of the analysis: the page bundles it. Sits with the
// config in the core; the views take `PictureOptions` as they are. A depth
// has no ceiling: past `DEEP_DEPTH` the picture says it may be big
// (`depthWarning`), and the CLI and the page say so too.
// Entry points: `PICTURE_OPTIONS`, `PictureOptions`, `readPictureOptions`,
// `readEachPictureOption`, `writePictureParams`, `pictureOptionsHelp`,
// `DEFAULT_PICTURE_OPTIONS`, `DEEP_DEPTH`, `depthWarning`, `OVERLAYS`,
// `MERMAID_STYLES`, `MERMAID_ONLY_FOR`, `LANE_MODES`.

import { ok, wrong, type Result } from "./result.ts";
import type { ViewKind } from "./view-keys.ts";

/** The overlays a picture can carry, in the order `--overlay` lists them. */
export const OVERLAYS = ["tests", "storages", "heat", "instability"] as const;

export type Overlay = (typeof OVERLAYS)[number];

/** The Mermaid types a diagram can be written as, besides the flowchart: each fits some views and no other. */
export const MERMAID_STYLES = ["auto", "flowchart", "c4", "quadrant", "pie", "gitgraph", "mindmap", "state"] as const;

export type MermaidStyle = (typeof MERMAID_STYLES)[number];

/** The Mermaid types that draw one kind of view alone (a machine, the timeline): elsewhere a picture is written as its own type, with a comment saying why. */
export const MERMAID_ONLY_FOR: Partial<Record<MermaidStyle, { kinds: readonly ViewKind[]; what: string }>> = {
  state: { kinds: ["machine"], what: "a machine" },
  gitgraph: { kinds: ["timeline", "branches"], what: "the commits of the timeline or of the branches" },
  quadrant: { kinds: ["hotspots", "metrics"], what: "the hotspots or the metrics" },
};

/** How the lanes lie: `auto` (rows, columns on a map of many lanes), `rows` (bands down the picture), `columns` (blocks across it). */
export const LANE_MODES = ["auto", "rows", "columns"] as const;

export type LaneMode = (typeof LANE_MODES)[number];

/** One option of the table: how it is named on the CLI (`--flag`), in a query (`param`), and what it holds. */
type OptionSpec =
  | { key: string; flag: string; param: string; type: "int"; min: number; help: string }
  | { key: string; flag: string; param: string; type: "bool"; default: boolean; help: string; negatedFlag?: true; paramValue?: string }
  | { key: string; flag: string; param: string; type: "list"; help: string }
  | { key: string; flag: string; param: string; type: "enum"; values: readonly string[]; default: string; help: string }
  | { key: string; flag: string; param: string; type: "enum-list"; values: readonly string[]; help: string };

export const PICTURE_OPTIONS = [
  { key: "depth", flag: "depth", param: "depth", type: "int", min: 0, help: "how far from the subject the picture goes (each view has its default)" },
  { key: "limit", flag: "limit", param: "limit", type: "int", min: 1, help: "fold a bigger picture into \"… N more\" shapes by directory (default 40; the whole map, modules, 200)" },
  { key: "weight", flag: "weight", param: "weight", type: "int", min: 1, help: "leave out lines standing for fewer than N imports or calls" },
  { key: "hubs", flag: "no-hubs", param: "hubs", type: "bool", default: true, negatedFlag: true, help: "a module most of a picture imports (a logger, the types) is a badge \"+ log.ts\" on its importers, not a tangle of lines; --no-hubs draws it" },
  { key: "packages", flag: "packages", param: "packages", type: "bool", default: false, help: "draw the packages and built-ins a module imports" },
  { key: "expand", flag: "expand", param: "expand", type: "list", help: "open modules in place: each becomes a lane of its functions (the mix of a module view and an inside view)" },
  { key: "hideLanes", flag: "hide-lanes", param: "hide", type: "list", help: "leave lanes out of the picture" },
  { key: "overlays", flag: "overlay", param: "overlay", type: "enum-list", values: OVERLAYS, help: "tests marks untested modules, storages labels the stores, heat shades by calls in, instability shades by Martin's I — on any view" },
  { key: "changes", flag: "changes", param: "changes", type: "bool", default: false, help: "lay the review's marks (--base, --head) over the view: structure and change in one picture" },
  { key: "onlyChanges", flag: "only-changes", param: "only", type: "bool", default: false, paramValue: "changes", help: "with --changes: keep the marked shapes and their neighbours only" },
  { key: "mermaid", flag: "mermaid", param: "mermaid", type: "enum", values: MERMAID_STYLES, default: "auto", help: "the Mermaid type of the Markdown (auto: a sequence, class, state or gitGraph where the view has one, else a flowchart)" },
  { key: "lanes", flag: "lanes", param: "lanes", type: "enum", values: LANE_MODES, default: "auto", help: "lanes as rows (bands down the picture) or columns (blocks across it; auto: columns on a map of more than six lanes)" },
  { key: "types", flag: "types", param: "types", type: "bool", default: false, help: "count type-only imports too (cycles, matrix), drawn dashed" },
] as const satisfies readonly OptionSpec[];

type Spec = (typeof PICTURE_OPTIONS)[number];

/** The table as the wider union, for the readers and writers (the literal table types only the keys and values). */
const SPECS: readonly OptionSpec[] = PICTURE_OPTIONS;

type ValueOf<S> = S extends { type: "int" } ? number | null : S extends { type: "bool" } ? boolean : S extends { type: "list" } ? string[] : S extends { type: "enum"; values: readonly (infer V)[] } ? V : S extends { type: "enum-list"; values: readonly (infer V)[] } ? V[] : never;

/** The options of a picture, every key present: null for an unset number, the default for the rest. */
export type PictureOptions = { [S in Spec as S["key"]]: ValueOf<S> };

export type PictureOptionKey = keyof PictureOptions;

function defaultOf(spec: OptionSpec): unknown {
  if (spec.type === "int") return null;

  if (spec.type === "bool") return spec.default;

  if (spec.type === "enum") return spec.default;

  return [];
}

export const DEFAULT_PICTURE_OPTIONS: PictureOptions = Object.fromEntries(SPECS.map((spec) => [spec.key, defaultOf(spec)])) as PictureOptions;

/** What was read: the options, and the keys the source named (the page lays its remembered defaults under the rest). */
export interface ReadOptions {
  options: PictureOptions;
  given: Set<PictureOptionKey>;
}

/** A query's yes for a boolean (`1`, `true`, `yes`), its no (`0`, `false`, `no`, empty); anything else is wrong. */
const QUERY_YES = new Set(["1", "true", "yes"]);
const QUERY_NO = new Set(["0", "false", "no", ""]);

/**
 * Reads the options from a source of named values: the CLI's flags
 * (`source: "flag"`, a flag without a value reads as `true`) or a query's
 * parameters (`source: "param"`). A query writes an unset number as an
 * empty value, an empty list as `none`, a boolean as `1` or `0` (and reads
 * `true`/`false` and `yes`/`no` too); a flag takes a number or a
 * comma-separated list after it. A wrong value is a problem naming the
 * option.
 */
export function readPictureOptions(get: (name: string) => string | true | null | undefined, source: "flag" | "param"): Result<ReadOptions> {
  const options: Record<string, unknown> = { ...DEFAULT_PICTURE_OPTIONS };
  const given = new Set<PictureOptionKey>();
  const name = (spec: OptionSpec): string => (source === "flag" ? `--${spec.flag}` : spec.param);

  for (const spec of SPECS) {
    const raw = get(source === "flag" ? spec.flag : spec.param);

    if (raw === undefined || raw === null) continue;
    given.add(spec.key as PictureOptionKey);

    if (spec.type === "bool") {
      if (source === "flag") options[spec.key] = spec.negatedFlag ? false : true;
      else if (raw === true || QUERY_YES.has(raw) || (spec.paramValue !== undefined && raw === spec.paramValue)) options[spec.key] = true;
      else if (QUERY_NO.has(raw)) options[spec.key] = false;
      else return wrong(`${name(spec)} must be 1 or 0`);
      continue;
    }

    if (raw === true) return wrong(`${name(spec)} needs a value`);

    if (spec.type === "int") {
      if (raw === "" && source === "param") {
        options[spec.key] = null;
        continue;
      }

      const value = Number(raw);

      if (!(Number.isInteger(value) && value >= spec.min)) return wrong(`${name(spec)} must be a whole number${spec.min > 0 ? ` of at least ${spec.min}` : ""}`);
      options[spec.key] = value;
      continue;
    }

    const items = raw.split(",").map((item) => item.trim()).filter((item) => item !== "" && item !== "none");

    if (spec.type === "list") {
      options[spec.key] = items;
      continue;
    }

    if (spec.type === "enum") {
      if (!spec.values.includes(raw)) return wrong(`${name(spec)} must be one of ${spec.values.join(", ")}`);
      options[spec.key] = raw;
      continue;
    }

    for (const item of items) if (!spec.values.includes(item)) return wrong(`unknown ${spec.key === "overlays" ? "overlay" : spec.key} "${item}" (${spec.values.join(", ")})`);
    options[spec.key] = [...new Set(items)];
  }

  return ok({ options: options as PictureOptions, given });
}

/** What a lenient reading found: the options and the keys given, and the values it left out, each with why. */
export interface LenientOptions extends ReadOptions {
  /** `limit=1.5 (limit must be a whole number of at least 1)`, one per value left out. */
  wrong: string[];
}

/**
 * Reads a query's options one by one, for a link that may be old or typed
 * by hand: a wrong value is left out alone (its option keeps the default)
 * and named in `wrong`, and every other option is read as given. The CLI
 * and the API read strictly (`readPictureOptions`) and refuse instead.
 */
export function readEachPictureOption(get: (name: string) => string | null | undefined): LenientOptions {
  const options: Record<string, unknown> = { ...DEFAULT_PICTURE_OPTIONS };
  const given = new Set<PictureOptionKey>();
  const wrongs: string[] = [];

  for (const spec of SPECS) {
    const raw = get(spec.param);

    if (raw === undefined || raw === null) continue;
    const read = readPictureOptions((name) => (name === spec.param ? raw : null), "param");

    if (!read.ok) {
      wrongs.push(`${spec.param}=${raw} (${read.problem.message})`);
      continue;
    }

    options[spec.key] = read.value.options[spec.key as PictureOptionKey];
    given.add(spec.key as PictureOptionKey);
  }

  return { options: options as PictureOptions, given, wrong: wrongs };
}

/** Past this depth a picture can grow big and slow to draw: archdiff warns, it does not refuse. */
export const DEEP_DEPTH = 12;

/** The warning of a depth past `DEEP_DEPTH`, or null (no depth, or a shallow one). */
export function depthWarning(depth: number | null): string | null {
  return depth !== null && depth > DEEP_DEPTH ? `depth ${depth} is deeper than ${DEEP_DEPTH}: the picture may be big and slow to draw (the fold keeps it readable)` : null;
}

/**
 * The query of a picture's options: every option that differs from
 * `defaults` (the built-in ones unless the page passes its remembered
 * ones), so a plain link stays short and an explicit "none" survives.
 */
export function writePictureParams(options: PictureOptions, defaults: PictureOptions = DEFAULT_PICTURE_OPTIONS): URLSearchParams {
  const params = new URLSearchParams();

  for (const spec of SPECS) {
    const value: unknown = options[spec.key as PictureOptionKey];
    const base: unknown = defaults[spec.key as PictureOptionKey];

    if (JSON.stringify(value) === JSON.stringify(base)) continue;

    if (spec.type === "int") params.set(spec.param, value === null ? "" : String(value));
    else if (spec.type === "bool") params.set(spec.param, value ? (spec.paramValue ?? "1") : "0");
    else if (spec.type === "enum") params.set(spec.param, String(value));
    else params.set(spec.param, (value as string[]).length > 0 ? (value as string[]).join(",") : "none");
  }

  return params;
}

/** The options of the query as text to append to a URL (`&depth=2&hubs=0`), empty when every option is the default. */
export function pictureQueryText(options: PictureOptions, defaults?: PictureOptions): string {
  const text = writePictureParams(options, defaults).toString();

  return text === "" ? "" : `&${text}`;
}

/** The usage of the flags, one line each, for `--help`. */
export function pictureOptionsHelp(): string[] {
  return SPECS.map((spec) => {
    const usage = spec.type === "bool" ? `--${spec.flag}` : spec.type === "int" ? `--${spec.flag} N` : spec.type === "enum" ? `--${spec.flag} ${spec.values.join("|")}` : spec.type === "enum-list" ? `--${spec.flag} ${spec.values.join(",")}` : `--${spec.flag} a,b`;

    return `${usage.padEnd(22)} ${spec.help}`;
  });
}

/** The flags of the table, for a command's flag list. */
export function pictureFlags(): { name: string; value: boolean }[] {
  return SPECS.map((spec) => ({ name: spec.flag, value: spec.type !== "bool" }));
}
