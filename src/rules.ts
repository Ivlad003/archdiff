// The rules a repository states beside its contract: `"rules"` in
// archdiff.json, for what the flowchart of ARCHITECTURE.md has no room
// to say. The flowchart says which layer may import which; a rule says how
// the files of a layer are named (`naming`), how far a number archdiff
// measures may go (`threshold`: fan-in, fan-out, instability, abstractness,
// the distance from the main sequence, cohesion, lines), how many import
// cycles the code may have (`cycles`), through which module a layer is
// reached (`through`), and what is not imported (`forbidden`: a module, a
// glob of them, a package or a built-in). `archdiff check` holds the code
// to them (violations.ts) and reports each violation with its file and
// line, as it does an import against the layers.
//
// Read and validated here, with config.ts: a wrong rule names its place
// (`rules[2].metric`) and what is expected there, and a field no rule of
// that kind takes is refused, so a misspelt one does not loosen the rule
// unseen. Pure. Entry points: `rulesFromConfig`, `Rule`, `Metric`,
// `METRICS`, `RULE_KINDS`.

import { isJsonNumber, isJsonObject, isJsonString, type JsonObject, type JsonValue } from "./json.ts";

/** The numbers of a module a threshold may be set on, by the name a rule gives them. */
export const METRICS = ["fanIn", "fanOut", "instability", "abstractness", "distance", "cohesion", "lines"] as const;

export type Metric = (typeof METRICS)[number];

/** What every rule has: the name its violations and the baseline carry, and its place in archdiff.json for a message. */
interface RuleBase {
  name: string;
  /** `rules[2]`: where the rule is written. */
  at: string;
}

/** The files of a layer are named by a pattern: a glob (of the file's name, or of its path when it has a slash) or a regular expression of the name. */
export interface NamingRule extends RuleBase {
  kind: "naming";
  layer: string;
  pattern: string | null;
  regex: string | null;
}

/** A number of every module (of a layer, when one is named) stays at or under `max` and at or over `min`. */
export interface ThresholdRule extends RuleBase {
  kind: "threshold";
  metric: Metric;
  max: number | null;
  min: number | null;
  layer: string | null;
}

/** No more than `max` import cycles (none, by default). */
export interface CyclesRule extends RuleBase {
  kind: "cycles";
  max: number;
}

/** The modules of layer `from` (of every other layer, without one) reach layer `to` only through the modules `through` names. */
export interface ThroughRule extends RuleBase {
  kind: "through";
  from: string | null;
  to: string;
  through: string[];
}

/** The modules of layer `from` (every module, without one) import none of `imports`: paths or globs of modules, packages and built-ins by their names. */
export interface ForbiddenRule extends RuleBase {
  kind: "forbidden";
  from: string | null;
  imports: string[];
}

export type Rule = NamingRule | ThresholdRule | CyclesRule | ThroughRule | ForbiddenRule;

/** The fields each kind of rule takes, besides `kind` and `name`. */
export const RULE_KINDS: Record<Rule["kind"], readonly string[]> = {
  naming: ["layer", "pattern", "regex"],
  threshold: ["metric", "max", "min", "layer"],
  cycles: ["max"],
  through: ["from", "to", "through"],
  forbidden: ["from", "imports"],
};

/** The name of the contract's own rule (violations.ts): no rule of archdiff.json may take it. */
const RESERVED = "layers";

/** An error of a rule's field, said as config.ts says a wrong field: the field in quotes, then what it must be. */
function wrong(field: string, expected: string): Error {
  return new Error(`"${field}" ${expected}`);
}

/** A field that must be a non-empty string, or absent when not `required`. */
function text(rule: JsonObject, at: string, field: string, what: string, required: boolean): string | null {
  const value = rule[field];

  if (value === undefined && !required) return null;

  if (!isJsonString(value) || value.trim() === "") throw wrong(`${at}.${field}`, `must be ${what}`);

  return value;
}

/** A field that is one string or a list of them, at least one. */
function texts(rule: JsonObject, at: string, field: string, what: string): string[] {
  const value = rule[field];
  const list = isJsonString(value) ? [value] : value;

  if (!Array.isArray(list) || list.length === 0 || !list.every((item) => isJsonString(item) && item.trim() !== "")) throw wrong(`${at}.${field}`, `must be ${what}`);

  return list as string[];
}

/** A field that is a number of at least zero, or absent. */
function amount(rule: JsonObject, at: string, field: string, whole: boolean): number | null {
  const value = rule[field];

  if (value === undefined) return null;

  if (!isJsonNumber(value) || !(value >= 0) || !Number.isFinite(value) || (whole && !Number.isInteger(value))) throw wrong(`${at}.${field}`, `must be a ${whole ? "whole number" : "number"}, 0 or more`);

  return value;
}

/** A rule as its own fields say it, before it has its name and its place. */
type Unnamed<R> = R extends Rule ? Omit<R, "name" | "at"> : never;

/** One rule read from its JSON, without its name. */
function ruleOf(rule: JsonObject, at: string): Unnamed<Rule> {
  const kind = rule["kind"];
  const kinds = Object.keys(RULE_KINDS) as Rule["kind"][];

  if (!isJsonString(kind) || !(kinds as string[]).includes(kind)) throw wrong(`${at}.kind`, `must be one of ${kinds.join(", ")}`);
  const takes = RULE_KINDS[kind as Rule["kind"]];
  const unknown = Object.keys(rule).find((field) => field !== "kind" && field !== "name" && !takes.includes(field));

  if (unknown !== undefined) throw wrong(`${at}.${unknown}`, `is no field of a ${kind} rule (it takes ${["name", ...takes].join(", ")})`);

  if (kind === "naming") {
    const pattern = text(rule, at, "pattern", "a glob of the file's name, or of its path", false);
    const regex = text(rule, at, "regex", "a regular expression of the file's name", false);

    if ((pattern === null) === (regex === null)) throw wrong(at, 'needs one of "pattern" (a glob) and "regex"');

    if (regex !== null) {
      try {
        new RegExp(regex);
      } catch (error) {
        throw wrong(`${at}.regex`, `is no regular expression (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    return { kind, layer: text(rule, at, "layer", "the name of a layer", true)!, pattern, regex };
  }

  if (kind === "threshold") {
    const metric = rule["metric"];

    if (!isJsonString(metric) || !(METRICS as readonly string[]).includes(metric)) throw wrong(`${at}.metric`, `must be one of ${METRICS.join(", ")}`);
    const max = amount(rule, at, "max", false);
    const min = amount(rule, at, "min", false);

    if (max === null && min === null) throw wrong(at, 'needs "max" or "min"');

    if (max !== null && min !== null && min > max) throw wrong(`${at}.min`, 'must not be over "max"');

    return { kind, metric: metric as Metric, max, min, layer: text(rule, at, "layer", "the name of a layer", false) };
  }

  if (kind === "cycles") return { kind, max: amount(rule, at, "max", true) ?? 0 };

  if (kind === "through") return { kind, from: text(rule, at, "from", "the name of a layer", false), to: text(rule, at, "to", "the name of a layer", true)!, through: texts(rule, at, "through", "the path of a module, a glob, or a list of them") };

  return { kind: "forbidden", from: text(rule, at, "from", "the name of a layer", false), imports: texts(rule, at, "imports", "a module's path, a glob, a package's name, or a list of them") };
}

/** The name a rule has when it gives none: its kind and what it is of, so the baseline keeps it when the rules are reordered. */
function defaultName(rule: Unnamed<Rule>): string {
  if (rule.kind === "naming") return `naming:${rule.layer}`;

  if (rule.kind === "threshold") return `${rule.metric}${rule.layer === null ? "" : `:${rule.layer}`}`;

  if (rule.kind === "cycles") return "cycles";

  if (rule.kind === "through") return `through:${rule.from ?? "*"}→${rule.to}`;

  return `forbidden:${rule.from ?? "*"}`;
}

/**
 * The `rules` of archdiff.json: a list of `{ "kind": …, "name"?: … }` with the fields of the kind. Throws naming
 * the field that is wrong (`"rules[1].metric" must be one of …`); the caller says the file. Two rules of one
 * name are refused: a violation is known to the baseline by its rule's name.
 */
export function rulesFromConfig(value: JsonValue | undefined): Rule[] {
  if (value === undefined) return [];

  if (!Array.isArray(value)) throw wrong("rules", 'must be a list of rules: { "kind": "naming" | "threshold" | "cycles" | "through" | "forbidden", … }');
  const rules: Rule[] = [];

  value.forEach((item, i) => {
    const at = `rules[${i}]`;

    if (!isJsonObject(item)) throw wrong(at, `must be an object with a "kind": ${Object.keys(RULE_KINDS).join(", ")}`);
    const read = ruleOf(item, at);
    const given = item["name"];

    if (given !== undefined && (!isJsonString(given) || given.trim() === "")) throw wrong(`${at}.name`, "must be a name for the rule");
    const name = given ?? defaultName(read);

    if (name === RESERVED) throw wrong(`${at}.name`, `must not be "${RESERVED}": that is the rule of the contract's arrows`);
    const twin = rules.find((other) => other.name === name);

    if (twin) throw wrong(given === undefined ? at : `${at}.name`, `${given === undefined ? `is named "${name}" as ${twin.at} is: give one of them a "name"` : `is ${twin.at}'s name too: a rule is known by its name`}`);
    rules.push({ ...read, name, at } as Rule);
  });

  return rules;
}
