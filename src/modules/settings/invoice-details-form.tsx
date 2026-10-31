import { useState } from "react";
import type { InvoiceDetails, UpdateInvoiceDetailsInput } from "@shared/schema/settings";
import { useAuth } from "@/app/auth";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Textarea } from "@/shared/ui/field";
import { useInvoiceDetails, useUpdateInvoiceDetails } from "./settings.api";

type Field = Exclude<keyof InvoiceDetails, "logo">;
type Draft = Record<Field, string>;

const FIELDS: { key: Field; label: string; rows?: "address" | "payment" }[] = [
  { key: "name", label: "From" },
  { key: "address", label: "Address", rows: "address" },
  { key: "website", label: "Website" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "paymentInfo", label: "Payment information", rows: "payment" },
];

const toDraft = (details: InvoiceDetails): Draft => ({
  name: details.name,
  address: details.address ?? "",
  website: details.website ?? "",
  email: details.email ?? "",
  phone: details.phone ?? "",
  paymentInfo: details.paymentInfo ?? "",
});

/** Only the boxes that now differ. An emptied box sends null, and From comes back as the firm's. */
function toInput(edits: Partial<Draft>, saved: Draft): UpdateInvoiceDetailsInput {
  const input: UpdateInvoiceDetailsInput = {};
  for (const { key } of FIELDS) {
    const text = edits[key]?.trim();
    if (text !== undefined && text !== saved[key]) input[key] = text || null;
  }
  return input;
}

/**
 * What every invoice prints as its sender and how to pay. Read-only for anybody but an admin, the
 * way numbering is: seeing it is fair, and changing it decides where clients send their money.
 */
export function InvoiceDetailsForm() {
  const { data, isError, refetch } = useInvoiceDetails();
  if (isError) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-[13px] text-danger-text">The invoice details did not load.</p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!data) return <p className="text-[13px] text-muted">Loading…</p>;
  return <Form details={data} />;
}

function Form({ details }: { details: InvoiceDetails }) {
  const isAdmin = useAuth().user?.role === "admin";
  const update = useUpdateInvoiceDetails();
  // only what was typed: every other box goes on showing the server's latest, and is not saved
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const saved = toDraft(details);
  const input = toInput(edits, saved);

  return (
    <div className="space-y-3">
      {FIELDS.map(({ key, label, rows }) => (
        <FormField key={key} label={label} htmlFor={`invoice-${key}`}>
          {rows ? (
            <Textarea
              id={`invoice-${key}`}
              className={rows === "payment" ? "h-[120px]" : "h-[64px]"}
              value={edits[key] ?? saved[key]}
              readOnly={!isAdmin}
              onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
            />
          ) : (
            <Input
              id={`invoice-${key}`}
              value={edits[key] ?? saved[key]}
              readOnly={!isAdmin}
              onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
            />
          )}
        </FormField>
      ))}

      <p className="text-[12px] text-muted">
        {details.logo
          ? details.logo.printable
            ? "The logo is the one on letters."
            : "The letter logo is not a PNG or JPEG, so invoices print without it."
          : "No letter logo yet, so invoices print without one."}
      </p>

      {isAdmin ? (
        <Button
          disabled={Object.keys(input).length === 0 || update.isPending}
          onClick={() => update.mutate(input, { onSuccess: () => setEdits({}) })}
        >
          Save
        </Button>
      ) : (
        <p className="text-[12px] text-muted">Only an admin changes this.</p>
      )}
      {update.error && <p className="text-[12px] text-danger-text">{update.error.message}</p>}
    </div>
  );
}
