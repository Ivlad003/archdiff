// One analysis of a repository: list the files, extract the facts of each
// (from the cache when the content is unchanged), build the graph. The
// only I/O of the pipeline besides the server: reading sources and the
// cache. `overrides` lets a caller analyse another revision without a
// checkout: the content of changed files at that revision, null for files
// it does not have (`review`, diff.ts), the revision's ARCHITECTURE.md
// among them.
//
// Pipeline: root → Config + files → FileFacts (cache | extractTs) → Graph.
// Entry points: `analyze`, `Analysis`, `AnalysisStats`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash, FactCache } from "./cache.ts";
import { loadConfig, type Config } from "./config.ts";
import type { FileFacts } from "./extract/facts.ts";
import { INTENT_FILE, parseIntent, readIntent, withIntentLayers, type Intent } from "./intent.ts";
import { extractAll } from "./extract/pool.ts";
import { isSourceFile, listAllFiles, listSourceFiles, type SkippedFile } from "./files.ts";
import { frameworkEntries, repositoryPackages, type DeclaredEntry, type RepositoryPackage } from "./frameworks.ts";
import { buildGraph, type Graph } from "./graph.ts";
import { createResolver, tsconfigResolver } from "./resolve.ts";

export interface AnalysisStats {
  files: number;
  modules: number;
  fns: number;
  classes: number;
  types: number;
  deps: number;
  calls: number;
  gaps: number;
  unresolvedImports: number;
  cacheHits: number;
  cacheMisses: number;
  /** Milliseconds: listing, extraction, graph. */
  ms: { list: number; extract: number; graph: number; total: number };
}

export interface Analysis {
  root: string;
  config: Config;
  files: string[];
  /** Source files left out (too large), with the reason. */
  skipped: SkippedFile[];
  facts: Map<string, FileFacts>;
  graph: Graph;
  /** What the frameworks of the repository call (routes, hooks). */
  declaredEntries: DeclaredEntry[];
  /** The packages of the repository (package.json files), for the packages view. */
  packages: RepositoryPackage[];
  /** The intended architecture (ARCHITECTURE.md), null without the file. */
  intent: Intent | null;
  stats: AnalysisStats;
}

export interface AnalyzeOptions {
  /** Read and write the fact cache (`.archdiff/facts.json.gz`, and `revisions.json.gz` for other revisions' files); default true. */
  cache?: boolean;
  /** Content of files at another revision: a string replaces the disk, null drops the file; a path not on disk is added when a string. */
  overrides?: ReadonlyMap<string, string | null>;
  /** A config to use instead of the repository's. */
  config?: Config;
}

/** The facts of the jobs, parsed in parallel; on one thread when worker threads are refused (a sandbox, a memory limit). */
async function extractEvery(jobs: readonly { path: string; content: string }[]): Promise<FileFacts[]> {
  try {
    return await extractAll(jobs);
  } catch (error) {
    process.stderr.write(`archdiff: parallel extraction failed (${error instanceof Error ? error.message : String(error)}); parsing on one thread\n`);

    return extractAll(jobs, 1);
  }
}

/**
 * Parses, in one parallel batch, the files of several revisions (overrides as `analyze` takes them: a history's
 * commits) the cache does not hold yet: each analysis that follows finds its files cached, where alone it would parse
 * its few changed files on one thread.
 */
export async function prepareRevisions(root: string, revisions: readonly ReadonlyMap<string, string | null>[]): Promise<void> {
  const cache = FactCache.of(root);
  const jobs = new Map<string, { path: string; content: string; hash: string }>();

  for (const revision of revisions) {
    for (const [path, content] of revision) {
      if (content === null || !isSourceFile(path)) continue;
      const hash = contentHash(content);

      if (!jobs.has(`${path}\0${hash}`) && cache.lookup(path, hash, true) === null) jobs.set(`${path}\0${hash}`, { path, content, hash });
    }
  }

  const list = [...jobs.values()];
  const fresh = await extractEvery(list);

  for (let i = 0; i < list.length; i++) cache.store(list[i]!.path, list[i]!.hash, fresh[i]!, true);
}

/** Analyses the repository at `root`. */
export async function analyze(root: string, options: AnalyzeOptions = {}): Promise<Analysis> {
  const started = performance.now();
  const overrides = options.overrides ?? new Map<string, string | null>();
  // ARCHITECTURE.md is read first — the revision's, when the overrides carry it: a review's or a comparison's head is
  // held to its own contract. Without layers of its own, archdiff.json takes the contract's.
  const contract = overrides.get(INTENT_FILE);
  const intent = !overrides.has(INTENT_FILE) ? readIntent(root) : contract ? parseIntent(contract) : null;
  const config = withIntentLayers(options.config ?? loadConfig(root), intent);
  const listed0 = listSourceFiles(root, config.exclude);
  const files = [...new Set([...listed0.files, ...[...overrides.keys()].filter((path) => path !== INTENT_FILE && overrides.get(path) !== null)])].filter((path) => overrides.get(path) !== null).sort();
  const listed = performance.now();
  // One cache per repository and process: the analyses of a history or a comparison share what each extracts.
  const cache = options.cache === false ? null : FactCache.of(root);
  const facts = new Map<string, FileFacts>();
  const jobs: { path: string; content: string; hash: string; revision: boolean }[] = [];

  // Cache hits first; the misses go to the extractors together, in parallel. A file the overrides give is another
  // revision's, cached apart from the working tree's.
  for (const path of files) {
    const override = overrides.get(path);
    const content = override ?? readFileSync(join(root, path), "utf8");
    const hash = contentHash(content);
    const cached = cache?.lookup(path, hash, override !== undefined) ?? null;

    if (cached) facts.set(path, cached);
    else jobs.push({ path, content, hash, revision: override !== undefined });
  }

  const fresh = await extractEvery(jobs);

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!;
    facts.set(job.path, fresh[i]!);
    cache?.store(job.path, job.hash, fresh[i]!, job.revision);
  }

  // A file too large to parse is still a module of the repository: imports of it resolve, its own content stays unknown (opaque).
  for (const skipped of listed0.skipped) {
    if (overrides.get(skipped.path) === null || facts.has(skipped.path)) continue;
    facts.set(skipped.path, { path: skipped.path, endLine: 1, endCol: 1, imports: [], decls: [], exports: new Set(), reexportsAll: [], exportRows: [], unsupported: [], valueRefs: [], moduleCalls: [], completeness: "opaque", parseError: null });
  }

  const extracted = performance.now();
  // An analysis of the working tree looked every file up: what it did not is gone.
  cache?.save(overrides.size === 0);
  const allFiles = listAllFiles(root);
  // The packages of a monorepo first: an import of one by its name is an import of its source, not of a package.
  const packages = repositoryPackages(root, allFiles);
  // One reading of the tsconfigs for both: the paths to resolve, and whether `import { type A }` stays in the code.
  const tsconfigOf = tsconfigResolver(root, [...facts.keys()]);
  const graph = buildGraph([...facts.values()], config, createResolver(root, [...facts.keys()], [...facts.values()], tsconfigOf, packages), (file) => tsconfigOf(file)?.verbatimModuleSyntax === true);
  const declaredEntries = frameworkEntries(root, files, allFiles);
  const built = performance.now();
  const kinds = [...graph.nodes.values()].reduce((counts, node) => ({ ...counts, [node.kind]: (counts[node.kind] ?? 0) + 1 }), {} as Record<string, number>);
  const stats: AnalysisStats = {
    files: files.length,
    modules: graph.modules.size,
    fns: kinds["fn"] ?? 0,
    classes: kinds["class"] ?? 0,
    types: kinds["type"] ?? 0,
    deps: graph.deps.length,
    calls: graph.calls.length,
    gaps: graph.gaps.length,
    unresolvedImports: graph.unresolvedImports.length,
    cacheHits: cache ? files.length - jobs.length : 0,
    cacheMisses: cache ? jobs.length : files.length,
    ms: { list: Math.round(listed - started), extract: Math.round(extracted - listed), graph: Math.round(built - extracted), total: Math.round(built - started) },
  };

  return { root, config, files, skipped: listed0.skipped, facts, graph, declaredEntries, packages, intent, stats };
}
