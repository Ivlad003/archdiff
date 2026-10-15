// The fact cache: the extracted facts of every file, keyed by the SHA-256
// of its content and the extractor version, so a second run parses only
// what changed. One JSON file, `.archdiff/facts.json`, read once per run
// and written once (atomically) at the end. Sets in the facts are stored as
// arrays and revived on read.
//
// Sits around extraction: analyze.ts asks `lookup` before `extractTs` and
// `store` after. Entry points: `FactCache`, `contentHash`, `CACHE_FILE`.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FileFacts } from "./extract/facts.ts";

/** Bumped when the extractor changes what it records: every cached entry is then stale. */
export const EXTRACTOR_VERSION = 1;

export const CACHE_DIRECTORY = ".archdiff";

export const CACHE_FILE = `${CACHE_DIRECTORY}/facts.json`;

interface CacheEntry {
  hash: string;
  facts: FileFacts;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

/** The key of a file's content under the current extractor. */
export function contentHash(content: string): string {
  return createHash("sha256").update(`v${EXTRACTOR_VERSION}\0`).update(content).digest("hex");
}

/** JSON with Sets written as arrays. */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item instanceof Set ? [...item] : item));
}

/** Revives the one Set of `FileFacts` (`exports`). */
function revive(facts: FileFacts): FileFacts {
  return { ...facts, exports: new Set(facts.exports as unknown as string[]) };
}

/** The cache of one repository: what was read at the start, what the run adds. */
export class FactCache {
  private readonly file: string;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly used = new Set<string>();
  private dirty = false;
  hits = 0;
  misses = 0;

  constructor(root: string) {
    this.file = join(root, CACHE_FILE);

    if (!existsSync(this.file)) return;

    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as CacheFile;

      if (parsed.version !== EXTRACTOR_VERSION || typeof parsed.entries !== "object") return;

      for (const [path, entry] of Object.entries(parsed.entries)) this.entries.set(path, { hash: entry.hash, facts: revive(entry.facts) });
    } catch {
      // An unreadable cache is an empty one: the run extracts everything again and rewrites it.
    }
  }

  /** The cached facts of `path` for this exact content, or null. */
  lookup(path: string, hash: string): FileFacts | null {
    const entry = this.entries.get(path);

    if (entry && entry.hash === hash) {
      this.hits++;
      this.used.add(path);

      return entry.facts;
    }

    this.misses++;

    return null;
  }

  store(path: string, hash: string, facts: FileFacts): void {
    this.entries.set(path, { hash, facts });
    this.used.add(path);
    this.dirty = true;
  }

  /** Writes the cache when the run changed it, keeping only the files this run looked up. */
  save(): void {
    const stale = [...this.entries.keys()].some((path) => !this.used.has(path));

    if (!this.dirty && !stale) return;
    const entries: Record<string, CacheEntry> = {};

    for (const path of [...this.used].sort()) {
      const entry = this.entries.get(path);

      if (entry) entries[path] = entry;
    }

    const content: CacheFile = { version: EXTRACTOR_VERSION, entries };
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, stringify(content));
    renameSync(temporary, this.file);
  }
}
