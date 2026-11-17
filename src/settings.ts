// The user's settings: which program each agent is, the model it is told
// to use, the agents of the user's own, the keys the agents run with, and
// the language the page speaks (page-language.ts).
// They are the user's and no repository's — a key must not land in a
// commit — so they are kept in `<home>/.archdiff/settings.json`, written
// for the user alone, and never in archdiff.json. The page's settings
// window reads and changes them through routes/settings.ts; the file may
// as well be written by hand.
//
//   {
//     "agents": { "claude": { "command": "C:\\tools\\claude.exe", "model": "sonnet", "openrouter": true },
//                 "opencode": { "model": "openrouter/anthropic/claude-sonnet-4.5" } },
//     "custom": [{ "name": "mine", "command": ["node", "agent.mjs"], "protocol": "stream-json", "resume": "--resume" }],
//     "keys": { "OPENROUTER_API_KEY": "sk-or-…" },
//     "language": "uk"
//   }
//
// A key is an environment variable named `…_KEY` or `…_TOKEN`: every
// agent run gets the keys in its environment, over the server's own.
// OpenCode reads `OPENROUTER_API_KEY` by itself for a model
// `openrouter/…`; Claude Code goes through OpenRouter when its
// `openrouter` is set, by the three variables OpenRouter documents.
//
// Entry points: `readSettings`, `writeSettings`, `settingsPath`,
// `changedSettings`, `agentSpecs`, `pageLanguage`, `NO_SETTINGS`,
// `KNOWN_KEYS`, `OPENROUTER_KEY`.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENTS, isAgentName, PROTOCOLS, type AgentName, type AgentProtocol, type AgentSpec } from "./agent.ts";
import { userHome } from "./home.ts";
import { isJsonObject, isJsonString, parseJson, type JsonObject, type JsonValue } from "./json.ts";
import { isPageLanguage, PAGE_LANGUAGES, type PageLanguage } from "./page-language.ts";
import { attempt, type Result } from "./result.ts";

/** What the settings say of a built-in agent: its program when it is not found by its name, its model, and (Claude Code) whether it goes through OpenRouter. */
export interface AgentChoice {
  command?: string;
  model?: string;
  openrouter?: boolean;
}

/** An agent of the user's own: a command that prints the events of one of the protocols. */
export interface OwnAgent {
  name: string;
  command: string[];
  protocol: AgentProtocol;
  resume: string | null;
}

export interface Settings {
  agents: Partial<Record<AgentName, AgentChoice>>;
  custom: OwnAgent[];
  keys: Record<string, string>;
  /** The language the page speaks, when it is not English (the one it speaks unasked). */
  language?: PageLanguage;
}

export const NO_SETTINGS: Settings = { agents: {}, custom: [], keys: {} };

/** The key OpenRouter gives: OpenCode reads it under this name, and Claude Code is handed it when it goes through OpenRouter. */
export const OPENROUTER_KEY = "OPENROUTER_API_KEY";

/** The keys the settings window suggests by name; any other `…_KEY` or `…_TOKEN` is as good. */
export const KNOWN_KEYS = [OPENROUTER_KEY, "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CURSOR_API_KEY"];

const KEY_NAME = /^[A-Z][A-Z0-9_]*_(KEY|TOKEN)$/;
const MODEL = /^[\w.:/@-]{1,200}$/;
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,39}$/i;

/** Where the settings are kept: the user's own file, outside every repository. */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(userHome(env), ".archdiff", "settings.json");
}

/** A field that must be an object when it is there; an empty one when it is not. */
function objectField(parent: JsonObject, field: string): JsonObject {
  const value = parent[field];

  if (value === undefined || value === null) return {};

  if (!isJsonObject(value)) throw new Error(`settings: "${field}" must be an object`);

  return value;
}

function choiceFrom(name: AgentName, value: JsonValue | undefined): AgentChoice {
  if (!isJsonObject(value)) throw new Error(`settings: "agents.${name}" must be an object`);
  const choice: AgentChoice = {};
  const { command, model, openrouter } = value;

  if (command !== undefined && command !== null && command !== "") {
    if (!isJsonString(command) || /[\r\n\0]/.test(command)) throw new Error(`settings: "agents.${name}.command" must be the path or the name of a program`);
    choice.command = command;
  }

  if (model !== undefined && model !== null && model !== "") {
    if (!isJsonString(model) || !MODEL.test(model)) throw new Error(`settings: "agents.${name}.model" must be a model's name (letters, digits and . : / @ - _)`);
    choice.model = model;
  }

  if (openrouter !== undefined && openrouter !== null && openrouter !== false) {
    if (openrouter !== true || name !== "claude") throw new Error(`settings: "agents.${name}.openrouter" is Claude Code's alone, true or false`);
    choice.openrouter = true;
  }

  return choice;
}

function ownFrom(value: JsonValue, taken: Set<string>): OwnAgent {
  if (!isJsonObject(value) || !isJsonString(value["name"]) || !AGENT_NAME.test(value["name"])) throw new Error('settings: an agent of "custom" needs a "name" of letters, digits, - and _');
  const name = value["name"];

  if (isAgentName(name) || taken.has(name)) throw new Error(`settings: the agent "${name}" is there already`);
  const command = value["command"];

  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => isJsonString(part) && !/\0/.test(part)) || command[0] === "") throw new Error(`settings: the agent "${name}" needs a "command": the program, then its arguments`);
  const protocol = value["protocol"] ?? "stream-json";

  if (!isJsonString(protocol) || !(PROTOCOLS as readonly string[]).includes(protocol)) throw new Error(`settings: the "protocol" of "${name}" must be ${PROTOCOLS.map((each) => `"${each}"`).join(", ")}`);
  const resume = value["resume"] ?? null;

  if (resume !== null && !isJsonString(resume)) throw new Error(`settings: the "resume" of "${name}" must be a flag, or left out`);
  taken.add(name);

  return { name, command: command as string[], protocol: protocol as AgentProtocol, resume: resume === "" ? null : resume };
}

/** The settings a JSON value holds; throws naming the field that is wrong. */
export function settingsFrom(value: JsonValue): Settings {
  if (!isJsonObject(value)) throw new Error("settings: must be an object");
  const agents: Settings["agents"] = {};

  for (const [name, choice] of Object.entries(objectField(value, "agents"))) {
    if (!isAgentName(name)) throw new Error(`settings: "agents" names the built-in agents (${Object.keys(AGENTS).join(", ")}), not "${name}"; another agent goes in "custom"`);
    const read = choiceFrom(name, choice);

    if (Object.keys(read).length > 0) agents[name] = read;
  }

  const listed = value["custom"] ?? [];

  if (!Array.isArray(listed)) throw new Error('settings: "custom" must be a list of agents');
  const taken = new Set<string>();
  const custom = listed.map((each) => ownFrom(each, taken));
  const keys: Settings["keys"] = {};

  for (const [name, key] of Object.entries(objectField(value, "keys"))) {
    if (!KEY_NAME.test(name)) throw new Error(`settings: a key is an environment variable named …_KEY or …_TOKEN in capitals, not "${name}"`);

    if (!isJsonString(key) || /[\r\n\0]/.test(key) || key.length > 1000) throw new Error(`settings: the key ${name} must be one line of text`);
    keys[name] = key;
  }

  const language = value["language"] ?? "en";

  if (!isPageLanguage(language)) throw new Error(`settings: "language" must be one of ${Object.keys(PAGE_LANGUAGES).map((each) => `"${each}"`).join(", ")}`);

  return { agents, custom, keys, ...(language === "en" ? {} : { language }) };
}

/** The language the page speaks for this user: the settings', English without one or with a file that does not read. */
export function pageLanguage(env: NodeJS.ProcessEnv = process.env): PageLanguage {
  const read = readSettings(env);

  return read.ok ? (read.value.language ?? "en") : "en";
}

/** The settings of this user; none when there is no file; a problem naming the file when it cannot be read as settings. */
export function readSettings(env: NodeJS.ProcessEnv = process.env): Result<Settings> {
  const file = settingsPath(env);

  if (!existsSync(file)) return { ok: true, value: NO_SETTINGS };
  const read = attempt(() => settingsFrom(parseJson(readFileSync(file, "utf8"))));

  return read.ok ? read : { ok: false, problem: { ...read.problem, message: `${file}: ${read.problem.message}` } };
}

/** Writes the settings for the user alone (the file holds keys); what is empty is left out. */
export function writeSettings(settings: Settings, env: NodeJS.ProcessEnv = process.env): void {
  const file = settingsPath(env);
  const kept: JsonObject = {};

  if (Object.keys(settings.agents).length > 0) kept["agents"] = settings.agents as JsonObject;

  if (settings.custom.length > 0) kept["custom"] = settings.custom as unknown as JsonValue;

  if (Object.keys(settings.keys).length > 0) kept["keys"] = settings.keys;

  if (settings.language) kept["language"] = settings.language;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  // A file that was there keeps the mode it had: it is the user's alone from now on (Windows keeps it by the profile's own rights).
  chmodSync(file, 0o600);
}

/**
 * The settings after a change from the page: `agents`, `custom` and `language` replace what was there when they are
 * given; each key of `keys` is set (a string) or forgotten (null), the others stay — the page never holds a key's value.
 * Throws naming the field that is wrong, with nothing changed.
 */
export function changedSettings(current: Settings, change: JsonValue): Settings {
  if (!isJsonObject(change)) throw new Error("settings: the change must be an object");
  const keys: JsonObject = { ...current.keys };

  for (const [name, key] of Object.entries(objectField(change, "keys"))) {
    if (key === null) delete keys[name];
    else keys[name] = key;
  }

  return settingsFrom({ agents: change["agents"] ?? (current.agents as JsonObject), custom: change["custom"] ?? (current.custom as unknown as JsonValue), keys, language: change["language"] ?? current.language ?? "en" });
}

/**
 * The agents the page may offer, as the settings have them: the built-in ones — each with its program, its model
 * and the keys — then the one given to the server (`--agent`, archdiff.json) when it is none of them, then the
 * user's own. Claude Code set to go through OpenRouter runs on OpenRouter's key (the settings', else the server's
 * environment's) by the variables OpenRouter documents, and is blocked, saying why, without one.
 */
export function agentSpecs(settings: Settings, given: AgentSpec | null, env: NodeJS.ProcessEnv = process.env): AgentSpec[] {
  const keyed = (spec: AgentSpec, more: Record<string, string> = {}): AgentSpec => {
    const all = { ...settings.keys, ...more };

    return Object.keys(all).length === 0 ? spec : { ...spec, env: all, secrets: [...new Set(Object.values(all).filter((value) => value !== "" && !/^https?:/.test(value)))] };
  };

  const builtIn = (name: AgentName): AgentSpec => {
    const choice = settings.agents[name] ?? {};
    const base = AGENTS[name];
    const placed: AgentSpec = choice.command ? { ...base, command: [choice.command, ...base.command.slice(1)], ...(base.resumeCommand ? { resumeCommand: [choice.command, ...base.resumeCommand.slice(1)] } : {}) } : base;
    const spec: AgentSpec = choice.model ? { ...placed, model: choice.model } : placed;

    if (!choice.openrouter) return keyed(spec);
    const key = settings.keys[OPENROUTER_KEY] || env[OPENROUTER_KEY] || "";

    // An empty ANTHROPIC_API_KEY is part of it: a key of Anthropic's own would be used in place of OpenRouter's.
    return key === "" ? keyed({ ...spec, blocked: `${base.label} is set to go through OpenRouter, and no ${OPENROUTER_KEY} is set` }) : keyed(spec, { ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: "" });
  };

  const own = settings.custom.filter((agent) => agent.name !== given?.name).map((agent): AgentSpec => ({ name: agent.name, label: agent.name, command: agent.command, resumeFlag: agent.resume, protocol: agent.protocol }));

  return [...(Object.keys(AGENTS) as AgentName[]).map(builtIn), ...[...(given && !isAgentName(given.name) ? [given] : []), ...own].map((spec) => keyed(spec))];
}
