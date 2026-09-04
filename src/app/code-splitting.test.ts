import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Route-level splitting is only real if nothing eager can reach a screen.
 *
 * `router.tsx` loads every page with `lazy()`, but that is worth nothing on its own: the shell
 * imports `TimerBar` from `@/modules/tasks`, and while that barrel re-exported `TasksPage` the
 * bundler put the whole kanban — dnd-kit included — in the first chunk anyway. The lazy route was
 * decorative. Measured 2026-09-01: 265 kB on every first visit, of which 16.5 kB was a drag
 * library nobody had opened a board to use.
 *
 * So the rule is mechanical rather than remembered: a module's barrel is its CROSS-MODULE surface,
 * and a screen is not part of that. Screens come from their own `*.page` file, which only the
 * router imports and only on demand.
 */
const MODULES = new URL("../modules/", import.meta.url);

describe("code splitting cannot be undone by accident", () => {
  it("no module barrel re-exports a page", async () => {
    const modules = (await readdir(MODULES, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(modules.length).toBeGreaterThan(5); // the test found the modules at all

    const offenders: string[] = [];
    for (const name of modules) {
      const index = new URL(`${name}/index.ts`, MODULES);
      const source = await readFile(index, "utf8").catch(() => null);
      if (source === null) continue;
      for (const line of source.split("\n")) {
        // `export … from "./something.page"` — the shape that welds a screen to the barrel
        if (/^\s*export\s.*from\s+["']\.\/[^"']*\.page["']/.test(line)) {
          offenders.push(`${name}/index.ts → ${line.trim()}`);
        }
      }
    }

    expect(
      offenders,
      "A barrel exporting a page puts that screen in the first chunk for everyone, however lazily " +
        "the route is declared. Import it in router.tsx from its own *.page file instead.",
    ).toEqual([]);
  });

  /**
   * The same failure one level down: a barrel is shared, so what it reaches statically travels to
   * every module that imports it — screens are simply the loudest case, not the only one.
   *
   * `modules/tasks/index.ts` publishes `ClientLeadSearch` out of `task-modals.tsx`, which makes
   * that file a chunk the board, leads, the client card and the calendar all share. The task form
   * needs the client's "Add service" modal, and exporting it from the clients barrel with a plain
   * `export … from` moved the whole subscription screen into that shared chunk — measured
   * 2026-09-04: task-modals 9.66 → 14.27 kB gzip, and opening the CALENDAR downloaded billing
   * pills. Through `lazy()` it is its own 6.59 kB chunk and task-modals moves by 0.34 kB.
   */
  it("the clients barrel reaches the subscription screen only through lazy()", async () => {
    const barrel = await readFile(new URL("../modules/clients/index.ts", import.meta.url), "utf8");
    expect(
      /^\s*export\s.*from\s+["']\.\/client-services["']/m.test(barrel),
      "Re-exporting ./client-services statically welds the subscription screen to every module " +
        "that imports the clients barrel. Export it as lazy(() => import(...)) instead.",
    ).toBe(false);
    // whitespace-tolerant: prettier wraps this call across lines
    expect(barrel).toMatch(/lazy\(\s*\(\)\s*=>\s*import\("\.\/client-services"\)/);
  });

  it("the router loads every screen on demand", async () => {
    const router = await readFile(new URL("./router.tsx", import.meta.url), "utf8");
    // every Page component the router names must arrive through lazy(), not a static import
    const statics = [...router.matchAll(/^import\s+\{([^}]*)\}\s+from\s+["']@\/modules\//gm)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim()))
      .filter((n) => n.endsWith("Page"));
    expect(statics, "a screen imported statically is a screen in the first chunk").toEqual([]);
    expect(router).toContain("lazy(");
  });
});
