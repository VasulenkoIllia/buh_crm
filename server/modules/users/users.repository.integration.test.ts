import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../core/db.js";
import { findByEmail } from "./users.repository.js";

/**
 * The invitation's duplicate check. The address schema refuses `%` and `\` before the route gets
 * that far, so the read is asked directly; the `_` case through the route is in
 * audit-fixes.integration.test.ts.
 */

const DOMAIN = `@ur${randomUUID().slice(0, 6)}.local`;
let userId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `olena${DOMAIN}`,
      firstName: "Olena",
      lastName: "Tester",
      status: "invited",
    },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe("finding a colleague by address", () => {
  it("compares the whole address, whatever its case", async () => {
    expect((await findByEmail(`OLENA${DOMAIN}`))?.id).toBe(userId);
    expect(await findByEmail(`olen_${DOMAIN}`)).toBeNull();
    expect(await findByEmail(`ol%${DOMAIN}`)).toBeNull();
    expect(await findByEmail(`olena${DOMAIN}\\`)).toBeNull();
  });
});
