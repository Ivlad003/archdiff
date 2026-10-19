// Regenerates src/scapi-table.ts from the storefront-next runtime's type declarations: the SCAPI families with
// their base paths and operations (method, path template), which the Postman export needs when a repository has
// no runtime in its node_modules to read them from.
//
//   node scripts/scapi-table.mjs <path/to/node_modules/@salesforce/storefront-next-runtime>
//
// Reads dist/scapi.d.ts and package.json of that directory; writes src/scapi-table.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scapiTableFromDts } from "../src/scapi-runtime.ts";

const directory = resolve(process.argv[2] ?? "node_modules/@salesforce/storefront-next-runtime");
const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
const version = manifest !== null && typeof manifest === "object" && typeof manifest.version === "string" ? manifest.version : null;

if (version === null) {
  console.error(`${join(directory, "package.json")}: no "version" string`);
  process.exit(2);
}

const table = scapiTableFromDts(readFileSync(join(directory, "dist", "scapi.d.ts"), "utf8"));
const count = Object.values(table).reduce((sum, family) => sum + Object.keys(family.operations).length, 0);

if (count === 0) {
  console.error(`no operations read from ${directory}`);
  process.exit(2);
}

const lines = [
  "// The SCAPI families the storefront-next runtime's clients serve, each with its base path and operations (method and",
  `// path template), read from @salesforce/storefront-next-runtime ${version} (dist/scapi.d.ts) by scripts/scapi-table.mjs.`,
  "// apis.ts reads the runtime a repository installed first; this table stands in when there is none. Do not edit by hand.",
  "",
  'import type { ScapiTable } from "./apis.ts";',
  "",
  `export const SCAPI_TABLE_VERSION = ${JSON.stringify(version)};`,
  "",
  `export const SCAPI_TABLE: ScapiTable = ${JSON.stringify(table, null, 2)};`,
  "",
];
writeFileSync(resolve(import.meta.dirname, "../src/scapi-table.ts"), lines.join("\n"));
console.log(`src/scapi-table.ts: ${Object.keys(table).length} families, ${count} operations from ${version}`);
