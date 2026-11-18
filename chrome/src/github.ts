// Where a place of the code is on GitHub: a file the change touched is in
// the list of the change's files — the pull request's, the comparison's,
// the commit's — under an anchor made of its path (`diff-` and the SHA-256
// of the path, as GitHub writes it); any other file is read at the head's
// revision, at its line. The panel sends the reader's tab there when a
// shape is tapped on the picture: the picture beside, the code on GitHub.
//
// Entry points: `placeOnGitHub`, `anchorOf`, `blobAddress`, `isPlace`, `Where`, `Place`.

/** What a picture's subject is on GitHub's side. */
export interface Where {
  /** The page that lists the change's files, each under the anchor of its path; null when the picture is of code, not of a change. */
  changes: string | null;
  /** Where a file is read at the head's revision: `https://github.com/<owner>/<repository>/blob/<revision>` — the fork's, for a pull request from one. */
  blob: string;
}

/** A place of the code, as the page tells its host of it. */
export interface Place {
  file: string;
  line: number;
  endLine?: number;
}

/** Whether a message from the framed page is a place to open, in the form the page sends it (`archdiff:open`, web/src/host.ts of archdiff). */
export function isPlace(message: unknown): message is Place {
  if (typeof message !== "object" || message === null) return false;
  const { type, file, line, endLine } = message as Record<string, unknown>;

  return type === "archdiff:open" && typeof file === "string" && file !== "" && typeof line === "number" && Number.isInteger(line) && line >= 1 && (endLine === undefined || (typeof endLine === "number" && Number.isInteger(endLine)));
}

/** The anchor of a file in a list of changed files: `diff-` and the SHA-256 of its path, in hex. */
export async function anchorOf(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));

  return `diff-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A path as an address writes it: every segment escaped, the slashes kept. */
function escaped(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The address of a file at a revision of a repository (`https://github.com/<owner>/<repository>`): a branch's name keeps its slashes. */
export function blobAddress(repository: string, revision: string): string {
  return `${repository}/blob/${escaped(revision)}`;
}

/** The address of a place: in the list of the change's files when the change touched the file, else the file at the head's revision, at its lines. */
export async function placeOnGitHub(where: Where, place: Place, changed: ReadonlySet<string>): Promise<string> {
  if (where.changes !== null && changed.has(place.file)) return `${where.changes}#${await anchorOf(place.file)}`;
  const lines = place.endLine !== undefined && place.endLine > place.line ? `L${place.line}-L${place.endLine}` : `L${place.line}`;

  return `${where.blob}/${escaped(place.file)}#${lines}`;
}
