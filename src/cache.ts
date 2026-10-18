// The fact cache: the extracted facts of every file, keyed by the SHA-256
// of its content and the extractor version, so a second run parses only
// what changed. Two gzipped JSON files under `.archdiff/`: `facts.json.gz`
// holds the working tree's files, one version each, read once per process
// and written (atomically) after an analysis that changed it;
// `revisions.json.gz` the files of other revisions a review, a history or
// a comparison read — many versions of one file, the most recently used
// kept — read when a revision is first analysed, written when the process
// ends. Sets in the facts are stored as arrays and revived on read.
//
// Sits around extraction: analyze.ts asks `lookup` before extracting and
// `store` after, of the one cache of its root (`FactCache.of`). Entry
// points: `FactCache`, `contentHash`, `CACHE_FILE`, `REVISIONS_FILE`.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { reviveFacts, type FileFacts } from "./extract/facts.ts";

/**
 * The version of the extractors: a hash of their own source files (the
 * `extract/` directory beside this module, .ts in a checkout, .js in the
 * package), read once per process. A change to any extractor — a new
 * fact, a fixed walk — makes every cached entry stale by itself; nobody
 * has to remember to bump a number (which was forgotten once, and left
 * stale syntax errors in the cache for a day).
 */
export const EXTRACTOR_VERSION: string = extractorVersion();

function extractorVersion(): string {
  const directory = join(dirname(fileURLToPath(import.meta.url)), "extract");
  const hash = createHash("sha256");

  try {
    for (const name of readdirSync(directory).filter((file) => /\.(ts|js|mjs)$/.test(file)).sort()) hash.update(name).update("\0").update(readFileSync(join(directory, name))).update("\0");
  } catch {
    // No extractor directory beside this module (an unusual bundle): a fixed version, every run then trusts the cache.
    return "unknown";
  }

  return hash.digest("hex").slice(0, 16);
}

export const CACHE_DIRECTORY = ".archdiff";

/** Gzipped JSON: the facts of a repository are tens of megabytes as text, a few as gzip. */
export const CACHE_FILE = `${CACHE_DIRECTORY}/facts.json.gz`;

interface CacheEntry {
  hash: string;
  facts: FileFacts;
}

interface CacheFile {
  version: string;
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


/** The facts of other revisions' files: many versions of a path, by path and content. */
export const REVISIONS_FILE = `${CACHE_DIRECTORY}/revisions.json.gz`;

/** Versions of other revisions' files kept, at most: the most recently used. Thousands of files, tens of commits. */
const MAX_REVISIONS = 4000;

/** One version of a file of another revision, and when it was last read (for keeping the most recent). */
interface RevisionEntry {
  path: string;
  hash: string;
  facts: FileFacts;
  used: number;
}

interface RevisionsFile {
  version: string;
  entries: RevisionEntry[];
}

/** Reads a gzipped JSON cache file of this extractor version; null when it is missing, unreadable or of another version. */
function readCacheFile<T extends { version: string }>(file: string): T | null {
  if (!existsSync(file)) return null;

  try {
    const parsed = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as T;

    return parsed.version === EXTRACTOR_VERSION ? parsed : null;
  } catch {
    // An unreadable cache is an empty one: the run extracts everything again and rewrites it.
    return null;
  }
}

/** Writes a cache file atomically: a temporary file renamed over the old one. */
function writeCacheFile(file: string, content: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, gzipSync(stringify(content), { level: 4 }));
  renameSync(temporary, file);
}

/**
 * The cache of one repository, one per process (`FactCache.of`): what was read at the start, what the analyses add.
 * The working tree's facts are written after each analysis that changed them; the revisions' when the process ends.
 */
export class FactCache {
  private static readonly open = new Map<string, FactCache>();

  /** The cache of the repository at `root`, the same for every analysis of the process: a history's commits share it. */
  static of(root: string): FactCache {
    const known = FactCache.open.get(root);

    if (known) return known;
    const made = new FactCache(root);
    FactCache.open.set(root, made);

    return made;
  }

  private readonly root: string;
  private readonly file: string;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly used = new Set<string>();
  private dirty = false;
  /** Other revisions' versions by path and hash; read on the first lookup of one. */
  private revisions: Map<string, RevisionEntry> | null = null;
  private revisionsDirty = false;

  private constructor(root: string) {
    this.root = root;
    this.file = join(root, CACHE_FILE);
    const parsed = readCacheFile<CacheFile>(this.file);

    if (!parsed || typeof parsed.entries !== "object") return;

    for (const [path, entry] of Object.entries(parsed.entries)) this.entries.set(path, { hash: entry.hash, facts: reviveFacts(entry.facts) });
  }

  /** The cached facts of `path` for this exact content, or null; `revision`: the content is another revision's. */
  lookup(path: string, hash: string, revision = false): FileFacts | null {
    // The working tree's version serves a revision whose file is the same; only a revision reads the revisions' file.
    const entry = this.entries.get(path);

    if (entry && entry.hash === hash) {
      if (!revision) this.used.add(path);

      return entry.facts;
    }

    if (!revision) return null;
    const version = this.revisionsRead().get(`${path}\0${hash}`);

    if (!version) return null;
    version.used = Date.now();
    this.revisionsDirty = true;

    return version.facts;
  }

  /** Keeps the facts of `path` at this content: the working tree's version, or (`revision`) one of another revision. */
  store(path: string, hash: string, facts: FileFacts, revision = false): void {
    if (!revision) {
      this.entries.set(path, { hash, facts });
      this.used.add(path);
      this.dirty = true;

      return;
    }

    this.revisionsRead().set(`${path}\0${hash}`, { path, hash, facts, used: Date.now() });
    this.revisionsDirty = true;
  }

  /**
   * Writes the working tree's cache when an analysis changed it; `prune` (after an analysis of the working tree, which
   * looked every file up) drops the files the process never looked up — deleted ones.
   */
  save(prune: boolean): void {
    const stale = prune && [...this.entries.keys()].some((path) => !this.used.has(path));

    if (!this.dirty && !stale) return;
    const entries: Record<string, CacheEntry> = {};

    for (const path of (prune ? [...this.used] : [...this.entries.keys()]).sort()) {
      const entry = this.entries.get(path);

      if (entry) entries[path] = entry;
    }

    writeCacheFile(this.file, { version: EXTRACTOR_VERSION, entries } satisfies CacheFile);
    this.dirty = false;
    // The uncompressed cache of an earlier version, when it is still there.
    const old = this.file.replace(/\.gz$/, "");

    if (existsSync(old)) rmSync(old, { force: true });
  }

  /** The revisions' versions, read from their file the first time; their writing is arranged for the end of the process. */
  private revisionsRead(): Map<string, RevisionEntry> {
    if (this.revisions) return this.revisions;
    this.revisions = new Map();
    const parsed = readCacheFile<RevisionsFile>(join(this.root, REVISIONS_FILE));

    for (const entry of Array.isArray(parsed?.entries) ? parsed.entries : []) this.revisions.set(`${entry.path}\0${entry.hash}`, { ...entry, facts: reviveFacts(entry.facts) });
    // Written once, when the process ends: a history's tens of analyses add to it in turn.
    process.once("exit", () => this.saveRevisions());

    return this.revisions;
  }

  /** Writes the revisions' versions when they changed, the most recently used first, `MAX_REVISIONS` at most. */
  saveRevisions(): void {
    // A repository gone (a test's temporary directory) gets no cache back.
    if (!this.revisions || !this.revisionsDirty || !existsSync(this.root)) return;
    const entries = [...this.revisions.values()].sort((a, b) => b.used - a.used).slice(0, MAX_REVISIONS);

    try {
      writeCacheFile(join(this.root, REVISIONS_FILE), { version: EXTRACTOR_VERSION, entries } satisfies RevisionsFile);
      this.revisionsDirty = false;
    } catch {
      // A cache that cannot be written (a read-only checkout) is only a slower next run.
    }
  }
}
