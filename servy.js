// Resolved against this worker's own URL. An absolute "/cdn.js" would hit the
// ORIGIN root, which is wrong on any host that serves the app from a
// subdirectory -- on a CDN it becomes https://cdn.jsdelivr.net/cdn.js.
importScripts(new URL("cdn.js", self.location.href).href);

/*
 * Engine assets can come from a CDN instead of shipping with the build.
 *
 * Two separate mechanisms are at work here, and they solve different problems:
 *
 *   1. importScripts() works cross-origin, so the worker-side engine code can
 *      be pulled straight from the CDN. Nothing below has to exist on this
 *      origin for the worker itself to boot.
 *
 *   2. Assets that get injected into PROXIED pages -- the UV handler/client/
 *      bundle, prism's inject script, scramjet's wasm -- are requested from
 *      this origin by documents we control. There does not have to be a file
 *      behind those URLs: the fetch handler below synthesizes them from the
 *      CDN and stamps the correct Content-Type on the way out. That also means
 *      a host serving text/plain cannot break them.
 *
 * Page-side scripts are NOT covered by this. A document is uncontrolled on its
 * first load, so its own <script src> fetches bypass the worker entirely --
 * those go to the CDN directly via src/lib/lethe/cdn.js.
 */
const CDN = self.__GALAXY_CDN || "";

const ENGINE_SOURCES = [
  "glass/glass.bundle.js",
  "glass/glass.config.js",
  "glass/glass.sw.js",
  "poly/polygon.all.js",
  "prism/prism.sw.js",
];

if (CDN) {
  importScripts(...ENGINE_SOURCES.map((p) => CDN + p));
} else {
  // Relative to this worker's own URL, so it works off-root too.
  importScripts(...ENGINE_SOURCES.map((p) => new URL(p, self.location.href).href));
}

/*
 * Same-origin path -> CDN path. Exact pathname matches only; a suffix match
 * would also catch proxied URLs that happen to end the same way.
 *
 * Directory names mirror static/ exactly, so whatever gets pushed to the assets
 * repo can be a straight copy of these folders.
 */
const ASSET_MAP = {
  "/glass/glass.handler.js": "glass/glass.handler.js",
  "/glass/glass.client.js": "glass/glass.client.js",
  "/glass/glass.bundle.js": "glass/glass.bundle.js",
  "/glass/glass.config.js": "glass/glass.config.js",
  "/glass/glass.sw.js": "glass/glass.sw.js",

  "/poly/polygon.all.js": "poly/polygon.all.js",
  "/poly/polygon.sync.js": "poly/polygon.sync.js",
  "/poly/polygon.wasm.wasm": "poly/polygon.wasm.wasm",

  "/prism/prism.js": "prism/prism.js",
  "/prism/prism.api.js": "prism/prism.api.js",
  "/prism/prism.inject.js": "prism/prism.inject.js",
  "/prism/prism.sw.js": "prism/prism.sw.js",
  "/prism/prism.wasm": "prism/prism.wasm",
  "/prism/libby.js": "prism/libby.js",
  "/prism/libbyworse.js": "prism/libbyworse.js",

  "/charon/worker.js": "charon/worker.js",
  "/charon/index.js": "charon/index.js",

  "/reflux/index.mjs": "reflux/index.mjs",
  "/libby/index.mjs": "libby/index.mjs",
  "/libbybutslightlyworse/index.mjs": "libbybutslightlyworse/index.mjs",
};

function contentTypeFor(path) {
  if (path.endsWith(".wasm")) return "application/wasm";
  return "application/javascript; charset=utf-8";
}

/*
 * The worker's scope is the app root, which is NOT the origin root when the
 * build is served from a subdirectory (a CDN path, a project Pages site).
 * Asset requests arrive prefixed with it, so matching has to be scope-relative
 * or every lookup misses off-root.
 */
const SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, "");

function assetTarget(request) {
  if (!CDN) return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  if (SCOPE_PATH && !url.pathname.startsWith(SCOPE_PATH + "/")) return null;
  const rel = SCOPE_PATH ? url.pathname.slice(SCOPE_PATH.length) : url.pathname;
  const mapped = ASSET_MAP[rel];
  return mapped ? CDN + mapped : null;
}

async function serveAsset(target) {
  const upstream = await fetch(target, { cache: "force-cache" });
  if (!upstream.ok) {
    return new Response("asset fetch failed: " + upstream.status, {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response(upstream.body, {
    status: 200,
    statusText: "OK",
    headers: {
      "Content-Type": contentTypeFor(target),
      "Access-Control-Allow-Origin": "*",
      // Pinned CDN URLs are immutable, so this is safe and keeps the engine
      // out of the network path on every subsequent load.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/*
 * adapter-static emits flat files (slate.html, os.html), but the router needs
 * extensionless URLs (/slate). Hosts like GitHub Pages resolve that themselves;
 * a pure file CDN does not, so a request for <scope>/slate 404s and the page
 * dies. Serving the .html contents at the extensionless path makes both work.
 */
const ROUTE_DOCS = new Set([
  "", "slate", "os", "books", "apps", "settings", "api", "lethe", "changelog", "contrast", "test"
]);

function routeDocTarget(request) {
  // Deliberately not gated on request.mode/destination: the same path is asked
  // for as a navigation, an iframe load, and a plain fetch, and all three need
  // the same answer. Proxied URLs cannot collide here -- they always carry the
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
    headers: { "Content-Type": "text/html; charset=utf-8" }
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
   * controls the whole scope, that makes the entire site unloadable the moment
   * it is installed: first visit works, every reload is a blank page.
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
  const asset = assetTarget(event.request);
  if (asset) {
    event.respondWith(serveAsset(asset));
    return;
  }
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
