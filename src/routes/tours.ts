// The routes of the guided tours: the tours of the repository, one of
// them, a tour saved whole as the page recorded it, and a tour removed.
// The tours are files of the repository (`.archdiff/tours/`, or the
// directory archdiff.json names), read anew for every request, so a tour
// written by hand or pulled from git is there at once.
//
// Entry point: `routes`, by `METHOD /path` (server.ts dispatches through
// it).

import { loadConfig } from "../config.ts";
import { parseJson } from "../json.ts";
import { isTourName, listTours, loadTour, parseTour, removeTour, toursDirectory, writeTour } from "../tours.ts";
import { failed, json, problem, type RouteContext, type RouteRequest } from "./context.ts";

/** The directory of the repository's tours, as its archdiff.json says now. */
function directoryOf(ctx: RouteContext): string {
  return toursDirectory(loadConfig(ctx.root));
}

export async function getTours(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  const directory = directoryOf(ctx);

  return json(response, { directory, tours: listTours(ctx.root, directory) });
}

export async function getTour(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const tour = loadTour(ctx.root, directoryOf(ctx), url.searchParams.get("name") ?? "");

  return tour.ok ? json(response, tour.value) : failed(response, tour);
}

export async function postTour(ctx: RouteContext, { url, body, response }: RouteRequest): Promise<void> {
  const directory = directoryOf(ctx);

  try {
    const tour = parseTour(parseJson(body), url.searchParams.get("name") ?? "");

    return json(response, { saved: writeTour(ctx.root, directory, tour), tour });
  } catch (error) {
    return problem(response, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function postTourDelete(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const name = url.searchParams.get("name") ?? "";

  if (!isTourName(name)) return problem(response, 400, `"${name}" is no name of a tour`);

  return removeTour(ctx.root, directoryOf(ctx), name) ? json(response, { removed: name }) : problem(response, 404, `no tour "${name}"`);
}

/** The handlers by `METHOD /path`. */
export const routes: Record<string, (ctx: RouteContext, request: RouteRequest) => Promise<void>> = {
  "GET /api/tours": getTours,
  "GET /api/tour": getTour,
  "POST /api/tour": postTour,
  "POST /api/tour/delete": postTourDelete,
};
