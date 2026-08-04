import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive as ArchiveIcon, RotateCcw } from "lucide-react";
import { useClients, useRestoreClient } from "@/modules/clients";
import { useLeads, useRestoreLead } from "@/modules/leads";
import { useRestoreTask, useTasks } from "@/modules/tasks";
import { cn } from "@/shared/lib/cn";
import { fmtDate } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { FilterChips } from "@/shared/ui/tabs";

/**
 * The Archive — one screen for everything that was soft-deleted, and the only place it can be
 * undone.
 *
 * "Archive" used to mean three different things in this app, which is why this screen could not
 * be built before: Client/Task `archivedAt` was a soft delete, an Invoice's was "settled and tidied
 * out of the working list", and the Leads screen's "Archive" tab was not `archivedAt` at all but
 * an OUTCOME (won or lost). Only the first of those belongs here. Invoices kept their meaning
 * under its own name — Billing's "Settled" chip — and the leads tab is now called "Closed"
 * (decision 2026-08-03).
 *
 * Invoices are deliberately absent for a second reason too: archiving a client never hides what
 * they owe. An unpaid invoice stays in Billing, flagged, however long its client sits here.
 */

const TABS = [
  { key: "clients", label: "Clients" },
  { key: "leads", label: "Leads" },
  { key: "tasks", label: "Tasks" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const PAGE_SIZE = 25;
const pagesOf = (total: number | undefined) => Math.max(1, Math.ceil((total ?? 0) / PAGE_SIZE));

/** Every row here is archived by definition, but the DTO field is nullable — say so once. */
const archivedOn = (at: string | null) => (at ? fmtDate(at) : "—");

const HINTS: Record<TabKey, string> = {
  clients:
    "Restoring a client brings back their tasks, invoices and history exactly as they were — but their services stay paused. Resume each one from the client's Services tab, on the date you actually start serving them again.",
  leads:
    "Archived leads are gone from the pipeline. A lead that was simply won or lost is not here — that's the Leads screen's Closed tab.",
  tasks:
    "A task of an archived client can't come back on its own. Restore the client and every one of their tasks comes back with them.",
};

export function ArchivePage() {
  const [tab, setTab] = useState<TabKey>("clients");
  const [error, setError] = useState<string | null>(null);
  // one page number per tab: switching tabs must not carry page 3 into a one-page list
  const [page, setPage] = useState<Record<TabKey, number>>({ clients: 1, leads: 1, tasks: 1 });

  // all three stay mounted so every chip carries a live count — the same reason the Leads screen
  // keeps both of its lists loaded
  const clients = useClients({ tab: "archived", page: page.clients, pageSize: PAGE_SIZE });
  const leads = useLeads("archived");
  const tasks = useTasks({
    view: "table",
    status: "all",
    archived: true,
    page: page.tasks,
    pageSize: PAGE_SIZE,
  });


  const restoreClient = useRestoreClient();
  const restoreLead = useRestoreLead();
  const restoreTask = useRestoreTask();
  const busy = restoreClient.isPending || restoreLead.isPending || restoreTask.isPending;

  const counts = {
    clients: clients.data?.total,
    leads: leads.data?.total,
    tasks: tasks.data?.total,
  };

  /**
   * Every restore goes through here, so one failure reads the same wherever it happened — and
   * emptying the last page steps back instead of leaving you staring at "3 / 2" and no rows.
   */
  async function run(action: () => Promise<unknown>, rowsOnThisPage: number) {
    setError(null);
    try {
      await action();
      if (rowsOnThisPage === 1) {
        setPage((prev) => ({ ...prev, [tab]: Math.max(1, prev[tab] - 1) }));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-3.5 flex flex-wrap items-center gap-3.5">
        <h1 className="text-[20px] font-semibold">Archive</h1>
        <span className="text-[13px] text-muted-400">
          Everything hidden from the working views — and the way back
        </span>
      </div>

      <FilterChips
        className="mb-4"
        value={tab}
        onChange={(key) => {
          setTab(key);
          setError(null);
        }}
        options={TABS.map((t) => ({ value: t.key, label: t.label, count: counts[t.key] }))}
      />

      {error && (
        <p className="mb-3 rounded-(--radius-card) border border-[#f0c9c9] bg-[#fdf5f5] px-3 py-2 text-[13px] text-danger-text">
          {error}
        </p>
      )}

      {tab === "clients" && (
        <Panel
          loading={clients.isLoading}
          failed={!!clients.error}
          empty={clients.data?.items.length === 0}
          emptyLabel="No archived clients"
          columns={["Client", "Company", "Archived", ""]}
          grid="grid-cols-[1.4fr_1fr_140px_120px]"
        >
          {clients.data?.items.map((c) => (
            <Row
              key={c.id}
              grid="grid-cols-[1.4fr_1fr_140px_120px]"
              cells={[c.displayName, c.companyName ?? "—", archivedOn(c.archivedAt)]}
              busy={busy}
              onRestore={() => run(() => restoreClient.mutateAsync(c.id), clients.data!.items.length)}
            />
          ))}
        </Panel>
      )}
      {tab === "clients" && (
        <Pager
          page={page.clients}
          total={clients.data?.total ?? 0}
          onChange={(p) => setPage((prev) => ({ ...prev, clients: p }))}
        />
      )}

      {tab === "leads" && (
        <Panel
          loading={leads.isLoading}
          failed={!!leads.error}
          empty={leads.data?.items.length === 0}
          emptyLabel="No archived leads"
          columns={["Lead", "Company", "Archived", ""]}
          grid="grid-cols-[1.4fr_1fr_140px_120px]"
        >
          {leads.data?.items.map((l) => (
            <Row
              key={l.id}
              grid="grid-cols-[1.4fr_1fr_140px_120px]"
              cells={[l.name, l.companyName ?? "—", archivedOn(l.archivedAt)]}
              busy={busy}
              onRestore={() => run(() => restoreLead.mutateAsync(l.id), leads.data!.items.length)}
            />
          ))}
        </Panel>
      )}
      {tab === "leads" && leads.data?.truncated && (
        <p className="mt-2 text-[12px] text-[#b5651d]">
          Showing the {leads.data.items.length} newest of {leads.data.total} archived leads.
        </p>
      )}

      {tab === "tasks" && (
        <Panel
          loading={tasks.isLoading}
          failed={!!tasks.error}
          empty={tasks.data?.items.length === 0}
          emptyLabel="No archived tasks"
          columns={["Task", "For", "Archived", ""]}
          grid="grid-cols-[2fr_1fr_140px_120px]"
        >
          {tasks.data?.items.map((t) => (
            <Row
              key={t.id}
              grid="grid-cols-[2fr_1fr_140px_120px]"
              cells={[t.title, t.clientName ?? t.leadName ?? "Internal", archivedOn(t.archivedAt)]}
              busy={busy}
              onRestore={() => run(() => restoreTask.mutateAsync(t.id), tasks.data!.items.length)}
            />
          ))}
        </Panel>
      )}
      {tab === "tasks" && (
        <Pager
          page={page.tasks}
          total={tasks.data?.total ?? 0}
          onChange={(p) => setPage((prev) => ({ ...prev, tasks: p }))}
        />
      )}

      <p className="mt-2.5 text-[12px] text-faint">{HINTS[tab]}</p>
    </div>
  );
}

/** Says nothing at all on a single-page list, and never lets one silently hide the rest. */
function Pager({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = pagesOf(total);
  if (pages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-[13px] text-muted">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Prev
      </Button>
      <span>
        {page} / {pages}
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
      >
        Next
      </Button>
    </div>
  );
}

function Panel({
  loading,
  failed,
  empty,
  emptyLabel,
  columns,
  grid,
  children,
}: {
  loading: boolean;
  failed: boolean;
  empty?: boolean;
  emptyLabel: string;
  columns: string[];
  grid: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  if (failed) return <p className="text-[13px] text-danger-text">Failed to load the archive.</p>;
  if (loading) {
    return (
      <div className="rounded-(--radius-panel) border border-border bg-surface p-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="mb-2 h-[38px] animate-pulse rounded-(--radius-card) bg-[#f1f3f6]" />
        ))}
      </div>
    );
  }
  if (empty) {
    return (
      <div className="rounded-(--radius-panel) border border-border bg-surface p-11 text-center">
        <ArchiveIcon size={26} strokeWidth={1.5} className="mx-auto text-faint" />
        <div className="mt-2 text-[15px] font-semibold">{emptyLabel}</div>
        <p className="mt-1 text-[13px] text-muted">Nothing has been archived here yet.</p>
        <Button variant="secondary" className="mt-4" onClick={() => navigate("/clients")}>
          Go to Clients
        </Button>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface">
      <div
        className={cn(
          "grid min-w-[720px] gap-x-3 border-b border-[#eef0f3] bg-[#fafbfc] px-4 py-2.5 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400",
          grid,
        )}
      >
        {columns.map((c, i) => (
          <div key={i}>{c}</div>
        ))}
      </div>
      {children}
    </div>
  );
}

function Row({
  grid,
  cells,
  busy,
  onRestore,
}: {
  grid: string;
  cells: string[];
  busy: boolean;
  onRestore: () => void;
}) {
  return (
    <div
      className={cn(
        "grid min-w-[720px] items-center gap-x-3 border-b border-[#f2f4f7] px-4 py-2.5 text-[13px] last:border-b-0",
        grid,
      )}
    >
      <div className="truncate font-medium text-ink-700">{cells[0]}</div>
      <div className="truncate text-muted">{cells[1]}</div>
      <div className="text-muted-400">{cells[2]}</div>
      <div className="text-right">
        <Button variant="secondary" size="sm" disabled={busy} onClick={onRestore}>
          <RotateCcw size={13} strokeWidth={2} className="mr-1 inline" />
          Restore
        </Button>
      </div>
    </div>
  );
}
