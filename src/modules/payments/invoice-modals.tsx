import { useEffect, useState } from "react";
import { ChevronDown, History as HistoryIcon, Pencil, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { periodLabel } from "@shared/billing-periods";
import { isItemLine, type Invoice } from "@shared/schema/payment";
import { useAuth } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { fmtBizDate, fmtDate, todayIso } from "@/shared/lib/format";
import { fmtMoney, moneyInputValue, parseMoney } from "@/shared/lib/money";
import { Button, IconButton } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { FormField, Input } from "@/shared/ui/field";
import { InvoiceStatusPill } from "@/shared/ui/invoice-status";
import { CopyLink } from "@/shared/ui/copy-link";
import { Modal } from "@/shared/ui/modal";
import { Segmented } from "@/shared/ui/segmented";
import {
  useAddPayment,
  useCancelInvoice,
  useDeletePayment,
  useBulkTidy,
  useInvoice,
  useInvoiceAudit,
  useSetDelivery,
  useUpdateInvoice,
} from "./payments.api";
import { InvoicePdfActions } from "./invoice-pdf-actions";
import { AttachJob } from "./job-picker";
import {
  LinesEditor,
  draftTotal,
  emptyLine,
  linesProblem,
  toDraftLines,
  toLineInput,
  type DraftLine,
} from "./invoice-lines-editor";

// ── invoice detail + payments ────────────────────────────────────────────────

/**
 * The design's payment modal: totals, payment history, and the record-payment form.
 * Any user may record a payment; deleting one and cancelling the invoice are admin-only.
 */
export function InvoiceModal({
  invoiceId,
  onClose,
}: {
  invoiceId: string;
  onClose: () => void;
}) {
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
    addPayment.isPending ||
    deletePayment.isPending ||
    cancelInvoice.isPending ||
    archive.isPending;

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
      actions={<CopyLink href={`/billing?invoice=${invoiceId}`} />}
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
                if (
                  window.confirm("Cancel this invoice? It stays in history but owes nothing.")
                )
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
            {invoice.periodKey && <span>· for {periodLabel(invoice.periodKey)}</span>}
          </div>

          <InvoicePdfActions invoice={invoice} />

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

          {/* The editor spans the WHOLE card, above the two columns.
              It used to sit inside the left one, which was fine for three fields and impossible
              for a table of positions: description, hours, rate and amount cannot share half a
              modal, so the row overflowed and ran under the payment panel (user, 2026-08-21). */}
          {editing && (
            <EditInvoiceForm
              invoice={invoice}
              onDone={() => setEditing(false)}
              onError={setError}
            />
          )}

          {/* Two columns so the card fits without scrolling: WHAT is owed and what the invoice is
             on the left, the MOVEMENT of money — history, the payment form, the journal — on the
             right (user, 2026-08-01). One column on a narrow window. */}
          <div className="grid items-start gap-x-5 gap-y-4 md:grid-cols-2">
            <div className="space-y-4">
              {
                /* What's still OWED is the number this screen exists to answer, so it leads; the
             billed total and what's come in are the context behind it. */
                <div className="rounded-(--radius-panel) border border-border p-3">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-faint">
                        {invoice.balance === 0 ? "Settled" : "Remaining"}
                        {/* acts on THIS invoice → an icon, the same control the catalog rows use */}
                        {isAdmin && !invoice.cancelledAt && !editing && (
                          <IconButton
                            label="Edit the amount, positions, description or due date"
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
                        Billed{" "}
                        <span className="font-semibold tabular-nums text-ink-700">
                          {fmtMoney(invoice.amount)}
                        </span>
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
              }

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
                    <Link
                      className="text-primary-link hover:underline"
                      to={`/tasks?task=${invoice.taskId}`}
                    >
                      {invoice.taskTitle}
                    </Link>
                  </div>
                )}
                {!invoice.taskId &&
                  isAdmin &&
                  !invoice.cancelledAt &&
                  !invoice.periodKey &&
                  !invoice.clientArchived && (
                    <div className="py-1">
                      <AttachJob invoice={invoice} />
                    </div>
                  )}
                <div className="text-muted">
                  Client:{" "}
                  <Link
                    className="text-primary-link hover:underline"
                    to={`/clients/${invoice.clientId}`}
                  >
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
                          {isItemLine(line)
                            ? `${line.quantity / 100} pcs`
                            : `${(line.quantity / 100).toFixed(2)} h`}{" "}
                          × {fmtMoney(line.unitRate)}
                        </span>
                      )}
                      <span className="w-[110px] text-right tabular-nums">
                        {fmtMoney(line.amount)}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-baseline gap-3 border-t border-border bg-[#fafbfc] px-3 py-2 text-[13px] font-medium">
                    <span className="flex-1">Total</span>
                    <span className="w-[110px] text-right tabular-nums">
                      {fmtMoney(invoice.amount)}
                    </span>
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
                  {invoice.cancelledByName ? ` by ${invoice.cancelledByName}` : ""} — nothing is
                  owed.
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
    if (itemised && filled.length === 0)
      return onError("Add at least one position, with a name");
    const problem = itemised ? linesProblem(filled) : null;
    if (problem) return onError(problem);
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

      <div className="flex flex-wrap gap-3">
        {/* With positions on, the total lives at the foot of the table where it is being added up.
            A second, read-only "Amount" beside the due date was the same number twice, and the
            eye could not tell which one it was meant to act on. */}
        {!itemised && (
          <div className="w-[140px]">
            <FormField label="Amount">
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </FormField>
          </div>
        )}
        <div className="w-[150px]">
          <FormField label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </FormField>
        </div>
        <div className="min-w-[200px] flex-1">
          <FormField label={itemised ? "Note on the invoice" : "Description"}>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </FormField>
        </div>
      </div>
      {itemised && <LinesEditor lines={lines} onChange={setLines} />}

      <p className="text-[12px] text-faint">
        {invoice.paid > 0
          ? `Already paid ${fmtMoney(invoice.paid)} — the total can't go below that.`
          : "Clearing the due date leaves the invoice with none."}
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
