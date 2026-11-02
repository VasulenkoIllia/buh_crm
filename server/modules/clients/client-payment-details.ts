import {
  FIRM_DEFAULT_LABEL,
  type SetClientPaymentDetailsInput,
} from "@shared/schema/payment-details.js";
import { record } from "../../core/activity.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import { clientLabel } from "../../core/names.js";
import * as repo from "./clients.repository.js";
import { getClient } from "./clients.service.js";

/**
 * **Which payment details a client's invoices carry** (payments.md §10): a set of their own, or
 * `null` for the firm's default. An admin's act (the owner, 2026-11-02), because it decides which
 * account the client is asked to pay into. Invoices already issued keep the text they were issued
 * with; the next one takes the new set.
 *
 * Its own file: `clients.service.ts` is past a thousand lines.
 */
export async function setClientPaymentDetails(id: string, input: SetClientPaymentDetailsInput) {
  const client = await repo.findClient(id);
  if (!client || client.archivedAt) throw new NotFoundError("Client not found");
  const next = input.paymentDetailsId
    ? await repo.findLivePaymentDetails(input.paymentDetailsId)
    : null;
  const gone = new ValidationError(
    "Those payment details are archived or gone. Pick another set",
  );
  if (input.paymentDetailsId && !next) throw gone;
  const before = client.paymentDetails;
  if ((before?.id ?? null) !== (next?.id ?? null)) {
    if (!(await repo.setClientPaymentDetails(id, next?.id ?? null))) throw gone;
    record("client.payment_details_changed", {
      subjectId: id,
      subjectLabel: clientLabel(client),
      clientId: id,
      changes: {
        paymentDetails: {
          from: before?.name ?? FIRM_DEFAULT_LABEL,
          to: next?.name ?? FIRM_DEFAULT_LABEL,
        },
      },
    });
  }
  return getClient(id);
}
