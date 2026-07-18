import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Client } from "@shared/schema/client";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ClientFormModal } from "./client-form";
import { useClients, useUpdateClient } from "./clients.api";

const TABS = [
  { key: "one_time", label: "One-time" },
  { key: "regular", label: "Regular" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const TAB_HINTS: Record<TabKey, string> = {
  one_time:
    "One-time clients. Tick “Regular” to move a client to a subscription — amount and period appear with the Services stage.",
  regular:
    "Regular clients (subscriptions). Amount · Period · Category per subscription arrive with the Services stage.",
};

export function ClientsPage() {
  const [tab, setTab] = useState<TabKey>("one_time");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error } = useClients({ tab, search: search || undefined, page });
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

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
        <Button className="ml-auto" onClick={() => setFormOpen(true)}>
          + New client
        </Button>
      </div>

      <div className="mb-4 flex gap-2">
        {TABS.map((t) => {
          const active = tab === t.key;
          const count = data?.counts[t.key];
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
                setPage(1);
              }}
              className={cn(
                "whitespace-nowrap rounded-(--radius-field) px-3.5 py-2 text-[13px] font-medium",
                active
                  ? "bg-primary text-white"
                  : "border border-border bg-[#f1f3f6] text-ink-700 hover:bg-divider",
              )}
            >
              {t.label}
              {count !== undefined && (
                <span
                  className={cn(
                    "ml-1.5 rounded-[10px] px-1.5 py-px text-[11px] font-semibold",
                    active ? "bg-white/20 text-white" : "bg-[#e7eaef] text-muted-400",
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {error && <p className="text-[13px] text-danger-text">Failed to load clients.</p>}
      {isLoading && <SkeletonList />}

      {data && !isLoading && (
        <>
          {data.counts.one_time + data.counts.regular === 0 && !search ? (
            <EmptyState onCreate={() => setFormOpen(true)} />
          ) : (
            <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface">
              <ListHeader tab={tab} />
              {data.items.map((client) => (
                <ClientRow
                  key={client.id}
                  client={client}
                  tab={tab}
                  onOpen={() => navigate(`/clients/${client.id}`)}
                />
              ))}
              {data.items.length === 0 && (
                <div className="px-4 py-[34px] text-center text-[13px] text-faint">
                  No clients match your search
                </div>
              )}
            </div>
          )}
          <p className="mt-2.5 text-[12px] text-faint">{TAB_HINTS[tab]}</p>

          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-end gap-2 text-[13px] text-muted">
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
            </div>
          )}
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

const GRID: Record<TabKey, string> = {
  one_time: "grid-cols-[1.3fr_1fr_90px_130px_160px_1.1fr_140px_80px]",
  regular: "grid-cols-[1.3fr_1fr_110px_130px_150px_90px]",
};
const HEADERS: Record<TabKey, string[]> = {
  one_time: ["Client", "Company", "Regular", "Phone", "Email", "Address", "Category", "Debt"],
  regular: ["Name", "Company", "Amount", "Period", "Category", "Debt"],
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
        <div key={h} className={cn(i === headers.length - 1 && "text-right")}>
          {h}
        </div>
      ))}
    </div>
  );
}

function Initials({ name }: { name: string }) {
  return (
    <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-[#dfe4ec] text-[11px] font-semibold text-ink-700">
      {name[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

function ClientRow({
  client,
  tab,
  onOpen,
}: {
  client: Client;
  tab: TabKey;
  onOpen: () => void;
}) {
  const update = useUpdateClient();
  const companies = client.companies.map((c) => c.name).join(", ") || "—";
  const debt =
    client.debt > 0 ? (
      <span className="text-danger-text">${(client.debt / 100).toFixed(2)}</span>
    ) : (
      <span className="text-muted">—</span>
    );

  const nameCell = (
    <div className="flex min-w-0 items-center gap-2">
      <Initials name={client.displayName} />
      <span className="truncate font-semibold">{client.displayName}</span>
    </div>
  );
  const category = <span className="text-muted">—</span>; // chips with Services (S3)

  return (
    <div
      onClick={onOpen}
      className={cn(
        "grid min-w-[980px] cursor-pointer items-center gap-x-3 border-b border-divider px-4 py-2.5 text-[13px] last:border-0 hover:bg-divider/40",
        GRID[tab],
        client.isRegular && "bg-[#f7f9ff]",
      )}
    >
      {tab === "regular" ? (
        <>
          {nameCell}
          <div className="truncate text-ink-700">{companies}</div>
          <div className="text-muted">—</div>
          <div className="text-muted">—</div>
          {category}
          <div className="text-right tabular-nums">{debt}</div>
        </>
      ) : (
        <>
          {nameCell}
          <div className="truncate text-ink-700">{companies}</div>
          <div onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={client.isRegular}
              disabled={update.isPending}
              onChange={(e) =>
                update.mutate({
                  id: client.id,
                  input: { regularOverride: e.target.checked ? true : false },
                })
              }
            />
          </div>
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
      <div className="mb-2 text-[30px] text-[#c7ccd3]">▢</div>
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
