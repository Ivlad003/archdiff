// Swaps bin/archdiff.js for the published package: the checkout imports
// src/cli.ts (Node strips its types), the package imports dist/cli.js.
//
// Entry point: the script itself: `publish` in prepack, `restore` in
// postpack.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = join(dirname(fileURLToPath(import.meta.url)), "../bin/archdiff.js");

const entry = (target) => `#!/usr/bin/env node
// Checkout entry. \`npm pack\` rewrites this file to import ../dist/cli.js and
// restores this copy afterwards (scripts/pack-entry.mjs).
//
// Entry point: the \`archdiff\` command of package.json's \`bin\`.
import { main } from "${target}";

// \`archdiff … | head\` closes stdout early; that is not an error.
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
  process.stderr.write(\`archdiff: cannot write the output: \${e.message}\\n\`);
  process.exit(2);
});

process.exitCode = await main(process.argv.slice(2));
`;

const mode = process.argv[2];

if (mode === "publish") writeFileSync(bin, entry("../dist/cli.js"));
else if (mode === "restore") writeFileSync(bin, entry("../src/cli.ts"));
else {
  process.stderr.write("usage: pack-entry.mjs publish|restore\n");
  process.exitCode = 2;
}
