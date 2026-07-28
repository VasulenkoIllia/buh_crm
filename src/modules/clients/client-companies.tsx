import { useState } from "react";
import type { Client, Company, CompanyInput } from "@shared/schema/client";
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
 * ONE COMPANY AT A TIME (user, 2026-07-28). This used to be a "Manage companies" modal holding
 * the whole list: adding one meant opening a list editor and clicking "+ Add company" again
 * inside it before you could type, and removing one looked like it had already happened while
 * nothing was written until Save. Now the row carries its own Edit and Delete and the form edits
 * a single company — the same shape as services, subscriptions and people elsewhere in the app.
 *
 * The API still takes the whole list (it reconciles by id, which is what makes a rename keep the
 * company and its history), so each action sends the list with that one company added, replaced
 * or dropped. Every guard on it — the firm-wide name conflict, "still used by N subscriptions" —
 * keeps working untouched.
 */

/** The list with `company` added, or replacing the entry with the same id. */
const withCompany = (companies: Company[], company: CompanyInput): CompanyInput[] => {
  const rest = companies.map(toInput);
  return company.id
    ? rest.map((c) => (c.id === company.id ? company : c))
    : [...rest, company];
};

const toInput = (c: Company): CompanyInput => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  email: c.email,
  description: c.description,
});

export function CompaniesTab({ client }: { client: Client }) {
  const update = useUpdateClient();
  const [editing, setEditing] = useState<Company | "new" | null>(null);

  // a delete the server refuses (the company still carries subscriptions, tasks or invoices)
  // has to say so — it is the one action here that can be turned down
  const error = update.error instanceof ApiError ? update.error.message : null;

  // the form is its own mutation, so opening one would leave a refused delete sitting there
  const openForm = (target: Company | "new") => {
    update.reset();
    setEditing(target);
  };

  const remove = (company: Company) => {
    if (
      !window.confirm(
        `Delete “${company.name}”? Possible only while nothing is attached to it.`,
      )
    )
      return;
    update
      .mutateAsync({
        id: client.id,
        input: { companies: client.companies.filter((c) => c.id !== company.id).map(toInput) },
      })
      .catch(() => {
        /* surfaced below */
      });
  };

  return (
    <>
      <div className="rounded-(--radius-panel) border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-divider px-5 py-3">
          <div>
            <h2 className="text-[15px] font-semibold">Companies</h2>
            <p className="mt-0.5 text-[12px] text-muted">
              Services, tasks and invoices can be attached to any of them.
            </p>
          </div>
          <Button size="sm" onClick={() => openForm("new")}>
            + Add company
          </Button>
        </div>

        {client.companies.length === 0 ? (
          <div className="px-5 py-8 text-center text-[13px] text-muted">
            No companies. Everything for this client is billed and tracked directly on them.
          </div>
        ) : (
          <ul>
            {client.companies.map((c) => (
              <li
                key={c.id}
                className="flex items-start gap-3 border-b border-divider px-5 py-3 text-[13px] last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{c.name}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-muted">
                    <span>{c.phone || "no phone"}</span>
                    {/* the address this company's invoices will go to once S10 lands */}
                    <span>{c.email || "no email"}</span>
                  </div>
                  {c.description && (
                    <p className="mt-1 whitespace-pre-wrap text-[12px] text-ink-700">
                      {c.description}
                    </p>
                  )}
                </div>
                <div className="flex flex-none items-center gap-2.5">
                  <button
                    type="button"
                    className="text-[12px] font-medium text-primary-link hover:underline"
                    onClick={() => openForm(c)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={update.isPending}
                    className="text-[12px] font-medium text-muted hover:text-danger hover:underline disabled:opacity-50"
                    onClick={() => remove(c)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="mt-2 text-[12px] text-danger-text">{error}</p>}

      {editing && (
        <CompanyModal
          client={client}
          company={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** One company — add or edit. The name is the only required field. */
function CompanyModal({
  client,
  company,
  onClose,
}: {
  client: Client;
  company?: Company;
  onClose: () => void;
}) {
  const update = useUpdateClient();
  const [name, setName] = useState(company?.name ?? "");
  const [phone, setPhone] = useState(company?.phone ?? "");
  const [email, setEmail] = useState(company?.email ?? "");
  const [description, setDescription] = useState(company?.description ?? "");

  const serverError = update.error instanceof ApiError ? update.error.message : null;

  /**
   * A name this client ALREADY holds would be silently merged, not added: the API matches a
   * company without an id by name (that's what lets the create form send bare names), so "add"
   * would quietly overwrite the other one's phone/email and the list wouldn't grow. The old
   * whole-list editor made that visible; a single-company form can't, so it's caught here.
   */
  const clash = client.companies.find(
    (c) => c.id !== company?.id && c.name.toLowerCase() === name.trim().toLowerCase(),
  );

  const save = async () => {
    const edited: CompanyInput = {
      ...(company ? { id: company.id } : {}),
      name: name.trim(),
      phone: phone.trim() || null,
      email: email.trim() || null,
      description: description.trim() || null,
    };
    try {
      await update.mutateAsync({
        id: client.id,
        input: { companies: withCompany(client.companies, edited) },
      });
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  };

  return (
    <Modal
      title={company ? "Edit company" : "New company"}
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!name.trim() || !!clash || update.isPending}>
            {update.isPending ? "Saving…" : company ? "Save" : "Add company"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Company name" htmlFor="co-name">
          <Input
            id="co-name"
            autoFocus
            placeholder="e.g. Romashka LLC"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Phone" htmlFor="co-phone">
            <Input
              id="co-phone"
              placeholder="+380 67 123 4567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </FormField>
          <FormField label="Email (invoices)" htmlFor="co-email">
            <Input
              id="co-email"
              type="email"
              placeholder="billing@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </FormField>
        </div>
        <FormField label="Description" htmlFor="co-desc">
          <Textarea
            id="co-desc"
            className="h-[52px]"
            placeholder="Anything worth knowing about this company"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormField>
        {clash ? (
          <p className="text-[12px] text-danger-text">
            This client already has a company called “{clash.name}” — edit that one instead.
          </p>
        ) : (
          <p className="text-[12px] text-muted">
            The name has to be unique across the whole firm. The email is where this
            company&apos;s invoices will be sent.
          </p>
        )}
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </div>
    </Modal>
  );
}
