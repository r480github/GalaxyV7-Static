importScripts("/cdn.js");

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
  importScripts(...ENGINE_SOURCES.map((p) => "/" + p));
}

/*
 * Same-origin path -> CDN path. Exact pathname matches only; a suffix match
 * would also catch proxied URLs that happen to end the same way.
 *
 * The last two entries are a fix as well as a remap: car.js asks for
 * /libby/ and /libbybutslightlyworse/, but copystatic.js writes libcurl/ and
 * epoxy/, so those transports 404 in the current static build.
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
  "/libby/index.mjs": "libcurl/index.mjs",
  "/libbybutslightlyworse/index.mjs": "epoxy/index.mjs",
};

function contentTypeFor(path) {
  if (path.endsWith(".wasm")) return "application/wasm";
  return "application/javascript; charset=utf-8";
}

function assetTarget(request) {
  if (!CDN) return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  const mapped = ASSET_MAP[url.pathname];
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

const uv = new UVServiceWorker();
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

async function handleRequest(event) {
  await scramjet.loadConfig();
  if (uv.route(event)) {
    return await uv.fetch(event);
  }
  if (scramjet.route(event)) {
    return await scramjet.fetch(event);
  }

  return await fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  const asset = assetTarget(event.request);
  if (asset) {
    event.respondWith(serveAsset(asset));
    return;
  }
  if (typeof $scramjetController !== "undefined" && $scramjetController.shouldRoute(event)) {
    event.respondWith($scramjetController.route(event));
    return;
  }
  event.respondWith(handleRequest(event));
});
