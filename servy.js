/*
 * Resolved against this worker's own URL. An absolute "/glass/..." would hit
 * the ORIGIN root, which is wrong wherever the app is served from a
 * subdirectory -- on a CDN it becomes https://cdn.jsdelivr.net/glass/...
 */
const ENGINE_SOURCES = [
  "glass/glass.bundle.js",
  "glass/glass.config.js",
  "glass/glass.sw.js",
  "poly/polygon.all.js",
  "prism/prism.sw.js",
];
importScripts(...ENGINE_SOURCES.map((p) => new URL(p, self.location.href).href));

/*
 * The worker's scope is the app root, which is not the origin root off-root, so
 * any path matching below has to be scope-relative.
 */
const SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, "");

/*
 * adapter-static emits flat files (slate.html, os.html), but the router needs
 * extensionless URLs (/slate). Hosts like GitHub Pages resolve that themselves;
 * a pure file CDN does not, so a request for <scope>/os would 404 and the page
 * would die. Serving the .html contents at the extensionless path makes both
 * behave the same.
 */
const ROUTE_DOCS = new Set([
  "", "slate", "os", "books", "apps", "settings", "api", "lethe", "changelog", "contrast", "test"
]);

function routeDocTarget(request) {
  // Deliberately not gated on request.mode/destination: the same path is asked
  // for as a navigation, an iframe load, and a plain fetch, and all three need
  // the same answer. Proxied URLs cannot collide -- they always carry the
  // engine prefix, so they contain a slash and fail the checks below.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  if (SCOPE_PATH && !url.pathname.startsWith(SCOPE_PATH + "/")) return null;

  const rel = (SCOPE_PATH ? url.pathname.slice(SCOPE_PATH.length) : url.pathname).replace(/^\//, "");
  if (rel.includes("/") || rel.endsWith(".html") || !ROUTE_DOCS.has(rel)) return null;

  return new URL((rel || "index") + ".html", self.registration.scope).href;
}

async function serveRouteDoc(target, request) {
  const res = await fetch(target, { cache: "no-store" });
  if (!res.ok) return fetch(request);
  return new Response(res.body, {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const uv = new UVServiceWorker();
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

async function handleRequest(event) {
  /*
   * A freshly installed worker has no scramjet config yet -- the app writes it
   * when the proxy is first set up. Until then loadConfig() rejects, and an
   * unhandled rejection here fails the request outright. Since this worker
   * controls the whole scope, that made the entire site unloadable once
   * installed: first visit fine, every reload a blank page.
   *
   * Anything that goes wrong below degrades to a plain network request.
   */
  try {
    await scramjet.loadConfig();
  } catch (err) {
    return fetch(event.request);
  }

  try {
    if (uv.route(event)) {
      return await uv.fetch(event);
    }
    if (scramjet.route(event)) {
      return await scramjet.fetch(event);
    }
  } catch (err) {
    return fetch(event.request);
  }

  return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  const routeDoc = routeDocTarget(event.request);
  if (routeDoc) {
    event.respondWith(serveRouteDoc(routeDoc, event.request));
    return;
  }
  if (typeof $scramjetController !== "undefined" && $scramjetController.shouldRoute(event)) {
    event.respondWith($scramjetController.route(event));
    return;
  }
  // Last line of defence: never let a worker error blank the page.
  event.respondWith(handleRequest(event).catch(() => fetch(event.request)));
});
