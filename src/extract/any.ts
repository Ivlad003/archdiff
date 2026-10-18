// One extractor for every language archdiff reads: the file's extension
// picks the frontend (TypeScript/JavaScript, Python, Rust, PHP), all of
// which produce the same `FileFacts`.
//
// Entry point: `extractAny` (pool.ts and its workers).

import type { FileFacts } from "./facts.ts";
import { languageOf } from "../languages.ts";
import { extractPhp } from "./php.ts";
import { extractPython } from "./python.ts";
import { extractRust } from "./rust.ts";
import { extractTs } from "./ts.ts";

/** The facts of `src` at `path`, by the language its extension names; an unknown extension is read as JavaScript. */
export function extractAny(path: string, src: string): Promise<FileFacts> {
  switch (languageOf(path)) {
    case "python":
      return extractPython(path, src);
    case "rust":
      return extractRust(path, src);
    case "php":
      return extractPhp(path, src);
    default:
      return extractTs(path, src);
  }
}
