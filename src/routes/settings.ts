// The routes of the user's settings: the agents as this computer has them
// and as the settings place them, the keys the agents run with, and the
// language the page speaks. The
// settings hold keys and name programs to start, so they are read and
// changed from this computer alone, however the server is bound; a key's
// value goes in and never comes back — the page is told that a key is
// set, and its last characters.
//
// Entry point: `routes`, by `METHOD /path` (server.ts dispatches through
// it).

import type { IncomingMessage } from "node:http";
import { isAgentName } from "../agent.ts";
import { parseJson, type JsonValue } from "../json.ts";
import { attempt } from "../result.ts";
import { changedSettings, KNOWN_KEYS, NO_SETTINGS, readSettings, settingsPath, writeSettings, type Settings } from "../settings.ts";
import { json, problem, type RouteContext, type RouteRequest } from "./context.ts";

/** Whether a request comes from this computer itself. */
function fromHere(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";

  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const ELSEWHERE = "the settings are read and changed on the computer archdiff runs on";

/** What is left of a key to recognise it by: its last four characters when it is long enough to spare them. */
function hintOf(key: string): string {
  return key.length >= 12 ? `…${key.slice(-4)}` : "";
}

/** The settings as the page shows them: every agent with where it was found or why not, the keys by name and hint. */
function shown(ctx: RouteContext, settings: Settings, broken: string | null): unknown {
  const own = new Set(settings.custom.map((agent) => agent.name));

  return {
    file: settingsPath(),
    problem: broken,
    language: settings.language ?? "en",
    agents: ctx.agents().map(({ spec, installed, path, problem: why }) => {
      const builtIn = isAgentName(spec.name);
      const choice = builtIn ? (settings.agents[spec.name as keyof Settings["agents"]] ?? {}) : {};

      return {
        name: spec.name,
        label: spec.label,
        // Whose it is: a built-in agent (its program and model are the settings'), the user's own (all of it is), or the one given to the server (archdiff.json, --agent: shown as it is).
        from: builtIn ? "built-in" : own.has(spec.name) ? "settings" : "server",
        installed,
        path,
        problem: why,
        // The name it is looked for by when the settings place no program.
        program: builtIn ? spec.command[0] : null,
        command: builtIn ? (choice.command ?? null) : spec.command,
        model: choice.model ?? null,
        openrouter: spec.name === "claude" ? (choice.openrouter ?? false) : null,
        protocol: spec.protocol,
        resume: spec.resumeFlag,
      };
    }),
    keys: Object.entries(settings.keys).map(([name, key]) => ({ name, hint: hintOf(key), empty: key === "" })),
    // The names suggested, and whether the server's own environment holds each: such a key reaches the agents without the settings.
    known: KNOWN_KEYS.map((name) => ({ name, environment: (process.env[name] ?? "") !== "" })),
  };
}

export async function getSettings(ctx: RouteContext, { response, request }: RouteRequest): Promise<void> {
  if (!fromHere(request)) return problem(response, 403, ELSEWHERE);
  const read = readSettings();

  return json(response, shown(ctx, read.ok ? read.value : NO_SETTINGS, read.ok ? null : read.problem.message));
}

export async function postSettings(ctx: RouteContext, { body, response, request }: RouteRequest): Promise<void> {
  if (!fromHere(request)) return problem(response, 403, ELSEWHERE);
  const read = readSettings();

  // A file written by hand that does not read: changing it from here would drop what it holds.
  if (!read.ok) return problem(response, 400, `${read.problem.message} — correct the file or remove it first`);
  let change: JsonValue;

  try {
    change = parseJson(body);
  } catch {
    return problem(response, 400, "the body must be JSON");
  }

  const next = attempt(() => changedSettings(read.value, change), 400);

  if (!next.ok) return problem(response, 400, next.problem.message);
  const written = attempt(() => writeSettings(next.value));

  if (!written.ok) return problem(response, 500, `${settingsPath()}: ${written.problem.message}`);

  return json(response, shown(ctx, next.value, null));
}

/** The handlers by `METHOD /path`. */
export const routes: Record<string, (ctx: RouteContext, request: RouteRequest) => Promise<void>> = {
  "GET /api/settings": getSettings,
  "POST /api/settings": postSettings,
};
