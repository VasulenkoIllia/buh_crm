import { useEffect, useState } from "react";
import { useClients } from "@/modules/clients";
import { useLeads } from "@/modules/leads";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ClearButton } from "@/shared/ui/clear-button";
import { ClientCode } from "@/shared/ui/client-code";
import { Input } from "@/shared/ui/field";
import { RowButton } from "@/shared/ui/row-button";

/**
 * **The client/lead combobox, in a file of its own.**
 *
 * It lives here because it is the one thing the tasks barrel publishes to other modules, and a
 * barrel carries whatever it reaches: while this stood in `task-modals.tsx`, that 37 kB file — the
 * task form, the details modal, subtasks, files, comments and the time log — was a chunk the
 * board, leads, the client card and the CALENDAR all shared, for the sake of one combobox in the
 * meeting form. `src/app/code-splitting.test.ts` said so in its own comment for two weeks before
 * anybody moved it (2026-09-21).
 *
 * It searches on the SERVER, so it has no cap — the meeting form first used the tasks BOARD FILTER
 * list by mistake, which only ever contained clients and leads that already had work
 * (user, 2026-08-06).
 */

/** A resolved task target: a client (through one of its subscriptions) or a lead. */
export type Target =
  { kind: "client"; id: string; label: string } | { kind: "lead"; id: string; label: string };

/**
 * Dynamic-search combobox over clients + in-process leads. The picked value
 * lives in the input itself — re-pick freely by editing the text (no separate
 * "change" control); create a client or a lead inline.
 */
export function ClientLeadSearch({
  value,
  onPick,
  onClear,
  onNewClient,
  onNewLead,
  placeholder = "Search or pick a client / lead…",
}: {
  value: Target | null;
  onPick: (t: Target) => void;
  onClear: () => void;
  /** omitted → no inline "+ New client" row (the calendar has no use for it) */
  onNewClient?: () => void;
  onNewLead?: () => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState(value?.label ?? "");
  const [open, setOpen] = useState(false);
  // reflect an externally-set target (e.g. a just-created client) in the field
  useEffect(() => {
    if (value) {
      setQuery(value.label);
      setOpen(false);
    }
  }, [value]);

  const q = query.trim().toLowerCase();
  const committed = value?.label === query; // showing the current pick, not a fresh search
  const searching = q.length > 0 && !committed;
  // fetch only while the dropdown is open: search results when typing, else a
  // short suggestion list (most-recent clients) — like a normal combobox
  const { data: clientsResp } = useClients(
    { tab: "all", search: searching ? query.trim() : undefined, pageSize: searching ? 20 : 6 },
    { enabled: open },
  );
  // only live leads can be picked as a task target — the server sends just those
  const { data: leads } = useLeads("in_process");

  const clientMatches = clientsResp?.items ?? [];
  const leadMatches = (leads?.items ?? [])
    .filter((l) => !searching || l.name.toLowerCase().includes(q))
    .slice(0, searching ? 6 : 4);

  const onType = (v: string) => {
    setQuery(v);
    setOpen(true);
    if (value) onClear(); // editing the text drops the current pick → re-searching
  };

  return (
    <div className="relative">
      <div className="relative">
        <Input
          className={cn("w-full pr-16", value && "border-primary font-medium")}
          placeholder={placeholder}
          value={query}
          onChange={(e) => onType(e.target.value)}
          onFocus={(e) => {
            e.target.select();
            setOpen(true); // clicking the field opens the suggestion dropdown
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)} // let an option click land first
        />
        {value ? (
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] font-medium text-[#0e7a6b]">
            ✓ {value.kind}
          </span>
        ) : (
          query && (
            <ClearButton
              label="Clear"
              className="absolute top-1/2 right-2 -translate-y-1/2"
              onClick={() => {
                setQuery("");
                onClear();
              }}
            />
          )
        )}
      </div>
      {(onNewClient ?? onNewLead) && (
        <div className="mt-1 flex gap-3">
          {onNewClient && (
            <Button variant="text" size="sm" className="h-auto px-0" onClick={onNewClient}>
              + New client
            </Button>
          )}
          {onNewLead && (
            <Button variant="text" size="sm" className="h-auto px-0" onClick={onNewLead}>
              + New lead
            </Button>
          )}
        </div>
      )}
      {open && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-(--radius-field) border border-border bg-surface shadow-(--shadow-card)">
          {!searching && (clientMatches.length > 0 || leadMatches.length > 0) && (
            <p className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-[.4px] text-muted-400 uppercase">
              Suggestions
            </p>
          )}
          {clientMatches.map((c) => (
            <RowButton
              key={c.id}
              className="border-b border-divider px-3 py-2 text-[13px] last:border-0"
              onMouseDown={(e) => e.preventDefault()} // keep focus so onClick fires before blur
              onClick={() => onPick({ kind: "client", id: c.id, label: c.displayName })}
            >
              {/* the code is quoted BETWEEN people; this row is where a quoted one is acted on,
                  so it has to be possible to confirm you picked the client you were told about */}
              <ClientCode code={c.code} className="text-[11px]" />
              <span className="truncate font-medium">{c.displayName}</span>
              <span className="flex-none text-[11px] text-muted">client</span>
            </RowButton>
          ))}
          {leadMatches.map((l) => (
            <RowButton
              key={l.id}
              className="border-b border-divider px-3 py-2 text-[13px] last:border-0"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick({ kind: "lead", id: l.id, label: l.name })}
            >
              <span className="font-medium">{l.name}</span>
              <span className="text-[11px] text-[#8b6a1f]">lead · free</span>
            </RowButton>
          ))}
          {clientMatches.length === 0 && leadMatches.length === 0 && (
            <p className="px-3 py-3 text-[12px] text-muted">
              {searching ? "No matches — try another name." : "No clients or leads yet."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
