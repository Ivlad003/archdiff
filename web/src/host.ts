// The host of the page: an editor that shows the page in a frame of its
// own (the VS Code extension's panel) and opens the code itself. A page
// opened with `?host=1` inside a frame tells its parent of every place in
// the code the reader asks for — a `file:line` clicked on a page, a shape
// tapped — with `postMessage`, and the host opens the file there. The
// message names a path of the repository and its lines, and the revision
// when the page shows another one than the working tree; nothing else
// leaves the page. Without the flag, or in a window of its own, there is
// no host, and the page shows the code on its Code tab as ever.
//
// Entry points: `hosted`, `tellHost`, `HostMessage`.

/** What the page tells its host: a place in the code to open. */
export interface HostMessage {
  type: "archdiff:open";
  /** The file, as a path in the repository. */
  file: string;
  /** The first line of the place, from 1. */
  line: number;
  /** Its last line, when the place is a declaration's lines. */
  endLine?: number;
  /** The revision the page shows the code of, when it is not the working tree's. */
  head?: string;
}

/** Whether an editor hosts the page: `?host=1`, in a frame. */
export const hosted = new URLSearchParams(location.search).get("host") === "1" && window.parent !== window;

/**
 * Tells the host, when there is one. The host's origin is its own business (a webview's is made up per panel), so
 * the message goes to whoever frames the page: it says a place, no more.
 */
export function tellHost(message: HostMessage): void {
  if (hosted) window.parent.postMessage(message, "*");
}
