#!/usr/bin/env node
// Checkout entry. `npm pack` rewrites this file to import ../dist/cli.js and
// restores this copy afterwards (scripts/pack-entry.mjs).
//
// Entry point: the `archdiff` command of package.json's `bin`.
import { main } from "../src/cli.ts";

// `archdiff … | head` closes stdout early; that is not an error.
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
  process.stderr.write(`archdiff: cannot write the output: ${e.message}\n`);
  process.exit(2);
});

process.exitCode = await main(process.argv.slice(2));
