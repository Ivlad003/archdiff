// Postman collections of the repository, read for the picture of one against
// the code: every `*.postman_collection.json` git lists (and the files
// archdiff.json's `postman` names), each request with its method and the
// path as written, the variables of the path (`{{basketId}}`, `:id`, `{id}`)
// read as wildcards so a request matches the operation the code calls by
// method and path. A collection written by `archdiff postman` matches whole.
//
// Sits in the core beside the analysis, which reads the collections once;
// the `postman` view and its Markdown match them against the operations.
//
// Entry points: `readCollections`, `requestSegments`, `pathSegments`,
// `routeMatch`, `COLLECTION_SUFFIX`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, isJsonString, parseJson, type JsonValue } from "./json.ts";

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

/** Every collection of the repository: the files named like a Postman export, and the ones configured; a file that is no collection is left out. */
export function readCollections(root: string, allFiles: readonly string[], configured: readonly string[]): ImportedCollection[] {
  const files = [...new Set([...allFiles.filter((path) => path.endsWith(COLLECTION_SUFFIX) && !path.includes("node_modules/")), ...configured])].sort();
  const collections: ImportedCollection[] = [];

  for (const file of files) {
    let parsed: JsonValue;

    try {
      parsed = parseJson(readFileSync(join(root, file), "utf8"));
    } catch {
      continue;
    }

    const collection = collectionOf(parsed, file);

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

/** The URL of a request object: `raw`, else its host and path joined. */
function rawOf(url: Record<string, JsonValue>): string | null {
  if (isJsonString(url["raw"])) return url["raw"];
  const host = Array.isArray(url["host"]) ? url["host"].filter(isJsonString).join(".") : isJsonString(url["host"]) ? url["host"] : "";
  const path = Array.isArray(url["path"]) ? url["path"].filter(isJsonString).join("/") : isJsonString(url["path"]) ? url["path"] : "";

  return host || path ? `${host}/${path}` : null;
}

/**
 * The path of a request URL as segments, a variable as `*`: the query dropped, the scheme and host (or the `{{baseUrl}}`
 * variable standing for them) dropped, `{{basketId}}`, `:basketId` and `{basketId}` read as any value.
 */
export function requestSegments(raw: string): string[] {
  let path = raw.split(/[?#]/)[0]!.trim();
  // A host variable: `{{baseUrl}}/checkout/…`, `{{host}}/…`; a scheme and host: `https://x.y/…`.
  path = path.replace(/^\{\{[^}]*\}\}/, "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");

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
