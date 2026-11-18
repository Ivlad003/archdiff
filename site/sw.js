// The builds page's service worker: the page's own files are kept, so that it
// opens without a network. Each file is asked of the network first, so a new
// version of the page is shown as soon as it is published, and the kept copy
// answers when the network fails or takes more than three seconds. The list
// of releases is not handled here: builds.js keeps the last one it read, and
// says how old it is. Nothing of another site passes through this worker,
// the downloads included.
//
// Entry point: registered by builds.js on GitHub Pages.

const CACHE = "archdiff-builds-v1";

/** The files the page needs to open, relative to this worker. */
const SHELL = ["./", "index.html", "builds.css", "builds.js", "icon.svg", "manifest.webmanifest", "icons/180.png", "icons/192.png", "icons/512.png", "icons/maskable-512.png"];

/** How long the network may take before the kept copy answers. */
const PATIENCE_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

/** The kept copy of a request; for a page of the site, the page itself. */
async function kept(request) {
  const cache = await caches.open(CACHE);

  return (await cache.match(request, { ignoreSearch: true })) ?? (request.mode === "navigate" ? cache.match("index.html") : undefined);
}

/** The network's answer, kept for next time; the kept copy when the network fails or is slow and there is one. */
async function answer(request, finishing) {
  const fetched = fetch(request).then(async (response) => {
    if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());

    return response;
  });
  // The copy is written even when the kept one answered first.
  finishing(fetched.catch(() => undefined));
  const slow = new Promise((resolve) => setTimeout(() => resolve(null), PATIENCE_MS));

  try {
    const first = await Promise.race([fetched, slow]);

    if (first !== null) return first;

    return (await kept(request)) ?? (await fetched);
  } catch (error) {
    const copy = await kept(request);

    if (copy) return copy;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(answer(request, (work) => event.waitUntil(work)));
});
