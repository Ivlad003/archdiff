// Which files of a repository archdiff reads: TypeScript and JavaScript
// sources, as git lists them when the root is a repository (so .gitignore
// holds, and it is one process call), else a walk that skips the usual
// generated directories. Paths are POSIX, relative to the root, sorted.
//
// Sits at the I/O edge before extraction: root → file list → extractors.
// Entry points: `listSourceFiles`, `isSourceFile`, `SOURCE_EXTENSIONS`.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { matchesGlob } from "./glob.ts";

/** Extensions archdiff parses. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** Directories the walk never enters when git does not list the files. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".archdiff", ".next", ".cache", "out"]);

/** A source file archdiff parses: a known extension, not a declaration file. */
export function isSourceFile(path: string): boolean {
  if (/\.d\.[cm]?ts$/.test(path)) return false;

  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** Windows separators to POSIX. */
export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Tracked and untracked-but-not-ignored files as git lists them, or null outside a repository (or without git). */
function gitFiles(root: string): string[] | null {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

  if (result.error || result.status !== 0) return null;

  return result.stdout.split("\0").filter((path) => path !== "");
}

/** Every file under `root`, skipping generated directories. */
function walkFiles(root: string): string[] {
  const found: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const directory = stack.pop()!;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) stack.push(join(directory, entry.name));
      } else if (entry.isFile()) {
        found.push(toPosix(relative(root, join(directory, entry.name))));
      }
    }
  }

  return found;
}

/** Every file of `root` git lists (or the walk finds), relative POSIX paths, sorted: for manifests beside the sources (hooks.json). */
export function listAllFiles(root: string): string[] {
  return [...new Set(gitFiles(root) ?? walkFiles(root))].sort();
}

/**
 * The source files of `root`, relative POSIX paths, sorted. `exclude` is a
 * list of globs (archdiff.json). A path git lists but the disk no longer
 * has (deleted, not yet staged) is left out.
 */
export function listSourceFiles(root: string, exclude: readonly string[] = []): string[] {
  const all = gitFiles(root) ?? walkFiles(root);
  // Hidden directories (.github, .agents, .scratch) hold tooling, not the program; `exclude` cannot bring them back but archdiff.json layers may name them later.
  const kept = all.filter((path) => isSourceFile(path) && !path.startsWith(".") && !path.split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment)) && !exclude.some((glob) => matchesGlob(path, glob)));
  const present = kept.filter((path) => {
    const full = join(root, path);

    return existsSync(full) && statSync(full).isFile();
  });

  return [...new Set(present)].sort();
}
