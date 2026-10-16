// Whether a path archdiff derived from code exists on disk with exactly that
// spelling. `existsSync` answers for the file system: on APFS and NTFS
// `src/models/User.rs` exists when `src/models/user.rs` does, so a resolver
// that trusts it names a file the index does not have, and a `use
// crate::models::User` that Linux resolves to `models/mod.rs` becomes a hole
// on a developer's laptop. The directory listing carries the real spelling,
// so every segment of the path is compared with the listing of its parent.
// Names are compared in NFC: HFS+ lists them in NFD.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The two calls the check makes, replaceable in tests that emulate a case-insensitive file system. */
export interface ExactFs {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
}

/** The real file system. */
export const nodeFs: ExactFs = { existsSync, readdirSync: (path) => readdirSync(path) };

/**
 * A predicate over POSIX paths relative to `root`: the file or directory
 * exists, spelled exactly so. Listings are read once per directory, so the
 * predicate is for one analysis, as a resolver is.
 */
export function exactExistence(root: string, fs: ExactFs = nodeFs): (file: string) => boolean {
  const listings = new Map<string, ReadonlySet<string> | null>();

  const entries = (dir: string): ReadonlySet<string> | null => {
    // Each directory is listed at most once; an unreadable one is cached as
    // null so the predicate answers false without retrying.
    let names = listings.get(dir);

    if (names === undefined) {
      try {
        names = new Set(fs.readdirSync(join(root, dir)).map((name) => name.normalize("NFC")));
      } catch {
        names = null;
      }

      listings.set(dir, names);
    }

    return names;
  };

  return (file) => {
    // Cheap rejection first: a path missing even case-insensitively is missing.
    if (!fs.existsSync(join(root, file))) return false;
    let dir = "";

    // Walk the path one segment at a time and require each segment to appear
    // verbatim in its parent's listing. `..` is refused: it would make the
    // listing walk leave the path archdiff derived.

    for (const segment of file.split("/")) {
      if (segment === "" || segment === ".") continue;

      if (segment === ".." || !entries(dir)?.has(segment.normalize("NFC"))) return false;
      dir = dir === "" ? segment : `${dir}/${segment}`;
    }

    return true;
  };
}
