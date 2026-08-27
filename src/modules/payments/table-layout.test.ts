import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * A scrolling table's `min-width` must leave room for its FLEXIBLE columns.
 *
 * The header and the rows are separate grid containers inside one horizontally scrolling box. When
 * the fixed columns plus the gaps plus the padding come to MORE than the declared `min-width`, the
 * flexible track has nothing left and falls back to its content-driven floor — which is different
 * in the header ("Client") and in a row ("Elena Kantarovich"). The two grids then resolve different
 * track widths and every column after the flexible one sits offset from its own label.
 *
 * Measured in a browser on 2026-08-27, on the Billing table as it then stood: a fixed budget of
 * 990px against `min-w-[980px]` produced a constant 39px drift and pushed the content out to
 * 1050px, which is where the horizontal scroll came from. Raising the `min-width` above the budget
 * removed the drift on its own, with the bare `1fr` still in place — so this arithmetic IS the bug,
 * and `minmax(0,1fr)` is the belt to its braces.
 *
 * jsdom does not do layout, so this cannot be asserted by rendering. It is asserted as the sum it
 * is, read out of the source — the same shape as the reset-script check in schema-invariants.
 */

/** Every table drawn as header-grid + row-grids inside an `overflow-x-auto` box. */
const TABLES = [
  { file: "src/modules/payments/billing.page.tsx", label: "Billing" },
  { file: "src/modules/payments/entity-invoices.tsx", label: "Client card → Invoices" },
];

/** `gap-x-3` = 0.75rem between every pair of columns; `px-4` = 1rem either side. */
const GAP = 12;
const PADDING = 32;
/** below this a flexible column is narrower than the word it holds — legible, but only just */
const MIN_FLEXIBLE = 100;

function parse(source: string) {
  const grid = /grid-cols-\[([^\]]+)\]/.exec(source);
  const minWidth = /min-w-\[(\d+)px\]/.exec(source);
  if (!grid || !minWidth) throw new Error("no grid template or min-width found");
  // minmax(0,1fr) holds a comma, so split on the underscores Tailwind uses between tracks
  const tracks = grid[1].split("_");
  const fixed = tracks
    .filter((t) => t.endsWith("px"))
    .reduce((sum, t) => sum + Number(t.slice(0, -2)), 0);
  const flexible = tracks.length - tracks.filter((t) => t.endsWith("px")).length;
  return { tracks, fixed, flexible, minWidth: Number(minWidth[1]) };
}

describe("scrolling table layout", () => {
  for (const { file, label } of TABLES) {
    it(`${label}: min-width leaves room for its flexible columns`, async () => {
      const source = await readFile(new URL(`../../../${file}`, import.meta.url), "utf8");
      const { tracks, fixed, flexible, minWidth } = parse(source);
      const budget = fixed + (tracks.length - 1) * GAP + PADDING;

      expect(flexible, "a table with no flexible column cannot drift, but also cannot fill").toBeGreaterThan(0);
      expect(
        minWidth - budget,
        `${label}: fixed columns (${fixed}) + gaps + padding = ${budget}px, but min-width is ` +
          `${minWidth}px. The flexible column${flexible > 1 ? "s" : ""} would collapse onto ` +
          `content and the header would stop lining up with the rows.`,
      ).toBeGreaterThanOrEqual(flexible * MIN_FLEXIBLE);
    });

    it(`${label}: flexible tracks have a ZERO floor, so both grids resolve alike`, async () => {
      const source = await readFile(new URL(`../../../${file}`, import.meta.url), "utf8");
      const { tracks } = parse(source);
      const bare = tracks.filter((t) => /^[\d.]*fr$/.test(t));
      expect(
        bare,
        "a bare `1fr` is `minmax(auto,1fr)`: its floor is its content, which differs between the " +
          "header and a row. Use `minmax(0,1fr)`.",
      ).toEqual([]);
    });
  }
});
