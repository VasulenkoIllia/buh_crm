/**
 * Rewrite `server/route-inventory.json` from the routes the app actually registers.
 *
 * The inventory is committed so that any change to the API is a reviewable diff — see
 * `server/route-inventory.test.ts`, which fails on drift and prints what moved. That test is the
 * point; this script is only the way to accept a change deliberately, after reading it.
 *
 *   NODE_ENV=test npx tsx --env-file=.env scripts/dev/regen-route-inventory.ts
 *
 * Then check the diff, and move the literal totals in the test if the count changed.
 */
import { writeFile } from "node:fs/promises";
import { buildApp } from "../../server/app.js";
import { finalizeInventory } from "../../server/core/route-inventory.js";

const app = await buildApp();
await app.ready();
const rows = finalizeInventory(app.routeInventory);
await writeFile(
  new URL("../../server/route-inventory.json", import.meta.url),
  JSON.stringify(rows, null, 2) + "\n",
);
const real = rows.filter((r) => !r.derived);
console.log(
  `${rows.length} entries · ${real.length} real routes · ` +
    `${real.filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method)).length} mutating`,
);
await app.close();
process.exit(0);
