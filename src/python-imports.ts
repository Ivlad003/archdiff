// Python dotted path → file. `.m.x` starts at the importing file's package
// (one dot per level), `a.b.x` at a source root (the repository root, then
// `src/`). A module is `p.py` or the package `p/__init__.py`; the longest
// prefix of the path that is a module names the file, and when that is the
// whole path the import binds the module itself. The last segment is the
// imported name (`from m import x` is `m.x`), so the prefix is never shorter
// than the module the statement names: `from .missing import x` of a module
// that does not exist is unresolved, not a name of the package above it. In
// `m.*` (`from m import *`) the module is `m` itself. A top-level name found in
// no source root is the standard library when `sys.stdlib_module_names` lists
// it, else a package: Python has no path aliases, so a name that is not in the
// repository comes from the environment.
//
// Part of source → FileFacts: the Python frontend asks `PythonResolver.resolve`
// for every import, and the `Resolution` kind (internal, local, stdlib,
// external, generated, unresolved) decides whether the graph gets an edge.

import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, posix } from "node:path";
import type { Resolution, SourceResolver } from "./imports.ts";
import { exactExistence, nodeFs, type ExactFs } from "./exact-path.ts";
import { isPythonStdlib } from "./python-stdlib.ts";

// Source roots for absolute imports, tried in order: the repository root wins.
const ROOTS = ["", "src"];

/** Resolves Python import specs (`a.b.x`, `..m.x`, `m.*`) to repository files or to stdlib/external packages. */
export class PythonResolver implements SourceResolver {
  private readonly root: string;
  private readonly roots: string[];
  /** Files of the analysis (unsaved buffers included) and their directories: they exist for resolution, on disk or not. */
  private readonly sources: ReadonlySet<string>;
  private readonly sourceDirs: ReadonlySet<string>;
  /** Directories above a `.py` source. */
  private readonly pythonDirs: ReadonlySet<string>;
  /** The resolver reads no configuration files: edges depend only on the indexed sources. */
  readonly inputs = new Map<string, string | null>();
  /** A file on disk, spelled exactly so: `existsSync` alone finds `User.py` through `user.py` on APFS and NTFS. */
  private readonly onDisk: (file: string) => boolean;

  constructor(root: string, sources: ReadonlySet<string> = new Set(), fs: ExactFs = nodeFs) {
    this.root = root;
    this.sources = sources;
    this.onDisk = exactExistence(root, fs);
    this.sourceDirs = directoriesOf(sources);
    this.pythonDirs = directoriesOf(new Set([...sources].filter((file) => file.endsWith(".py"))));
    // `src/` counts as a root only when the repository has it.
    this.roots = ROOTS.filter((dir) => dir === "" || this.isDir(dir));
  }

  resolve(fromFile: string, spec: string): Resolution {
    // Split the spec into its leading dots (relative depth) and dotted segments.
    const dots = /^\.*/.exec(spec)![0].length;
    const segments = spec.slice(dots).split(".").filter((s) => s !== "");
    // `m.*`: every public name of `m`, which must be a module itself.
    const glob = segments.at(-1) === "*";

    if (glob) segments.pop();

    // Relative import: one dot is the importing file's package, each extra dot
    // climbs one directory; climbing above the repository root is unresolved.
    if (dots > 0) {
      let base = posix.dirname(fromFile);

      for (let i = 1; i < dots; i++) {
        if (base === ".") return { kind: "unresolved" };
        base = posix.dirname(base);
      }

      // `from . import x`: the package itself may be the module that has `x`.
      return this.longest(base === "." ? "" : base, segments, fromFile, glob ? segments.length : Math.max(0, segments.length - 1)) ?? { kind: "unresolved" };
    }

    // Absolute import: the first root whose top-level segment is Python code
    // owns the import; later roots are not tried once one claims it.
    for (const root of this.roots) {
      const head = posix.join(root, segments[0]!);
      // A directory is a package only with Python code in it (a PEP 420 namespace package
      // without `__init__.py` too); `redis/` with a Dockerfile hides neither pip's `redis` nor `src/redis`.
      const isModule = this.moduleFile(head) !== null;

      if (!isModule && !this.hasPython(head)) continue;
      // A source root is no module of an absolute import.
      const found = this.longest(root, segments, fromFile, glob ? segments.length : Math.max(1, segments.length - 1));

      if (found) return found;

      // `import nsp` binding the namespace package of `import nsp.inner.mod`: no module, so no edge, but no hole either.
      if (!isModule && !glob && segments.length === 1) return { kind: "generated" };

      return { kind: "unresolved" };
    }

    // Not in the repository: stdlib by name, else an installed package.
    return isPythonStdlib(segments[0]!) ? { kind: "stdlib" } : { kind: "external", pkg: segments[0]! };
  }

  /** The longest prefix of `segments` of at least `least` segments under `base` that is a module. */
  private longest(base: string, segments: string[], fromFile: string, least: number): Resolution | null {
    // Try the longest prefix first, so `a.b.c` prefers module `a/b/c.py` over
    // name `c` of `a/b.py`; an empty prefix at the repository root is no module.
    for (let k = segments.length; k >= least; k--) {
      if (k === 0 && base === "") return null;
      const file = this.moduleFile(posix.join(base, ...segments.slice(0, k)));

      if (file === null) continue;

      // An import of the file itself is a local reference, not an edge.
      if (file === fromFile) return { kind: "local" };

      return k === segments.length ? { kind: "internal", file, whole: true } : { kind: "internal", file };
    }

    return null;
  }

  /** `a/b.py`, else the package `a/b/__init__.py`; null for neither. */
  private moduleFile(path: string): string | null {
    for (const file of [`${path}.py`, posix.join(path, "__init__.py")]) if (this.sources.has(file) || this.onDisk(file)) return file;

    return null;
  }

  /** A directory with a `.py` file in it or below: among the sources, or on disk (an excluded package). */
  private hasPython(path: string): boolean {
    if (this.pythonDirs.has(path)) return true;

    if (!this.isDir(path)) return false;
    // Depth-first walk of the directory on disk, capped at 2000 directories so a
    // huge non-Python tree cannot stall resolution; hidden directories,
    // `node_modules` and `__pycache__` are skipped. Unreadable entries are ignored.
    const pending = [join(this.root, path)];

    for (let seen = 0; pending.length > 0 && seen < 2000; seen++) {
      let entries: Dirent[];

      try {
        entries = readdirSync(pending.pop()!, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".py")) return true;

        if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "__pycache__") pending.push(join(e.parentPath, e.name));
      }
    }

    return false;
  }

  /** A directory among the analysed sources' parents, else on disk. */
  private isDir(path: string): boolean {
    if (this.sourceDirs.has(path)) return true;
    const abs = join(this.root, path);

    return existsSync(abs) && statSync(abs).isDirectory();
  }
}

/** Every directory above a file of `files` (POSIX, relative). */
function directoriesOf(files: ReadonlySet<string>): Set<string> {
  const dirs = new Set<string>();

  // Walk up from each file; stop at a directory already seen, because its
  // ancestors were added with it.
  for (const file of files) for (let dir = posix.dirname(file); dir !== "." && !dirs.has(dir); dir = posix.dirname(dir)) dirs.add(dir);

  return dirs;
}
