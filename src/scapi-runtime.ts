// The SCAPI table a repository works against: the families' base paths and
// operations (method, path template) read from the storefront-next runtime
// it installed — its `scapi.d.ts` in node_modules (1.7 MB, read once per
// analysis), so a newer runtime brings its own operations — else the table
// archdiff ships (scapi-table.ts, which scripts/scapi-table.mjs regenerates
// with the same reader).
//
// Sits in the core beside the analysis, which carries the table to the graph
// (which families an operation may belong to), the views and the exports.
//
// Entry points: `scapiTable`, `scapiTableFromDts`, `operationPath`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiOperation, ScapiFamilySpec, ScapiTable } from "./apis.ts";
import { SCAPI_TABLE, SCAPI_TABLE_VERSION } from "./scapi-table.ts";

/** Where the runtime a repository installed keeps its SCAPI declarations. */
const RUNTIME_DTS = "node_modules/@salesforce/storefront-next-runtime/dist/scapi.d.ts";

export interface ScapiSource {
  table: ScapiTable;
  /** Where the table came from, for a report: the runtime in node_modules, or archdiff's own. */
  source: string;
}

/** The SCAPI table of the runtime the repository installed, else the table archdiff ships. */
export function scapiTable(root: string): ScapiSource {
  const file = join(root, RUNTIME_DTS);

  if (existsSync(file)) {
    const table = scapiTableFromDts(readFileSync(file, "utf8"));

    if (Object.keys(table).length > 0) return { table, source: `the runtime installed in node_modules (${RUNTIME_DTS})` };
  }

  return { table: SCAPI_TABLE, source: `archdiff's table of @salesforce/storefront-next-runtime ${SCAPI_TABLE_VERSION}` };
}

/**
 * The SCAPI table read from the runtime's `scapi.d.ts` (openapi-typescript output): `BUILT_IN_CLIENT_DEFAULTS` gives each
 * client key its base path, the clients record binds a family's `endpoints` to its `operations$N` table, and each table
 * lists an operation's method, base and suffix. Empty when the text holds none of these.
 */
export function scapiTableFromDts(text: string): ScapiTable {
  const defaults = /declare const BUILT_IN_CLIENT_DEFAULTS: \{([\s\S]*?)\n\};/.exec(text)?.[1] ?? "";
  const bases = new Map<string, string>();

  for (const match of defaults.matchAll(/readonly (\w+): \{\s*readonly basePath: "([^"]+)";/g)) bases.set(match[1]!, match[2]!);
  const tables = new Map<string, string>();

  for (const match of text.matchAll(/declare const (operations\$\d+): \{([\s\S]*?)\n\};/g)) tables.set(match[1]!, match[2]!);
  const families: ScapiTable = {};

  for (const match of text.matchAll(/(\w+): ProxyClient<Client<(\w+)\.endpoints>, typeof (operations\$\d+)>;/g)) {
    const [, key, family, table] = match;
    const basePath = bases.get(key!);
    const body = tables.get(table!);

    if (!basePath || body === undefined) continue;
    const operations: ScapiFamilySpec["operations"] = {};

    for (const op of body.matchAll(/readonly (\w+): \{\s*readonly m: "(\w+)";\s*readonly b: "([^"]*)";\s*readonly s: "([^"]*)";/g)) operations[op[1]!] = { method: op[2]!, path: op[3]! + op[4]! };
    families[family!] = { basePath, operations };
  }

  return families;
}


/** The method and full path template of an operation (`GET /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}`), or null when the table lacks it. */
export function operationPath(table: ScapiTable, operation: ApiOperation): { method: string; path: string } | null {
  const family = table[operation.family];
  const known = family?.operations[operation.operation];

  return family && known ? { method: known.method, path: `${family.basePath}${known.path}` } : null;
}
