import { useEffect, useState } from "react";
import { ChevronDown, History as HistoryIcon, Pencil, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import type { Invoice } from "@shared/schema/payment";
import { lineAmount } from "@shared/schema/payment";
import { useAuth } from "@/app/auth";
import { useCatalog } from "@/modules/catalog";
import { useClient, useClients } from "@/modules/clients";
import { useAssignees } from "@/modules/tasks";
import { cn } from "@/shared/lib/cn";
import { fmtBizDate, fmtDate, todayIso } from "@/shared/lib/format";
import { fmtMoney, moneyInputValue, parseMoney } from "@/shared/lib/money";
import { AssigneePicker } from "@/shared/ui/assignee-picker";
import { Button, IconButton } from "@/shared/ui/button";
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
  useBulkTidy,
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
  const archive = useBulkTidy();
  const [editing, setEditing] = useState(false);

  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState(todayIso());
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);

  const busy =
    addPayment.isPending || deletePayment.isPending || cancelInvoice.isPending || archive.isPending;

  // the amount actually being recorded — the single number the button acts on and reports
  const typed = parseMoney(amount);

  // Open on the remaining balance: settling in full is what happens most of the time, and a
  // prefilled field is what let the second "pay in full" button go away.
  const balance = invoice?.balance;
  useEffect(() => {
    if (balance != null && balance > 0) setAmount(moneyInputValue(balance));
  }, [balance]);

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
      size="lg"
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
                    tidied: !invoice.tidiedAt,
                  }),
                )
              }
              title="Settled invoices can be tidied out of the working lists (reversible)"
            >
              {invoice.tidiedAt ? "↩ Back to the working list" : "📦 Tidy away"}
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
            <span>issued {fmtBizDate(invoice.issuedAt)}</span>
            {invoice.dueDate && (
              <span className={cn(invoice.status === "overdue" && "text-danger-text")}>
                · due {fmtBizDate(invoice.dueDate)}
              </span>
            )}
            {invoice.periodKey && <span>· period {invoice.periodKey}</span>}
          </div>

          {invoice.tidiedAt && (
            <p className="rounded-(--radius-field) bg-[#f1f3f6] px-3 py-2 text-[12px] text-muted">
              📦 Tidied away {fmtDate(invoice.tidiedAt)}
              {invoice.tidiedByName ? ` by ${invoice.tidiedByName}` : ""} — it stays searchable,
              just out of the working lists.
            </p>
          )}
          {invoice.clientArchived && (
            <p className="rounded-(--radius-field) bg-[#f7ede2] px-3 py-2 text-[12px] text-[#b5651d]">
              🗄 This client is archived — the invoice still counts as owed.
            </p>
          )}

          {/* Two columns so the card fits without scrolling: WHAT is owed and what the invoice is
             on the left, the MOVEMENT of money — history, the payment form, the journal — on the
             right (user, 2026-08-01). One column on a narrow window. */}
          <div className="grid items-start gap-x-5 gap-y-4 md:grid-cols-2">
          <div className="space-y-4">
          {editing ? (
            <EditInvoiceForm invoice={invoice} onDone={() => setEditing(false)} onError={setError} />
          ) : (
          /* What's still OWED is the number this screen exists to answer, so it leads; the
             billed total and what's come in are the context behind it. */
          <div className="rounded-(--radius-panel) border border-border p-3">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-faint">
                  {invoice.balance === 0 ? "Settled" : "Remaining"}
                  {/* acts on THIS invoice → an icon, the same control the catalog rows use */}
                  {isAdmin && !invoice.cancelledAt && (
                    <IconButton
                      label="Edit amount, description or due date"
                      className="h-6 w-6"
                      onClick={() => setEditing(true)}
                    >
                      <Pencil size={13} />
                    </IconButton>
                  )}
                </div>
                <div
                  className={cn(
                    "text-[26px] font-bold leading-tight tabular-nums",
                    invoice.balance === 0 && "text-success-text",
                    invoice.status === "overdue" && "text-danger-text",
                  )}
                >
                  {fmtMoney(invoice.balance)}
                </div>
              </div>
              <div className="text-right text-[12px] text-muted">
                <div>
                  Billed <span className="font-semibold tabular-nums text-ink-700">{fmtMoney(invoice.amount)}</span>
                </div>
                <div>
                  Paid{" "}
                  <span className="font-semibold tabular-nums text-success-text">
                    {fmtMoney(invoice.paid)}
                  </span>
                </div>
              </div>
            </div>
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

          {/* The breakdown, when there is one. An invoice without positions shows nothing here and
              reads exactly as it did before they existed. */}
          {invoice.lines.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-(--radius-field) border border-border">
              {invoice.lines.map((line) => (
                <div
                  key={line.id}
                  className="flex items-baseline gap-3 border-b border-divider px-3 py-2 text-[13px] last:border-0"
                >
                  <span className="min-w-0 flex-1 truncate">{line.description}</span>
                  {line.quantity != null && line.unitRate != null && (
                    <span className="whitespace-nowrap text-[12px] text-muted tabular-nums">
                      {(line.quantity / 100).toFixed(2)} h × {fmtMoney(line.unitRate)}
                    </span>
                  )}
                  <span className="w-[110px] text-right tabular-nums">{fmtMoney(line.amount)}</span>
                </div>
              ))}
              <div className="flex items-baseline gap-3 border-t border-border bg-[#fafbfc] px-3 py-2 text-[13px] font-medium">
                <span className="flex-1">Total</span>
                <span className="w-[110px] text-right tabular-nums">{fmtMoney(invoice.amount)}</span>
              </div>
            </div>
          )}

          {/* DISCLOSURE, not a row action — so it keeps its word ("History") and wears an icon
              beside it. An icon alone here would be a riddle: nothing else on the card is hidden. */}
          {isAdmin && (
            <div>
              <button
                type="button"
                className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint hover:text-ink"
                onClick={() => setShowAudit((v) => !v)}
              >
                <HistoryIcon size={13} />
                History
                <ChevronDown
                  size={13}
                  className={cn("transition-transform", showAudit && "rotate-180")}
                />
              </button>
              {/* the log grows without bound, so IT scrolls — the card itself must not */}
              {showAudit && (
                <div className="mt-1.5 max-h-32 space-y-1 overflow-y-auto pr-1 text-[12px] text-muted">
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

          <div className="space-y-4">
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
                  <span className="text-muted">{fmtBizDate(p.paidAt)}</span>
                  {p.reference && <span className="text-faint">ref: {p.reference}</span>}
                  <span className="ml-auto text-[12px] text-faint">{p.createdByName}</span>
                  {isAdmin && (
                    <IconButton
                      label="Delete payment"
                      disabled={busy}
                      className="-mr-1 hover:text-danger"
                      onClick={() => {
                        if (window.confirm("Delete this payment?"))
                          void run(() => deletePayment.mutateAsync(p.id));
                      }}
                    >
                      <Trash2 size={14} />
                    </IconButton>
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
            /* ONE action, and it always records exactly what the field says. There used to be a
               second button, "Pay remaining", which silently ignored a typed amount — two
               same-sized buttons that did different things with the same form (user, 2026-08-01).
               Paying in full is the common case, so the field simply OPENS on the remaining
               balance; "Full amount" puts it back if you edited it. */
            <div className="space-y-2.5 rounded-(--radius-panel) border border-border p-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
                  Record a payment
                </div>
                {typed !== invoice.balance && (
                  <button
                    type="button"
                    className="text-[12px] font-medium text-primary-link hover:underline"
                    onClick={() => setAmount(moneyInputValue(invoice.balance))}
                  >
                    Full amount ({fmtMoney(invoice.balance)})
                  </button>
                )}
              </div>
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
                // short enough to READ in the column — the long form was clipped mid-word
                placeholder="Bank / external ref (optional)"
                title="For reconciling against the bank or another system"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
              <Button
                variant="positive"
                className="w-full"
                disabled={busy || typed <= 0 || typed > invoice.balance}
                onClick={() => void record(typed)}
              >
                {typed > invoice.balance
                  ? `More than the ${fmtMoney(invoice.balance)} left`
                  : typed > 0
                    ? `Record payment · ${fmtMoney(typed)}`
                    : "Record payment"}
              </Button>
              {typed > 0 && typed < invoice.balance && (
                <p className="text-[12px] text-muted">
                  Part payment — {fmtMoney(invoice.balance - typed)} would still be owed.
                </p>
              )}
            </div>
          )}

          {error && <p className="text-[12px] text-danger-text">{error}</p>}

          </div>
          </div>
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
  const [itemised, setItemised] = useState(invoice.lines.length > 0);
  const [lines, setLines] = useState<DraftLine[]>(() =>
    invoice.lines.length > 0 ? toDraftLines(invoice.lines) : [emptyLine()],
  );

  const filled = lines.filter((l) => l.description.trim());
  const total = itemised ? draftTotal(filled) : parseMoney(amount);

  async function save() {
    onError(null);
    if (itemised && filled.length === 0) return onError("Add at least one position, with a name");
    if (total <= 0) return onError("Enter an amount");
    try {
      await update.mutateAsync({
        invoiceId: invoice.id,
        input: {
          amount: total,
          // [] clears the positions and hands the total back to the amount field
          lines: itemised ? toLineInput(filled) : [],
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
      <Segmented
        value={itemised ? "lines" : "flat"}
        onChange={(v) => setItemised(v === "lines")}
        options={[
          { value: "flat", label: "One amount" },
          { value: "lines", label: "Positions" },
        ]}
      />

      <div className="flex gap-3">
        <div className="w-[140px]">
          <FormField label="Amount">
            <Input
              inputMode="decimal"
              value={itemised ? moneyInputValue(total) : amount}
              readOnly={itemised}
              onChange={(e) => setAmount(e.target.value)}
            />
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
      {itemised && <LinesEditor lines={lines} onChange={setLines} />}

      <p className="text-[12px] text-faint">
        Already paid: {fmtMoney(invoice.paid)} — the amount can&apos;t go below that. Clearing the
        date leaves the invoice with no due date.
        {itemised && " With positions on, the amount is their sum."}
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

  // open on the client's default service — the one they're usually billed for
  useEffect(() => {
    if (subscriptionId || subscriptions.length === 0) return;
    const preferred =
      subscriptions.find((s) => s.isDefault) ?? (subscriptions.length === 1 ? subscriptions[0] : undefined);
    if (preferred) setSubscriptionId(preferred.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the picked client changes
  }, [client.data?.id]);

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

/**
 * The positions editor — the toggle the firm asked for.
 *
 * It changes what you FILL IN, not what is stored: with it off an invoice is a single amount, as
 * every invoice was before this existed; with it on the amount is the sum of the rows. There is no
 * "invoice type" anywhere in the database, because the difference is "does it have a breakdown"
 * and the rows themselves already answer that.
 *
 * Hours are entered as hours ("3.5") and carried as hundredths, so the arithmetic stays integer —
 * a float hour times a rate is where the last cent goes missing.
 */
function LinesEditor({
  lines,
  onChange,
}: {
  lines: DraftLine[];
  onChange: (next: DraftLine[]) => void;
}) {
  const set = (i: number, patch: Partial<DraftLine>) =>
    onChange(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[1fr_80px_110px_110px_28px] items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-faint">
        <div>Position</div>
        <div className="text-right">Hours</div>
        <div className="text-right">Rate</div>
        <div className="text-right">Amount</div>
        <div />
      </div>

      {lines.map((line, i) => {
        const computed = draftAmount(line);
        return (
          <div key={i} className="grid grid-cols-[1fr_80px_110px_110px_28px] items-center gap-2">
            <Input
              value={line.description}
              placeholder="Consultation"
              onChange={(e) => set(i, { description: e.target.value })}
            />
            <Input
              inputMode="decimal"
              className="text-right"
              placeholder="—"
              value={line.hours}
              onChange={(e) => set(i, { hours: e.target.value })}
            />
            <Input
              inputMode="decimal"
              className="text-right"
              placeholder="—"
              value={line.rate}
              onChange={(e) => set(i, { rate: e.target.value })}
            />
            {/* read-only the moment hours AND a rate are both there — the number is theirs, and
                two editable fields that must agree is how they stop agreeing */}
            <Input
              inputMode="decimal"
              className="text-right"
              value={computed !== null ? moneyInputValue(computed) : line.amount}
              readOnly={computed !== null}
              onChange={(e) => set(i, { amount: e.target.value })}
            />
            <IconButton
              label="Remove this position"
              className="hover:text-danger"
              onClick={() => onChange(lines.filter((_, n) => n !== i))}
            >
              <Trash2 size={15} />
            </IconButton>
          </div>
        );
      })}

      <div className="flex items-center justify-between pt-1">
        <Button size="sm" variant="secondary" onClick={() => onChange([...lines, emptyLine()])}>
          + Position
        </Button>
        <span className="text-[13px]">
          Total{" "}
          <span className="font-semibold tabular-nums">{fmtMoney(draftTotal(lines))}</span>
        </span>
      </div>
    </div>
  );
}

/** A row while it is being typed — strings, because a half-typed number is not a number yet. */
interface DraftLine {
  description: string;
  hours: string;
  rate: string;
  amount: string;
}

const emptyLine = (): DraftLine => ({ description: "", hours: "", rate: "", amount: "" });

/** Hours as typed → hundredths of an hour. "3.5" → 350. */
const parseHours = (text: string): number | null => {
  const n = Number(text.replace(",", ".").trim());
  return text.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : Math.round(n * 100);
};

/** A row's amount when hours AND a rate are both present — otherwise the typed one stands. */
function draftAmount(line: DraftLine): number | null {
  const hours = parseHours(line.hours);
  const rate = parseMoney(line.rate);
  return hours !== null && rate > 0 ? lineAmount(hours, rate) : null;
}

const draftTotal = (lines: DraftLine[]) =>
  lines.reduce((sum, l) => sum + (draftAmount(l) ?? parseMoney(l.amount)), 0);

/** Draft rows → what the API takes. */
const toLineInput = (lines: DraftLine[]) =>
  lines.map((l) => {
    const hours = parseHours(l.hours);
    const rate = parseMoney(l.rate);
    return {
      description: l.description.trim(),
      quantity: hours,
      unitRate: rate > 0 ? rate : null,
      amount: draftAmount(l) ?? parseMoney(l.amount),
    };
  });

/** A stored invoice's positions → editable rows. */
const toDraftLines = (lines: Invoice["lines"]): DraftLine[] =>
  lines.map((l) => ({
    description: l.description,
    hours: l.quantity != null ? String(l.quantity / 100) : "",
    rate: l.unitRate != null ? moneyInputValue(l.unitRate) : "",
    amount: moneyInputValue(l.amount),
  }));
