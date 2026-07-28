import { useState } from "react";
import { Link } from "react-router-dom";
import type { Client } from "@shared/schema/client";
import type { Invoice, InvoiceListQuery } from "@shared/schema/payment";
import { cn } from "@/shared/lib/cn";
import { fmtBizDate, fmtDate } from "@/shared/lib/format";
import { fmtMoney } from "@/shared/lib/money";
import { Button } from "@/shared/ui/button";
import { Select } from "@/shared/ui/field";
import { InvoiceStatusPill } from "@/shared/ui/invoice-status";
import { FilterChips } from "@/shared/ui/tabs";
import { InvoiceModal, NewInvoiceModal } from "./invoice-modals";
import { useInvoices } from "./payments.api";

const PAGE_SIZE = 25;

const VIEWS: { key: InvoiceListQuery["filter"]; label: string }[] = [
  { key: "all", label: "All" },
  { key: "paid", label: "Paid" },
  { key: "archived", label: "Archived" },
  { key: "cancelled", label: "Cancelled" },
];

/** Fixed columns with a header — the same rhythm as the Billing table, so both read alike. */
const GRID = "grid-cols-[116px_1fr_92px_108px_84px_96px_96px]";

/**
 * A client's invoices, for the card's Invoices tab. Same modal as the Billing screen;
 * "+ New invoice" is pre-targeted to this client. Multi-company clients can narrow to one
 * company (the same dimension subscriptions and tasks carry).
 */
export function EntityInvoices({ client }: { client: Client }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [view, setView] = useState<InvoiceListQuery["filter"]>("all");
  const [companyId, setCompanyId] = useState<string>("");
  const [page, setPage] = useState(1);

  const { data, isLoading } = useInvoices({
    clientId: client.id,
    filter: view,
    companyId: (companyId || undefined) as InvoiceListQuery["companyId"],
    page,
    pageSize: PAGE_SIZE,
  });

  const items = data?.items ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const reset = () => setPage(1);

  return (
    <div className="space-y-3">
      {/* what this client owes, before any of the detail */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-(--radius-panel) border border-border bg-surface px-4 py-3">
        <Stat label="Outstanding" value={fmtMoney(data?.totals.receivable ?? 0)} strong />
        <Stat
          label="Overdue"
          value={fmtMoney(data?.totals.overdue ?? 0)}
          tone={data && data.totals.overdue > 0 ? "danger" : undefined}
        />
        <Stat label="Invoices" value={String(data?.total ?? 0)} />
        {data && data.counts.unsent > 0 && (
          <Stat label="Not sent yet" value={String(data.counts.unsent)} tone="warn" />
        )}
        <Button size="sm" className="ml-auto" onClick={() => setNewOpen(true)}>
          + New invoice
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterChips
          value={view}
          onChange={(key) => {
            setView(key);
            reset();
          }}
          options={VIEWS.map((v) => ({
            value: v.key,
            label: v.label,
            count: data?.counts[v.key],
          }))}
        />

        {client.companies.length > 0 && (
          <Select
            className="h-8 w-[190px] text-[13px]"
            value={companyId}
            onChange={(e) => {
              setCompanyId(e.target.value);
              reset();
            }}
          >
            <option value="">All companies</option>
            {/* companyId = null — billed to the client directly, with no company involved */}
            <option value="root">No company (the client)</option>
            {client.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}

        <Link
          className="ml-auto text-[12px] text-primary-link hover:underline"
          to={`/billing?client=${client.id}`}
        >
          Open in Billing →
        </Link>
      </div>

      {isLoading && <p className="text-[13px] text-muted">Loading…</p>}

      {data &&
        (items.length === 0 ? (
          <div className="rounded-(--radius-panel) border border-dashed border-[#cfd4db] px-4 py-10 text-center text-[13px] text-muted">
            Nothing here for this client yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface">
            <div
              className={cn(
                "grid min-w-[720px] items-center gap-x-3 border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-faint",
                GRID,
              )}
            >
              <div>№</div>
              <div>Service</div>
              <div>Status</div>
              <div>Delivery</div>
              <div>Due</div>
              <div className="text-right">Amount</div>
              <div className="text-right">Paid</div>
            </div>
            {items.map((invoice) => (
              <InvoiceRow key={invoice.id} invoice={invoice} onOpen={() => setOpenId(invoice.id)} />
            ))}
          </div>
        ))}

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-[13px]">
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

      {openId && <InvoiceModal invoiceId={openId} onClose={() => setOpenId(null)} />}
      {newOpen && (
        <NewInvoiceModal
          presetClientId={client.id}
          onClose={() => setNewOpen(false)}
          onCreated={(inv) => setOpenId(inv.id)}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "danger" | "warn";
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div
        className={cn(
          "tabular-nums",
          strong ? "text-[17px] font-bold" : "text-[15px] font-semibold",
          tone === "danger" && "text-danger-text",
          tone === "warn" && "text-[#b5651d]",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function InvoiceRow({ invoice, onOpen }: { invoice: Invoice; onOpen: () => void }) {
  const overdue = invoice.status === "overdue";
  const sent = invoice.delivery === "sent";
  return (
    <div
      onClick={onOpen}
      className={cn(
        "grid min-w-[720px] cursor-pointer items-center gap-x-3 border-b border-divider px-4 py-2.5 text-[13px] last:border-0 hover:bg-divider/40",
        GRID,
        overdue && "bg-[#fef6f6]",
        (invoice.cancelledAt || invoice.archivedAt) && "opacity-60",
      )}
    >
      <div className="tabular-nums text-ink-700">
        {overdue && <span className="mr-1 text-danger-text">⚠</span>}
        {invoice.number}
      </div>
      <div className="min-w-0 truncate">
        {invoice.serviceName ?? invoice.description ?? "—"}
        {invoice.periodKey && <span className="text-faint"> · {invoice.periodKey}</span>}
        {invoice.companyName && <span className="text-faint"> · {invoice.companyName}</span>}
        {invoice.archivedAt && <span className="ml-1.5 text-faint">📦</span>}
      </div>
      <div>
        <InvoiceStatusPill status={invoice.status} size="sm" />
      </div>
      <div>
        {invoice.cancelledAt ? (
          <span className="text-[12px] text-faint">—</span>
        ) : (
          <span
            className={cn(
              "inline-flex items-center rounded-(--radius-chip) px-2 py-0.5 text-[11px] font-medium",
              sent
                ? "bg-[#e6f4ea] text-success-text"
                : "border border-dashed border-[#c7ccd3] text-muted",
            )}
            title={
              sent
                ? `Sent${invoice.sentAt ? ` ${fmtDate(invoice.sentAt)}` : ""}`
                : "Not handed to the client yet"
            }
          >
            {sent ? "✉ Sent" : "✉ Not sent"}
          </span>
        )}
      </div>
      <div className={cn("text-[12px]", overdue ? "text-danger-text" : "text-muted")}>
        {invoice.dueDate ? fmtBizDate(invoice.dueDate) : <span className="text-faint">—</span>}
      </div>
      <div className="text-right font-semibold tabular-nums">{fmtMoney(invoice.amount)}</div>
      <div className="text-right tabular-nums text-muted">
        {invoice.paid > 0 ? fmtMoney(invoice.paid) : <span className="text-faint">—</span>}
      </div>
    </div>
  );
}
