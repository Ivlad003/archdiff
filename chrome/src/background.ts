// The extension's service worker: a press on the extension's button opens
// the side panel beside the page. Everything else is the panel's own
// (panel.ts), which lives while it is open.
//
// Entry point: loaded by Chrome (manifest.json, `background`).

// Said whenever the worker starts: Chrome keeps it, and a worker that starts again says nothing new.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => console.error("archdiff:", error));
