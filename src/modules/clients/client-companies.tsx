import { useState } from "react";
import { X } from "lucide-react";
import type { Client, CompanyInput } from "@shared/schema/client";
import { ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { useUpdateClient } from "./clients.api";

/**
 * A client's companies — the dimension subscriptions, tasks and invoices are attached to.
 *
 * A company belongs to exactly one client, and its NAME identifies it across the whole firm, so
 * a name another client already holds comes back as a 409 naming them. Holding no companies is
 * perfectly normal: everything then hangs off the client directly.
 *
 * Rows carry their `id` so a rename stays the same company and the history pointing at it follows.
 */
export type CompanyRow = CompanyInput & { key: string };

const toRows = (client: Client): CompanyRow[] =>
  client.companies.map((c) => ({
    key: c.id,
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    description: c.description,
  }));

/** Drop the UI-only key; blank optional fields become null (the API's "not set"). */
const toInput = (rows: CompanyRow[]): CompanyInput[] =>
  rows
    .filter((r) => r.name.trim())
    .map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      name: r.name.trim(),
      phone: r.phone?.trim() || null,
      email: r.email?.trim() || null,
      description: r.description?.trim() || null,
    }));

export function CompaniesTab({ client, onManage }: { client: Client; onManage: () => void }) {
  return (
    <div className="rounded-(--radius-panel) border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-divider px-5 py-3">
        <div>
          <h2 className="text-[15px] font-semibold">Companies</h2>
          <p className="mt-0.5 text-[12px] text-muted">
            Services, tasks and invoices can be attached to any of them.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onManage}>
          Manage
        </Button>
      </div>

      {client.companies.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-[13px] text-muted">
            No companies. Everything for this client is billed and tracked directly on them.
          </p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={onManage}>
            + Add company
          </Button>
        </div>
      ) : (
        <ul>
          {client.companies.map((c) => (
            <li key={c.id} className="border-b border-divider px-5 py-3 text-[13px] last:border-0">
              <div className="font-semibold">{c.name}</div>
              <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-muted">
                <span>{c.phone || "no phone"}</span>
                {/* the address this company's invoices will go to once S10 lands */}
                <span>{c.email || "no email"}</span>
              </div>
              {c.description && (
                <p className="mt-1 whitespace-pre-wrap text-[12px] text-ink-700">{c.description}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Add / edit / remove the client's companies — writes only the `companies` list. */
export function ClientCompaniesModal({
  open,
  onClose,
  client,
}: {
  open: boolean;
  onClose: () => void;
  client: Client;
}) {
  const update = useUpdateClient();
  const [rows, setRows] = useState<CompanyRow[]>(() => toRows(client));

  const set = (i: number, patch: Partial<CompanyRow>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const close = () => {
    setRows(toRows(client));
    update.reset();
    onClose();
  };

  const save = async () => {
    try {
      await update.mutateAsync({ id: client.id, input: { companies: toInput(rows) } });
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  };

  const serverError = update.error instanceof ApiError ? update.error.message : null;

  return (
    <Modal
      title="Manage companies"
      open={open}
      onClose={close}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[12px] text-muted">
          Only the name is required, and it has to be unique across the whole firm. The email is
          where this company&apos;s invoices will be sent.
        </p>

        {rows.map((row, i) => (
          <div key={row.key} className="rounded-(--radius-field) border border-border p-3">
            <div className="mb-2 flex items-start gap-2">
              <div className="flex-1">
                <FormField label="Company name" htmlFor={`co-name-${row.key}`}>
                  <Input
                    id={`co-name-${row.key}`}
                    autoFocus={!row.id}
                    placeholder="e.g. Romashka LLC"
                    value={row.name}
                    onChange={(e) => set(i, { name: e.target.value })}
                  />
                </FormField>
              </div>
              <button
                type="button"
                aria-label="Remove company"
                title="Remove this company"
                className="mt-6 rounded p-1 text-muted hover:bg-divider hover:text-danger-text"
                onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <X size={15} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <FormField label="Phone" htmlFor={`co-phone-${row.key}`}>
                <Input
                  id={`co-phone-${row.key}`}
                  placeholder="+380 67 123 4567"
                  value={row.phone ?? ""}
                  onChange={(e) => set(i, { phone: e.target.value })}
                />
              </FormField>
              <FormField label="Email (invoices)" htmlFor={`co-email-${row.key}`}>
                <Input
                  id={`co-email-${row.key}`}
                  type="email"
                  placeholder="billing@company.com"
                  value={row.email ?? ""}
                  onChange={(e) => set(i, { email: e.target.value })}
                />
              </FormField>
            </div>
            <div className="mt-2">
              <FormField label="Description" htmlFor={`co-desc-${row.key}`}>
                <Textarea
                  id={`co-desc-${row.key}`}
                  className="h-[52px]"
                  placeholder="Anything worth knowing about this company"
                  value={row.description ?? ""}
                  onChange={(e) => set(i, { description: e.target.value })}
                />
              </FormField>
            </div>
          </div>
        ))}

        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            setRows((prev) => [
              ...prev,
              // no `id` — the server reads that as "a new company"
              { key: `new-${prev.length}-${Date.now()}`, name: "", phone: null, email: null, description: null },
            ])
          }
        >
          + Add company
        </Button>

        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </div>
    </Modal>
  );
}
