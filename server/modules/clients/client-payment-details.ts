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
 * Picking the default set is `null` too, so a client is either with everybody or an exception,
 * and the card offers the sets alone (the owner, 2026-11-03). Pinned to the default by id, a client
 * would stay behind when the firm moves its default.
 *
 * Its own file: `clients.service.ts` is past a thousand lines.
 */
export async function setClientPaymentDetails(id: string, input: SetClientPaymentDetailsInput) {
  const client = await repo.findClient(id);
  if (!client || client.archivedAt) throw new NotFoundError("Client not found");
  const picked = input.paymentDetailsId
    ? await repo.findLivePaymentDetails(input.paymentDetailsId)
    : null;
  const gone = new ValidationError(
    "Those payment details are archived or gone. Pick another set",
  );
  if (input.paymentDetailsId && !picked) throw gone;
  const before = client.paymentDetails?.id ?? null;
  // this read only skips a pick that changes nothing; the repository decides null or the id
  // under the set's lock, where a default moved meanwhile is seen
  if (before === (picked?.isDefault ? null : (picked?.id ?? null))) return getClient(id);
  const saved = await repo.setClientPaymentDetails(id, picked?.id ?? null);
  if (!saved) throw gone;
  const next = saved.paymentDetailsId ? picked : null;
  if (before !== (next?.id ?? null)) {
    record("client.payment_details_changed", {
      subjectId: id,
      subjectLabel: clientLabel(client),
      clientId: id,
      changes: {
        paymentDetails: {
          from: client.paymentDetails?.name ?? FIRM_DEFAULT_LABEL,
          to: next?.name ?? FIRM_DEFAULT_LABEL,
        },
      },
    });
  }
  return getClient(id);
}
