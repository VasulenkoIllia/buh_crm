import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import { staticCacheControl } from "./static-cache.js";

const p = (...parts: string[]) => parts.join(sep);

describe("how long a built file may be kept", () => {
  it("keeps a content-hashed asset for a year, without revalidating", () => {
    const header = staticCacheControl(p("", "app", "dist", "assets", "tasks.page-BgAtnvTY.js"));
    expect(header).toContain("immutable");
    expect(header).toContain("max-age=31536000");
  });

  /**
   * The one that must never be cached: it names the hashed files, so a stale copy sends a browser
   * to the previous deploy's chunks — which are gone.
   */
  it("never caches index.html", () => {
    expect(staticCacheControl(p("", "app", "dist", "index.html"))).toBe("no-cache");
  });

  it("treats anything outside /assets as needing a check", () => {
    expect(staticCacheControl(p("", "app", "dist", "favicon.ico"))).toBe("no-cache");
    // a directory merely NAMED assets-something is not the assets directory
    expect(staticCacheControl(p("", "app", "dist", "assets-old", "x.js"))).toBe("no-cache");
  });
});
