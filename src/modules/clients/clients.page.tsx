import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pin, Users } from "lucide-react";
import type { Client, ClientListQuery } from "@shared/schema/client";
import type { Service } from "@shared/schema/catalog";
import { ServiceChip, useCatalog } from "@/modules/catalog";
import { cn } from "@/shared/lib/cn";
import { fmtMoney } from "@/shared/lib/money";
import { Button } from "@/shared/ui/button";
import { Select } from "@/shared/ui/field";
import { SearchSelect } from "@/shared/ui/search-select";
import { FilterChips } from "@/shared/ui/tabs";
import { ClientFormModal } from "./client-form";
import { useClients, usePinClient } from "./clients.api";

const TABS = [
  { key: "one_time", label: "One-time" },
  { key: "regular", label: "Regular" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/**
 * The labels, keyed by the sort the SERVER accepts — one definition of the values, in the zod enum,
 * and this map is a compile error until a new one is given a name here. Key order is the order of
 * the dropdown.
 */
type SortKey = ClientListQuery["sort"];
const SORT_LABELS: Record<SortKey, string> = {
  recent: "Newest first",
  updated: "Recently edited",
  name: "Name A–Z",
};
const SORTS = Object.keys(SORT_LABELS) as SortKey[];

const PAGE_SIZES = [25, 50, 100] as const;

/**
 * How many rows the reader wants, remembered between visits.
 *
 * `localStorage` and not the server: this is a property of the screen someone is looking at, not
 * of the account — and the throw a private window or blocked site data produces must not take the
 * clients page down with it, hence the try/catch on both sides.
 */
const PAGE_SIZE_KEY = "clients.pageSize";

function storedPageSize(): number {
  try {
    const n = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return (PAGE_SIZES as readonly number[]).includes(n) ? n : 25;
  } catch {
    return 25;
  }
}

function rememberPageSize(n: number): void {
  try {
    localStorage.setItem(PAGE_SIZE_KEY, String(n));
  } catch {
    // a private window or blocked site data — the choice just will not stick
  }
}

const TAB_HINTS: Record<TabKey, string> = {
  one_time:
    "One-time clients — no active subscription. Add a subscription service on the client's Services tab and they move to Regular automatically.",
  regular:
    "Regular clients — they hold an active subscription service. Stop it and the client returns to One-time.",
};

export function ClientsPage() {
  const [tab, setTab] = useState<TabKey>("one_time");
  const [search, setSearch] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [pageSize, setPageSize] = useState(storedPageSize);
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const pin = usePinClient();

  const { data, isLoading, error } = useClients({
    tab,
    search: search || undefined,
    serviceId: serviceId || undefined,
    sort,
    page,
    pageSize,
  });
  const { data: services } = useCatalog();
  const serviceById = new Map((services ?? []).map((s) => [s.id, s]));
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  // pinned rows always lead the sequence, so the block is the run of them at the top of this page
  const rows = data?.items ?? [];
  const firstUnpinned = rows.findIndex((c) => !c.pinned);
  const pinnedOnPage = firstUnpinned === -1 ? rows.length : firstUnpinned;

  return (
    <div className="mx-auto max-w-[1320px]">
      <div className="mb-3.5 flex flex-wrap items-center gap-3.5">
        <h1 className="text-[20px] font-semibold">Clients</h1>
        <span className="whitespace-nowrap text-[13px] text-muted-400">
          {data ? `${data.counts.one_time + data.counts.regular} total` : ""}
        </span>
        <input
          className="ml-2 w-72 rounded-(--radius-card) border border-[#d9dde3] bg-surface px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:border-primary"
          placeholder="🔍 Search: name, company, email…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        {/* Who holds this service RIGHT NOW — the same question the row's chips answer, asked of
            the database by the same rule (see `inForceTodayWhere`). */}
        <div className="w-56">
          <SearchSelect
            value={serviceId}
            options={(services ?? []).filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))}
            placeholder="Any service"
            emptyLabel="Any service"
            ariaLabel="Filter by service"
            onChange={(v) => {
              setServiceId(v);
              setPage(1);
            }}
          />
        </div>
        <Select
          className="w-[152px]"
          aria-label="Sort clients"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as SortKey);
            setPage(1);
          }}
        >
          {SORTS.map((key) => (
            <option key={key} value={key}>
              {SORT_LABELS[key]}
            </option>
          ))}
        </Select>
        <Button className="ml-auto" onClick={() => setFormOpen(true)}>
          + New client
        </Button>
      </div>

      <FilterChips
        className="mb-4"
        value={tab}
        onChange={(key) => {
          setTab(key);
          setPage(1);
        }}
        options={TABS.map((t) => ({
          value: t.key,
          label: t.label,
          count: data?.counts[t.key],
        }))}
      />

      {error && <p className="text-[13px] text-danger-text">Failed to load clients.</p>}
      {isLoading && <SkeletonList />}

      {data && !isLoading && (
        <>
          {data.counts.one_time + data.counts.regular === 0 && !search && !serviceId ? (
            <EmptyState onCreate={() => setFormOpen(true)} />
          ) : (
            <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface">
              <ListHeader tab={tab} />
              {/* Pinned rows always lead, so the block is however many of them the page opens
                  with. Labelling it is what stops "my pins changed" — they never do; they simply
                  sit above a list that reorders (user, 2026-08-26). */}
              {data.items[0]?.pinned && (
                <div className="flex items-center gap-2 border-b border-divider bg-primary/[0.04] px-4 py-1.5 text-[11px] font-medium uppercase tracking-[.4px] text-primary-link">
                  <Pin size={11} strokeWidth={2.5} fill="currentColor" />
                  {/* the number is only the whole block when the block closes on this page;
                      a page made entirely of pinned rows continues onto the next one */}
                  Pinned{pinnedOnPage < rows.length ? ` (${pinnedOnPage})` : ""}
                </div>
              )}
              {data.items.map((client, i) => (
                <ClientRow
                  key={client.id}
                  client={client}
                  tab={tab}
                  serviceById={serviceById}
                  // the line that closes the block — drawn only when ordinary rows follow it
                  lastPinned={i === pinnedOnPage - 1 && data.items.length > pinnedOnPage}
                  onOpen={() => navigate(`/clients/${client.id}`)}
                  onTogglePin={() =>
                    pin.mutate(
                      { id: client.id, pinned: !client.pinned },
                      {
                        // a click that does nothing and says nothing is the worst outcome here:
                        // the row simply stays where it was, which reads as "the feature is
                        // broken" whatever the actual cause was (a 403 from a dev origin, once)
                        onError: (err) =>
                          window.alert(
                            `Could not ${client.pinned ? "unpin" : "pin"} ${client.displayName}.\n\n` +
                              (err instanceof Error ? err.message : "Please try again."),
                          ),
                      },
                    )
                  }
                />
              ))}
              {data.items.length === 0 && (
                <div className="px-4 py-[34px] text-center text-[13px] text-faint">
                  No clients match these filters
                </div>
              )}
            </div>
          )}
          <p className="mt-2.5 text-[12px] text-faint">{TAB_HINTS[tab]}</p>

          {/* The row-count picker stays even on a single page — it is how you GET to one page. */}
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2 text-[13px] text-muted">
            <label className="mr-auto flex items-center gap-2">
              <span className="text-faint">Rows</span>
              <Select
                className="w-[76px]"
                aria-label="Clients per page"
                value={String(pageSize)}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setPageSize(next);
                  setPage(1); // page 7 of 25 is off the end at 100 per page
                  rememberPageSize(next);
                }}
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
            {totalPages > 1 && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Prev
                </Button>
                <span>
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
              </>
            )}
          </div>
        </>
      )}

      {formOpen && (
        <ClientFormModal
          open={formOpen}
          onClose={() => setFormOpen(false)}
          onSaved={(client) => navigate(`/clients/${client.id}`)}
        />
      )}
    </div>
  );
}

// the leading 26px column is the pin — a column of its own so the names below still line up
const GRID: Record<TabKey, string> = {
  one_time: "grid-cols-[26px_1.3fr_1fr_130px_160px_1.1fr_140px_80px]",
  regular: "grid-cols-[26px_1.3fr_1fr_110px_130px_150px_90px]",
};
const HEADERS: Record<TabKey, string[]> = {
  one_time: ["", "Client", "Company", "Phone", "Email", "Address", "Category", "Debt"],
  regular: ["", "Name", "Company", "Amount", "Period", "Category", "Debt"],
};

function ListHeader({ tab }: { tab: TabKey }) {
  const headers = HEADERS[tab];
  return (
    <div
      className={cn(
        "grid min-w-[980px] gap-x-3 border-b border-[#eef0f3] bg-[#fafbfc] px-4 py-2.5 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400",
        GRID[tab],
      )}
    >
      {headers.map((h, i) => (
        <div key={i} className={cn(i === headers.length - 1 && "text-right")}>
          {h}
        </div>
      ))}
    </div>
  );
}

/**
 * The pin control. Always rendered, not revealed on hover: a hidden affordance on a 177-row list
 * is one nobody finds. Un-pinned it is a faint outline that reads as "you could"; pinned it is the
 * primary blue and filled.
 */
function PinButton({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={pinned ? "Unpin from the top" : "Pin to the top"}
      aria-pressed={pinned}
      title={pinned ? "Unpin from the top" : "Pin to the top"}
      // the whole row navigates; the pin must not
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "flex h-[22px] w-[22px] items-center justify-center rounded-(--radius-chip) transition-colors",
        pinned
          ? "text-primary-link hover:bg-primary/10"
          : "text-[#c7ccd3] hover:bg-divider hover:text-muted",
      )}
    >
      <Pin size={14} strokeWidth={2} fill={pinned ? "currentColor" : "none"} />
    </button>
  );
}

function Initials({ name }: { name: string }) {
  return (
    <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-[#dfe4ec] text-[11px] font-semibold text-ink-700">
      {name[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

const PERIOD_SHORT: Record<string, string> = { month: "monthly", quarter: "quarterly", year: "yearly" };

function ClientRow({
  client,
  tab,
  serviceById,
  onOpen,
  onTogglePin,
  lastPinned = false,
}: {
  client: Client;
  tab: TabKey;
  serviceById: Map<string, Service>;
  onOpen: () => void;
  onTogglePin: () => void;
  /** the final pinned row — carries the rule that closes the block */
  lastPinned?: boolean;
}) {
  // the companies they actually hold; the plain `companyName` label stands in when there are none
  const companies =
    client.companies.map((c) => c.name).join(", ") || client.companyName || "—";
  const debt =
    client.debt > 0 ? (
      <span className="text-danger-text">{fmtMoney(client.debt)}</span>
    ) : (
      <span className="text-muted">—</span>
    );

  const nameCell = (
    <div className="flex min-w-0 items-center gap-2">
      <Initials name={client.displayName} />
      <span className="truncate font-semibold">{client.displayName}</span>
    </div>
  );
  const category =
    client.categories.length > 0 ? (
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {client.categories.slice(0, 2).map((id) => {
          const svc = serviceById.get(id);
          return svc ? <ServiceChip key={id} name={svc.name} color={svc.color} /> : null;
        })}
        {client.categories.length > 2 && (
          <span className="text-[11px] text-muted">+{client.categories.length - 2}</span>
        )}
      </div>
    ) : (
      <span className="text-muted">—</span>
    );
  const activeSubs = client.subscriptions.filter((s) => s.active);
  const subsTotal = activeSubs.reduce((sum, s) => sum + s.amount, 0);
  const subsPeriods =
    [...new Set(activeSubs.map((s) => PERIOD_SHORT[s.period]))].join(", ") || "—";

  return (
    <div
      onClick={onOpen}
      className={cn(
        "grid min-w-[980px] cursor-pointer items-center gap-x-3 border-b border-divider px-4 py-2.5 text-[13px] last:border-0 hover:bg-divider/40",
        GRID[tab],
        client.isRegular && "bg-[#f7f9ff]",
        // pinned wins over the regular tint: it is the reader's own mark, and the two never
        // stack into a third colour nobody can read
        client.pinned && "bg-primary/[0.055]",
        lastPinned && "border-b-2 border-b-[#c3cdf3]",
      )}
    >
      <PinButton pinned={client.pinned} onToggle={onTogglePin} />
      {tab === "regular" ? (
        <>
          {nameCell}
          <div className="truncate text-ink-700">{companies}</div>
          <div className="tabular-nums">
            {activeSubs.length > 0 ? fmtMoney(subsTotal) : "—"}
          </div>
          <div className="truncate text-muted">{subsPeriods}</div>
          {category}
          <div className="text-right tabular-nums">{debt}</div>
        </>
      ) : (
        <>
          {nameCell}
          <div className="truncate text-ink-700">{companies}</div>
          <div className="truncate text-muted">{client.phone ?? "—"}</div>
          <div className="truncate text-muted">{client.email ?? "—"}</div>
          <div className="truncate text-muted">{client.address ?? "—"}</div>
          {category}
          <div className="text-right tabular-nums">{debt}</div>
        </>
      )}
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
          <div className="h-[30px] w-[30px] flex-none animate-pulse rounded-full bg-[#eef0f3]" />
          <div className="h-[11px] flex-1 animate-pulse rounded-md bg-[#eef0f3]" />
          <div className="h-[11px] w-[90px] animate-pulse rounded-md bg-[#eef0f3]" />
          <div className="h-[11px] w-[60px] animate-pulse rounded-md bg-[#eef0f3]" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-(--radius-panel) border border-dashed border-[#cfd4db] bg-surface p-12 text-center">
      {/* same pictogram as the sidebar's Clients entry, so the empty state names the page */}
      <Users size={30} strokeWidth={1.5} className="mx-auto mb-2 text-[#c7ccd3]" />
      <div className="text-[15px] font-semibold">No clients yet</div>
      <p className="mt-1 text-[13px] text-muted">
        Create the first client to start tracking work and billing.
      </p>
      <Button className="mt-4" onClick={onCreate}>
        + New client
      </Button>
    </div>
  );
}
