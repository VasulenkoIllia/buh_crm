import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { prisma } from "../../core/db.js";
import { setClientPaymentDetails } from "./clients.repository.js";

/**
 * The database's half of "a live client is never on an archived set" (payments.md §10): the
 * service checks the set first, and the repository refuses again under the set's row lock, for a
 * set archived by another admin between the two. The routes are covered in
 * `settings/payment-details.integration.test.ts`.
 */

const TAG = `cpd${randomUUID().slice(0, 6)}`;
const made = { clientIds: [] as string[], setIds: [] as string[] };

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: made.clientIds } } });
  await prisma.paymentDetails.deleteMany({ where: { id: { in: made.setIds } } });
});

it("refuses a set archived after the service read it", async () => {
  const set = await prisma.paymentDetails.create({
    data: { name: `${TAG} Old bank`, details: "Old bank", archivedAt: new Date() },
  });
  made.setIds.push(set.id);
  const client = await prisma.client.create({ data: { firstName: `${TAG} Client` } });
  made.clientIds.push(client.id);

  expect(await setClientPaymentDetails(client.id, set.id)).toBe(false);
  const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
  expect(after.paymentDetailsId).toBeNull();
});
