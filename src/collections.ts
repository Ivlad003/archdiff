// Postman collections of the repository against the code: every
// `*.postman_collection.json` git lists (and the files archdiff.json's
// `postman` names), each request with its method and the path as written,
// the variables of the path (`{{basketId}}`, `:id`, `{id}`) read as
// wildcards; the routes of the operations the code calls, from the SCAPI
// table; and the match between them — which request the code calls, which
// operation no request has. A collection written by `archdiff postman`
// matches whole. The `postman` view only draws what `matchRequests` says.
//
// Sits in the core beside the analysis, which reads the collections once
// per run (a file read before and unchanged is not parsed again).
//
// Entry points: `readCollections`, `collectionOf`, `requestSegments`,
// `pathSegments`, `routeMatch`, `routesOf`, `matchRequests`,
// `COLLECTION_SUFFIX`.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { operationId, type ApiOperation, type ScapiTable } from "./apis.ts";
import { isJsonObject, isJsonString, parseJson, type JsonValue } from "./json.ts";
import { operationPath } from "./scapi-runtime.ts";

/** How a Postman export names a collection file. */
export const COLLECTION_SUFFIX = ".postman_collection.json";

export interface ImportedRequest {
  /** The folders above the request, outermost first. */
  folder: string[];
  name: string;
  method: string;
  /** The URL as the collection writes it. */
  raw: string;
  /** The path's segments, a variable as `*`; empty when the URL has no path. */
  segments: string[];
}

export interface ImportedCollection {
  /** The file, relative to the root. */
  file: string;
  name: string;
  requests: ImportedRequest[];
}

/** The files parsed so far, by path, with the size and time of the file they were read from: the page analyses after every change of the code, the collections rarely change. */
const parsedFiles = new Map<string, { size: number; mtimeMs: number; collection: ImportedCollection | null }>();

/** Every collection of the repository: the files named like a Postman export, and the ones configured; a file that is no collection is left out. */
export function readCollections(root: string, allFiles: readonly string[], configured: readonly string[]): ImportedCollection[] {
  const files = [...new Set([...allFiles.filter((path) => path.endsWith(COLLECTION_SUFFIX) && !path.includes("node_modules/")), ...configured])].sort();
  const collections: ImportedCollection[] = [];

  for (const file of files) {
    const full = join(root, file);
    let size: number;
    let mtimeMs: number;

    try {
      ({ size, mtimeMs } = statSync(full));
    } catch {
      continue;
    }

    // A file read before, of the same size and time, is the collection it was (or no collection, as before).
    const known = parsedFiles.get(full);
    let collection = known && known.size === size && known.mtimeMs === mtimeMs ? known.collection : undefined;

    if (collection === undefined) {
      try {
        collection = collectionOf(parseJson(readFileSync(full, "utf8")), file);
      } catch {
        collection = null;
      }

      parsedFiles.set(full, { size, mtimeMs, collection });
    }

    if (collection) collections.push(collection);
  }

  return collections;
}

/** A collection as data (schema v2.0 or v2.1: `info.name`, `item` nested in folders), or null for JSON of another shape. */
export function collectionOf(parsed: JsonValue, file: string): ImportedCollection | null {
  if (!isJsonObject(parsed) || !isJsonObject(parsed["info"]) || !Array.isArray(parsed["item"])) return null;
  const name = isJsonString(parsed["info"]["name"]) ? parsed["info"]["name"] : file;
  const requests: ImportedRequest[] = [];

  const walk = (items: readonly JsonValue[], folder: string[]): void => {
    for (const item of items) {
      if (!isJsonObject(item)) continue;
      const itemName = isJsonString(item["name"]) ? item["name"] : "";

      if (Array.isArray(item["item"])) {
        walk(item["item"], [...folder, itemName]);
        continue;
      }

      const request = item["request"];
      // A request is an object with a method and a URL, or a URL string alone (a GET).
      const url = isJsonString(request) ? request : isJsonObject(request) ? request["url"] : undefined;
      const raw = isJsonString(url) ? url : isJsonObject(url) ? rawOf(url) : null;

      if (raw === null) continue;
      const method = isJsonObject(request) && isJsonString(request["method"]) ? request["method"].toUpperCase() : "GET";
      requests.push({ folder, name: itemName || raw, method, raw, segments: requestSegments(raw) });
    }
  };

  walk(parsed["item"], []);

  return { file, name, requests };
}

/** The URL of a request object: `raw`, else its host and path joined as `//host/path` (the host's parts dotted, a variable among them or not), so the host is no segment of the path. */
function rawOf(url: Record<string, JsonValue>): string | null {
  if (isJsonString(url["raw"])) return url["raw"];
  const host = Array.isArray(url["host"]) ? url["host"].filter(isJsonString).join(".") : isJsonString(url["host"]) ? url["host"] : "";
  const path = Array.isArray(url["path"]) ? url["path"].filter(isJsonString).join("/") : isJsonString(url["path"]) ? url["path"] : "";

  if (!host && !path) return null;

  return host === "" ? `/${path}` : `//${host}/${path}`;
}

/**
 * The path of a request URL as segments, a variable as `*`: the query dropped, the scheme and host (or the `{{baseUrl}}`
 * variable standing for them) dropped, `{{basketId}}`, `:basketId` and `{basketId}` read as any value.
 */
export function requestSegments(raw: string): string[] {
  let path = raw.split(/[?#]/)[0]!.trim();
  // A host variable: `{{baseUrl}}/checkout/…`, `{{host}}/…`; a scheme and host, or a host alone after `//`: `https://x.y/…`, `//x.y/…`.
  path = path.replace(/^\{\{[^}]*\}\}/, "").replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*/i, "");

  return path.split("/").filter((segment) => segment !== "").map((segment) => (/^(\{\{[^}]*\}\}|:[\w-]+|\{[^}]*\})$/.test(segment) ? "*" : segment));
}

/** The segments of an operation's path template, a `{parameter}` as `*`. */
export function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "").map((segment) => (/^\{[^}]*\}$/.test(segment) ? "*" : segment));
}

/**
 * How well two routes match: null when they differ (the method, the number of segments, or a segment written
 * differently on both sides); else the number of segments that agree outright — equal literals, or a wildcard on both
 * sides. A wildcard against a literal matches but counts nothing, so `GET …/orders/{orderNo}` prefers the request
 * written with a variable there over `GET …/orders/oms-meta-data`, which its own route takes whole.
 */
export function routeMatch(method: string, segments: readonly string[], otherMethod: string, otherSegments: readonly string[]): number | null {
  if (method.toUpperCase() !== otherMethod.toUpperCase() || segments.length !== otherSegments.length) return null;
  let score = 0;

  for (const [i, segment] of segments.entries()) {
    const other = otherSegments[i]!;

    if (segment === other) score++;
    else if (segment !== "*" && other !== "*") return null;
  }

  return score;
}

/** An operation the code calls with its route: the method and the path's segments, a parameter as `*`. */
export interface Route {
  operation: ApiOperation;
  method: string;
  segments: string[];
}

/** The routes of the operations the code calls, by operation id, in the order of the calls: null for an operation the table does not know. */
export function routesOf(calls: readonly ApiOperation[], table: ScapiTable): Map<string, Route | null> {
  const routes = new Map<string, Route | null>();

  for (const call of calls) {
    const operation = operationId(call);

    if (routes.has(operation)) continue;
    const known = operationPath(table, call);
    routes.set(operation, known ? { operation: call, method: known.method, segments: pathSegments(known.path) } : null);
  }

  return routes;
}

/** A request of a collection against the routes: the route that agrees with it most, or null when the code calls nothing of its kind. */
export interface RequestMatch {
  collection: ImportedCollection;
  /** The request's position in its collection, which names its shape. */
  index: number;
  request: ImportedRequest;
  hit: { operation: string; route: Route } | null;
}

/**
 * The requests of the collections matched to the routes the code calls, in the collections' order: each with the
 * route that agrees with it most (`routeMatch`), and the operations no request matched — those the collection
 * lacks, in the order of the routes.
 */
export function matchRequests(collections: readonly ImportedCollection[], routes: ReadonlyMap<string, Route | null>): { requests: RequestMatch[]; unmatched: string[] } {
  const requests: RequestMatch[] = [];
  const matched = new Set<string>();

  for (const collection of collections) {
    for (const [index, request] of collection.requests.entries()) {
      // The route that agrees with the request most: a literal against a literal, a variable against a variable.
      let hit: RequestMatch["hit"] = null;
      let best = -1;

      for (const [operation, route] of routes) {
        const score = route === null ? null : routeMatch(request.method, request.segments, route.method, route.segments);

        if (route !== null && score !== null && score > best) {
          best = score;
          hit = { operation, route };
        }
      }

      if (hit) matched.add(hit.operation);
      requests.push({ collection, index, request, hit });
    }
  }

  return { requests, unmatched: [...routes.keys()].filter((operation) => !matched.has(operation)) };
}
