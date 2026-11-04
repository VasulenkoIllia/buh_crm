import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useRecordParam } from "@/shared/lib/use-record-param";
import { CircleCheck, CircleDollarSign, TriangleAlert } from "lucide-react";
import type { Invoice, InvoiceListQuery } from "@shared/schema/payment";
import { useClient } from "@/modules/clients";
import { cn } from "@/shared/lib/cn";
import { useDebounced } from "@/shared/lib/use-debounced";
import { fmtBizDate, fmtDate } from "@/shared/lib/format";
import { fmtMoney } from "@/shared/lib/money";
import { Button } from "@/shared/ui/button";
import { Select } from "@/shared/ui/field";
import { InvoiceStatusPill } from "@/shared/ui/invoice-status";
import { SearchInput } from "@/shared/ui/search-input";
import { FilterChips } from "@/shared/ui/tabs";
import { ClearButton } from "@/shared/ui/clear-button";
import { InvoiceModal } from "./invoice-modals";
import { NewInvoiceModal } from "./new-invoice-modal";
import { PageCheckbox, SelectionBar, type BulkKind } from "./selection-bar";
import { invoiceDetail, invoiceSubject } from "@shared/invoice-subject";
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
const GRID = "grid-cols-[30px_104px_minmax(0,1fr)_minmax(0,1fr)_72px_72px_84px_84px_76px_96px]";

/** Billing / Unpaid — every invoice with what's been paid against it. */
export function BillingPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  // The request follows the pause, not the keystroke: without this every letter typed was a
  // separate call against the app's global rate limit. `placeholderData` keeps the old rows
  // on screen meanwhile, so the wait is not visible as a flash of empty list.
  const settledSearch = useDebounced(search);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  // the open invoice lives in the address, so the link to it is the page's own URL (shared hook)
  const [openId, openInvoice, closeInvoice] = useRecordParam("invoice");
  const [newOpen, setNewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; hint?: string; skipped: boolean } | null>(
    null,
  );

  // ?client=<id> narrows the list to one client (drill-through from the client card's Invoices tab)
  const [searchParams, setSearchParams] = useSearchParams();
  const clientParam = searchParams.get("client");
  // ?job=<id> arrives from a job's card and opens the form on that job, once: the address forgets
  // it at once, so neither closing the form nor a reload brings it back
  const jobParam = searchParams.get("job");
  const [jobToBill, setJobToBill] = useState<string>();
  // Duplicate on an invoice's card: the card closes and New invoice opens filled in from it
  const [copyOf, setCopyOf] = useState<Invoice>();
  useEffect(() => {
    if (!jobParam) return;
    setJobToBill(jobParam);
    setNewOpen(true);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("job");
        return next;
      },
      { replace: true },
    );
  }, [jobParam, setSearchParams]);
  // one of that client's companies, as on the card. Kept WITH the client it was picked for, so it
  // can never narrow another client's list once the chip is cleared or the address changes.
  const [companyPick, setCompanyPick] = useState<{
    clientId: string;
    companyId: string;
  } | null>(null);
  const companyId =
    companyPick && companyPick.clientId === clientParam ? companyPick.companyId : "";

  const {
    data,
    isLoading,
    error: loadError,
    refetch,
  } = useInvoices({
    filter,
    search: settledSearch || undefined,
    clientId: clientParam ?? undefined,
    companyId: companyId || undefined,
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
  const selectAll = (on: boolean) => setSelected(on ? items.map((i) => i.id) : []);
  const hasChosen = chosen.length > 0;

  /**
   * The select-all box and the bar swap places with the headings. A keyboard's focus, dropped with
   * the one that went, lands on the one that came rather than on the page; not scrolled to, so a
   * phone that cleared at the foot of the list stays there.
   */
  const headBox = useRef<HTMLInputElement>(null);
  const barBox = useRef<HTMLInputElement>(null);
  const wasChosen = useRef(hasChosen);
  useEffect(() => {
    if (wasChosen.current === hasChosen) return;
    wasChosen.current = hasChosen;
    // gone with the bar, or still held by the hidden headings until the browser lets it go
    const held = document.activeElement;
    if (!held || held === document.body || held.getClientRects().length === 0) {
      (hasChosen ? barBox : headBox).current?.focus({ preventScroll: true });
    }
  }, [hasChosen]);

  // what a run did is said above the list, which a phone, its bar at the foot, may have left behind
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (note || error) result.current?.scrollIntoView({ block: "nearest" });
  }, [note, error]);
  const [barHeight, setBarHeight] = useState(0);

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
    try {
      const { changed, skipped } = await action();
      setError(null);
      setNote({
        text:
          changed > 0
            ? `${label} ${changed} invoice${changed === 1 ? "" : "s"}.`
            : `Nothing to do: no invoice was ${label.toLowerCase()}.`,
        hint: skipped > 0 ? `${skipped} skipped: ${skipReason}.` : undefined,
        skipped: skipped > 0 || changed === 0,
      });
      setSelected([]);
    } catch (e) {
      setNote(null);
      setError((e as Error).message);
    }
  }

  const bulk: Record<BulkKind, () => void> = {
    send: () =>
      void runBulk(
        "Marked as sent",
        () => bulkDelivery.mutateAsync({ invoiceIds: chosen, sent: true }),
        "already sent or cancelled",
      ),
    pay: () =>
      void runBulk(
        "Settled",
        async () => {
          const { settled, skipped } = await markPaid.mutateAsync({ invoiceIds: chosen });
          return { changed: settled, skipped };
        },
        "already settled or cancelled",
      ),
    tidy: () =>
      void runBulk(
        "Tidied away",
        () => bulkTidy.mutateAsync({ invoiceIds: chosen, tidied: true }),
        "they still have a balance",
      ),
    restore: () =>
      void runBulk(
        "Restored",
        () => bulkTidy.mutateAsync({ invoiceIds: chosen, tidied: false }),
        "not tidied away",
      ),
  };

  return (
    // as wide as Clients: at 960px the client and service columns had 101px each, and a company
    // under the client read "BE1 BARO Equi…" on a 13-inch screen (owner, 2026-10-07)
    <div className="mx-auto max-w-[1320px]">
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
            <ClearButton
              label="Show all clients"
              onClick={() => {
                setSearchParams({}, { replace: true });
                setCompanyPick(null);
                resetView();
              }}
            />
          </span>
        )}
        {clientParam && client.data && client.data.companies.length > 0 && (
          <Select
            className="h-9 w-auto max-w-[260px] text-[13px]"
            aria-label="Filter by company"
            value={companyId}
            onChange={(e) => {
              setCompanyPick({ clientId: clientParam, companyId: e.target.value });
              resetView();
            }}
          >
            <option value="">All companies</option>
            {/* "root" = billed to the client directly, with no company involved */}
            <option value="root">No company (the client)</option>
            {client.data.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        <SearchInput
          className="ml-2 w-64"
          placeholder="🔍 Search: number, client, company…"
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
          {/* above the list, where the bar that did it was; kept mounted, so a reader hears it */}
          <div
            ref={result}
            aria-live="polite"
            className={cn((note || error) && "mb-3 space-y-2")}
          >
            {note && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-(--radius-field) px-3 py-2 text-[13px]",
                  note.skipped
                    ? "bg-[#f7ede2] text-[#b5651d]"
                    : "bg-success-soft text-success-text",
                )}
              >
                {note.skipped ? (
                  <TriangleAlert size={15} className="mt-0.5 shrink-0" />
                ) : (
                  <CircleCheck size={15} className="mt-0.5 shrink-0" />
                )}
                <span>
                  <span className="font-medium">{note.text}</span>
                  {note.hint && <span className="ml-1.5 opacity-80">{note.hint}</span>}
                </span>
              </div>
            )}
            {error && <p className="text-[13px] text-danger-text">{error}</p>}
          </div>
          {items.length === 0 ? (
            <EmptyState
              onCreate={() => setNewOpen(true)}
              hasFilters={!!search || filter !== "all" || !!clientParam}
            />
          ) : (
            // only the list scrolls sideways on a narrow screen, so the bar's actions stay in reach
            <div className="overflow-hidden rounded-(--radius-panel) border border-border bg-surface">
              {hasChosen && (
                <SelectionBar
                  count={chosen.length}
                  total={items.length}
                  eligible={eligible}
                  settledView={filter === "settled"}
                  busy={busy}
                  boxRef={barBox}
                  onAll={selectAll}
                  onClear={() => setSelected([])}
                  onHeight={setBarHeight}
                  run={bulk}
                />
              )}
              <div className="overflow-x-auto">
                {/* the bar above stands in for the headings while anything is ticked, at their
                    height, so the rows do not move under the pointer */}
                <div
                  className={cn(
                    "grid h-11 min-w-[960px] items-center gap-x-3 border-b border-border px-4 text-[11px] font-medium uppercase tracking-wide text-faint",
                    GRID,
                    hasChosen && "sm:hidden",
                  )}
                >
                  <PageCheckbox
                    boxRef={headBox}
                    chosen={chosen.length}
                    total={items.length}
                    onAll={selectAll}
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
                    onOpen={() => openInvoice(invoice.id)}
                    onError={setError}
                  />
                ))}
              </div>
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
          {/* room for the phone's bar at the foot, as tall as it is, so it covers neither the
              last row nor Next */}
          {hasChosen && <div aria-hidden className="sm:hidden" style={{ height: barHeight }} />}
        </>
      )}

      {openId && (
        <InvoiceModal
          invoiceId={openId}
          onClose={closeInvoice}
          onDuplicate={(invoice) => {
            closeInvoice();
            setCopyOf(invoice);
            setNewOpen(true);
          }}
        />
      )}
      {newOpen && (
        <NewInvoiceModal
          presetClientId={clientParam ?? undefined}
          presetJobId={jobToBill}
          copyOf={copyOf}
          onClose={() => {
            setNewOpen(false);
            setJobToBill(undefined);
            setCopyOf(undefined);
          }}
          onCreated={(inv) => openInvoice(inv.id)}
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
  const subject = invoiceSubject(invoice);
  const detail = invoiceDetail(invoice);

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
      {/* the company under the client: one client's invoices for the same service on several
          companies otherwise read as duplicates (owner, 2026-10-07) */}
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium" title={invoice.clientName}>
            {invoice.clientName}
          </span>
          {invoice.clientArchived && (
            <span
              className="flex-none text-[11px] text-faint"
              title="Client archived — still owed"
            >
              🗄
            </span>
          )}
        </div>
        {invoice.companyName && (
          <div className="truncate text-[12px] text-muted" title={invoice.companyName}>
            {invoice.companyName}
          </div>
        )}
      </div>
      <div className="min-w-0 text-ink-700">
        <div className="truncate" title={subject ?? ""}>
          {subject ?? "—"}
        </div>
        {detail && (
          <div className="truncate text-[12px] text-muted" title={detail}>
            {detail}
          </div>
        )}
      </div>
      {/* `fmtBizDate` for both: `issuedAt` is a calendar day stamped at UTC midnight
          (`invoiceRow` in invoicing.ts), like `dueDate`. Read on the firm's clock it showed the
          day before, so a 1 October invoice read 30/09 (2026-10-07) */}
      <div className="text-[12px] text-muted">{fmtBizDate(invoice.issuedAt)}</div>
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
