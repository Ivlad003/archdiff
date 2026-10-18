// Copies the grammar WASM files into dist/wasm so the published package can
// parse without relying on the layout of @vscode/tree-sitter-wasm, which is
// a devDependency. The list is the runtime's own (`src/extract/grammars.ts`).
//
// Entry point: the script itself, run by prepack.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAMMARS, wasmFile } from "../src/extract/grammars.ts";

const require = createRequire(import.meta.url);

const manifest = require.resolve("@vscode/tree-sitter-wasm/package.json");

const from = join(dirname(manifest), "wasm");

const to = join(dirname(fileURLToPath(import.meta.url)), "../dist/wasm");

mkdirSync(to, { recursive: true });

for (const grammar of GRAMMARS) cpSync(join(from, wasmFile(grammar)), join(to, wasmFile(grammar)));

const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));

writeFileSync(join(to, "grammars.json"), `${JSON.stringify({ package: name, version }, null, 2)}\n`);
