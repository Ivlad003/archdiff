// The SCAPI table a repository works against: the families' base paths and
// operations (method, path template) read from the storefront-next runtime
// it installed — its `scapi.d.ts` in node_modules, so a newer runtime brings
// its own operations — else the table archdiff ships (scapi-table.ts). Read
// once per file version: the declarations are 1.7 MB.
//
// Sits in the core beside the analysis, which carries the table to the views
// and the exports (the Postman collection, a collection against the code).
//
// Entry points: `scapiTable`, `operationPath`.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scapiTableFromDts, type ApiOperation, type ScapiTable } from "./apis.ts";
import { SCAPI_TABLE, SCAPI_TABLE_VERSION } from "./scapi-table.ts";

/** Where the runtime a repository installed keeps its SCAPI declarations. */
const RUNTIME_DTS = "node_modules/@salesforce/storefront-next-runtime/dist/scapi.d.ts";

export interface ScapiSource {
  table: ScapiTable;
  /** Where the table came from, for a report: the runtime in node_modules, or archdiff's own. */
  source: string;
}

/** The last reading of a repository's runtime, by the file's size and mtime. */
const readings = new Map<string, { stamp: string; read: ScapiSource }>();

/** The SCAPI table of the runtime the repository installed, else the table archdiff ships. */
export function scapiTable(root: string): ScapiSource {
  const file = join(root, RUNTIME_DTS);

  if (existsSync(file)) {
    const stat = statSync(file);
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    const known = readings.get(file);

    if (known && known.stamp === stamp) return known.read;
    const table = scapiTableFromDts(readFileSync(file, "utf8"));

    if (Object.keys(table).length > 0) {
      const read = { table, source: `the runtime installed in node_modules (${RUNTIME_DTS})` };
      readings.set(file, { stamp, read });

      return read;
    }
  }

  return { table: SCAPI_TABLE, source: `archdiff's table of @salesforce/storefront-next-runtime ${SCAPI_TABLE_VERSION}` };
}

/** The method and full path template of an operation (`GET /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}`), or null when the table lacks it. */
export function operationPath(table: ScapiTable, operation: ApiOperation): { method: string; path: string } | null {
  const family = table[operation.family];
  const known = family?.operations[operation.operation];

  return family && known ? { method: known.method, path: `${family.basePath}${known.path}` } : null;
}
