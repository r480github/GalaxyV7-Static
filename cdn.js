/*
 * Single source of truth for where the proxy engine assets live.
 *
 * Empty string  -> assets are served from this origin (what copystatic.js
 *                  produces). Everything behaves exactly as it did before.
 * A pinned URL  -> assets come from a CDN and copystatic.js can be skipped,
 *                  dropping ~7MB from the build.
 *
 * Pin a COMMIT HASH, never @main. jsDelivr caches hard and a moving ref will
 * serve you stale engine code long after you push a fix.
 *
 *   self.__GALAXY_CDN = "https://cdn.jsdelivr.net/gh/r480github/galaxy-assets@a1b2c3d/";
 *
 * Loaded by static/servy.js via importScripts, and by page code through
 * src/lib/lethe/cdn.js. Must keep a trailing slash.
 */
self.__GALAXY_CDN = "";
