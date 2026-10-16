// Rust path → file. A crate is a directory with `Cargo.toml` and `[package]`;
// each target — the library (`src/lib.rs` or `[lib] path`), and each binary
// (`src/main.rs`, `src/bin/*.rs`, `src/bin/*/main.rs`, `[[bin]] path`) — is a
// module tree of its own rooted at that file: `crate::a::b` is `a/b.rs` or
// `a/b/mod.rs` next to the root. A file under both a library and a binary
// root belongs to the one whose root declares its top module (`mod a;`), the
// library when both or neither do. `self`/`super` start at the importing
// file's module, a workspace member's name at that crate's library, a
// `[dependencies]` name is an external package. The longest prefix of the
// path that is a module names the file; when that is the whole path, the
// import binds the module itself. A path that goes on into a module that is
// not a file (an inline `mod x {}`, a `#[path]` module) is unresolved.
//
// Part of source → FileFacts: the Rust frontend asks `RustResolver.resolve`
// for every `use` path, and the `Resolution` decides the graph's edge. The
// `Cargo.toml` files it reads are recorded in `inputs`, so a cache can tell
// when a manifest change invalidates the edges.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseToml, TomlDate, type TomlTable, type TomlValue } from "smol-toml";
import type { Resolution, SourceResolver } from "./imports.ts";
import { exactExistence, nodeFs, type ExactFs } from "./exact-path.ts";
import { globToRegExp } from "./glob.ts";

/** Crates of the toolchain: always there, never in `Cargo.toml`. */
const TOOLCHAIN = new Set(["std", "core", "alloc", "proc_macro", "test"]);

/** One Cargo package of the repository, with its targets and dependency names. */
interface Crate {
  /** Directory of `Cargo.toml`, POSIX, relative to the root ("" for the root). */
  dir: string;
  /** Crate name as code writes it (`-` → `_`). */
  name: string | null;
  /** Root file of the library target, relative to the repository root; null without one. */
  lib: string | null;
  /** Root files of the binary targets. */
  bins: string[];
  /** Names code uses for dependencies → the package name and, for a `path` dependency inside the repository, its directory. */
  deps: Map<string, { pkg: string; path: string | null }>;
}

/** Resolves Rust `use` paths (`crate::`, `self::`, `super::`, crate names) to files or packages; caches manifests, crates and `mod` scans. */
export class RustResolver implements SourceResolver {
  private readonly root: string;
  private readonly manifests = new Map<string, TomlTable | null>();
  private readonly crates = new Map<string, Crate | null>();
  /** Workspace root directory → members by crate name (the root package included). */
  private readonly workspaces = new Map<string, Map<string, Crate>>();
  /** File → names of the modules it declares with `mod x;` (`files`) and `mod x {}` (`inline`). */
  private readonly declared = new Map<string, { files: Set<string>; inline: Set<string> }>();
  readonly inputs = new Map<string, string | null>();
  /** Files of the analysis (unsaved buffers included): they exist for resolution, on disk or not. */
  private readonly sources: ReadonlySet<string>;
  /** A file on disk, spelled exactly so: `existsSync` alone finds `User.rs` through `user.rs` on APFS and NTFS. */
  private readonly onDisk: (file: string) => boolean;

  constructor(root: string, sources: ReadonlySet<string> = new Set(), fs: ExactFs = nodeFs) {
    this.root = root;
    this.sources = sources;
    this.onDisk = exactExistence(root, fs);
  }

  resolve(fromFile: string, spec: string): Resolution {
    // A file in no crate cannot be resolved; otherwise find its target root and
    // its own module path under that root.
    const crate = this.crateOf(fromFile);

    if (!crate) return { kind: "unresolved" };
    const segments = spec.split("::");
    const head = segments[0]!;
    const own = this.rootOf(crate, fromFile);
    const here = own === null ? null : modulePath(own, fromFile);
    let target = own;
    let base: string[];
    let rest: string[];

    // Pick the starting point from the first segment: the target root (`crate`),
    // the current module (`self`/`super`), another crate's library, or an
    // external package, which needs no file lookup.
    if (head === "crate") {
      // `build.rs` and other files outside every target are crate roots of their own.
      if (here === null) return { kind: "unresolved" };
      base = [];
      rest = segments.slice(1);
    } else if (head === "self" || head === "super") {
      if (here === null) return { kind: "unresolved" };
      base = here;
      rest = segments;

      if (rest[0] === "self") rest = rest.slice(1);

      while (rest[0] === "super") {
        if (base.length === 0) return { kind: "unresolved" };
        base = base.slice(0, -1);
        rest = rest.slice(1);
      }
    } else if (TOOLCHAIN.has(head)) {
      return { kind: "external", pkg: head };
    } else if (this.pathDependency(crate, head) !== null || this.membersOf(crate).has(head)) {
      // A `path` dependency on a crate of the repository (under the name the code uses, renamed through
      // `package` or not), another workspace member or this package's library, from a binary: its library.
      target = (this.pathDependency(crate, head) ?? this.membersOf(crate).get(head)!).lib;
      base = [];
      rest = segments.slice(1);
    } else if (crate.deps.has(head)) {
      return { kind: "external", pkg: crate.deps.get(head)!.pkg };
    } else {
      // Edition 2018: a path may start at a child of the current module.
      if (own === null || here === null || this.moduleFile(own, [...here, head]) === null) return { kind: "unresolved" };
      base = here;
      rest = segments;
    }

    if (target === null) return { kind: "unresolved" };

    // Longest prefix of the path that is a module file wins.
    for (let k = rest.length; k >= 0; k--) {
      const file = this.moduleFile(target, [...base, ...rest.slice(0, k)]);

      if (file === null) continue;
      const beyond = rest.slice(k);

      // Two or more segments left and the first is lowercase: it names a
      // module, not an item (Rust convention), and that module has no file.
      if (beyond.length > 1 && /^[a-z_]/.test(beyond[0]!)) {
        // `a::inner::f` with `mod inner {}` in `a.rs`: a dependency on `a.rs`, whose member `f` is not indexed.
        // Any other module without a file of its own (`#[path]`, a macro, a `pub use` alias) is unknown.
        if (file === fromFile || !this.declares(file, beyond[0]!, true)) return { kind: "unresolved" };

        return { kind: "internal", file, nested: true };
      }

      if (file === fromFile) return { kind: "local" };

      return k === rest.length ? { kind: "internal", file, whole: true } : { kind: "internal", file };
    }

    return { kind: "unresolved" };
  }

  /** The file of a module path under a target root, or null: `a/b.rs`, `a/b/mod.rs`, the root itself for `[]`. */
  private moduleFile(rootFile: string, path: string[]): string | null {
    if (path.length === 0) return rootFile;
    const dir = posix.dirname(rootFile);

    // `a/b.rs` (2018 style) before `a/b/mod.rs` (2015 style).
    for (const c of [`${path.join("/")}.rs`, `${path.join("/")}/mod.rs`]) {
      const file = dir === "." ? c : posix.join(dir, c);

      if (this.sources.has(file) || this.onDisk(file)) return file;
    }

    return null;
  }

  /** The target root whose module tree holds `file`; null for a file outside all of them (`build.rs`). */
  private rootOf(crate: Crate, file: string): string | null {
    const roots = [...(crate.lib ? [crate.lib] : []), ...crate.bins];

    if (roots.includes(file)) return file;
    // The deepest root directory that contains the file.
    let best: string[] = [];
    let depth = -1;

    for (const root of roots) {
      const dir = posix.dirname(root);
      const inside = dir === "." || file.startsWith(`${dir}/`);

      if (!inside) continue;
      const d = dir === "." ? 0 : dir.split("/").length;

      if (d > depth) {
        depth = d;
        best = [root];
      } else if (d === depth) best.push(root);
    }

    if (best.length <= 1) return best[0] ?? null;
    // `src/lib.rs` and `src/main.rs` share `src/`: the file is the binary's when only the binary declares its top module.
    const top = modulePath(best[0]!, file)[0];
    const lib = best.find((root) => root === crate.lib) ?? null;
    const claiming = best.filter((root) => top !== undefined && this.declares(root, top));

    if (claiming.length === 1 && claiming[0] !== lib) return claiming[0]!;

    return lib ?? best[0]!;
  }

  /** The file declares `mod <name>` (only an inline `mod <name> { … }` with `inline`). A text scan: the resolver does not parse sources. */
  private declares(file: string, name: string, inline = false): boolean {
    let names = this.declared.get(file);

    // Scan once per file, from disk: strip block and line comments, then
    // match `mod name;` (a file module) or `mod name {` (an inline one).
    if (!names) {
      names = { files: new Set(), inline: new Set() };
      const abs = join(this.root, file);
      const text = existsSync(abs) ? readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "") : "";

      for (const m of text.matchAll(/\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*([;{])/g)) (m[2] === "{" ? names.inline : names.files).add(m[1]!);
      this.declared.set(file, names);
    }

    return names.inline.has(name) || (!inline && names.files.has(name));
  }

  /** The nearest crate at or above the file's directory, as Cargo finds a package. */
  private crateOf(file: string): Crate | null {
    for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
      const at = dir === "." ? "" : dir;
      const crate = this.crateAt(at);

      if (crate) return crate;

      if (at === "") return null;
    }
  }

  /** The crate whose `Cargo.toml` with `[package]` is in `dir`, or null (a workspace-only manifest, or none); cached. */
  private crateAt(dir: string): Crate | null {
    const cached = this.crates.get(dir);

    if (cached !== undefined) return cached;
    const manifest = this.manifestAt(dir);
    let crate: Crate | null = null;

    if (manifest && isTable(manifest.package)) {
      // Code writes a crate's name with `_` where Cargo.toml may have `-`.
      const pkg = manifest.package;
      const name = isText(pkg.name) ? pkg.name.replace(/-/g, "_") : null;
      const at = (path: string): string => posix.normalize(posix.join(dir, path));
      const deps = new Map<string, { pkg: string; path: string | null }>();
      // `[target.'cfg(…)'.dependencies]` add platform-specific ones.
      const targets = isTable(manifest.target) ? Object.values(manifest.target).filter(isTable) : [];
      const tables = [manifest, ...targets].flatMap((t) => [t.dependencies, t["dev-dependencies"], t["build-dependencies"]]);

      // Each dependency under the name code uses (the key), with its real
      // package name (`package = "…"` renames) and an in-repository `path`.
      for (const table of tables) {
        if (!isTable(table)) continue;

        for (const [key, value] of Object.entries(table)) {
          const renamed = isTable(value) && isText(value.package) ? value.package : key;
          const path = isTable(value) && isText(value.path) ? insideRoot(at(value.path)) : null;
          deps.set(key.replace(/-/g, "_"), { pkg: renamed, path });
        }
      }

      // Targets: Cargo's auto-discovered library and binaries plus the ones the
      // manifest declares; binaries are sorted for a stable root choice.
      const exists = (path: string): boolean => this.sources.has(path) || existsSync(join(this.root, path));
      const libPath = isTable(manifest.lib) && isText(manifest.lib.path) ? at(manifest.lib.path) : at("src/lib.rs");
      const bins = new Set<string>();

      if (exists(at("src/main.rs"))) bins.add(at("src/main.rs"));
      const binDir = at("src/bin");

      if (exists(binDir)) {
        for (const entry of readdirSync(join(this.root, binDir), { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".rs")) bins.add(posix.join(binDir, entry.name));
          else if (entry.isDirectory() && exists(posix.join(binDir, entry.name, "main.rs"))) bins.add(posix.join(binDir, entry.name, "main.rs"));
        }
      }

      for (const bin of Array.isArray(manifest.bin) ? manifest.bin.filter(isTable) : []) if (isText(bin.path)) bins.add(at(bin.path));
      crate = { dir, name, lib: exists(libPath) ? libPath : null, bins: [...bins].sort(), deps };
    }

    this.crates.set(dir, crate);

    return crate;
  }

  /** The crate a `path` dependency named `name` in code points at, when it is inside the repository; null otherwise. */
  private pathDependency(crate: Crate, name: string): Crate | null {
    const path = crate.deps.get(name)?.path;

    return path === undefined || path === null ? null : this.crateAt(path);
  }

  /**
   * The members of the crate's workspace by name, as Cargo finds it: the nearest `Cargo.toml` with
   * `[workspace]` from the crate's directory up to the analysis root, its `members` expanded relative
   * to that manifest's directory, plus the root package itself; a crate under no workspace is one of its own.
   */
  private membersOf(crate: Crate): Map<string, Crate> {
    let workspace = crate.dir;

    // Climb to the nearest manifest with `[workspace]`.
    for (let dir = crate.dir; ; dir = posix.dirname(dir)) {
      const at = dir === "." ? "" : dir;
      const manifest = this.manifestAt(at);

      if (manifest && isTable(manifest.workspace)) {
        workspace = at;
        break;
      }

      if (at === "") break;
    }

    const cached = this.workspaces.get(workspace);

    if (cached) return cached;
    const members = new Map<string, Crate>();

    for (const dir of [...this.workspaceMembers(workspace), workspace]) {
      const member = this.crateAt(dir);

      if (member?.name) members.set(member.name, member);
    }

    this.workspaces.set(workspace, members);

    return members;
  }

  /** `[workspace] members` of the manifest in `dir`, root-relative, globs expanded one directory level at a time. */
  private workspaceMembers(dir: string): string[] {
    const manifest = this.manifestAt(dir);
    const workspace = manifest && isTable(manifest.workspace) ? manifest.workspace : null;
    const members = Array.isArray(workspace?.members) ? workspace.members.filter(isText) : [];
    const out: string[] = [];

    // A literal member is a directory; a glob is matched against the entries
    // of its parent directory only. Members outside the repository are dropped.
    for (const member of members) {
      if (!/[*?[{]/.test(member)) {
        const at = insideRoot(posix.normalize(posix.join(dir, member)));

        if (at !== null) out.push(at);
        continue;
      }

      const parent = member.slice(0, member.lastIndexOf("/") + 1);
      const pattern = globToRegExp(member);
      const abs = join(this.root, dir, parent);

      if (!existsSync(abs)) continue;

      for (const name of readdirNames(abs)) {
        const at = insideRoot(posix.normalize(posix.join(dir, `${parent}${name}`)));

        if (pattern.test(`${parent}${name}`) && at !== null) out.push(at);
      }
    }

    return out.sort();
  }

  /** The parsed `Cargo.toml` of a directory (root-relative, "" for the root), read once; null without one. */
  private manifestAt(dir: string): TomlTable | null {
    const cached = this.manifests.get(dir);

    if (cached !== undefined) return cached;
    const manifest = this.readToml(posix.join(dir, "Cargo.toml"));
    this.manifests.set(dir, manifest);

    return manifest;
  }

  /** A parsed TOML file, recording its text (or its absence) in `inputs`; a syntax error names the file. */
  private readToml(file: string): TomlTable | null {
    const abs = join(this.root, file);

    if (!existsSync(abs)) {
      this.inputs.set(file, null);

      return null;
    }

    const text = readFileSync(abs, "utf8");
    this.inputs.set(file, text);

    try {
      return parseToml(text);
    } catch (e) {
      throw new Error(`${file}: invalid TOML: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Module path of a file under a target root: `src/a/b.rs` → `[a, b]`, `src/a/mod.rs` → `[a]`, the root → `[]`. */
function modulePath(rootFile: string, file: string): string[] {
  if (file === rootFile) return [];
  const dir = posix.dirname(rootFile);
  const parts = (dir === "." ? file : file.slice(dir.length + 1)).replace(/\.rs$/, "").split("/");

  if (parts.at(-1) === "mod") parts.pop();

  return parts;
}

/** A normalized root-relative directory when it stays inside the repository ("" for the root); null when it leaves it. */
function insideRoot(dir: string): string | null {
  if (dir === "." || dir === "") return "";

  return dir === ".." || dir.startsWith("../") || dir.startsWith("/") ? null : dir;
}

/** The subdirectory names of `abs`, sorted. */
function readdirNames(abs: string): string[] {
  return readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** A Cargo.toml table: neither a list nor a date, the other values TOML gives as objects. */
function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === "object" && !Array.isArray(value) && !(value instanceof TomlDate);
}

/** A TOML string. */
function isText(value: TomlValue | undefined): value is string {
  return typeof value === "string";
}
