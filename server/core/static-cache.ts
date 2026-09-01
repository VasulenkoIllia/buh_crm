import { sep } from "node:path";

/**
 * How long a built file may be kept, decided by whether its NAME can go stale.
 *
 * This matters more since every screen became a separate file loaded on demand: how long that file
 * may be cached decides whether a person sees the loading line once or every time they open that
 * screen. It was `max-age=0`, which makes the browser revalidate on every navigation — cheap in
 * bytes (a 304) but a full network round-trip each time. Invisible on an office LAN, very visible
 * to somebody working remotely (2026-09-01).
 *
 * Everything under `/assets` is content-hashed by Vite, so those names are immutable by
 * construction: change the file and you get a different name. `index.html` is the opposite — it is
 * the map from route to hashed file, so a cached one points a browser at the previous deploy.
 */
export function staticCacheControl(filePath: string): string {
  return filePath.includes(`${sep}assets${sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}
