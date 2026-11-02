import type { Client } from "@shared/schema/client";
import { FIRM_DEFAULT_LABEL } from "@shared/schema/payment-details";
import { useAuth } from "@/app/auth";
import { usePaymentDetailsOptions } from "@/modules/settings";
import { Select } from "@/shared/ui/field";
import { useSetClientPaymentDetails } from "./clients.api";

/**
 * **Which payment details the client's invoices carry** (payments.md §10): a set by name, never its
 * text. Everybody sees it; only an admin changes it (the owner, 2026-11-02). The next invoice takes
 * the new set, and the ones already issued keep the text they were issued with.
 */
export function ClientPaymentDetails({ client }: { client: Client }) {
  const isAdmin = useAuth().user?.role === "admin";
  const { data: options, isError } = usePaymentDetailsOptions();
  const update = useSetClientPaymentDetails();
  const own = client.paymentDetails;
  const fallback = options?.find((o) => o.isDefault);
  const firmDefault = fallback
    ? `${FIRM_DEFAULT_LABEL} (${fallback.name})`
    : FIRM_DEFAULT_LABEL;

  // shown while the names load, and for a set archived while the client was archived: restored,
  // the client prints the default, so the select never claims a set the client is not on
  const isOwnMissing = !!own && !options?.some((o) => o.id === own.id);

  if (!isAdmin)
    return (
      <div className="text-[14px] break-words">
        {own && (!options || !isOwnMissing) ? own.name : firmDefault}
      </div>
    );

  return (
    <div>
      <Select
        aria-label="Payment details"
        className="h-8 w-auto max-w-full text-[14px]"
        // the pick stays shown while it saves, rather than snapping back until the refetch
        value={update.isPending ? (update.variables.paymentDetailsId ?? "") : (own?.id ?? "")}
        disabled={!options || update.isPending}
        onChange={(e) =>
          update.mutate({ id: client.id, paymentDetailsId: e.target.value || null })
        }
      >
        <option value="">{firmDefault}</option>
        {options?.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
        {isOwnMissing && (
          <option value={own.id}>{options ? `${own.name} (archived)` : own.name}</option>
        )}
      </Select>
      {(update.error || (isError && !options)) && (
        <p role="alert" className="mt-1 text-[12px] text-danger-text">
          {update.error?.message ?? "The payment details did not load."}
        </p>
      )}
    </div>
  );
}
