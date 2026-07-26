import { useState } from "react";
import { Link } from "react-router-dom";
import type { Invoice } from "@shared/schema/payment";
import { useAuth } from "@/app/auth";
import { useCatalog } from "@/modules/catalog";
import { useClient, useClients } from "@/modules/clients";
import { useAssignees } from "@/modules/tasks";
import { cn } from "@/shared/lib/cn";
import { fmtDate, todayIso } from "@/shared/lib/format";
import { fmtMoney, moneyInputValue, parseMoney } from "@/shared/lib/money";
import { AssigneePicker } from "@/shared/ui/assignee-picker";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { FormField, Input, Textarea } from "@/shared/ui/field";
import { InvoiceStatusPill } from "@/shared/ui/invoice-status";
import { Modal } from "@/shared/ui/modal";
import { SearchSelect } from "@/shared/ui/search-select";
import { Segmented } from "@/shared/ui/segmented";
import {
  useAddPayment,
  useCancelInvoice,
  useCreateInvoice,
  useDeletePayment,
  useBulkArchive,
  useInvoice,
  useInvoiceAudit,
  useSetDelivery,
  useUpdateInvoice,
} from "./payments.api";

// ── invoice detail + payments ────────────────────────────────────────────────

/**
 * The design's payment modal: totals, payment history, and the record-payment form.
 * Any user may record a payment; deleting one and cancelling the invoice are admin-only.
 */
export function InvoiceModal({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data: invoice, isPending } = useInvoice(invoiceId);
  const [showAudit, setShowAudit] = useState(false);
  const audit = useInvoiceAudit(invoiceId, isAdmin && showAudit);

  const addPayment = useAddPayment();
  const deletePayment = useDeletePayment();
  const cancelInvoice = useCancelInvoice();
  const archive = useBulkArchive();
  const [editing, setEditing] = useState(false);

  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState(todayIso());
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);

  const busy =
    addPayment.isPending || deletePayment.isPending || cancelInvoice.isPending || archive.isPending;

  async function record(minor: number) {
    setError(null);
    if (minor <= 0) return setError("Enter an amount");
    try {
      await addPayment.mutateAsync({
        invoiceId,
        input: { amount: minor, paidAt, reference: reference.trim() || null },
      });
      setAmount("");
      setReference("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal
      title={invoice ? `${invoice.number} · ${invoice.clientName}` : "Invoice"}
      open
      onClose={onClose}
      size="md"
      footer={
        <>
          {invoice && (invoice.balance === 0 || invoice.cancelledAt) && (
            <Button
              variant="text"
              className="mr-auto"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  archive.mutateAsync({
                    invoiceIds: [invoice.id],
                    archived: !invoice.archivedAt,
                  }),
                )
              }
              title="Settled invoices can be tidied out of the working lists (reversible)"
            >
              {invoice.archivedAt ? "↩ Restore from archive" : "📦 Archive"}
            </Button>
          )}
          {isAdmin && invoice && !invoice.cancelledAt && invoice.paid === 0 && (
            <Button
              variant="text"
              className="text-danger-text hover:text-danger-text"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Cancel this invoice? It stays in history but owes nothing."))
                  void run(() => cancelInvoice.mutateAsync(invoiceId));
              }}
            >
              Cancel invoice
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {isPending && <p className="text-[13px] text-muted">Loading…</p>}
      {/* a stale ?invoice= link (cancelled data reset, bad id) must say so, not sit empty */}
      {!isPending && !invoice && (
        <p className="text-[13px] text-danger-text">This invoice no longer exists.</p>
      )}
      {invoice && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <InvoiceStatusPill status={invoice.status} />
            <DeliveryControl invoice={invoice} disabled={busy} onError={setError} />
            <span>issued {fmtDate(invoice.issuedAt)}</span>
            {invoice.dueDate && (
              <span className={cn(invoice.status === "overdue" && "text-danger-text")}>
                · due {fmtDate(invoice.dueDate)}
              </span>
            )}
            {invoice.periodKey && <span>· period {invoice.periodKey}</span>}
          </div>

          {invoice.archivedAt && (
            <p className="rounded-(--radius-field) bg-[#f1f3f6] px-3 py-2 text-[12px] text-muted">
              📦 Archived {fmtDate(invoice.archivedAt)}
              {invoice.archivedByName ? ` by ${invoice.archivedByName}` : ""} — it stays searchable,
              just out of the working lists.
            </p>
          )}
          {invoice.clientArchived && (
            <p className="rounded-(--radius-field) bg-[#f7ede2] px-3 py-2 text-[12px] text-[#b5651d]">
              🗄 This client is archived — the invoice still counts as owed.
            </p>
          )}

          {editing ? (
            <EditInvoiceForm invoice={invoice} onDone={() => setEditing(false)} onError={setError} />
          ) : (
          <div className="grid grid-cols-3 gap-3 rounded-(--radius-panel) border border-border p-3">
            {[
              { label: "Amount", value: fmtMoney(invoice.amount), tone: "" },
              { label: "Paid", value: fmtMoney(invoice.paid), tone: "text-success-text" },
              { label: "Remaining", value: fmtMoney(invoice.balance), tone: "" },
            ].map((cell) => (
              <div key={cell.label}>
                <div className="text-[11px] uppercase tracking-wide text-faint">{cell.label}</div>
                <div className={cn("text-[17px] font-bold tabular-nums", cell.tone)}>
                  {cell.value}
                </div>
              </div>
            ))}
            {isAdmin && !invoice.cancelledAt && (
              <button
                type="button"
                className="col-span-3 -mb-1 text-left text-[12px] text-primary-link hover:underline"
                onClick={() => setEditing(true)}
              >
                Edit amount / description / due date
              </button>
            )}
          </div>
          )}

          <div className="space-y-1 text-[13px]">
            {(invoice.serviceName || invoice.description) && (
              <div className="text-ink-700">
                {[invoice.serviceName, invoice.companyName, invoice.description]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
            {invoice.taskId && (
              <div className="text-muted">
                Job:{" "}
                <Link className="text-primary-link hover:underline" to={`/tasks?task=${invoice.taskId}`}>
                  {invoice.taskTitle}
                </Link>
              </div>
            )}
            <div className="text-muted">
              Client:{" "}
              <Link className="text-primary-link hover:underline" to={`/clients/${invoice.clientId}`}>
                {invoice.clientName}
              </Link>
            </div>
          </div>

          {/* payment history */}
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
              Payment history
            </div>
            {invoice.payments.length === 0 && (
              <p className="text-[13px] text-muted">No payments yet.</p>
            )}
            <div className="space-y-1.5">
              {invoice.payments.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 rounded-(--radius-field) border border-divider bg-[#fafbfc] px-3 py-2 text-[13px]"
                >
                  <span className="font-semibold tabular-nums text-success-text">
                    {fmtMoney(p.amount)}
                  </span>
                  <span className="text-muted">{fmtDate(p.paidAt)}</span>
                  {p.reference && <span className="text-faint">ref: {p.reference}</span>}
                  <span className="ml-auto text-[12px] text-faint">{p.createdByName}</span>
                  {isAdmin && (
                    <button
                      type="button"
                      disabled={busy}
                      className="text-[13px] text-danger-text hover:underline disabled:opacity-50"
                      onClick={() => {
                        if (window.confirm("Delete this payment?"))
                          void run(() => deletePayment.mutateAsync(p.id));
                      }}
                      aria-label="Delete payment"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {invoice.cancelledAt ? (
            <p className="rounded-(--radius-field) bg-[#eef0f3] px-3 py-2 text-[13px] text-muted">
              Cancelled {fmtDate(invoice.cancelledAt)}
              {invoice.cancelledByName ? ` by ${invoice.cancelledByName}` : ""} — nothing is owed.
            </p>
          ) : invoice.balance === 0 ? (
            <p className="rounded-(--radius-field) bg-[#e6f4ea] px-3 py-2 text-[13px] text-success-text">
              ✓ Invoice fully paid
            </p>
          ) : (
            <div className="space-y-2 rounded-(--radius-panel) border border-border p-3">
              <div className="flex gap-2">
                <div className="flex-1">
                  <Input
                    inputMode="decimal"
                    placeholder="Amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
                <Input
                  type="date"
                  className="w-[140px]"
                  value={paidAt}
                  onChange={(e) => setPaidAt(e.target.value)}
                />
              </div>
              <Input
                placeholder="Reconcile — external system number (optional)"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  disabled={busy}
                  onClick={() => void record(parseMoney(amount))}
                >
                  Record payment
                </Button>
                <Button
                  variant="positive"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => void record(invoice.balance)}
                >
                  Pay remaining ({fmtMoney(invoice.balance)})
                </Button>
              </div>
            </div>
          )}

          {error && <p className="text-[12px] text-danger-text">{error}</p>}

          {isAdmin && (
            <div>
              <button
                type="button"
                className="text-[12px] text-primary-link hover:underline"
                onClick={() => setShowAudit((v) => !v)}
              >
                {showAudit ? "Hide" : "Show"} change journal
              </button>
              {showAudit && (
                <div className="mt-2 space-y-1 text-[12px] text-muted">
                  {audit.data?.length === 0 && <p>No changes recorded.</p>}
                  {audit.data?.map((entry) => (
                    <div key={entry.id}>
                      <span className="capitalize text-ink-700">{entry.action}</span>{" "}
                      {entry.action === "updated" && entry.before && entry.after
                        ? `${fmtMoney(entry.before.amount)} → ${fmtMoney(entry.after.amount)}`
                        : fmtMoney((entry.after ?? entry.before)?.amount ?? 0)}{" "}
                      · {entry.byUserName} · {fmtDate(entry.createdAt)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * Correcting an issued invoice (admin) — a typo in the amount shouldn't force a cancel and a
 * burnt number. The amount can't fall below what's already paid (server enforces it too), and a
 * linked job's price follows along. Every change lands in the journal below.
 */
function EditInvoiceForm({
  invoice,
  onDone,
  onError,
}: {
  invoice: Invoice;
  onDone: () => void;
  onError: (message: string | null) => void;
}) {
  const update = useUpdateInvoice();
  const [amount, setAmount] = useState(moneyInputValue(invoice.amount));
  const [description, setDescription] = useState(invoice.description ?? "");
  const [dueDate, setDueDate] = useState(invoice.dueDate ? invoice.dueDate.slice(0, 10) : "");

  async function save() {
    onError(null);
    const minor = parseMoney(amount);
    if (minor <= 0) return onError("Enter an amount");
    try {
      await update.mutateAsync({
        invoiceId: invoice.id,
        input: {
          amount: minor,
          description: description.trim() || null,
          dueDate: dueDate || null, // cleared = no due date
        },
      });
      onDone();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className="space-y-3 rounded-(--radius-panel) border border-primary/40 bg-[#f7f8fa] p-3">
      <div className="flex gap-3">
        <div className="w-[140px]">
          <FormField label="Amount">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </FormField>
        </div>
        <div className="w-[150px]">
          <FormField label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </FormField>
        </div>
        <div className="flex-1">
          <FormField label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </FormField>
        </div>
      </div>
      <p className="text-[12px] text-faint">
        Already paid: {fmtMoney(invoice.paid)} — the amount can't go below that. Clearing the date
        leaves the invoice with no due date.
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={update.isPending} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Delivery state — "created" until the invoice goes out to the client, then "sent".
 * Marked by hand for now; when invoice-by-email / PDF land (S10) the same mark is
 * stamped by the sender and this control just reflects it (undo stays useful).
 */
function DeliveryControl({
  invoice,
  disabled,
  onError,
}: {
  invoice: Invoice;
  disabled: boolean;
  onError: (message: string | null) => void;
}) {
  const setDelivery = useSetDelivery();
  if (invoice.cancelledAt) return null;

  const sent = invoice.delivery === "sent";
  const toggle = async () => {
    onError(null);
    try {
      await setDelivery.mutateAsync({ invoiceId: invoice.id, input: { sent: !sent } });
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return sent ? (
    <span className="inline-flex items-center gap-1">
      <Chip tone="teal">✉ sent {fmtDate(invoice.sentAt!)}</Chip>
      <button
        type="button"
        disabled={disabled || setDelivery.isPending}
        className="text-[12px] text-muted hover:underline disabled:opacity-50"
        onClick={() => void toggle()}
        title={invoice.sentByName ? `Marked by ${invoice.sentByName}` : undefined}
      >
        undo
      </button>
    </span>
  ) : (
    <button
      type="button"
      disabled={disabled || setDelivery.isPending}
      className="rounded-(--radius-chip) border border-border px-2 py-0.5 text-[12px] text-ink-700 hover:bg-divider disabled:opacity-50"
      onClick={() => void toggle()}
    >
      ✉ Mark as sent
    </button>
  );
}

// ── new invoice ──────────────────────────────────────────────────────────────

/** Compact client search — the invoice always belongs to exactly one client. */
function ClientPicker({
  clientId,
  onPick,
}: {
  clientId: string | null;
  onPick: (id: string | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const { data } = useClients({ tab: "all", search, pageSize: 8 }, { enabled: open });
  const picked = useClient(clientId ?? undefined);

  if (clientId) {
    return (
      <div className="flex h-9 items-center gap-2 rounded-(--radius-field) border border-border px-3 text-[14px]">
        <span className="truncate">{picked.data?.displayName ?? "…"}</span>
        <button
          type="button"
          className="ml-auto text-muted hover:text-ink"
          onClick={() => onPick(null)}
          aria-label="Clear client"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        placeholder="Search clients…"
        value={search}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
      />
      {open && (data?.items.length ?? 0) > 0 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-(--radius-field) border border-border bg-surface shadow-(--shadow-card)">
          {data?.items.map((c) => (
            <button
              key={c.id}
              type="button"
              className="block w-full px-3 py-2 text-left text-[13px] hover:bg-divider"
              onClick={() => {
                onPick(c.id);
                setOpen(false);
              }}
            >
              {c.displayName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NewInvoiceModal({
  presetClientId,
  onClose,
  onCreated,
}: {
  presetClientId?: string;
  onClose: () => void;
  onCreated?: (invoice: Invoice) => void;
}) {
  const createInvoice = useCreateInvoice();
  const { data: catalog } = useCatalog();
  const { data: assignees } = useAssignees();

  const [clientId, setClientId] = useState<string | null>(presetClientId ?? null);
  const [subscriptionId, setSubscriptionId] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [noDueDate, setNoDueDate] = useState(false);
  const [mode, setMode] = useState<"invoice" | "with_task">("invoice");
  const [taskTitle, setTaskTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const client = useClient(clientId ?? undefined);
  const serviceName = (id: string) => catalog?.find((s) => s.id === id)?.name ?? "Service";
  const subscriptions = (client.data?.subscriptions ?? []).filter((s) => s.active);

  async function submit() {
    setError(null);
    if (!clientId) return setError("Pick a client");
    const minor = parseMoney(amount);
    if (minor <= 0) return setError("Enter an amount");
    try {
      const invoice = await createInvoice.mutateAsync({
        clientId,
        subscriptionId: subscriptionId || null,
        description: description.trim() || undefined,
        amount: minor,
        // a date sets it · "no due date" sends null · leaving it empty inherits the service preset
        dueDate: dueDate || (noDueDate ? null : undefined),
        withTask: mode === "with_task",
        taskTitle: taskTitle.trim() || undefined,
        assigneeIds: mode === "with_task" ? selected : [],
      });
      onCreated?.(invoice);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal
      title="New invoice"
      open
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={createInvoice.isPending} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <FormField label="Client">
          <ClientPicker
            clientId={clientId}
            onPick={(id) => {
              setClientId(id);
              setSubscriptionId("");
            }}
          />
        </FormField>

        <FormField label="Service (optional — pins the company target)">
          <SearchSelect
            value={subscriptionId}
            onChange={setSubscriptionId}
            disabled={!clientId}
            placeholder={clientId ? "Search this client's services…" : "Pick a client first"}
            emptyLabel="No service — a plain charge"
            options={
              clientId
                ? subscriptions.map((s) => ({
                    value: s.id,
                    label: s.companyId
                      ? `${serviceName(s.serviceId)} · ${client.data?.companies.find((c) => c.id === s.companyId)?.name ?? "company"}`
                      : serviceName(s.serviceId),
                  }))
                : []
            }
          />
        </FormField>

        <FormField label="Description">
          <Textarea
            className="h-[60px]"
            placeholder="What this invoice is for"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormField>

        <div className="flex gap-3">
          <div className="flex-1">
            <FormField label="Amount">
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </FormField>
          </div>
          <div className="w-[170px]">
            <FormField label="Due date">
              <Input
                type="date"
                value={dueDate}
                disabled={noDueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </FormField>
            <label className="mt-1 flex items-center gap-1.5 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={noDueDate}
                onChange={(e) => {
                  setNoDueDate(e.target.checked);
                  if (e.target.checked) setDueDate("");
                }}
              />
              No due date
            </label>
            {!noDueDate && !dueDate && (
              <p className="mt-1 text-[11px] text-faint">empty = service default</p>
            )}
          </div>
        </div>

        <FormField label="What to create">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "invoice", label: "Invoice only" },
              { value: "with_task", label: "Invoice + task" },
            ]}
          />
        </FormField>

        {mode === "with_task" && (
          <div className="space-y-3 rounded-(--radius-panel) bg-[#f7f8fa] p-3">
            <FormField label="Task name">
              <Input
                placeholder={description || "What has to be done"}
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
              />
            </FormField>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-700">Assign to</div>
              <AssigneePicker
                users={assignees ?? []}
                selected={(id) => selected.includes(id)}
                onToggle={(id) =>
                  setSelected((prev) =>
                    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                  )
                }
              />
              <p className="mt-1.5 text-[12px] text-faint">
                The job opens in the New column with this invoice already attached — its price is
                locked to the invoice.
              </p>
            </div>
          </div>
        )}

        {error && <p className="text-[12px] text-danger-text">{error}</p>}
      </div>
    </Modal>
  );
}
