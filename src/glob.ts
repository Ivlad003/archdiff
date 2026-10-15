// Minimal glob matching for `archdiff.json` (no dependency, no experimental
// Node API). Supports `**`, `*`, `?` and `{a,b}`; `[` is a literal (Next.js
// `app/[id]/page.tsx`). Paths are POSIX-relative.
//
// Used on the code side (source → FileFacts → graph → map) to place files in
// layers and modules from `archdiff.json`, and by rules that name paths.
// Entry points: `globToRegExp`, `matchesGlob`, `firstMatchingGlob`,
// `globDirectory`, `globPrefix`.

/** Compiled globs: a map matches every file against every layer glob, so each compiles once per process. */
const compiled = new Map<string, RegExp>();

/** Globs come from configuration, so few are distinct; the bound only keeps a long session from growing without end. */
const COMPILED_LIMIT = 4096;

/** The anchored RegExp of a glob, compiled once. It has no `g` or `y` flag, so sharing it keeps `test` stateless. */
export function globToRegExp(glob: string): RegExp {
  let re = compiled.get(glob);

  if (re === undefined) {
    re = new RegExp(`^${source(glob)}$`);

    // Crude bound: drop the whole cache rather than track recency.
    if (compiled.size >= COMPILED_LIMIT) compiled.clear();
    compiled.set(glob, re);
  }

  return re;
}

/** The regex body of a glob; each `{a,b}` alternative is a glob itself (`{src/**,lib/*.ts}`). */
function source(glob: string): string {
  let re = "";

  // Translate one character at a time; wildcards never cross a `/` except `**`.
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;

    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;

        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/` matches zero or more directories
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const close = closingBrace(glob, i);

      // An unclosed `{` is a literal brace, not an error.
      if (close === -1) {
        re += "\\{";
      } else {
        re += `(?:${splitAlternatives(glob.slice(i + 1, close)).map(source).join("|")})`;
        i = close;
      }
    } else {
      re += escape(c);
    }
  }

  return re;
}

/** Index of the `}` that closes the `{` at `open`, counting nested braces; -1 when unclosed. */
function closingBrace(glob: string, open: number): number {
  let depth = 0;

  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth++;
    else if (glob[i] === "}" && --depth === 0) return i;
  }

  return -1;
}

/** Top-level commas of a brace body: `a,{b,c}` → `a`, `{b,c}`. */
function splitAlternatives(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;

  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") depth--;
    else if (body[i] === "," && depth === 0) {
      out.push(body.slice(from, i));
      from = i + 1;
    }
  }

  out.push(body.slice(from));

  return out;
}

/** Escape regex metacharacters; `[` is among them, so a bracket in a path stays literal. */
function escape(s: string): string {
  return s.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
}

/** True when the whole POSIX-relative `path` matches `glob`. */
export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

/** The first of `globs` that matches `path`, or null. */
export function firstMatchingGlob(path: string, globs: readonly string[]): string | null {
  for (const glob of globs) if (globToRegExp(glob).test(path)) return glob;

  return null;
}

/**
 * The one directory a set of globs owns: `D` when every glob is `D/**` or
 * `D/**` followed by a file pattern, else null. A set that lists files, or
 * spreads over two directories, owns none, so a README beside its files does
 * not speak for it.
 */
export function globDirectory(globs: readonly string[]): string | null {
  let dir: string | null = null;

  for (const glob of globs) {
    // Matches `D/**` or `D/**/<one segment>` where D is plain path segments without wildcards or brackets.
    const m = /^((?:[^*?{}[\]/]+\/)*[^*?{}[\]/]+)\/\*\*(?:\/[^/]*)?$/.exec(glob);

    if (!m || (dir !== null && dir !== m[1])) return null;
    dir = m[1]!;
  }

  return dir;
}

/** Directory prefix of a glob, up to the first wildcard: `src/domain/**` → `src/domain`. */
export function globPrefix(glob: string): string {
  const parts = glob.split("/");
  const fixed: string[] = [];

  for (const p of parts) {
    // Stop at the first segment holding a wildcard or brace alternative.
    if (/[*?{]/.test(p)) break;
    fixed.push(p);
  }

  // A trailing fixed component is a file name unless the glob had a wildcard after it.
  if (fixed.length === parts.length) fixed.pop();

  return fixed.join("/");
}
