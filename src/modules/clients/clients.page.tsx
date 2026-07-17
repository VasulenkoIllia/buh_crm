import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Client } from "@shared/schema/client";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/field";
import { ClientFormModal } from "./client-form";
import { useClients } from "./clients.api";

const TABS = [
  { key: "all", label: "All" },
  { key: "regular", label: "Regular" },
  { key: "one_time", label: "One-time" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function ClientsPage() {
  const [tab, setTab] = useState<TabKey>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error } = useClients({ tab, search: search || undefined, page });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-[20px] font-semibold">Clients</h1>
        <Button onClick={() => setFormOpen(true)}>New client</Button>
      </div>

      <div className="mb-3 flex items-center gap-3">
        <div className="inline-flex rounded-(--radius-field) border border-border bg-surface p-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={cn(
                "rounded-(--radius-btn-sm) px-3 py-1.5 text-[13px] font-medium text-muted",
                tab === t.key && "bg-primary text-white",
              )}
              onClick={() => {
                setTab(t.key);
                setPage(1);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Input
          className="w-72"
          placeholder="Search name, email, phone, company…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      {isLoading && <p className="text-[13px] text-muted">Loading…</p>}
      {error && <p className="text-[13px] text-danger-text">Failed to load clients.</p>}

      {data && (
        <>
          <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-border text-[11px] font-semibold uppercase tracking-wide text-muted-400">
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3">Companies</th>
                  <th className="px-4 py-3">Regular</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Address</th>
                  <th className="px-4 py-3 text-right">Debt</th>
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted">
                      No clients yet — create the first one.
                    </td>
                  </tr>
                )}
                {data.items.map((client) => (
                  <ClientRow
                    key={client.id}
                    client={client}
                    onOpen={() => navigate(`/clients/${client.id}`)}
                  />
                ))}
              </tbody>
            </table>
          </div>

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

function ClientRow({ client, onOpen }: { client: Client; onOpen: () => void }) {
  return (
    <tr
      className={cn(
        "cursor-pointer border-b border-divider last:border-0 hover:bg-divider/50",
        client.isRegular && "bg-[#f7f9ff]",
      )}
      onClick={onOpen}
    >
      <td className="px-4 py-2.5 font-medium">
        {client.firstName} {client.lastName}
      </td>
      <td className="px-4 py-2.5">
        <span className="flex flex-wrap gap-1">
          {client.companies.length === 0 && <span className="text-muted">—</span>}
          {client.companies.map((company) => (
            <span
              key={company.id}
              className="rounded-(--radius-chip) bg-divider px-1.5 py-0.5 text-[12px]"
            >
              {company.name}
            </span>
          ))}
        </span>
      </td>
      <td className="px-4 py-2.5">
        {client.isRegular ? (
          <span className="rounded-(--radius-chip) bg-success-soft px-1.5 py-0.5 text-[12px] font-medium text-success">
            Regular
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-muted">{client.phone ?? "—"}</td>
      <td className="px-4 py-2.5 text-muted">{client.email ?? "—"}</td>
      <td className="px-4 py-2.5 text-muted">{client.address ?? "—"}</td>
      <td className="px-4 py-2.5 text-right text-muted">
        {client.debt > 0 ? `$${(client.debt / 100).toFixed(2)}` : "—"}
      </td>
    </tr>
  );
}
