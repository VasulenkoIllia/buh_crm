import { prisma } from "../core/db.js";

/**
 * **No payment details sets at all**, whatever a failed run left. The sets are firm-wide and a
 * suite that adds them makes every later invoice in the run carry one, so a suite that touches
 * them starts and ends here. The clients and invoices pointing at a set are let go first: both
 * keys are RESTRICT.
 */
export async function wipePaymentDetails() {
  await prisma.client.updateMany({
    where: { paymentDetailsId: { not: null } },
    data: { paymentDetailsId: null },
  });
  await prisma.invoice.updateMany({
    where: { paymentDetailsId: { not: null } },
    data: { paymentDetailsId: null },
  });
  await prisma.paymentDetails.deleteMany();
}
