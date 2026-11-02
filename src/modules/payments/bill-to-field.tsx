import { useState } from "react";
import type { Client } from "@shared/schema/client";
import { Select } from "@/shared/ui/field";
import { billToOf } from "./invoice-defaults";

/**
 * **Bill to** (owner, 2026-11-02): which of the client's companies a hand-issued invoice is
 * addressed to, or the client itself, whatever company its service sits on.
 *
 * `null` = untouched, as for the form's other suggestions: the field follows the service's company
 * until somebody picks, and a pick is never replaced by a later change of service. A job decides
 * its own company, as it decides its service, so the field is not offered for one.
 */
export function useBillTo(companies: readonly { id: string }[]) {
  const [picked, setPicked] = useState<{ companyId: string | null } | null>(null);
  // a company removed while the form is open is no pick at all: the server would refuse it, and
  // the select could not show it
  const isStale =
    picked?.companyId != null && !companies.some((c) => c.id === picked.companyId);
  return {
    picked: isStale ? null : picked,
    pick: (companyId: string | null) => setPicked({ companyId }),
    reset: () => setPicked(null),
  };
}

/** The `Bill to` line: a choice when the client holds companies, a plain line otherwise. */
export function BillToLine({
  client,
  companyId,
  locked,
  onPick,
}: {
  client: Pick<Client, "displayName" | "email" | "companies">;
  companyId: string | null;
  /** For a job: the job's company stands, and before a job is picked there is nothing to choose */
  locked: boolean;
  onPick: (companyId: string | null) => void;
}) {
  const { name, email } = billToOf(client, companyId);
  if (locked || client.companies.length === 0) {
    return (
      <p className="-mt-1.5 truncate text-[12px] text-muted">
        Bill to: <span className="text-ink-700">{name}</span>
        {email ? ` · ${email}` : ""}
      </p>
    );
  }
  return (
    <div className="-mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
      <label htmlFor="inv-bill-to">Bill to:</label>
      <Select
        id="inv-bill-to"
        className="h-7 w-auto max-w-[280px] truncate pl-2 text-[13px] text-ink-700"
        value={companyId ?? ""}
        onChange={(e) => onPick(e.target.value || null)}
      >
        {/* marked, because a sole trader's company often carries the owner's own name */}
        <option value="">{client.displayName} (client)</option>
        {client.companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      {/* the dot only joins it to the select on one line; wrapped under it on a phone it would lead */}
      {email && (
        <span className="min-w-0 truncate">
          <span className="max-sm:hidden">· </span>
          {email}
        </span>
      )}
    </div>
  );
}
