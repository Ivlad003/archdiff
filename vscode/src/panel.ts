// The panel's document: one frame, as large as the panel, on the page
// archdiff serves, and the few lines of script that pass messages between
// the page and the extension. The page tells its host which place of the
// code to open (`archdiff:open`, web/src/host.ts of archdiff); the script
// hands the extension that message when it comes from the frame and from
// the server's origin, and nothing else. The extension tells the script
// which address to show (`archdiff:show`): the frame is pointed at it when
// it is an address of the server, and an address that differs by its hash
// alone changes the page's view without loading the page again.
//
// The content security policy allows the frame on the server's origin, the
// one script and the one style by their nonce, and nothing more. Pure.
// Entry points: `panelHtml`, `isOpenMessage`, `OpenMessage`, `ShowMessage`.

/** What the page tells its host (web/src/host.ts): a place in the code to open. */
export interface OpenMessage {
  type: "archdiff:open";
  file: string;
  line: number;
  endLine?: number;
  /** The revision the page shows, when it is not the working tree's. */
  head?: string;
}

/** What the extension tells the panel's script: the address the frame shows. */
export interface ShowMessage {
  type: "archdiff:show";
  url: string;
}

/** Whether a message from the panel is a place to open, in the form the page sends it. */
export function isOpenMessage(message: unknown): message is OpenMessage {
  if (typeof message !== "object" || message === null) return false;
  const { type, file, line } = message as Record<string, unknown>;

  return type === "archdiff:open" && typeof file === "string" && file !== "" && typeof line === "number" && Number.isInteger(line) && line >= 1;
}

function attribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The document of the panel: the frame on `url` (an address of `origin`, the server's), the script and the style under `nonce`. */
export function panelHtml(url: string, origin: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${attribute(origin)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<title>archdiff</title>
<style nonce="${nonce}">
html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100%; overflow: hidden; }
iframe { display: block; background: #fff; }
</style>
</head>
<body>
<iframe id="page" src="${attribute(url)}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
const editor = acquireVsCodeApi();
const frame = document.getElementById("page");
const origin = ${JSON.stringify(origin)};
window.addEventListener("message", (event) => {
  const message = event.data;
  if (typeof message !== "object" || message === null) return;
  if (event.source === frame.contentWindow) {
    if (event.origin === origin && message.type === "archdiff:open") editor.postMessage(message);
  } else if (message.type === "archdiff:show" && typeof message.url === "string" && message.url.startsWith(origin + "/")) {
    frame.src = message.url;
  }
});
</script>
</body>
</html>
`;
}
