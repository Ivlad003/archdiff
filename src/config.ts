// The optional `archdiff.json` of a repository and the defaults without
// one: which files to skip, which layers the modules fall into, which
// functions are entry points, and which coding agent the page may run. Layers are globs; without any, a module's
// layer is its top directory (`src/<dir>` when under `src/`). Validated on
// read: a wrong field names the file and the field.
//
// Sits at the start of the pipeline: root → Config → files, graph.
// Entry points: `loadConfig`, `layerOf`, `CONFIG_FILE`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { firstMatchingGlob } from "./glob.ts";
import { agentFromConfig, type AgentSpec } from "./agent.ts";
import { isJsonObject, isJsonString, parseJson, type JsonValue } from "./json.ts";

export const CONFIG_FILE = "archdiff.json";

/** What `read` returns, its error said as an error of the config file (`archdiff.json: agent: …`). */
function named<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new Error(`${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The settings of one repository. */
export interface Config {
  /** Globs of files left out of the analysis, besides what git ignores. */
  exclude: string[];
  /** Layer name → globs of its files, in order; null: layers from the directories. */
  layers: Record<string, string[]> | null;
  /** Globs of files whose exported functions are entry points, besides what the code shows (`main`, `bin/`). */
  entries: string[];
  /** The layer of files no layer glob matches. */
  otherLayer: string;
  /** The coding agent the page may hand a task to; null: the Chat tab only writes the task. */
  agent: AgentSpec | null;
  /** When a module of a picture is a hub (a badge, not lines): imported by at least `min` of its modules and `share` of them, or by `max` whatever the picture's size. */
  hubs: HubThresholds;
  /** Glob → what the matching modules hold (`"src/cache/**": "the cache"`): storages the code's names and packages do not reveal. */
  storages: Record<string, string>;
  /** Package name → what a module importing it holds (`"my-orm": "MyORM"`), beside the built-in table. */
  storagePackages: Record<string, string>;
  /** Shell commands run after every agent run and on request (`npm test`, `npm run typecheck`); Claude Code may run exactly these. */
  checks: string[];
  /** Postman collections to read against the code, besides every `*.postman_collection.json` of the repository: paths from the root. */
  postman: string[];
}

export interface HubThresholds {
  min: number;
  share: number;
  max: number;
}

/** A quarter of a picture marks the logger and the shared types, not a busy neighbour; at least 6 importers, and 40 on a big map whatever its size. */
export const DEFAULT_HUBS: HubThresholds = { min: 6, share: 0.25, max: 40 };

export const DEFAULT_CONFIG: Config = { exclude: [], layers: null, entries: [], otherLayer: "other", agent: null, hubs: DEFAULT_HUBS, storages: {}, storagePackages: {}, checks: [], postman: [] };

/** `"storages": { "<glob>": "<what it holds>" }`: an object of strings. */
function stringMap(value: JsonValue | undefined, file: string, field: string): Record<string, string> {
  if (value === undefined) return {};

  if (!isJsonObject(value) || !Object.values(value).every(isJsonString)) throw new Error(`${file}: "${field}" must be an object of string → string`);

  return { ...(value as Record<string, string>) };
}

function stringList(value: JsonValue | undefined, file: string, field: string): string[] {
  if (value === undefined) return [];

  if (!Array.isArray(value) || !value.every(isJsonString)) throw new Error(`${file}: "${field}" must be a list of strings`);

  return value;
}

/** Reads `<root>/archdiff.json`; the defaults without one. Throws a message naming the file and field on a wrong shape. */
export function loadConfig(root: string): Config {
  const file = join(root, CONFIG_FILE);

  if (!existsSync(file)) return DEFAULT_CONFIG;
  let parsed;

  try {
    parsed = parseJson(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${CONFIG_FILE}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }

  if (!isJsonObject(parsed)) throw new Error(`${CONFIG_FILE}: must be a JSON object`);
  const exclude = stringList(parsed["exclude"], CONFIG_FILE, "exclude");
  const entries = stringList(parsed["entries"], CONFIG_FILE, "entries");
  let layers: Record<string, string[]> | null = null;

  if (parsed["layers"] !== undefined) {
    if (!isJsonObject(parsed["layers"])) throw new Error(`${CONFIG_FILE}: "layers" must be an object of layer name → globs`);
    layers = {};

    for (const [name, globs] of Object.entries(parsed["layers"])) {
      if (name === "") throw new Error(`${CONFIG_FILE}: "layers" has an empty layer name`);
      layers[name] = stringList(globs, CONFIG_FILE, `layers.${name}`);
    }
  }

  const other = parsed["other"];

  if (other !== undefined && !isJsonString(other)) throw new Error(`${CONFIG_FILE}: "other" must be a string`);

  return { exclude, layers, entries, otherLayer: other ?? DEFAULT_CONFIG.otherLayer, agent: named(() => agentFromConfig(parsed["agent"])), hubs: hubThresholds(parsed["hubs"]), storages: stringMap(parsed["storages"], CONFIG_FILE, "storages"), storagePackages: stringMap(parsed["storagePackages"], CONFIG_FILE, "storagePackages"), checks: stringList(parsed["checks"], CONFIG_FILE, "checks"), postman: stringList(parsed["postman"], CONFIG_FILE, "postman") };
}

/** `"hubs": { "min": 6, "share": 0.25, "max": 40 }`, each field optional; a wrong field names itself. */
function hubThresholds(value: JsonValue | undefined): HubThresholds {
  if (value === undefined) return DEFAULT_HUBS;

  if (!isJsonObject(value)) throw new Error(`${CONFIG_FILE}: "hubs" must be an object with min, share and max`);
  const out = { ...DEFAULT_HUBS };

  for (const field of ["min", "share", "max"] as const) {
    const item = value[field];

    if (item === undefined) continue;

    if (typeof item !== "number" || !(item >= 0) || (field !== "share" && !Number.isInteger(item)) || (field === "share" && item > 1)) throw new Error(`${CONFIG_FILE}: "hubs.${field}" must be ${field === "share" ? "a number between 0 and 1" : "a whole number"}`);
    out[field] = item;
  }

  return out;
}

/**
 * The layer of a file. With configured layers, the first whose glob matches,
 * else `otherLayer`. Without any: `src/<dir>` for a file under a directory
 * of `src/`, `src` for a file directly in it, else its top directory, and
 * `(root)` for a file at the root.
 */
export function layerOf(path: string, config: Config): string {
  if (config.layers) {
    for (const [name, globs] of Object.entries(config.layers)) if (firstMatchingGlob(path, globs) !== null) return name;

    return config.otherLayer;
  }

  const segments = path.split("/");

  if (segments.length === 1) return "(root)";

  if (segments[0] === "src") return segments.length > 2 ? `src/${segments[1]}` : "src";

  return segments[0]!;
}
