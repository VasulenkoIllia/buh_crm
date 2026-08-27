import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CircleDollarSign } from "lucide-react";
import type { Invoice, InvoiceListQuery } from "@shared/schema/payment";
import { useClient } from "@/modules/clients";
import { cn } from "@/shared/lib/cn";
import { fmtBizDate, fmtDate } from "@/shared/lib/format";
import { fmtMoney } from "@/shared/lib/money";
import { Button } from "@/shared/ui/button";
import { InvoiceStatusPill } from "@/shared/ui/invoice-status";
import { FilterChips } from "@/shared/ui/tabs";
import { InvoiceModal, NewInvoiceModal } from "./invoice-modals";
import {
  useBulkTidy,
  useBulkDelivery,
  useInvoices,
  useMarkPaid,
  useSetDelivery,
} from "./payments.api";

type Filter = InvoiceListQuery["filter"];

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unpaid", label: "Unpaid" },
  { key: "overdue", label: "Overdue ⚠" },
  { key: "paid", label: "Paid" },
  { key: "unsent", label: "Not sent ✉" },
  { key: "cancelled", label: "Cancelled" },
  { key: "settled", label: "Settled" },
];

/**
 * checkbox · № · client · service · issued · due · amount · paid · status · delivery
 *
 * `minmax(0,1fr)`, never a bare `1fr`. The header and the rows are SEPARATE grid containers inside
 * one horizontally scrolling box, and a bare `1fr` is `minmax(auto,1fr)` — its floor is the widest
 * thing in it. So a long client name widened that track in the ROWS and not in the header, and
 * every column after it drifted left of its own label (user, 2026-08-27). A zero floor makes the
 * two resolve identically whatever they hold; the cells truncate instead.
 */
const GRID =
  "grid-cols-[30px_104px_minmax(0,1fr)_minmax(0,1fr)_72px_72px_84px_84px_76px_96px]";

/** Billing / Unpaid — every invoice with what's been paid against it. */
export function BillingPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; hint?: string; skipped: boolean } | null>(null);

  // deep links: ?invoice=<id> opens that invoice (from a task card), ?client=<id> narrows the
  // list to one client (drill-through from the client card's Invoices tab)
  const [searchParams, setSearchParams] = useSearchParams();
  const invoiceParam = searchParams.get("invoice");
  const clientParam = searchParams.get("client");
  useEffect(() => {
    if (invoiceParam) setOpenId(invoiceParam);
  }, [invoiceParam]);

  const { data, isLoading, error: loadError, refetch } = useInvoices({
    filter,
    search: search || undefined,
    clientId: clientParam ?? undefined,
    page,
  });
  const client = useClient(clientParam ?? undefined);
  const markPaid = useMarkPaid();
  const bulkDelivery = useBulkDelivery();
  const bulkTidy = useBulkTidy();

  const items = data?.items ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const chosen = selected.filter((id) => items.some((i) => i.id === id));
  const chosenRows = items.filter((i) => chosen.includes(i.id));
  // what each bulk action would actually touch — shown on the buttons so nothing happens silently
  const eligible = {
    toSend: chosenRows.filter((i) => !i.cancelledAt && i.delivery === "created").length,
    toPay: chosenRows.filter((i) => !i.cancelledAt && i.balance > 0).length,
    toTidy: chosenRows.filter((i) => !i.tidiedAt && (i.cancelledAt || i.balance === 0)).length,
  };
  const busy = markPaid.isPending || bulkDelivery.isPending || bulkTidy.isPending;

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const resetView = () => {
    setPage(1);
    setSelected([]);
    setNote(null);
  };

  /**
   * Run a bulk mark and report exactly what happened. A partially-applied action that says
   * nothing is the worst outcome — so the banner always names the count AND why any were skipped.
   */
  async function runBulk(
    label: string,
    action: () => Promise<{ changed: number; skipped: number }>,
    skipReason: string,
  ) {
    setError(null);
    setNote(null);
    try {
      const { changed, skipped } = await action();
      setNote({
        text:
          changed > 0
            ? `${label} ${changed} invoice${changed === 1 ? "" : "s"}.`
            : `Nothing to do — no invoice was ${label.toLowerCase()}.`,
        hint: skipped > 0 ? `${skipped} skipped — ${skipReason}` : undefined,
        skipped: skipped > 0 || changed === 0,
      });
      setSelected([]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-[960px]">
      <div className="mb-3.5 flex flex-wrap items-center gap-3.5">
        <h1 className="text-[20px] font-semibold">Billing</h1>
        {data && (
          <span className="whitespace-nowrap text-[13px] text-muted-400">
            {data.total} invoice{data.total === 1 ? "" : "s"}
          </span>
        )}
        {clientParam && (
          <span className="inline-flex items-center gap-1.5 rounded-(--radius-chip) bg-[#eef1fb] px-2 py-1 text-[12px] text-primary-link">
            {client.data?.displayName ?? "client"}
            <button
              type="button"
              onClick={() => {
                setSearchParams({}, { replace: true });
                resetView();
              }}
              aria-label="Show all clients"
            >
              ×
            </button>
          </span>
        )}
        <input
          className="ml-2 w-64 rounded-(--radius-card) border border-[#d9dde3] bg-surface px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:border-primary"
          placeholder="🔍 Search: number, client…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Button className="ml-auto" onClick={() => setNewOpen(true)}>
          + New invoice
        </Button>
      </div>

      <FilterChips
        className="mb-4"
        value={filter}
        onChange={(key) => {
          setFilter(key);
          resetView();
        }}
        options={FILTERS.map((f) => ({
          value: f.key,
          label: f.label,
          count: data?.counts[f.key],
          tone: f.key === "overdue" ? ("danger" as const) : undefined,
        }))}
      />

      {loadError && (
        <div className="rounded-(--radius-panel) border border-[#f0c9c9] bg-surface p-11 text-center">
          <div className="mb-2 text-[28px]">⚠</div>
          <div className="text-[15px] font-semibold text-danger-text">Couldn't load data</div>
          <p className="mt-1 text-[13px] text-muted">
            Something went wrong while loading this list.
          </p>
          <Button className="mt-4" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      )}

      {isLoading && <SkeletonList />}

      {data && !isLoading && (
        <>
          {items.length === 0 ? (
            <EmptyState
              onCreate={() => setNewOpen(true)}
              hasFilters={!!search || filter !== "all" || !!clientParam}
            />
          ) : (
            <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface">
              <div
                className={cn(
                  "grid min-w-[960px] items-center gap-x-3 border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-faint",
                  GRID,
                )}
              >
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={items.length > 0 && chosen.length === items.length}
                  onChange={(e) => setSelected(e.target.checked ? items.map((i) => i.id) : [])}
                />
                <div>№</div>
                <div>Client</div>
                <div>Service</div>
                {/* issued before due: an invoice is raised and then falls due, and reading them in
                    that order is how you see at a glance how long one has been outstanding */}
                <div>Issued</div>
                <div>Due</div>
                <div className="text-right">Amount</div>
                <div className="text-right">Paid</div>
                <div>Status</div>
                <div>Delivery</div>
              </div>

              {items.map((invoice) => (
                <InvoiceRow
                  key={invoice.id}
                  invoice={invoice}
                  checked={selected.includes(invoice.id)}
                  onToggle={() => toggle(invoice.id)}
                  onOpen={() => setOpenId(invoice.id)}
                  onError={setError}
                />
              ))}
            </div>
          )}

          {/* bulk marks — everything doable to many invoices without opening each one.
              Each button states up front how many of the selection it can actually touch. */}
          {chosen.length > 0 && (
            <div className="mt-3 rounded-(--radius-panel) border border-primary/30 bg-[#f7f9ff] px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-semibold">{chosen.length} selected</span>
                <BulkAction
                  label="✉ Mark as sent"
                  eligible={eligible.toSend}
                  total={chosen.length}
                  disabled={busy}
                  reason="already marked as sent"
                  onRun={() =>
                    void runBulk(
                      "Marked as sent",
                      () => bulkDelivery.mutateAsync({ invoiceIds: chosen, sent: true }),
                      "they were already sent (or are cancelled)",
                    )
                  }
                />
                <BulkAction
                  label="Mark as paid"
                  tone="positive"
                  eligible={eligible.toPay}
                  total={chosen.length}
                  disabled={busy}
                  reason="nothing left to pay on them"
                  onRun={() =>
                    void runBulk(
                      "Settled",
                      async () => {
                        const { settled, skipped } = await markPaid.mutateAsync({
                          invoiceIds: chosen,
                        });
                        return { changed: settled, skipped };
                      },
                      "they were already settled (or are cancelled)",
                    )
                  }
                />
                {filter === "settled" ? (
                  <BulkAction
                    label="↩ Restore"
                    eligible={chosen.length}
                    total={chosen.length}
                    disabled={busy}
                    reason=""
                    onRun={() =>
                      void runBulk(
                        "Restored",
                        () => bulkTidy.mutateAsync({ invoiceIds: chosen, tidied: false }),
                        "they are not tidied away",
                      )
                    }
                  />
                ) : (
                  <BulkAction
                    label="📦 Tidy away"
                    eligible={eligible.toTidy}
                    total={chosen.length}
                    disabled={busy}
                    reason="only settled invoices (paid or cancelled) can be tidied away"
                    onRun={() =>
                      void runBulk(
                        "Tidied away",
                        () => bulkTidy.mutateAsync({ invoiceIds: chosen, tidied: true }),
                        "they still have a balance (only settled invoices can be tidied away)",
                      )
                    }
                  />
                )}
                <button
                  type="button"
                  className="ml-auto text-[12px] text-muted hover:underline"
                  onClick={() => setSelected([])}
                >
                  clear selection
                </button>
              </div>
              {eligible.toTidy < chosen.length && filter !== "settled" && (
                <p className="mt-1.5 text-[12px] text-muted">
                  {chosen.length - eligible.toTidy} of the selected still have a balance — an
                  invoice that is still owed can't be tidied away, so it never hides from Billing.
                </p>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[13px]">
            <div className="text-muted">
              Total receivable: <b className="text-ink">{fmtMoney(data.totals.receivable)}</b> ·
              Overdue: <b className="text-danger-text">{fmtMoney(data.totals.overdue)}</b>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Prev
                </Button>
                <span className="text-muted">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
          {note && (
            <div
              className={cn(
                "mt-3 rounded-(--radius-field) px-3 py-2 text-[13px]",
                note.skipped ? "bg-[#f7ede2] text-[#b5651d]" : "bg-[#e6f4ea] text-success-text",
              )}
            >
              <span className="font-medium">
                {note.skipped ? "⚠ " : "✓ "}
                {note.text}
              </span>
              {note.hint && <span className="ml-1.5 opacity-80">{note.hint}</span>}
            </div>
          )}
          {error && <p className="mt-2 text-[13px] text-danger-text">{error}</p>}
        </>
      )}

      {openId && (
        <InvoiceModal
          invoiceId={openId}
          onClose={() => {
            setOpenId(null);
            // drop the deep-link param so a reload doesn't re-open the modal
            if (invoiceParam) {
              setSearchParams(clientParam ? { client: clientParam } : {}, { replace: true });
            }
          }}
        />
      )}
      {newOpen && (
        <NewInvoiceModal
          presetClientId={clientParam ?? undefined}
          onClose={() => setNewOpen(false)}
          onCreated={(inv) => setOpenId(inv.id)}
        />
      )}
    </div>
  );
}

function InvoiceRow({
  invoice,
  checked,
  onToggle,
  onOpen,
  onError,
}: {
  invoice: Invoice;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onError: (message: string | null) => void;
}) {
  const setDelivery = useSetDelivery();
  const overdue = invoice.status === "overdue";
  const sent = invoice.delivery === "sent";

  return (
    <div
      onClick={onOpen}
      className={cn(
        "grid min-w-[960px] cursor-pointer items-center gap-x-3 border-b border-divider px-4 py-2.5 text-[13px] last:border-0 hover:bg-divider/40",
        GRID,
        overdue && "bg-[#fef6f6]",
        (invoice.cancelledAt || invoice.tidiedAt) && "opacity-60",
      )}
    >
      <div onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`Select ${invoice.number}`}
        />
      </div>
      <div className="truncate tabular-nums text-ink-700" title={invoice.number}>
        {overdue && <span className="mr-1 text-danger-text">⚠</span>}
        {invoice.number}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-medium">{invoice.clientName}</span>
        {invoice.clientArchived && (
          <span className="flex-none text-[11px] text-faint" title="Client archived — still owed">
            🗄
          </span>
        )}
      </div>
      <div className="truncate text-ink-700" title={invoice.serviceName ?? invoice.description ?? ""}>
        {invoice.serviceName ?? invoice.description ?? "—"}
        {invoice.periodKey && <span className="text-faint"> · {invoice.periodKey}</span>}
      </div>
      {/* `fmtDate`, not `fmtBizDate`: `issuedAt` is an INSTANT and is read on the firm's clock,
          while `dueDate` below is a calendar day and is read in UTC */}
      <div className="text-[12px] text-muted">{fmtDate(invoice.issuedAt)}</div>
      <div className={cn("text-[12px]", overdue ? "text-danger-text" : "text-muted")}>
        {invoice.dueDate ? fmtBizDate(invoice.dueDate) : "—"}
      </div>
      <div className="text-right font-semibold tabular-nums">{fmtMoney(invoice.amount)}</div>
      <div className="text-right tabular-nums text-muted">
        {invoice.paid > 0 ? fmtMoney(invoice.paid) : "—"}
      </div>
      <div>
        <InvoiceStatusPill status={invoice.status} />
      </div>
      {/* delivery is its own column and its own labelled control — a bare icon read as noise */}
      <div onClick={(e) => e.stopPropagation()}>
        {invoice.cancelledAt ? (
          <span className="text-[12px] text-faint">—</span>
        ) : (
          <button
            type="button"
            disabled={setDelivery.isPending}
            className={cn(
              "inline-flex w-full items-center justify-center gap-1 rounded-(--radius-btn-sm) border px-2 py-1 text-[12px] font-medium transition-colors disabled:opacity-50",
              sent
                ? "border-transparent bg-[#e6f4ea] text-success-text hover:bg-[#d7ecdd]"
                : "border-dashed border-[#c7ccd3] text-muted hover:border-primary hover:text-primary-link",
            )}
            title={
              sent
                ? `Sent${invoice.sentAt ? ` ${fmtDate(invoice.sentAt)}` : ""} — click to undo`
                : "Not sent yet — click to mark it as handed to the client"
            }
            onClick={() => {
              onError(null);
              setDelivery
                .mutateAsync({ invoiceId: invoice.id, input: { sent: !sent } })
                .catch((err: Error) => onError(err.message));
            }}
          >
            {sent ? "✉ Sent" : "✉ Not sent"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One bulk button. It always shows how many of the selection it can touch ("2 of 5") and goes
 * disabled with the reason when that's zero — so a click never looks like it did nothing.
 */
function BulkAction({
  label,
  eligible,
  total,
  disabled,
  reason,
  tone,
  onRun,
}: {
  label: string;
  eligible: number;
  total: number;
  disabled: boolean;
  reason: string;
  tone?: "positive";
  onRun: () => void;
}) {
  const none = eligible === 0;
  return (
    <Button
      size="sm"
      variant={tone === "positive" && !none ? "positive" : "secondary"}
      disabled={disabled || none}
      title={none ? `Not available — ${reason}` : undefined}
      onClick={onRun}
    >
      {label}
      <span className="ml-1 opacity-70">
        {none ? "(0)" : eligible === total ? `(${total})` : `(${eligible} of ${total})`}
      </span>
    </Button>
  );
}

function SkeletonList() {
  return (
    <div className="overflow-hidden rounded-(--radius-panel) border border-border bg-surface">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-divider px-4 py-[15px] last:border-0"
        >
          <div className="h-[11px] w-[90px] animate-pulse rounded-md bg-[#eef0f3]" />
          <div className="h-[11px] flex-1 animate-pulse rounded-md bg-[#eef0f3]" />
          <div className="h-[11px] w-[70px] animate-pulse rounded-md bg-[#eef0f3]" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onCreate, hasFilters }: { onCreate: () => void; hasFilters: boolean }) {
  return (
    <div className="rounded-(--radius-panel) border border-dashed border-[#cfd4db] bg-surface p-12 text-center">
      {/* same pictogram as the sidebar's Billing entry, so the empty state names the page */}
      <CircleDollarSign size={30} strokeWidth={1.5} className="mx-auto mb-2 text-[#c7ccd3]" />
      <div className="text-[15px] font-semibold">
        {hasFilters ? "Nothing matches this filter" : "No invoices yet"}
      </div>
      <p className="mt-1 text-[13px] text-muted">
        {hasFilters
          ? "Try another filter or clear the search."
          : "Invoices appear when a one-time job is billed, a subscription period comes due, or you issue one here."}
      </p>
      {!hasFilters && (
        <Button className="mt-4" onClick={onCreate}>
          + New invoice
        </Button>
      )}
    </div>
  );
}
