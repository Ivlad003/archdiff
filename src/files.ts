// Which files of a repository archdiff reads: TypeScript, JavaScript,
// Python, Rust and PHP sources, as git lists them when the root is a repository (so .gitignore
// holds, and it is one process call), else a walk that skips the usual
// generated directories. Paths are POSIX, relative to the root, sorted.
//
// Sits at the I/O edge before extraction: root → file list → extractors.
// Entry points: `listSourceFiles`, `isSourceFile`, `SOURCE_EXTENSIONS`.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { matchesGlob } from "./glob.ts";
import { LANGUAGES } from "./languages.ts";

/** Extensions archdiff parses: every language of `LANGUAGES`. */
export const SOURCE_EXTENSIONS: readonly string[] = Object.values(LANGUAGES).flatMap((language) => language.extensions);

/** A file larger than this (a vendored bundle, generated code) is not parsed: it would cost seconds and tell nothing about the architecture. */
export const MAX_FILE_BYTES = 1_500_000;

/** A source file left out of the analysis, and why: the coverage report names it. */
export interface SkippedFile {
  path: string;
  reason: string;
}

/** Directories the walk never enters when git does not list the files. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".archdiff", ".next", ".cache", "out"]);

/** A source file archdiff parses: a known extension (a `.d.ts` declaration file too: types and their imports live there). */
export function isSourceFile(path: string): boolean {
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

/** Every file under `root`, skipping generated directories; a symbolic link is followed to a file or a directory, each directory once. */
function walkFiles(root: string): string[] {
  const found: string[] = [];
  const stack = [root];
  const seen = new Set<string>();

  const enter = (directory: string): void => {
    let real: string;

    try {
      real = realpathSync(directory);
    } catch {
      return;
    }

    // A link to a directory already walked, or to a parent of one (a link back up the tree), is not walked again.
    if (seen.has(real) || [...seen].some((known) => known.startsWith(`${real}/`))) return;
    seen.add(real);
    stack.push(directory);
  };

  enter(root);

  while (stack.length > 0) {
    const directory = stack.pop()!;

    // Real entries before links, so a directory is walked under its own path and a link to it is the duplicate left out.
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => Number(a.isSymbolicLink()) - Number(b.isSymbolicLink()) || (a.name < b.name ? -1 : 1));

    for (const entry of entries) {
      const full = join(directory, entry.name);
      let kind: "directory" | "file" | null = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null;

      if (entry.isSymbolicLink()) {
        try {
          const stat = statSync(full);
          kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
        } catch {
          kind = null;
        }
      }

      if (kind === "directory") {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) enter(full);
      } else if (kind === "file") {
        found.push(toPosix(relative(root, full)));
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
export function listSourceFiles(root: string, exclude: readonly string[] = []): { files: string[]; skipped: SkippedFile[] } {
  const all = gitFiles(root) ?? walkFiles(root);
  // Hidden directories (.github, .agents, .scratch) hold tooling, not the program; `exclude` cannot bring them back but archdiff.json layers may name them later.
  const kept = all.filter((path) => isSourceFile(path) && !path.startsWith(".") && !path.split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment)) && !exclude.some((glob) => matchesGlob(path, glob)));
  const files: string[] = [];
  const skipped: SkippedFile[] = [];

  for (const path of new Set(kept)) {
    const full = join(root, path);

    if (!existsSync(full)) continue;
    const stat = statSync(full);

    if (!stat.isFile()) continue;

    if (stat.size > MAX_FILE_BYTES) skipped.push({ path, reason: `${(stat.size / 1_000_000).toFixed(1)} MB, over the ${MAX_FILE_BYTES / 1_000_000} MB limit` });
    else files.push(path);
  }

  return { files: files.sort(), skipped: skipped.sort((a, b) => (a.path < b.path ? -1 : 1)) };
}
